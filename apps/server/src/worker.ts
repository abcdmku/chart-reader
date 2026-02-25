import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import mime from 'mime-types';
import type { Db } from './db.js';
import { getConfig, withTransaction } from './db.js';
import { exportCsv } from './csv.js';
import { makeUniqueFilename } from './files.js';
import { extractChartRows, extractMissingChartRows } from './gemini.js';
import { rasterizePdfFirstPageForModel } from './pdfRasterize.js';
import type { FileLocation, Job } from './types.js';
import { coerceRank } from './utils/coerceRank.js';
import type { MissingChartGroup } from './utils/extractionCompleteness.js';
import { findMissingChartGroups, formatRankRanges } from './utils/extractionCompleteness.js';
import { parseEntryDate } from './utils/parseEntryDate.js';
import type { SseHub } from './sse.js';

type WorkerPaths = {
  newDir: string;
  completedDir: string;
  outputCsvPath: string;
};

type RunStatus = 'completed' | 'error' | 'cancelled';

class JobCancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(sourcePath: string, destPath: string): Promise<void> {
  try {
    await fsp.rename(sourcePath, destPath);
  } catch (error) {
    const asErr = error as NodeJS.ErrnoException;
    if (asErr.code === 'EXDEV') {
      await fsp.copyFile(sourcePath, destPath);
      await fsp.rm(sourcePath, { force: true });
      return;
    }
    throw error;
  }
}

export class Worker {
  private tickTimer: NodeJS.Timeout;
  private exportQueue: Promise<void> = Promise.resolve();
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly paths: WorkerPaths,
    private readonly sse: SseHub,
  ) {
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, 1_000);
  }

  stop(): void {
    clearInterval(this.tickTimer);
    for (const controller of this.activeControllers.values()) controller.abort();
    this.activeControllers.clear();
  }

  requestCancel(jobId: string, message = 'Cancelled'): void {
    const controller = this.activeControllers.get(jobId);
    controller?.abort(message);
  }

  async tick(): Promise<void> {
    const config = getConfig(this.db);
    if (config.paused) return;

    const activeCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'processing'")
      .get() as { count: number };
    const activeCountDb = activeCountRow.count ?? 0;
    const activeCount = Math.max(activeCountDb, this.activeControllers.size);

    const available = Math.max(0, config.concurrency - activeCount);
    if (available === 0) return;

    const claimed = this.claimQueuedJobs(available);
    for (const job of claimed) {
      this.sse.send('job', job);
      void this.processJob(job, config.model);
    }
  }

  private claimQueuedJobs(limit: number): Job[] {
    return withTransaction(this.db, () => {
      const now = new Date().toISOString();
      const ids = this.db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(limit) as Array<{ id: string }>;

      if (ids.length === 0) return [] as Job[];

      const update = this.db.prepare(
        `UPDATE jobs
         SET status = 'processing',
             progress_step = 'starting',
             error = NULL,
             started_at = ?,
             finished_at = NULL
         WHERE id = ? AND status = 'queued'`,
      );

      for (const { id } of ids) update.run(now, id);

      const placeholders = ids.map(() => '?').join(',');
      return this.db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders})`).all(...ids.map((r) => r.id)) as Job[];
    });
  }

  private updateJob(jobId: string): Job {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
    if (!job) throw new Error(`Job not found: ${jobId}`);
    this.sse.send('job', job);
    return job;
  }

  private setProgress(jobId: string, step: string): void {
    this.db.prepare("UPDATE jobs SET progress_step = ? WHERE id = ? AND status = 'processing'").run(step, jobId);
    this.updateJob(jobId);
  }

  private setError(jobId: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'error',
             progress_step = 'error',
             error = ?,
             finished_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(message, now, jobId);
    this.updateJob(jobId);
  }

  private setCancelled(jobId: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'cancelled',
             progress_step = NULL,
             error = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(message, now, jobId);
    this.updateJob(jobId);
  }

  private recordRun(args: {
    runId: string;
    jobId: string;
    model: string;
    extractedAt: string;
    rowsInserted: number;
    rawResultJson: string;
    status: RunStatus;
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, job_id, model, extracted_at, rows_inserted, raw_result_json, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.runId,
        args.jobId,
        args.model,
        args.extractedAt,
        args.rowsInserted,
        args.rawResultJson,
        args.status,
        args.error,
      );
  }

  private updateRunStatus(runId: string, status: RunStatus, error: string | null): void {
    this.db.prepare('UPDATE runs SET status = ?, error = ? WHERE run_id = ?').run(status, error, runId);
  }

  private setCompleted(args: { jobId: string; runId: string; rowsAppended: number; filename: string; fileLocation: FileLocation }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             progress_step = NULL,
             error = NULL,
             finished_at = ?,
             run_count = run_count + 1,
             last_run_id = ?,
             rows_appended_last_run = ?,
             filename = ?,
             file_location = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(now, args.runId, args.rowsAppended, args.filename, args.fileLocation, args.jobId);
    this.updateJob(args.jobId);
  }

  private getJobStatus(jobId: string): Job['status'] | null {
    const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status?: Job['status'] } | undefined;
    return row?.status ?? null;
  }

  private throwIfCancelled(jobId: string, signal: AbortSignal): void {
    if (signal.aborted) {
      const reason = signal.reason;
      const message = typeof reason === 'string' && reason.trim() ? reason : 'Cancelled';
      throw new JobCancelledError(message);
    }
    const status = this.getJobStatus(jobId);
    if (status === 'cancelled') throw new JobCancelledError('Cancelled');
  }

  private enqueueCsvExport(): Promise<void> {
    this.exportQueue = this.exportQueue
      .then(async () => {
        const result = await exportCsv(this.db, this.paths.outputCsvPath);
        this.sse.send('csv_updated', result);
      })
      .catch((error) => {
        this.sse.send('csv_error', { message: (error as Error).message });
      });

    return this.exportQueue;
  }

  private queuePendingVersionIfNeeded(jobId: string): void {
    const row = this.db.prepare('SELECT status, pending_filename FROM jobs WHERE id = ?').get(jobId) as
      | { status: Job['status']; pending_filename: string | null }
      | undefined;
    const pending = row?.pending_filename ?? null;
    if (!pending) return;
    if (row?.status === 'processing' || row?.status === 'deleted') return;

    const inNew = fs.existsSync(path.join(this.paths.newDir, pending));
    const inCompleted = fs.existsSync(path.join(this.paths.completedDir, pending));
    const fileLocation: FileLocation = inNew ? 'new' : inCompleted ? 'completed' : 'missing';

    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             progress_step = NULL,
             error = NULL,
             started_at = NULL,
             finished_at = NULL,
             filename = ?,
             file_location = ?,
             pending_filename = NULL
         WHERE id = ? AND status <> 'processing'`,
      )
      .run(pending, fileLocation, jobId);
    this.updateJob(jobId);
  }

  private async processJob(initialJob: Job, model: string): Promise<void> {
    const runId = nanoid();
    let runRecorded = false;
    let rawResultJson = '';

    type AttemptLog = {
      stage: 'initial' | 'missing_ranks' | 'missing_ranks_gemini3';
      model: string;
      rowsReturned: number;
      rowsAdded: number;
      missingAfter: Array<MissingChartGroup & { missingThisWeekRankRanges: string }>;
    };

    const attemptLogs: AttemptLog[] = [];

    let job = initialJob;
    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);

    try {
      this.throwIfCancelled(job.id, controller.signal);

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
      if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set');

      this.throwIfCancelled(job.id, controller.signal);
      this.setProgress(job.id, 'validating_file');

      const pathNew = path.join(this.paths.newDir, job.filename);
      const pathCompleted = path.join(this.paths.completedDir, job.filename);

      let filePath: string | null = null;
      let fileLocation: FileLocation = 'missing';

      if (await fileExists(pathNew)) {
        filePath = pathNew;
        fileLocation = 'new';
      } else if (await fileExists(pathCompleted)) {
        filePath = pathCompleted;
        fileLocation = 'completed';
      }

      if (!filePath) {
        this.db.prepare("UPDATE jobs SET file_location = 'missing' WHERE id = ?").run(job.id);
        throw new Error(`File not found in new/completed: ${job.filename}`);
      }

      this.db.prepare('UPDATE jobs SET file_location = ? WHERE id = ?').run(fileLocation, job.id);
      job = this.updateJob(job.id);

      const entryDate = job.entry_date ?? parseEntryDate(job.filename);
      if (!entryDate) {
        throw new Error('Date not found in filename (expected YYYY-MM-DD)');
      }
      if (job.entry_date !== entryDate) {
        this.db.prepare('UPDATE jobs SET entry_date = ? WHERE id = ?').run(entryDate, job.id);
        job = this.updateJob(job.id);
      }

      const mimeType = mime.lookup(job.filename) || '';
      const isSupportedMime = mimeType.startsWith('image/') || mimeType === 'application/pdf';
      if (!isSupportedMime) {
        throw new Error(`Unsupported file type: ${mimeType || 'unknown'}`);
      }

      this.throwIfCancelled(job.id, controller.signal);
      const fileData = await fsp.readFile(filePath);
      let modelFileData: Buffer = fileData;
      let modelMimeType = mimeType;

      if (mimeType === 'application/pdf') {
        this.throwIfCancelled(job.id, controller.signal);
        this.setProgress(job.id, 'rasterizing_pdf');

        const rasterized = await rasterizePdfFirstPageForModel({
          fileData,
          dpi: 300,
          abortSignal: controller.signal,
        });
        modelFileData = rasterized.fileData;
        modelMimeType = rasterized.mimeType;
      }

      this.throwIfCancelled(job.id, controller.signal);
      this.setProgress(job.id, 'extracting');

      let finalModel = model;
      let runStatus: RunStatus = 'completed';
      let runError: string | null = null;
      const initialExtraction = await extractChartRows({
        fileData: modelFileData,
        mimeType: modelMimeType,
        filename: job.filename,
        model,
        abortSignal: controller.signal,
      });
      let mergedRows = initialExtraction.result.rows;

      const chartGroupOrder: string[] = [];
      {
        const seen = new Set<string>();
        for (const row of mergedRows) {
          const key = `${row.chartSection}|||${row.chartTitle}`;
          if (seen.has(key)) continue;
          seen.add(key);
          chartGroupOrder.push(key);
        }
      }

      const summarizeMissing = (groups: MissingChartGroup[]) =>
        groups.map((g) => ({
          ...g,
          missingThisWeekRankRanges: formatRankRanges(g.missingThisWeekRanks, { maxRanges: 30 }),
        }));

      const mergeMissingRanks = (args: {
        existing: typeof mergedRows;
        incoming: typeof mergedRows;
        missing: MissingChartGroup[];
      }): { merged: typeof mergedRows; rowsAdded: number } => {
        const missingByKey = new Map<string, Set<number>>();
        for (const group of args.missing) {
          const key = `${group.chartSection}|||${group.chartTitle}`;
          missingByKey.set(key, new Set(group.missingThisWeekRanks));
        }

        const existingRanksByKey = new Map<string, Set<number>>();
        for (const row of args.existing) {
          const key = `${row.chartSection}|||${row.chartTitle}`;
          const rank = coerceRank(row.thisWeekRank);
          if (rank == null) continue;
          let set = existingRanksByKey.get(key);
          if (!set) {
            set = new Set<number>();
            existingRanksByKey.set(key, set);
          }
          set.add(rank);
        }

        const merged = args.existing.slice();
        let rowsAdded = 0;

        for (const row of args.incoming) {
          const key = `${row.chartSection}|||${row.chartTitle}`;
          const missingRanks = missingByKey.get(key);
          if (!missingRanks || missingRanks.size === 0) continue;

          const rank = coerceRank(row.thisWeekRank);
          if (rank == null || !missingRanks.has(rank)) continue;

          const existingRanks = existingRanksByKey.get(key) ?? new Set<number>();
          if (existingRanks.has(rank)) continue;

          merged.push(row);
          existingRanks.add(rank);
          existingRanksByKey.set(key, existingRanks);
          rowsAdded += 1;
        }

        return { merged, rowsAdded };
      };

      const sortMergedRows = (rows: typeof mergedRows): typeof mergedRows => {
        const orderIndex = new Map<string, number>();
        for (const [index, key] of chartGroupOrder.entries()) orderIndex.set(key, index);

        const groups = new Map<string, Array<{ row: (typeof mergedRows)[number]; rank: number | null; idx: number }>>();

        for (const [idx, row] of rows.entries()) {
          const key = `${row.chartSection}|||${row.chartTitle}`;
          const rank = coerceRank(row.thisWeekRank);
          let list = groups.get(key);
          if (!list) {
            list = [];
            groups.set(key, list);
          }
          list.push({ row, rank, idx });
        }

        const keys = Array.from(groups.keys()).sort((a, b) => {
          const ai = orderIndex.get(a) ?? Number.POSITIVE_INFINITY;
          const bi = orderIndex.get(b) ?? Number.POSITIVE_INFINITY;
          if (ai !== bi) return ai - bi;
          return a.localeCompare(b);
        });

        const out: typeof mergedRows = [];
        for (const key of keys) {
          const list = groups.get(key);
          if (!list) continue;
          list.sort((a, b) => {
            const ar = a.rank ?? Number.POSITIVE_INFINITY;
            const br = b.rank ?? Number.POSITIVE_INFINITY;
            if (ar !== br) return ar - br;
            return a.idx - b.idx;
          });
          for (const item of list) out.push(item.row);
        }

        return out;
      };

      let missing = findMissingChartGroups({ rows: mergedRows, sourceFilename: job.filename });
      attemptLogs.push({
        stage: 'initial',
        model,
        rowsReturned: initialExtraction.result.rows.length,
        rowsAdded: 0,
        missingAfter: summarizeMissing(missing),
      });

      if (missing.length > 0) {
        this.throwIfCancelled(job.id, controller.signal);
        this.setProgress(job.id, 'validating_extraction');

        this.throwIfCancelled(job.id, controller.signal);
        this.setProgress(job.id, 'extracting_missing_ranks');
        const missingExtraction = await extractMissingChartRows({
          fileData: modelFileData,
          mimeType: modelMimeType,
          filename: job.filename,
          model,
          missing,
          abortSignal: controller.signal,
        });

        const merged1 = mergeMissingRanks({ existing: mergedRows, incoming: missingExtraction.result.rows, missing });
        mergedRows = merged1.merged;
        missing = findMissingChartGroups({ rows: mergedRows, sourceFilename: job.filename });
        attemptLogs.push({
          stage: 'missing_ranks',
          model,
          rowsReturned: missingExtraction.result.rows.length,
          rowsAdded: merged1.rowsAdded,
          missingAfter: summarizeMissing(missing),
        });

        if (missing.length > 0 && model !== 'gemini-3-flash-preview') {
          this.throwIfCancelled(job.id, controller.signal);
          this.setProgress(job.id, 'extracting_missing_ranks_gemini3');

          const gemini3Model = 'gemini-3-flash-preview';
          const missingExtractionGemini3 = await extractMissingChartRows({
            fileData: modelFileData,
            mimeType: modelMimeType,
            filename: job.filename,
            model: gemini3Model,
            missing,
            abortSignal: controller.signal,
          });

          const merged2 = mergeMissingRanks({
            existing: mergedRows,
            incoming: missingExtractionGemini3.result.rows,
            missing,
          });
          mergedRows = merged2.merged;
          missing = findMissingChartGroups({ rows: mergedRows, sourceFilename: job.filename });
          attemptLogs.push({
            stage: 'missing_ranks_gemini3',
            model: gemini3Model,
            rowsReturned: missingExtractionGemini3.result.rows.length,
            rowsAdded: merged2.rowsAdded,
            missingAfter: summarizeMissing(missing),
          });

          finalModel = gemini3Model;
        }

        if (missing.length > 0) {
          const preview = missing
            .slice(0, 4)
            .map(
              (g) =>
                `${g.chartTitle || '(unknown chart)'}: expected ${g.expectedRowCount}, got ${g.actualRowCount}, missing ranks ${formatRankRanges(g.missingThisWeekRanks)}`,
            )
            .join('; ');
          runStatus = 'error';
          runError = `Extraction incomplete: ${preview}${missing.length > 4 ? '…' : ''}`;
        }
      }

      mergedRows = sortMergedRows(mergedRows);

      rawResultJson = JSON.stringify(
        {
          object: { rows: mergedRows },
          attempts: attemptLogs,
          status: runStatus,
          error: runError,
        },
        null,
        2,
      );

      if (mergedRows.length === 0) {
        throw new Error('No rows extracted');
      }

      this.throwIfCancelled(job.id, controller.signal);
      this.setProgress(job.id, 'writing_db');
      const extractedAt = new Date().toISOString();

      const insert = this.db.prepare(
        `INSERT INTO chart_rows (
          run_id,
          job_id,
          entry_date,
          chart_title,
          chart_section,
          this_week_rank,
          last_week_rank,
          two_weeks_ago_rank,
          weeks_on_chart,
          title,
          artist,
          label,
          source_file,
          extracted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      withTransaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO runs (run_id, job_id, model, extracted_at, rows_inserted, raw_result_json, status, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(runId, job.id, finalModel, extractedAt, mergedRows.length, rawResultJson, runStatus, runError);

        for (const row of mergedRows) {
          insert.run(
            runId,
            job.id,
            entryDate,
            row.chartTitle,
            row.chartSection ?? '',
            coerceRank(row.thisWeekRank),
            coerceRank(row.lastWeekRank),
            coerceRank(row.twoWeeksAgoRank),
            coerceRank(row.weeksOnChart),
            row.title,
            row.artist,
            row.label,
            job.filename,
            extractedAt,
          );
        }
      });
      runRecorded = true;

      if (runStatus !== 'completed') {
        throw new Error(runError || 'Extraction incomplete');
      }

      let finalFilename = job.filename;
      let finalLocation: FileLocation = fileLocation;

      if (fileLocation === 'new') {
        this.throwIfCancelled(job.id, controller.signal);
        this.setProgress(job.id, 'moving_file');

        const isTaken = (name: string) => {
          const existsInFs = fs.existsSync(path.join(this.paths.completedDir, name));
          const existsInDb =
            (this.db
              .prepare('SELECT 1 FROM jobs WHERE filename = ? AND id <> ?')
              .get(name, job.id) as { 1: 1 } | undefined) != null;
          return existsInFs || existsInDb;
        };

        finalFilename = makeUniqueFilename(finalFilename, isTaken);
        const destPath = path.join(this.paths.completedDir, finalFilename);

        await moveFile(pathNew, destPath);
        finalLocation = 'completed';

        if (finalFilename !== job.filename) {
          this.db.prepare('UPDATE chart_rows SET source_file = ? WHERE run_id = ?').run(finalFilename, runId);
        }
      }

      this.throwIfCancelled(job.id, controller.signal);
      this.setProgress(job.id, 'exporting_csv');
        this.setCompleted({
          jobId: job.id,
          runId,
          rowsAppended: mergedRows.length,
          filename: finalFilename,
          fileLocation: finalLocation,
        });
      await this.enqueueCsvExport();
    } catch (error) {
      if (error instanceof JobCancelledError || controller.signal.aborted || isAbortError(error)) {
        const message = error instanceof Error ? error.message : 'Cancelled';
        this.setCancelled(job.id, message || 'Cancelled');
        if (runRecorded) {
          this.updateRunStatus(runId, 'cancelled', message || 'Cancelled');
        } else {
          this.recordRun({
            runId,
            jobId: job.id,
            model,
            extractedAt: new Date().toISOString(),
            rowsInserted: 0,
            rawResultJson,
            status: 'cancelled',
            error: message || 'Cancelled',
          });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.setError(job.id, message);
        if (runRecorded) {
          this.updateRunStatus(runId, 'error', message);
        } else {
          this.recordRun({
            runId,
            jobId: job.id,
            model,
            extractedAt: new Date().toISOString(),
            rowsInserted: 0,
            rawResultJson,
            status: 'error',
            error: message,
          });
        }
      }
    } finally {
      this.activeControllers.delete(job.id);
      this.queuePendingVersionIfNeeded(job.id);
      await this.tick();
    }
  }
}

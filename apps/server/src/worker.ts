import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import mime from 'mime-types';
import type { Db } from './db.js';
import { getConfig, withTransaction } from './db.js';
import { exportCsv } from './csv.js';
import { makeUniqueFilename } from './files.js';
import { extractChartRows } from './gemini.js';
import type { FileLocation, Job } from './types.js';
import { coerceRank } from './utils/coerceRank.js';
import { parseEntryDate } from './utils/parseEntryDate.js';
import type { SseHub } from './sse.js';

type WorkerPaths = {
  newDir: string;
  completedDir: string;
  outputCsvPath: string;
};

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
  }

  async tick(): Promise<void> {
    const config = getConfig(this.db);
    if (config.paused) return;

    const activeCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'processing'")
      .get() as { count: number };
    const activeCount = activeCountRow.count ?? 0;

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
    this.db.prepare('UPDATE jobs SET progress_step = ? WHERE id = ?').run(step, jobId);
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
         WHERE id = ?`,
      )
      .run(message, now, jobId);
    this.updateJob(jobId);
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
         WHERE id = ?`,
      )
      .run(now, args.runId, args.rowsAppended, args.filename, args.fileLocation, args.jobId);
    this.updateJob(args.jobId);
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

  private async processJob(initialJob: Job, model: string): Promise<void> {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
    if (!apiKey) {
      this.setError(initialJob.id, 'GOOGLE_GENERATIVE_AI_API_KEY is not set');
      await this.tick();
      return;
    }

    let job = initialJob;

    try {
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
        this.setError(job.id, `File not found in new/completed: ${job.filename}`);
        await this.tick();
        return;
      }

      this.db.prepare('UPDATE jobs SET file_location = ? WHERE id = ?').run(fileLocation, job.id);
      job = this.updateJob(job.id);

      const entryDate = job.entry_date ?? parseEntryDate(job.filename);
      if (!entryDate) {
        this.setError(job.id, 'Date not found in filename (expected YYYY-MM-DD)');
        await this.tick();
        return;
      }
      if (job.entry_date !== entryDate) {
        this.db.prepare('UPDATE jobs SET entry_date = ? WHERE id = ?').run(entryDate, job.id);
        job = this.updateJob(job.id);
      }

      const mimeType = mime.lookup(job.filename) || '';
      if (!mimeType.startsWith('image/')) {
        this.setError(job.id, `Unsupported file type: ${mimeType || 'unknown'}`);
        await this.tick();
        return;
      }

      this.setProgress(job.id, 'extracting');
      const image = await fsp.readFile(filePath);
      const extraction = await extractChartRows({ image, mimeType, model });
      const extractedRows = extraction.result.rows;

      if (extractedRows.length === 0) {
        this.setError(job.id, 'No rows extracted');
        await this.tick();
        return;
      }

      this.setProgress(job.id, 'writing_db');
      const runId = nanoid();
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
            `INSERT INTO runs (run_id, job_id, model, extracted_at, rows_inserted, raw_result_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(runId, job.id, model, extractedAt, extractedRows.length, extraction.rawResultJson);

        for (const row of extractedRows) {
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

      let finalFilename = job.filename;
      let finalLocation: FileLocation = fileLocation;

      if (fileLocation === 'new') {
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

      this.setProgress(job.id, 'exporting_csv');
      this.setCompleted({
        jobId: job.id,
        runId,
        rowsAppended: extractedRows.length,
        filename: finalFilename,
        fileLocation: finalLocation,
      });
      await this.enqueueCsvExport();
    } catch (error) {
      this.setError(job.id, (error as Error).message);
    } finally {
      await this.tick();
    }
  }
}

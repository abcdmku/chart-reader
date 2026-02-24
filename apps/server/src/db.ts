import { createRequire } from 'node:module';
import path from 'node:path';
import type { Config, Job } from './types.js';

export type Statement = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
};

export type Db = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
};

const require = createRequire(import.meta.url);

function normalizeGeminiModelId(model: string): string {
  // Back-compat: older UI/server versions used `gemini-3-flash`, but the provider expects `gemini-3-flash-preview`.
  if (model === 'gemini-3-flash') return 'gemini-3-flash-preview';
  return model;
}

function getDatabaseSyncCtor(): new (path: string) => Db {
  const modName = 'node:sqlite';
  // Avoid static analysis issues in some bundlers by not using an import statement.
  return (require(modName) as { DatabaseSync: new (path: string) => Db }).DatabaseSync;
}

export function openDb(dbPath: string): Db {
  const DatabaseSync = getDatabaseSyncCtor();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      concurrency INTEGER NOT NULL,
      paused INTEGER NOT NULL,
      model TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      canonical_filename TEXT NOT NULL,
      entry_date TEXT NULL,
      status TEXT NOT NULL,
      progress_step TEXT NULL,
      error TEXT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT NULL,
      finished_at TEXT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_id TEXT NULL,
      rows_appended_last_run INTEGER NULL,
      file_location TEXT NOT NULL,
      version_count INTEGER NOT NULL DEFAULT 1,
      pending_filename TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      model TEXT NOT NULL,
      extracted_at TEXT NOT NULL,
      rows_inserted INTEGER NOT NULL,
      raw_result_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chart_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      chart_title TEXT NOT NULL,
      chart_section TEXT NOT NULL,
      this_week_rank INTEGER NULL,
      last_week_rank INTEGER NULL,
      two_weeks_ago_rank INTEGER NULL,
      weeks_on_chart INTEGER NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      label TEXT NOT NULL,
      source_file TEXT NOT NULL,
      extracted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_chart_rows_job_id ON chart_rows(job_id);
    CREATE INDEX IF NOT EXISTS idx_chart_rows_run_id ON chart_rows(run_id);
  `);

  const defaultModel = normalizeGeminiModelId(process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash');
  db.prepare(
    `INSERT INTO config (id, concurrency, paused, model)
     VALUES (1, 2, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(defaultModel);

  migrateJobsTable(db);
  migrateRunsTable(db);
}

type TableInfoRow = { name: string };

function getTableColumnNames(db: Db, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
  return new Set(rows.map((r) => r.name));
}

function removeTrailingNumberSuffix(filename: string): string | null {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  const match = base.match(/^(.*)_([0-9]+)$/);
  if (!match) return null;
  return `${match[1]}${ext}`;
}

function migrateJobsTable(db: Db): void {
  const columns = getTableColumnNames(db, 'jobs');

  if (!columns.has('canonical_filename')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN canonical_filename TEXT NOT NULL DEFAULT '';`);
  }
  if (!columns.has('version_count')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN version_count INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!columns.has('pending_filename')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN pending_filename TEXT NULL;`);
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_canonical_filename ON jobs(canonical_filename);');

  backfillCanonicalFilenames(db);
  mergeDuplicateJobs(db);
}

function migrateRunsTable(db: Db): void {
  const columns = getTableColumnNames(db, 'runs');

  if (!columns.has('status')) {
    db.exec(`ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';`);
  }
  if (!columns.has('error')) {
    db.exec(`ALTER TABLE runs ADD COLUMN error TEXT NULL;`);
  }
}

function backfillCanonicalFilenames(db: Db): void {
  type JobRow = { id: string; filename: string; created_at: string; canonical_filename: string | null };
  const jobs = db
    .prepare('SELECT id, filename, created_at, canonical_filename FROM jobs ORDER BY created_at ASC')
    .all() as JobRow[];

  const canonicalByFilename = new Map<string, string>();

  const update = db.prepare('UPDATE jobs SET canonical_filename = ? WHERE id = ?');

  for (const job of jobs) {
    const current = (job.canonical_filename ?? '').trim();
    if (current) {
      canonicalByFilename.set(job.filename, current);
      continue;
    }

    const baseCandidate = removeTrailingNumberSuffix(job.filename);
    const inferred = baseCandidate && canonicalByFilename.has(baseCandidate) ? canonicalByFilename.get(baseCandidate)! : job.filename;
    update.run(inferred, job.id);
    canonicalByFilename.set(job.filename, inferred);
  }
}

function mergeDuplicateJobs(db: Db): void {
  type GroupRow = { canonical_filename: string; cnt: number };
  const groups = db
    .prepare(
      `SELECT canonical_filename, COUNT(*) AS cnt
       FROM jobs
       WHERE canonical_filename <> ''
       GROUP BY canonical_filename
       HAVING cnt > 1`,
    )
    .all() as GroupRow[];

  if (groups.length === 0) return;

  withTransaction(db, () => {
    const selectJobs = db.prepare(
      `SELECT
         j.*,
         r.extracted_at AS last_extracted_at
       FROM jobs AS j
       LEFT JOIN runs AS r
         ON r.run_id = j.last_run_id
       WHERE j.canonical_filename = ?
       ORDER BY j.created_at ASC`,
    );

    const updateRunsJob = db.prepare('UPDATE runs SET job_id = ? WHERE job_id = ?');
    const updateChartRowsJob = db.prepare('UPDATE chart_rows SET job_id = ? WHERE job_id = ?');
    const deleteJob = db.prepare('DELETE FROM jobs WHERE id = ?');

    const selectLatestRun = db.prepare(
      `SELECT run_id, extracted_at, rows_inserted
       FROM runs
       WHERE job_id = ?
       ORDER BY extracted_at DESC
       LIMIT 1`,
    );
    const selectRunCount = db.prepare('SELECT COUNT(*) AS cnt FROM runs WHERE job_id = ?');
    const selectSourceFileForRun = db.prepare('SELECT source_file FROM chart_rows WHERE run_id = ? LIMIT 1');

    for (const group of groups) {
      const rows = selectJobs.all(group.canonical_filename) as Array<
        Job & { canonical_filename: string; version_count: number; pending_filename: string | null; last_extracted_at: string | null }
      >;
      if (rows.length < 2) continue;

      const primary = rows[0];

      const latestJob = rows
        .slice()
        .sort((a, b) => {
          const aMissing = a.last_extracted_at == null ? 1 : 0;
          const bMissing = b.last_extracted_at == null ? 1 : 0;
          if (aMissing !== bMissing) return aMissing - bMissing;
          if (a.last_extracted_at !== b.last_extracted_at) return (b.last_extracted_at ?? '').localeCompare(a.last_extracted_at ?? '');
          return b.created_at.localeCompare(a.created_at);
        })[0];

      let pendingFilename: string | null = null;
      for (const row of rows) {
        if (row.pending_filename && !pendingFilename) pendingFilename = row.pending_filename;
      }

      for (const row of rows.slice(1)) {
        updateRunsJob.run(primary.id, row.id);
        updateChartRowsJob.run(primary.id, row.id);
        deleteJob.run(row.id);
      }

      const lastRun = selectLatestRun.get(primary.id) as
        | { run_id: string; extracted_at: string; rows_inserted: number }
        | undefined;
      const runCount = (selectRunCount.get(primary.id) as { cnt: number } | undefined)?.cnt ?? 0;
      const sourceFile = lastRun ? ((selectSourceFileForRun.get(lastRun.run_id) as { source_file: string } | undefined)?.source_file ?? null) : null;

      db.prepare(
        `UPDATE jobs
         SET filename = ?,
             canonical_filename = ?,
             entry_date = ?,
             status = ?,
             progress_step = ?,
             error = ?,
             created_at = ?,
             started_at = ?,
             finished_at = ?,
             run_count = ?,
             last_run_id = ?,
             rows_appended_last_run = ?,
             file_location = ?,
             version_count = ?,
             pending_filename = ?
         WHERE id = ?`,
      ).run(
        sourceFile ?? latestJob.filename,
        latestJob.canonical_filename,
        latestJob.entry_date,
        latestJob.status,
        latestJob.progress_step,
        latestJob.error,
        primary.created_at,
        latestJob.started_at,
        latestJob.finished_at,
        runCount,
        lastRun?.run_id ?? null,
        lastRun?.rows_inserted ?? null,
        latestJob.file_location,
        rows.length,
        pendingFilename,
        primary.id,
      );
    }
  });
}

export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

export function getConfig(db: Db): Config {
  const row = db.prepare('SELECT concurrency, paused, model FROM config WHERE id = 1').get() as
    | { concurrency: number; paused: number; model: string }
    | undefined;
  if (!row) return { concurrency: 2, paused: false, model: 'gemini-2.5-flash' };

  const normalizedModel = normalizeGeminiModelId(row.model);
  if (normalizedModel !== row.model) {
    db.prepare('UPDATE config SET model = ? WHERE id = 1').run(normalizedModel);
  }

  return { concurrency: row.concurrency, paused: row.paused === 1, model: normalizedModel };
}

export function updateConfig(db: Db, next: Partial<Config>): Config {
  const current = getConfig(db);
  const merged: Config = {
    concurrency: next.concurrency ?? current.concurrency,
    paused: next.paused ?? current.paused,
    model: normalizeGeminiModelId(next.model ?? current.model),
  };

  db.prepare('UPDATE config SET concurrency = ?, paused = ?, model = ? WHERE id = 1').run(
    merged.concurrency,
    merged.paused ? 1 : 0,
    merged.model,
  );

  return merged;
}

export function listJobs(db: Db): Job[] {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as Job[];
}

export function getJob(db: Db, jobId: string): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  return row ?? null;
}

import { createRequire } from 'node:module';
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
      file_location TEXT NOT NULL
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

  const defaultModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  db.prepare(
    `INSERT INTO config (id, concurrency, paused, model)
     VALUES (1, 2, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(defaultModel);
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
  return { concurrency: row.concurrency, paused: row.paused === 1, model: row.model };
}

export function updateConfig(db: Db, next: Partial<Config>): Config {
  const current = getConfig(db);
  const merged: Config = {
    concurrency: next.concurrency ?? current.concurrency,
    paused: next.paused ?? current.paused,
    model: next.model ?? current.model,
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

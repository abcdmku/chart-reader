import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { exportCsv } from './csv.js';
import { getConfig, listJobs, openDb, updateConfig } from './db.js';
import {
  isSupportedImageFile,
  isSupportedSourceFile,
  isSupportedUploadMimeType,
  listSupportedSourceFiles,
  makeUniqueFilename,
  sanitizeFilename,
} from './files.js';
import { ensureDirectories, getPaths } from './paths.js';
import { SseHub } from './sse.js';
import type { Config, Job } from './types.js';
import { parseEntryDate } from './utils/parseEntryDate.js';
import { Worker } from './worker.js';

function normalizeGeminiModelId(model: string): string {
  if (model === 'gemini-3-flash') return 'gemini-3-flash-preview';
  return model;
}

const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2-flash', 'gemini-3-flash-preview']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalEnvFiles(): void {
  if (typeof process.loadEnvFile !== 'function') return;

  // Support both repo-root `.env` and `apps/server/.env` in tsx and built dist runs.
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'apps/server/.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ];

  const seen = new Set<string>();
  for (const envPath of candidates) {
    if (seen.has(envPath)) continue;
    seen.add(envPath);
    if (!fs.existsSync(envPath)) continue;
    process.loadEnvFile(envPath);
  }
}

loadLocalEnvFiles();

const paths = getPaths();
ensureDirectories(paths);

const db = openDb(paths.dbPath);
db.prepare("UPDATE jobs SET status = 'queued', progress_step = NULL WHERE status = 'processing'").run();

const sse = new SseHub();
const worker = new Worker(db, { newDir: paths.newDir, completedDir: paths.completedDir, outputCsvPath: paths.outputCsvPath }, sse);

function getAvgDurationMs(): number | null {
  const row = db
    .prepare(
      `SELECT AVG(
        (julianday(finished_at) - julianday(started_at)) * 86400000
      ) AS avg_ms
      FROM jobs
      WHERE status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    )
    .get() as { avg_ms: number | null } | undefined;
  return row?.avg_ms ?? null;
}

function buildState(): { config: Config; jobs: Job[]; avg_duration_ms: number | null } {
  return {
    config: getConfig(db),
    jobs: listJobs(db),
    avg_duration_ms: getAvgDurationMs(),
  };
}

function isFilenameTaken(name: string): boolean {
  if (fs.existsSync(path.join(paths.newDir, name))) return true;
  if (fs.existsSync(path.join(paths.completedDir, name))) return true;
  const exists = db.prepare('SELECT 1 FROM jobs WHERE filename = ?').get(name) as { 1: 1 } | undefined;
  return exists != null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.newDir),
    filename: (_req, file, cb) => {
      const desired = file.originalname;
      const unique = makeUniqueFilename(desired, isFilenameTaken);
      cb(null, unique);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const extOk = isSupportedSourceFile(file.originalname);
    const mimeOk = isSupportedUploadMimeType(file.mimetype);
    cb(null, extOk && mimeOk);
  },
  limits: { files: 200 },
});

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/state', (_req, res) => {
  res.json(buildState());
});

app.post('/api/config', (req, res) => {
  const body = (req.body ?? {}) as Partial<Config>;
  const next: Partial<Config> = {};

  if (body.concurrency != null) {
    const value = Number(body.concurrency);
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      res.status(400).json({ error: 'concurrency must be between 1 and 10' });
      return;
    }
    next.concurrency = Math.floor(value);
  }

  if (body.paused != null) next.paused = Boolean(body.paused);
  if (body.model != null) {
    const model = normalizeGeminiModelId(String(body.model));
    if (!ALLOWED_MODELS.has(model)) {
      res
        .status(400)
        .json({ error: 'model must be one of gemini-2.5-flash, gemini-2.5-pro, gemini-2-flash, gemini-3-flash-preview' });
      return;
    }
    next.model = model;
  }

  const updated = updateConfig(db, next);
  sse.send('config', updated);

  void worker.tick();
  res.json(buildState());
});

app.post('/api/scan', async (_req, res) => {
  const filenames = await listSupportedSourceFiles(paths.newDir);
  const pending = new Set(
    (db.prepare('SELECT pending_filename FROM jobs WHERE pending_filename IS NOT NULL').all() as Array<{
      pending_filename: string;
    }>).map((r) => r.pending_filename),
  );
  const scanFilenames = filenames.filter((name) => !pending.has(name));
  const createdJobs: Job[] = [];

  const insert = db.prepare(
    `INSERT INTO jobs (
      id,
      filename,
      canonical_filename,
      entry_date,
      status,
      progress_step,
      error,
      created_at,
      started_at,
      finished_at,
      run_count,
      last_run_id,
      rows_appended_last_run,
      file_location,
      version_count,
      pending_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, 'new', 1, NULL)
    ON CONFLICT(filename) DO NOTHING`,
  );

  for (const filename of scanFilenames) {
    const id = nanoid();
    const now = new Date().toISOString();
    const entryDate = parseEntryDate(filename);

    const status = entryDate ? 'queued' : 'error';
    const progressStep = entryDate ? null : 'error';
    const error = entryDate ? null : 'Date not found in filename (expected YYYY-MM-DD)';
    const finishedAt = entryDate ? null : now;

    const result = insert.run(id, filename, filename, entryDate, status, progressStep, error, now, finishedAt);
    if (result.changes > 0) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job;
      createdJobs.push(job);
      sse.send('job', job);
    }
  }

  if (createdJobs.some((j) => j.status === 'queued')) void worker.tick();

  res.json({ created: createdJobs.length });
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const files = (req.files ?? []) as Express.Multer.File[];
  const createdJobs: Job[] = [];

  const insert = db.prepare(
    `INSERT INTO jobs (
      id,
      filename,
      canonical_filename,
      entry_date,
      status,
      progress_step,
      error,
      created_at,
      started_at,
      finished_at,
      run_count,
      last_run_id,
      rows_appended_last_run,
      file_location,
      version_count,
      pending_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, 'new', 1, NULL)
    ON CONFLICT(filename) DO NOTHING`,
  );

  for (const file of files) {
    const id = nanoid();
    const now = new Date().toISOString();
    const canonicalFilename = sanitizeFilename(file.originalname);
    const entryDate = parseEntryDate(canonicalFilename) ?? parseEntryDate(file.filename);

    const existing = db
      .prepare('SELECT * FROM jobs WHERE canonical_filename = ? ORDER BY created_at ASC LIMIT 1')
      .get(canonicalFilename) as Job | undefined;

    const status = entryDate ? 'queued' : 'error';
    const progressStep = entryDate ? null : 'error';
    const error = entryDate ? null : 'Date not found in filename (expected YYYY-MM-DD)';
    const finishedAt = entryDate ? null : now;

    if (existing) {
      const srcPath = path.join(paths.newDir, file.filename);

      if (existing.status === 'processing') {
        const isTakenInCompleted = (name: string) => fs.existsSync(path.join(paths.completedDir, name));
        let pendingName = makeUniqueFilename(file.filename, isTakenInCompleted);
        const destPath = path.join(paths.completedDir, pendingName);
        try {
          await fsp.rename(srcPath, destPath);
        } catch (e) {
          // Best-effort move; if it fails, keep in newDir (scan may create a job, but we still record pending filename).
          // eslint-disable-next-line no-console
          console.warn('Failed to move pending duplicate upload:', (e as Error).message);
          pendingName = file.filename;
        }

        db.prepare('UPDATE jobs SET version_count = version_count + 1, pending_filename = ? WHERE id = ?').run(
          pendingName,
          existing.id,
        );
        const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(existing.id) as Job;
        sse.send('job', updated);
        continue;
      }

      const priorFilename = existing.filename;
      db.prepare(
        `UPDATE jobs
         SET status = ?,
             progress_step = ?,
             error = ?,
             started_at = NULL,
             finished_at = ?,
             filename = ?,
             canonical_filename = ?,
             entry_date = ?,
             file_location = 'new',
             version_count = version_count + 1,
             pending_filename = NULL
         WHERE id = ?`,
      ).run(status, progressStep, error, finishedAt, file.filename, canonicalFilename, entryDate, existing.id);

      const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(existing.id) as Job;
      sse.send('job', updated);

      // Best-effort cleanup: if we replaced a queued file, remove the old unreferenced upload from newDir.
      if (priorFilename !== updated.filename) {
        await fsp.rm(path.join(paths.newDir, priorFilename), { force: true }).catch(() => {});
      }
      continue;
    }

    const result = insert.run(id, file.filename, canonicalFilename, entryDate, status, progressStep, error, now, finishedAt);
    if (result.changes > 0) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job;
      createdJobs.push(job);
      sse.send('job', job);
    }
  }

  void worker.tick();
  res.json({ jobs: createdJobs });
});

app.post('/api/jobs/:id/rerun', (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.status === 'processing') {
    res.status(409).json({ error: 'job is processing' });
    return;
  }
  if (job.status === 'deleted') {
    res.status(400).json({ error: 'job is deleted' });
    return;
  }

  db.prepare(
    `UPDATE jobs
     SET status = 'queued',
         progress_step = NULL,
         error = NULL,
         started_at = NULL,
         finished_at = NULL
     WHERE id = ?`,
  ).run(jobId);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job;
  sse.send('job', updated);

  void worker.tick();
  res.json({ ok: true });
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.status !== 'processing') {
    res.status(409).json({ error: 'job is not processing' });
    return;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'cancelled',
           progress_step = NULL,
           error = 'Cancelled',
           finished_at = ?
       WHERE id = ? AND status = 'processing'`,
    )
    .run(now, jobId);

  if (result.changes === 0) {
    res.status(409).json({ error: 'job is not processing' });
    return;
  }

  worker.requestCancel(jobId, 'Cancelled');

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job;
  sse.send('job', updated);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/active-run', (req, res) => {
  const jobId = req.params.id;
  const body = (req.body ?? {}) as { run_id?: unknown };
  const runId = typeof body.run_id === 'string' ? body.run_id : null;

  if (!runId) {
    res.status(400).json({ error: 'run_id is required' });
    return;
  }

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }

  const run = db.prepare('SELECT rows_inserted FROM runs WHERE run_id = ? AND job_id = ?').get(runId, jobId) as
    | { rows_inserted: number }
    | undefined;
  if (!run) {
    res.status(404).json({ error: 'run not found for this job' });
    return;
  }
  if ((run.rows_inserted ?? 0) <= 0) {
    res.status(400).json({ error: 'run has no extracted rows' });
    return;
  }

  db.prepare('UPDATE jobs SET last_run_id = ? WHERE id = ?').run(runId, jobId);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job;
  sse.send('job', updated);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/run', (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }

  type RunRow = {
    run_id: string;
    job_id: string;
    model: string;
    extracted_at: string;
    rows_inserted: number;
    raw_result_json: string;
    status: string;
    error: string | null;
  };

  const runs = db
    .prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY extracted_at DESC LIMIT ?')
    .all(jobId, 10) as RunRow[];

  let run: RunRow | undefined;
  if (job.last_run_id) {
    run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(job.last_run_id) as RunRow | undefined;
  }
  if (!run) {
    run = db
      .prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY extracted_at DESC LIMIT 1')
      .get(jobId) as RunRow | undefined;
  }

  res.json({ job, run: run ?? null, runs });
});

app.delete('/api/jobs/:id', async (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job | undefined;
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.status === 'processing') {
    res.status(409).json({ error: 'job is processing' });
    return;
  }

  const pathNew = path.join(paths.newDir, job.filename);
  const pathCompleted = path.join(paths.completedDir, job.filename);
  await Promise.all([
    fsp.rm(pathNew, { force: true }).catch(() => {}),
    fsp.rm(pathCompleted, { force: true }).catch(() => {}),
  ]);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs
     SET status = 'deleted',
         progress_step = NULL,
         error = NULL,
         finished_at = ?,
         file_location = 'missing'
     WHERE id = ?`,
  ).run(now, jobId);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job;
  sse.send('job', updated);
  res.json({ ok: true });
});

app.get('/api/rows', (req, res) => {
  const limit = Math.min(5_000, Math.max(1, Number(req.query.limit ?? 500)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const order = String(req.query.order ?? 'desc') === 'asc' ? 'asc' : 'desc';

  const latestOnlyRaw = String(req.query.latest_only ?? req.query.latestOnly ?? '').trim().toLowerCase();
  const latestOnly = latestOnlyRaw === '1' || latestOnlyRaw === 'true' || latestOnlyRaw === 'yes' || latestOnlyRaw === 'on';

  if (!latestOnly) {
    const total = (db.prepare('SELECT COUNT(*) AS count FROM chart_rows').get() as { count: number }).count;
    const rows = db
      .prepare(`SELECT * FROM chart_rows ORDER BY id ${order.toUpperCase()} LIMIT ? OFFSET ?`)
      .all(limit, offset);

    res.json({ rows, total });
    return;
  }

  const latestRunsCte = `
    WITH latest_runs AS (
      SELECT
        j.id AS job_id,
        COALESCE(
          j.last_run_id,
          (
            SELECT r.run_id
            FROM runs r
            WHERE r.job_id = j.id
            ORDER BY r.extracted_at DESC
            LIMIT 1
          )
        ) AS run_id
      FROM jobs j
    )
  `;

  const total = (
    db.prepare(
      `${latestRunsCte}
       SELECT COUNT(*) AS count
       FROM chart_rows cr
       JOIN latest_runs lr
         ON lr.job_id = cr.job_id
        AND lr.run_id = cr.run_id`,
    ).get() as { count: number }
  ).count;

  const rows = db
    .prepare(
      `${latestRunsCte}
       SELECT cr.*
       FROM chart_rows cr
       JOIN latest_runs lr
         ON lr.job_id = cr.job_id
        AND lr.run_id = cr.run_id
       ORDER BY cr.id ${order.toUpperCase()}
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);

  res.json({ rows, total });
});

app.get('/api/csv', async (_req, res) => {
  await exportCsv(db, paths.outputCsvPath);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="output.csv"');
  fs.createReadStream(paths.outputCsvPath).pipe(res);
});

function sendStoredFile(req: express.Request, res: express.Response, options?: { imagesOnly?: boolean }): void {
  const filename = req.params.filename;
  const sanitized = path.basename(filename);
  if (sanitized !== filename || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }
  const isSupported = options?.imagesOnly ? isSupportedImageFile(sanitized) : isSupportedSourceFile(sanitized);
  if (!isSupported) {
    res.status(400).json({ error: 'Unsupported file type' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (!options?.imagesOnly) {
    res.setHeader('Content-Disposition', 'inline');
  }

  const completedPath = path.join(paths.completedDir, sanitized);
  if (fs.existsSync(completedPath)) {
    res.sendFile(completedPath);
    return;
  }
  const newPath = path.join(paths.newDir, sanitized);
  if (fs.existsSync(newPath)) {
    res.sendFile(newPath);
    return;
  }
  res.status(404).json({ error: 'File not found' });
}

app.get('/api/files/:filename', (req, res) => {
  sendStoredFile(req, res);
});

app.get('/api/images/:filename', (req, res) => {
  sendStoredFile(req, res, { imagesOnly: true });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = sse.addClient(res);
  sse.sendToClient(clientId, 'state', buildState());

  req.on('close', () => {
    sse.removeClient(clientId);
  });
});

const publicDir = path.resolve(__dirname, '../public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir));
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res
      .status(200)
      .type('text/plain')
      .send('Frontend not built. Run `npm --workspace apps/web run build` then start the server again.');
    return;
  }
  res.sendFile(indexPath);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Chart Reader listening on http://localhost:${port}`);
});

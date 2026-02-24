import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { exportCsv } from './csv.js';
import { getConfig, listJobs, openDb, updateConfig } from './db.js';
import { isSupportedImageFile, listSupportedImages, makeUniqueFilename } from './files.js';
import { ensureDirectories, getPaths } from './paths.js';
import { SseHub } from './sse.js';
import type { Config, Job } from './types.js';
import { parseEntryDate } from './utils/parseEntryDate.js';
import { Worker } from './worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const paths = getPaths();
ensureDirectories(paths);

const db = openDb(paths.dbPath);
db.prepare("UPDATE jobs SET status = 'queued', progress_step = NULL WHERE status = 'processing'").run();

const sse = new SseHub();
const worker = new Worker(db, { newDir: paths.newDir, completedDir: paths.completedDir, outputCsvPath: paths.outputCsvPath }, sse);

function buildState(): { config: Config; jobs: Job[] } {
  return {
    config: getConfig(db),
    jobs: listJobs(db),
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
    const extOk = isSupportedImageFile(file.originalname);
    const mimeOk = file.mimetype.startsWith('image/');
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
  if (body.model != null) next.model = String(body.model);

  const updated = updateConfig(db, next);
  sse.send('config', updated);

  void worker.tick();
  res.json(buildState());
});

app.post('/api/scan', async (_req, res) => {
  const filenames = await listSupportedImages(paths.newDir);
  const createdJobs: Job[] = [];

  const insert = db.prepare(
    `INSERT INTO jobs (
      id,
      filename,
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
      file_location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, 'new')
    ON CONFLICT(filename) DO NOTHING`,
  );

  for (const filename of filenames) {
    const id = nanoid();
    const now = new Date().toISOString();
    const entryDate = parseEntryDate(filename);

    const status = entryDate ? 'queued' : 'error';
    const progressStep = entryDate ? null : 'error';
    const error = entryDate ? null : 'Date not found in filename (expected YYYY-MM-DD)';
    const finishedAt = entryDate ? null : now;

    const result = insert.run(id, filename, entryDate, status, progressStep, error, now, finishedAt);
    if (result.changes > 0) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job;
      createdJobs.push(job);
      sse.send('job', job);
    }
  }

  if (createdJobs.some((j) => j.status === 'queued')) void worker.tick();

  res.json({ created: createdJobs.length });
});

app.post('/api/upload', upload.array('files'), (req, res) => {
  const files = (req.files ?? []) as Express.Multer.File[];
  const createdJobs: Job[] = [];

  const insert = db.prepare(
    `INSERT INTO jobs (
      id,
      filename,
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
      file_location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, 'new')
    ON CONFLICT(filename) DO NOTHING`,
  );

  for (const file of files) {
    const id = nanoid();
    const now = new Date().toISOString();
    const entryDate = parseEntryDate(file.filename);

    const status = entryDate ? 'queued' : 'error';
    const progressStep = entryDate ? null : 'error';
    const error = entryDate ? null : 'Date not found in filename (expected YYYY-MM-DD)';
    const finishedAt = entryDate ? null : now;

    const result = insert.run(id, file.filename, entryDate, status, progressStep, error, now, finishedAt);
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

  const total = (db.prepare('SELECT COUNT(*) AS count FROM chart_rows').get() as { count: number }).count;
  const rows = db
    .prepare(`SELECT * FROM chart_rows ORDER BY id ${order.toUpperCase()} LIMIT ? OFFSET ?`)
    .all(limit, offset);

  res.json({ rows, total });
});

app.get('/api/csv', async (_req, res) => {
  const exists = fs.existsSync(paths.outputCsvPath);
  if (!exists) await exportCsv(db, paths.outputCsvPath);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="output.csv"');
  fs.createReadStream(paths.outputCsvPath).pipe(res);
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

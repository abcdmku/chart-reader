import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportCsv } from './csv';
import { openDb } from './db';

describe('exportCsv', () => {
  it('exports only rows from each job latest run', async () => {
    const db = openDb(':memory:');

    db.prepare(
      `INSERT INTO jobs (
        id, filename, entry_date, status, progress_step, error, created_at, started_at, finished_at,
        run_count, last_run_id, rows_appended_last_run, file_location
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'job-1',
      'job-1.png',
      '2026-02-01',
      'completed',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:01:00.000Z',
      '2026-02-01T00:02:00.000Z',
      2,
      'run-new',
      1,
      'completed',
    );

    db.prepare(
      `INSERT INTO jobs (
        id, filename, entry_date, status, progress_step, error, created_at, started_at, finished_at,
        run_count, last_run_id, rows_appended_last_run, file_location
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'job-2',
      'job-2.png',
      '2026-02-08',
      'completed',
      '2026-02-08T00:00:00.000Z',
      '2026-02-08T00:01:00.000Z',
      '2026-02-08T00:02:00.000Z',
      1,
      'run-2',
      1,
      'completed',
    );

    const insertRun = db.prepare(
      `INSERT INTO runs (run_id, job_id, model, extracted_at, rows_inserted, raw_result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertRun.run('run-old', 'job-1', 'gemini', '2026-02-01T00:01:30.000Z', 1, '{"rows":1}');
    insertRun.run('run-new', 'job-1', 'gemini', '2026-02-01T00:03:00.000Z', 1, '{"rows":1}');
    insertRun.run('run-2', 'job-2', 'gemini', '2026-02-08T00:03:00.000Z', 1, '{"rows":1}');

    const insertRow = db.prepare(
      `INSERT INTO chart_rows (
        run_id, job_id, entry_date, chart_title, chart_section, this_week_rank, last_week_rank,
        two_weeks_ago_rank, weeks_on_chart, title, artist, label, source_file, extracted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertRow.run(
      'run-old',
      'job-1',
      '2026-02-01',
      'Top 100',
      'Main',
      10,
      11,
      12,
      4,
      'Old Song',
      'Old Artist',
      'Old Label',
      'job-1.png',
      '2026-02-01T00:01:30.000Z',
    );
    insertRow.run(
      'run-new',
      'job-1',
      '2026-02-01',
      'Top 100',
      'Main',
      1,
      2,
      3,
      5,
      'New Song',
      'New Artist',
      'New Label',
      'job-1.png',
      '2026-02-01T00:03:00.000Z',
    );
    insertRow.run(
      'run-2',
      'job-2',
      '2026-02-08',
      'Top 100',
      'Main',
      7,
      8,
      9,
      2,
      'Other Song',
      'Other Artist',
      'Other Label',
      'job-2.png',
      '2026-02-08T00:03:00.000Z',
    );

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chart-reader-csv-test-'));
    const outputCsvPath = path.join(tempDir, 'output.csv');

    try {
      const result = await exportCsv(db, outputCsvPath);
      const csv = await fsp.readFile(outputCsvPath, 'utf8');

      expect(result.total).toBe(2);
      expect(csv).toContain('New Song');
      expect(csv).toContain('Other Song');
      expect(csv).not.toContain('Old Song');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

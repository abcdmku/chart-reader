import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import type { Db } from './db.js';

const CSV_COLUMNS = [
  'entry_date',
  'chart_title',
  'chart_section',
  'this_week_rank',
  'last_week_rank',
  'two_weeks_ago_rank',
  'weeks_on_chart',
  'title',
  'artist',
  'label',
  'source_file',
  'run_id',
  'extracted_at',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];
type CsvRow = Record<CsvColumn, string | number | null>;

function escapeCsv(value: string | number | null): string {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function safeReplaceFile(tmpPath: string, finalPath: string): Promise<void> {
  try {
    await fs.promises.rename(tmpPath, finalPath);
  } catch (error) {
    const asErr = error as NodeJS.ErrnoException;
    if (asErr.code === 'EEXIST' || asErr.code === 'EPERM') {
      await fs.promises.rm(finalPath, { force: true });
      await fs.promises.rename(tmpPath, finalPath);
      return;
    }
    throw error;
  }
}

export async function exportCsv(db: Db, outputCsvPath: string): Promise<{ updatedAt: string; total: number }> {
  await fs.promises.mkdir(path.dirname(outputCsvPath), { recursive: true });

  const updatedAt = new Date().toISOString();
  const tmpPath = `${outputCsvPath}.tmp`;

  const rows = db
    .prepare(
      `SELECT
        cr.entry_date,
        cr.chart_title,
        cr.chart_section,
        cr.this_week_rank,
        cr.last_week_rank,
        cr.two_weeks_ago_rank,
        cr.weeks_on_chart,
        cr.title,
        cr.artist,
        cr.label,
        cr.source_file,
        cr.run_id,
        cr.extracted_at
      FROM chart_rows AS cr
      INNER JOIN jobs AS j
        ON j.id = cr.job_id
       AND j.last_run_id = cr.run_id
      ORDER BY cr.id ASC`,
    )
    .all() as CsvRow[];

  const out = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
  out.write(CSV_COLUMNS.join(',') + '\n');

  for (const row of rows) {
    const line = CSV_COLUMNS.map((col) => escapeCsv(row[col])).join(',') + '\n';
    if (!out.write(line)) await once(out, 'drain');
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });

  await safeReplaceFile(tmpPath, outputCsvPath);
  return { updatedAt, total: rows.length };
}

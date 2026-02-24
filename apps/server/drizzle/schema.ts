import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const config = sqliteTable('config', {
  id: integer('id').primaryKey(),
  concurrency: integer('concurrency').notNull(),
  paused: integer('paused').notNull(),
  model: text('model').notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    filename: text('filename').notNull(),
    entryDate: text('entry_date'),
    status: text('status').notNull(),
    progressStep: text('progress_step'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    runCount: integer('run_count').notNull().default(0),
    lastRunId: text('last_run_id'),
    rowsAppendedLastRun: integer('rows_appended_last_run'),
    fileLocation: text('file_location').notNull(),
  },
  (table) => ({
    idxJobsStatusCreated: index('idx_jobs_status_created').on(table.status, table.createdAt),
  }),
);

export const runs = sqliteTable('runs', {
  runId: text('run_id').primaryKey(),
  jobId: text('job_id').notNull(),
  model: text('model').notNull(),
  extractedAt: text('extracted_at').notNull(),
  rowsInserted: integer('rows_inserted').notNull(),
  rawResultJson: text('raw_result_json').notNull(),
});

export const chartRows = sqliteTable(
  'chart_rows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    jobId: text('job_id').notNull(),
    entryDate: text('entry_date').notNull(),
    chartTitle: text('chart_title').notNull(),
    chartSection: text('chart_section').notNull(),
    thisWeekRank: integer('this_week_rank'),
    lastWeekRank: integer('last_week_rank'),
    twoWeeksAgoRank: integer('two_weeks_ago_rank'),
    weeksOnChart: integer('weeks_on_chart'),
    title: text('title').notNull(),
    artist: text('artist').notNull(),
    label: text('label').notNull(),
    sourceFile: text('source_file').notNull(),
    extractedAt: text('extracted_at').notNull(),
  },
  (table) => ({
    idxChartRowsJobId: index('idx_chart_rows_job_id').on(table.jobId),
    idxChartRowsRunId: index('idx_chart_rows_run_id').on(table.runId),
  }),
);

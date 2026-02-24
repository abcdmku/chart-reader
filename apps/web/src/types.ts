export type Config = {
  concurrency: number;
  paused: boolean;
  model: string;
};

export type JobStatus = 'queued' | 'processing' | 'completed' | 'error' | 'deleted';
export type FileLocation = 'new' | 'completed' | 'missing';

export type Job = {
  id: string;
  filename: string;
  entry_date: string | null;
  status: JobStatus;
  progress_step: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  run_count: number;
  last_run_id: string | null;
  rows_appended_last_run: number | null;
  file_location: FileLocation;
};

export type Run = {
  run_id: string;
  job_id: string;
  model: string;
  extracted_at: string;
  rows_inserted: number;
  raw_result_json: string;
};

export type StateResponse = {
  config: Config;
  jobs: Job[];
  avg_duration_ms: number | null;
};

export type JobRunDetailsResponse = {
  job: Job;
  run: Run | null;
};

export type ChartRow = {
  id: number;
  run_id: string;
  job_id: string;
  entry_date: string;
  chart_title: string;
  chart_section: string;
  this_week_rank: number | null;
  last_week_rank: number | null;
  two_weeks_ago_rank: number | null;
  weeks_on_chart: number | null;
  title: string;
  artist: string;
  label: string;
  source_file: string;
  extracted_at: string;
};

export type RowsResponse = {
  rows: ChartRow[];
  total: number;
};


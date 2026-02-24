export type Config = {
  concurrency: number;
  paused: boolean;
  model: string;
};

export type JobStatus = 'queued' | 'processing' | 'completed' | 'error' | 'cancelled' | 'deleted';
export type FileLocation = 'new' | 'completed' | 'missing';

export type Job = {
  id: string;
  filename: string;
  canonical_filename: string;
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
  version_count: number;
  pending_filename: string | null;
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

export type ExtractedRow = {
  chartTitle: string;
  chartSection: string;
  thisWeekRank: string | null;
  lastWeekRank: string | null;
  twoWeeksAgoRank: string | null;
  weeksOnChart: string | null;
  title: string;
  artist: string;
  label: string;
};

export type ExtractionResult = {
  rows: ExtractedRow[];
};


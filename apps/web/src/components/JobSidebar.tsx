import React, { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../useAppState';
import type { Job, JobStatus } from '../types';

function statusDotClass(status: JobStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500';
    case 'processing':
      return 'bg-blue-500 animate-pulse';
    case 'error':
      return 'bg-red-500';
    case 'cancelled':
      return 'bg-amber-500';
    default:
      return 'bg-zinc-600';
  }
}

function chartLabel(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[_-]/, '')
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ');
}

const STEP_LABELS: Record<string, string> = {
  starting: 'Starting',
  validating_file: 'Validating',
  extracting: 'Extracting',
  validating_extraction: 'Checking rows',
  extracting_missing_ranks: 'Re-extracting missing rows',
  extracting_missing_ranks_gemini3: 'Re-extracting missing rows (Gemini 3 Flash)',
  writing_db: 'Writing DB',
  moving_file: 'Moving file',
  exporting_csv: 'Exporting',
};

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'finishing…';
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `~${secs}s left`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `~${mins}m ${rem}s left` : `~${mins}m left`;
}

function estimateAvgDurationMsFromJobs(jobs: Job[]): number | null {
  let totalMs = 0;
  let count = 0;

  for (const job of jobs) {
    if (job.status !== 'completed' || job.started_at == null || job.finished_at == null) continue;

    const startedAtMs = new Date(job.started_at).getTime();
    const finishedAtMs = new Date(job.finished_at).getTime();
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)) continue;

    const durationMs = finishedAtMs - startedAtMs;
    if (durationMs <= 0) continue;

    totalMs += durationMs;
    count += 1;
  }

  return count > 0 ? totalMs / count : null;
}

function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

function JobProgressBar({ job, avgDurationMs }: { job: Job; avgDurationMs: number | null }) {
  const isProcessing = job.status === 'processing';
  const now = useNow(1000, isProcessing);

  if (!isProcessing) return null;

  const startedAtMs = job.started_at ? new Date(job.started_at).getTime() : Number.NaN;
  const elapsed = Number.isFinite(startedAtMs) ? now - startedAtMs : null;
  const avg = avgDurationMs && avgDurationMs > 0 ? avgDurationMs : null;

  // Clamp progress between 2% and 95% — never show 100% before actually done
  const rawPct = avg != null && elapsed != null ? (elapsed / avg) * 100 : null;
  const pct = rawPct != null ? Math.min(95, Math.max(2, rawPct)) : null;

  const timeLeft = avg != null && elapsed != null ? avg - elapsed : null;
  const stepLabel = STEP_LABELS[job.progress_step ?? ''] ?? job.progress_step ?? 'Processing';

  return (
    <div className="mt-1.5">
      <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
        {pct != null ? (
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-full animate-pulse rounded-full bg-blue-500/30" />
        )}
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[10px] text-zinc-500">
        <span>{stepLabel}</span>
        {timeLeft != null ? <span>{formatTimeLeft(timeLeft)}</span> : null}
      </div>
    </div>
  );
}

type JobSidebarProps = {
  state: AppState;
  selectedJobIds: string[];
  onSelectJob: (
    id: string,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void;
  onClearSelection: () => void;
  onOpenRunDetails: (jobId: string) => void;
  onImageClick: (filename: string) => void;
};

export function JobSidebar({
  state,
  selectedJobIds,
  onSelectJob,
  onClearSelection,
  onOpenRunDetails,
  onImageClick,
}: JobSidebarProps) {
  const { config, jobs, avgDurationMs, rowsState, onTogglePause, onRerun, onStop, onDelete } = state;

  const sortedJobs = useMemo(
    () => jobs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [jobs],
  );
  const liveAvgDurationMs = useMemo(() => estimateAvgDurationMsFromJobs(jobs), [jobs]);
  const effectiveAvgDurationMs = liveAvgDurationMs ?? avgDurationMs;
  const selectedJobIdSet = useMemo(() => new Set(selectedJobIds), [selectedJobIds]);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      {/* Queue controls */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300">
            Jobs
            <span className="ml-1.5 font-normal text-zinc-600">{sortedJobs.length}</span>
          </span>
          <button
            onClick={onTogglePause}
            disabled={!config}
            className={`rounded px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:opacity-40 ${
              config?.paused
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'border border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {config?.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="mt-1.5 text-xs text-zinc-600">
          {config?.paused ? 'Paused' : 'Running'} · {config?.model ?? '—'}
        </div>
      </div>

      {/* Job list */}
      <nav
        className="flex-1 select-none overflow-y-auto"
        aria-label="Jobs"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClearSelection();
        }}
      >
        {sortedJobs.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-zinc-700">
            No jobs yet. Upload files to begin.
          </div>
        ) : (
          sortedJobs.map((job) => (
            <JobItem
              key={job.id}
              job={job}
              avgDurationMs={effectiveAvgDurationMs}
              isSelected={selectedJobIdSet.has(job.id)}
              onSelect={(modifiers) => onSelectJob(job.id, modifiers)}
              onDoubleClick={() => onOpenRunDetails(job.id)}
              onImageClick={() => {
                if (job.file_location !== 'missing') onImageClick(job.filename);
              }}
              onRerun={() => void onRerun(job.id)}
              onStop={() => void onStop(job.id)}
              onDelete={() => void onDelete(job.id)}
            />
          ))
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-zinc-800 px-4 py-2.5">
        <div className="flex items-center justify-between text-xs text-zinc-600">
          <span>{rowsState?.total ?? 0} rows total</span>
          <a
            href="/api/csv"
            className="rounded px-2 py-1 text-zinc-500 hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          >
            Export CSV
          </a>
        </div>
      </div>
    </aside>
  );
}

function JobItem({
  job,
  avgDurationMs,
  isSelected,
  onSelect,
  onDoubleClick,
  onImageClick,
  onRerun,
  onStop,
  onDelete,
}: {
  job: Job;
  avgDurationMs: number | null;
  isSelected: boolean;
  onSelect: (modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  onDoubleClick: () => void;
  onImageClick: () => void;
  onRerun: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const disableRerun = job.status === 'processing' || job.status === 'deleted';
  const disableDelete = job.status === 'processing' || job.status === 'deleted';
  const showStop = job.status === 'processing';
  const displayFilename = job.canonical_filename || job.filename;

  return (
    <div
      onClick={(e) =>
        onSelect({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
      }
      onDoubleClick={(e) => {
        e.preventDefault();
        onDoubleClick();
      }}
      className={`flex cursor-pointer select-none gap-3 border-b border-zinc-900 px-3 py-2.5 transition-colors hover:bg-zinc-900 ${
        isSelected ? 'bg-zinc-900' : ''
      }`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
        }
      }}
      aria-current={isSelected ? 'true' : undefined}
    >
      {/* Thumbnail */}
      <div
        className="h-12 w-10 shrink-0 cursor-pointer overflow-hidden rounded border border-zinc-800 bg-zinc-900"
        onClick={(e) => {
          e.stopPropagation();
          onImageClick();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.stopPropagation();
            onImageClick();
          }
        }}
        aria-label={`View image: ${job.filename}`}
      >
        {job.file_location !== 'missing' ? (
          <img
            src={`/api/images/${encodeURIComponent(job.filename)}`}
            alt={job.filename}
            className="h-full w-full object-cover"
            loading="lazy"
            width={40}
            height={48}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-700 text-xs">
            ?
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(job.status)}`}
            aria-hidden="true"
          />
          <span className="font-mono text-xs font-semibold text-zinc-200">
            {job.entry_date ?? '—'}
          </span>
          {job.version_count > 1 ? (
            <span className="text-[10px] font-medium text-zinc-500">
              · {job.version_count} versions
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500" title={chartLabel(displayFilename)}>
          {chartLabel(displayFilename)}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-600">
          <span>{job.status}</span>
          {job.pending_filename ? <span>· pending upload</span> : null}
          {job.rows_appended_last_run != null ? (
            <span>· {job.rows_appended_last_run} rows</span>
          ) : null}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDoubleClick();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="rounded border border-zinc-800 bg-zinc-900/40 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            aria-label="Open run details"
            title="Open run details"
          >
            {job.run_count} {job.run_count === 1 ? 'run' : 'runs'}
          </button>
        </div>
        <JobProgressBar job={job} avgDurationMs={avgDurationMs} />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 flex-col gap-0.5">
        {showStop ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:text-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            aria-label="Stop"
            title="Stop"
          >
            ⏹︎
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRerun();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={disableRerun}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:text-zinc-300 disabled:opacity-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            aria-label="Rerun"
            title="Rerun"
          >
            ↺
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          disabled={disableDelete}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-700 hover:text-red-400 disabled:opacity-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          aria-label="Delete"
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

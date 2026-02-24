import React, { useEffect, useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { getJobRunDetails } from '../api';
import type { JobRunDetailsResponse } from '../types';

type RunDetailsModalProps = {
  jobId: string | null;
  onClose: () => void;
  onSetActiveRun?: (jobId: string, runId: string) => Promise<void>;
};

function runStatusBadgeClass(status: 'completed' | 'error' | 'cancelled'): string {
  switch (status) {
    case 'error':
      return 'bg-red-900/40 text-red-200';
    case 'cancelled':
      return 'bg-amber-900/40 text-amber-200';
    default:
      return 'bg-zinc-800 text-zinc-200';
  }
}

function formatIso(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function RunDetailsModal({ jobId, onClose, onSetActiveRun }: RunDetailsModalProps) {
  const [data, setData] = useState<JobRunDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settingActiveRunId, setSettingActiveRunId] = useState<string | null>(null);

  useHotkeys('escape', onClose, { enabled: !!jobId });

  useEffect(() => {
    if (!jobId) {
      setData(null);
      setLoading(false);
      setError(null);
      setSelectedRunId(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedRunId(null);

    void getJobRunDetails(jobId, controller.signal)
      .then((next) => setData(next))
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [jobId]);

  const runs = useMemo(() => (data?.runs?.length ? data.runs : data?.run ? [data.run] : []), [data]);

  useEffect(() => {
    if (!data) {
      setSelectedRunId(null);
      return;
    }

    const latestId = data.run?.run_id ?? runs[0]?.run_id ?? null;
    setSelectedRunId((prev) => {
      if (prev && runs.some((r) => r.run_id === prev)) return prev;
      return latestId;
    });
  }, [data, runs]);

  const selectedRun = useMemo(() => {
    if (!data) return null;
    if (selectedRunId) {
      const found = runs.find((r) => r.run_id === selectedRunId);
      if (found) return found;
    }
    return data.run ?? runs[0] ?? null;
  }, [data, runs, selectedRunId]);

  // The active run is last_run_id if set, otherwise the most recently extracted run
  const activeRunId = useMemo(() => {
    if (!data) return null;
    return data.job.last_run_id ?? runs[0]?.run_id ?? null;
  }, [data, runs]);

  const prettyRawJson = useMemo(() => {
    const raw = selectedRun?.raw_result_json;
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [selectedRun?.raw_result_json]);

  async function handleSetActive(runId: string) {
    if (!jobId || !onSetActiveRun) return;
    setSettingActiveRunId(runId);
    try {
      await onSetActiveRun(jobId, runId);
      const next = await getJobRunDetails(jobId);
      setData(next);
    } finally {
      setSettingActiveRunId(null);
    }
  }

  if (!jobId) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Run details"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Run Details</div>
            <div className="text-xs text-zinc-500">
              {data?.job.canonical_filename ?? data?.job.filename ?? jobId}
              {data?.job.version_count && data.job.version_count > 1 ? ` (${data.job.version_count} versions)` : ''}
              {data?.job.pending_filename ? ' (pending upload)' : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-zinc-400 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <div className="overflow-auto p-4">
          {loading ? <div className="text-sm text-zinc-400">Loading run details…</div> : null}
          {error ? <div className="text-sm text-red-300">{error}</div> : null}

          {!loading && !error && data ? (
            <div className="space-y-4">
              <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Job
                </div>
                <div className="grid grid-cols-1 gap-2 text-xs text-zinc-300 md:grid-cols-2">
                  <div>
                    <span className="text-zinc-500">Filename:</span> {data.job.filename}
                  </div>
                  <div>
                    <span className="text-zinc-500">Original:</span> {data.job.canonical_filename}
                    {data.job.version_count > 1 ? ` (${data.job.version_count} versions)` : ''}
                    {data.job.pending_filename ? ' (pending upload)' : ''}
                  </div>
                  <div>
                    <span className="text-zinc-500">Status:</span> {data.job.status}
                  </div>
                  <div>
                    <span className="text-zinc-500">Entry Date:</span> {data.job.entry_date ?? '—'}
                  </div>
                  <div>
                    <span className="text-zinc-500">Runs:</span> {data.job.run_count}
                  </div>
                  <div>
                    <span className="text-zinc-500">Created:</span> {formatIso(data.job.created_at)}
                  </div>
                  <div>
                    <span className="text-zinc-500">Last Error:</span> {data.job.error ?? '—'}
                  </div>
                </div>
              </section>

              {selectedRun ? (
                <>
                  <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Run
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-xs text-zinc-300 md:grid-cols-2">
                      <div>
                        <span className="text-zinc-500">Run ID:</span>{' '}
                        <span className="font-mono">{selectedRun.run_id}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Status:</span> {selectedRun.status}
                      </div>
                      <div>
                        <span className="text-zinc-500">Model:</span> {selectedRun.model}
                      </div>
                      <div>
                        <span className="text-zinc-500">Timestamp:</span>{' '}
                        {formatIso(selectedRun.extracted_at)}
                      </div>
                      <div>
                        <span className="text-zinc-500">Rows Inserted:</span> {selectedRun.rows_inserted}
                      </div>
                      <div className="md:col-span-2">
                        <span className="text-zinc-500">Error:</span> {selectedRun.error ?? '—'}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Run History
                      </div>
                      <div className="text-xs text-zinc-500">Showing {runs.length} most recent</div>
                    </div>

                    <div className="overflow-hidden rounded border border-zinc-800 bg-zinc-950">
                      <div className="max-h-56 overflow-auto">
                        {runs.map((run) => {
                          const isSelected = run.run_id === selectedRunId;
                          const isActive = run.run_id === activeRunId;
                          const isSetting = settingActiveRunId === run.run_id;
                          const showSetActive = !!onSetActiveRun && !isActive && run.rows_inserted > 0;
                          const showStatus = run.status !== 'completed';
                          const statusTextClass = run.status === 'cancelled' ? 'text-amber-300' : 'text-red-300';
                          return (
                            <div
                              key={run.run_id}
                              onClick={() => setSelectedRunId(run.run_id)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setSelectedRunId(run.run_id);
                                }
                              }}
                              aria-current={isSelected ? 'true' : undefined}
                              className={`flex w-full items-start justify-between gap-3 border-b border-zinc-900 px-3 py-2 text-left text-xs hover:bg-zinc-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400 ${
                                isSelected ? 'bg-zinc-900/60' : ''
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-zinc-200">{run.run_id}</span>
                                  {isActive ? (
                                    <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                                      active
                                    </span>
                                  ) : showSetActive ? (
                                    <button
                                      type="button"
                                      disabled={!!settingActiveRunId}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleSetActive(run.run_id);
                                      }}
                                      className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
                                    >
                                      {isSetting ? 'Setting…' : 'Set active'}
                                    </button>
                                  ) : null}
                                  {showStatus ? (
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStatusBadgeClass(
                                        run.status,
                                      )}`}
                                    >
                                      {run.status}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-1 text-zinc-500">{formatIso(run.extracted_at)}</div>
                                {showStatus ? (
                                  <div className={`mt-1 truncate ${statusTextClass}`}>{run.error ?? '—'}</div>
                                ) : null}
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-right">
                                  <div className="text-zinc-300">{run.model}</div>
                                  <div className="mt-1 text-zinc-500">{run.rows_inserted} rows</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Raw Result JSON
                    </div>
                    <pre className="max-h-[40vh] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 select-text">
                      {prettyRawJson ?? '—'}
                    </pre>
                  </section>
                </>
              ) : (
                <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-400">
                  No run details available for this job yet.
                </section>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

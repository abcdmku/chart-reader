import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteJob, getRows, getState, rerunJob, scan, updateConfig, uploadFiles } from './api';
import type { ChartRow, Config, Job, RowsResponse } from './types';

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name?: string }).name === 'AbortError';
}

function upsertJob(prev: Job[], next: Job): Job[] {
  const index = prev.findIndex((j) => j.id === next.id);
  if (index === -1) return [next, ...prev];
  const copy = prev.slice();
  copy[index] = next;
  return copy;
}

function formatMaybeDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.valueOf()) ? iso : d.toLocaleString();
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [rowsState, setRowsState] = useState<RowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [configDraft, setConfigDraft] = useState<{ concurrency: number } | null>(null);

  const scanningRef = useRef(false);

  const refreshState = useCallback(async (signal?: AbortSignal) => {
    const state = await getState(signal);
    setConfig(state.config);
    setConfigDraft({ concurrency: state.config.concurrency });
    setJobs(state.jobs);
  }, []);

  const refreshRows = useCallback(async (signal?: AbortSignal) => {
    const next = await getRows({ limit: 500, offset: 0, order: 'desc' }, signal);
    setRowsState(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshState(controller.signal).catch((e: unknown) => {
      if (isAbortError(e)) return;
      setError((e as Error).message);
    });
    void refreshRows(controller.signal).catch((e: unknown) => {
      if (isAbortError(e)) return;
      setError((e as Error).message);
    });
    return () => controller.abort();
  }, [refreshRows, refreshState]);

  useEffect(() => {
    const es = new EventSource('/api/events');

    const onState = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { config: Config; jobs: Job[] };
        setConfig(data.config);
        setConfigDraft({ concurrency: data.config.concurrency });
        setJobs(data.jobs);
      } catch {
        // ignore
      }
    };

    const onJob = (event: MessageEvent) => {
      try {
        const job = JSON.parse(event.data) as Job;
        setJobs((prev) => upsertJob(prev, job));
      } catch {
        // ignore
      }
    };

    const onConfig = (event: MessageEvent) => {
      try {
        const next = JSON.parse(event.data) as Config;
        setConfig(next);
        setConfigDraft({ concurrency: next.concurrency });
      } catch {
        // ignore
      }
    };

    const onCsvUpdated = () => {
      void refreshRows().catch(() => {});
    };

    es.addEventListener('state', onState as EventListener);
    es.addEventListener('job', onJob as EventListener);
    es.addEventListener('config', onConfig as EventListener);
    es.addEventListener('csv_updated', onCsvUpdated as EventListener);

    es.onerror = () => {
      // Keep the last known state; browser will auto-retry.
    };

    return () => {
      es.close();
    };
  }, [refreshRows]);

  useEffect(() => {
    let cancelled = false;

    async function runScanOnce() {
      if (scanningRef.current) return;
      scanningRef.current = true;
      try {
        await scan();
      } catch {
        // ignore scan errors
      } finally {
        scanningRef.current = false;
      }
    }

    void runScanOnce();

    const interval = setInterval(() => {
      if (cancelled) return;
      void runScanOnce();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const jobCounts = useMemo(() => {
    const counts = { queued: 0, processing: 0, completed: 0, error: 0, deleted: 0 };
    for (const job of jobs) counts[job.status] += 1;
    return counts;
  }, [jobs]);

  const sortedJobs = useMemo(() => {
    return jobs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [jobs]);

  const rows = rowsState?.rows ?? [];

  const onApplyConcurrency = useCallback(async () => {
    if (!configDraft) return;
    try {
      setError(null);
      const state = await updateConfig({ concurrency: configDraft.concurrency });
      setConfig(state.config);
      setJobs(state.jobs);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [configDraft]);

  const onTogglePause = useCallback(async () => {
    if (!config) return;
    try {
      setError(null);
      const state = await updateConfig({ paused: !config.paused });
      setConfig(state.config);
      setJobs(state.jobs);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [config]);

  const onUpload = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    try {
      setError(null);
      setUploading(true);
      await uploadFiles(selectedFiles);
      setSelectedFiles([]);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }, [selectedFiles]);

  const onRerun = useCallback(async (jobId: string) => {
    try {
      setError(null);
      await rerunJob(jobId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, []);

  const onDelete = useCallback(async (jobId: string) => {
    const ok = window.confirm('Delete this file? CSV data will remain.');
    if (!ok) return;
    try {
      setError(null);
      await deleteJob(jobId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, []);

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Chart Reader</h1>
            <p className="text-sm text-zinc-400">
              Upload scans to extract Billboard chart rows into <code className="text-zinc-200">/files/output.csv</code>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
            <span className="rounded-full bg-zinc-900 px-3 py-1">
              queued: <span className="text-zinc-100">{jobCounts.queued}</span>
            </span>
            <span className="rounded-full bg-zinc-900 px-3 py-1">
              processing: <span className="text-zinc-100">{jobCounts.processing}</span>
            </span>
            <span className="rounded-full bg-zinc-900 px-3 py-1">
              completed: <span className="text-zinc-100">{jobCounts.completed}</span>
            </span>
            <span className="rounded-full bg-zinc-900 px-3 py-1">
              error: <span className="text-zinc-100">{jobCounts.error}</span>
            </span>
          </div>
        </header>

        {error ? (
          <div className="mt-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        ) : null}

        <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
            <h2 className="text-sm font-semibold text-zinc-200">Controls</h2>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <label className="text-xs font-medium text-zinc-400">Concurrency</label>
                <div className="flex items-center gap-2">
                  <input
                    className="w-24 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                    type="number"
                    min={1}
                    max={10}
                    value={configDraft?.concurrency ?? 2}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setConfigDraft({ concurrency: Number.isFinite(value) ? value : 2 });
                    }}
                  />
                  <button
                    className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
                    type="button"
                    onClick={onApplyConcurrency}
                    disabled={!configDraft}
                  >
                    Apply
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3">
                <div className="grid gap-0.5">
                  <div className="text-xs font-medium text-zinc-200">Queue</div>
                  <div className="text-xs text-zinc-400">{config?.paused ? 'Paused' : 'Running'}</div>
                </div>
                <button
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500"
                  type="button"
                  onClick={onTogglePause}
                  disabled={!config}
                >
                  {config?.paused ? 'Resume' : 'Pause'}
                </button>
              </div>

              <div className="text-xs text-zinc-400">
                Model: <span className="text-zinc-200">{config?.model ?? '—'}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5 lg:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-200">Upload</h2>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                className="w-full cursor-pointer rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-100"
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const next = Array.from(e.target.files ?? []);
                  setSelectedFiles(next);
                }}
              />
              <button
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
                type="button"
                onClick={onUpload}
                disabled={uploading || selectedFiles.length === 0}
              >
                {uploading ? 'Uploading…' : `Upload (${selectedFiles.length})`}
              </button>
              <a
                className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-600"
                href="/api/csv"
              >
                Download CSV
              </a>
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              Dropping files directly into <code className="text-zinc-200">/files/new</code> will be picked up while this UI
              is open.
            </p>
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">Jobs</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-xs text-zinc-400">
                  <th className="border-b border-zinc-800 py-2 pr-4">File</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Date</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Status</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Progress</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Last Error</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Rows</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Created</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="text-sm text-zinc-100">
                {sortedJobs.map((job) => (
                  <tr key={job.id} className="align-top">
                    <td className="border-b border-zinc-900 py-2 pr-4 font-mono text-xs text-zinc-200">{job.filename}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 font-mono text-xs text-zinc-200">
                      {job.entry_date ?? '—'}
                    </td>
                    <td className="border-b border-zinc-900 py-2 pr-4">
                      <span
                        className={[
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                          job.status === 'completed'
                            ? 'bg-emerald-900/40 text-emerald-200'
                            : job.status === 'processing'
                              ? 'bg-blue-900/40 text-blue-200'
                              : job.status === 'queued'
                                ? 'bg-zinc-800 text-zinc-200'
                                : job.status === 'error'
                                  ? 'bg-red-900/40 text-red-200'
                                  : 'bg-zinc-900 text-zinc-400',
                        ].join(' ')}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{job.progress_step ?? '—'}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{job.error ?? '—'}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">
                      {job.rows_appended_last_run ?? '—'}
                    </td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">
                      {formatMaybeDate(job.created_at)}
                    </td>
                    <td className="border-b border-zinc-900 py-2 pr-4">
                      <div className="flex gap-2">
                        <button
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-zinc-500 disabled:opacity-50"
                          type="button"
                          onClick={() => onRerun(job.id)}
                          disabled={job.status === 'processing' || job.status === 'deleted'}
                        >
                          Rerun
                        </button>
                        <button
                          className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                          type="button"
                          onClick={() => onDelete(job.id)}
                          disabled={job.status === 'processing' || job.status === 'deleted'}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {sortedJobs.length === 0 ? (
                  <tr>
                    <td className="py-6 text-sm text-zinc-400" colSpan={8}>
                      No jobs yet. Upload files or drop images into <code className="text-zinc-200">/files/new</code>.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">CSV Preview (last 500)</h2>
            <div className="text-xs text-zinc-400">Total rows: {rowsState?.total ?? 0}</div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-xs text-zinc-400">
                  <th className="border-b border-zinc-800 py-2 pr-4">Date</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Chart</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Section</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">This</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Last</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">2w</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Weeks</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Title</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Artist</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">Label</th>
                  <th className="border-b border-zinc-800 py-2 pr-4">File</th>
                </tr>
              </thead>
              <tbody className="text-sm text-zinc-100">
                {rows.map((r: ChartRow) => (
                  <tr key={r.id} className="align-top">
                    <td className="border-b border-zinc-900 py-2 pr-4 font-mono text-xs text-zinc-200">{r.entry_date}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-200">{r.chart_title}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{r.chart_section}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{r.this_week_rank ?? ''}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{r.last_week_rank ?? ''}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{r.two_weeks_ago_rank ?? ''}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-300">{r.weeks_on_chart ?? ''}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-200">{r.title}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-200">{r.artist}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 text-xs text-zinc-200">{r.label}</td>
                    <td className="border-b border-zinc-900 py-2 pr-4 font-mono text-xs text-zinc-300">{r.source_file}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td className="py-6 text-sm text-zinc-400" colSpan={11}>
                      No extracted rows yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

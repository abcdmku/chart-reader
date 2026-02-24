import React, { useEffect, useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { getJobRunDetails } from '../api';
import type { JobRunDetailsResponse } from '../types';

type RunDetailsModalProps = {
  jobId: string | null;
  onClose: () => void;
};

function formatIso(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function RunDetailsModal({ jobId, onClose }: RunDetailsModalProps) {
  const [data, setData] = useState<JobRunDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useHotkeys('escape', onClose, { enabled: !!jobId });

  useEffect(() => {
    if (!jobId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);

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

  const prettyRawJson = useMemo(() => {
    const raw = data?.run?.raw_result_json;
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [data?.run?.raw_result_json]);

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
            <div className="text-xs text-zinc-500">{data?.job.filename ?? jobId}</div>
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

              {data.run ? (
                <>
                  <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Latest Run
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-xs text-zinc-300 md:grid-cols-2">
                      <div>
                        <span className="text-zinc-500">Run ID:</span>{' '}
                        <span className="font-mono">{data.run.run_id}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Model:</span> {data.run.model}
                      </div>
                      <div>
                        <span className="text-zinc-500">Extracted:</span>{' '}
                        {formatIso(data.run.extracted_at)}
                      </div>
                      <div>
                        <span className="text-zinc-500">Rows Inserted:</span> {data.run.rows_inserted}
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

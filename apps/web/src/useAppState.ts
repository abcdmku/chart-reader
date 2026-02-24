import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteJob, getRows, getState, rerunJob, scan, stopJob, updateConfig, uploadFiles } from './api';
import type { Config, Job, RowsResponse } from './types';

const LS_LATEST_ONLY = 'chart-view-latest-only';

function loadLatestOnlyPreference(): boolean {
  try {
    const raw = localStorage.getItem(LS_LATEST_ONLY);
    if (raw == null) return true;
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
    return true;
  } catch {
    return true;
  }
}

function saveLatestOnlyPreference(value: boolean): void {
  try {
    localStorage.setItem(LS_LATEST_ONLY, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

function upsertJob(prev: Job[], next: Job): Job[] {
  const index = prev.findIndex((j) => j.id === next.id);
  if (index === -1) return [next, ...prev];
  const copy = prev.slice();
  copy[index] = next;
  return copy;
}

export type AppState = {
  config: Config | null;
  jobs: Job[];
  avgDurationMs: number | null;
  rowsState: RowsResponse | null;
  latestOnly: boolean;
  error: string | null;
  uploading: boolean;
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
  configDraft: { concurrency: number; model: string } | null;
  onSetConcurrency: (concurrency: number) => Promise<void>;
  onSetModel: (model: string) => Promise<void>;
  onTogglePause: () => Promise<void>;
  onSetLatestOnly: (latestOnly: boolean) => Promise<void>;
  onUpload: () => Promise<void>;
  onRerun: (jobId: string) => Promise<void>;
  onStop: (jobId: string) => Promise<void>;
  onDelete: (jobId: string) => Promise<void>;
};

export function useAppState(): AppState {
  const [config, setConfig] = useState<Config | null>(null);
  const configRef = useRef<Config | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [avgDurationMs, setAvgDurationMs] = useState<number | null>(null);
  const [rowsState, setRowsState] = useState<RowsResponse | null>(null);
  const [latestOnly, setLatestOnly] = useState<boolean>(() => loadLatestOnlyPreference());
  const latestOnlyRef = useRef(latestOnly);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [configDraft, setConfigDraft] = useState<{ concurrency: number; model: string } | null>(null);
  const scanningRef = useRef(false);
  const configUpdateSeqRef = useRef(0);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    latestOnlyRef.current = latestOnly;
  }, [latestOnly]);

  const refreshState = useCallback(async (signal?: AbortSignal) => {
    const s = await getState(signal);
    setConfig(s.config);
    setConfigDraft({ concurrency: s.config.concurrency, model: s.config.model });
    setJobs(s.jobs);
    setAvgDurationMs(s.avg_duration_ms);
  }, []);

  const refreshRows = useCallback(async (signal?: AbortSignal, latestOnlyOverride?: boolean) => {
    const latestOnlyValue = latestOnlyOverride ?? latestOnlyRef.current;
    const next = await getRows({ limit: 500, offset: 0, order: 'desc', latestOnly: latestOnlyValue }, signal);
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
        const data = JSON.parse(event.data) as { config: Config; jobs: Job[]; avg_duration_ms: number | null };
        setConfig(data.config);
        setConfigDraft({ concurrency: data.config.concurrency, model: data.config.model });
        setJobs(data.jobs);
        setAvgDurationMs(data.avg_duration_ms);
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
        setConfigDraft({ concurrency: next.concurrency, model: next.model });
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
      // keep last known state; browser will auto-retry
    };
    return () => es.close();
  }, [refreshRows]);

  useEffect(() => {
    let cancelled = false;
    async function runScanOnce() {
      if (scanningRef.current) return;
      scanningRef.current = true;
      try {
        await scan();
      } catch {
        // ignore
      } finally {
        scanningRef.current = false;
      }
    }
    void runScanOnce();
    const interval = setInterval(() => {
      if (!cancelled) void runScanOnce();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const mutateConfig = useCallback(async (next: Partial<Config>) => {
    const seq = ++configUpdateSeqRef.current;
    try {
      setError(null);
      const s = await updateConfig(next);
      if (seq !== configUpdateSeqRef.current) return;
      setConfig(s.config);
      setConfigDraft({ concurrency: s.config.concurrency, model: s.config.model });
      setJobs(s.jobs);
      if (s.avg_duration_ms !== undefined) setAvgDurationMs(s.avg_duration_ms);
    } catch (e: unknown) {
      if (seq !== configUpdateSeqRef.current) return;
      setError((e as Error).message);
      const current = configRef.current;
      if (current) setConfigDraft({ concurrency: current.concurrency, model: current.model });
    }
  }, []);

  const onSetConcurrency = useCallback(
    async (concurrency: number) => {
      const value = Math.floor(concurrency);
      if (!Number.isFinite(value) || value < 1 || value > 10) return;

      setConfigDraft((prev) => ({
        concurrency: value,
        model: prev?.model ?? configRef.current?.model ?? 'gemini-2.5-flash',
      }));
      await mutateConfig({ concurrency: value });
    },
    [mutateConfig],
  );

  const onSetModel = useCallback(
    async (model: string) => {
      setConfigDraft((prev) => ({
        concurrency: prev?.concurrency ?? configRef.current?.concurrency ?? 2,
        model,
      }));
      await mutateConfig({ model });
    },
    [mutateConfig],
  );

  const onTogglePause = useCallback(async () => {
    const current = configRef.current;
    if (!current) return;
    await mutateConfig({ paused: !current.paused });
  }, [mutateConfig]);

  const onSetLatestOnly = useCallback(
    async (value: boolean) => {
      setLatestOnly(value);
      latestOnlyRef.current = value;
      saveLatestOnlyPreference(value);

      try {
        setError(null);
        await refreshRows(undefined, value);
      } catch (e: unknown) {
        setError((e as Error).message);
      }
    },
    [refreshRows],
  );

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

  const onStop = useCallback(async (jobId: string) => {
    if (!window.confirm('Stop this run?')) return;
    try {
      setError(null);
      await stopJob(jobId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, []);

  const onDelete = useCallback(async (jobId: string) => {
    if (!window.confirm('Delete this job? CSV data will remain.')) return;
    try {
      setError(null);
      await deleteJob(jobId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, []);

  return {
    config,
    jobs,
    avgDurationMs,
    rowsState,
    latestOnly,
    error,
    uploading,
    selectedFiles,
    setSelectedFiles,
    configDraft,
    onSetConcurrency,
    onSetModel,
    onTogglePause,
    onSetLatestOnly,
    onUpload,
    onRerun,
    onStop,
    onDelete,
  };
}

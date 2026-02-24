import React, { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../useAppState';
import { JobSidebar } from '../components/JobSidebar';
import { ChartDataTable } from '../components/ChartDataTable';
import { ImageModal } from '../components/ImageModal';
import { RunDetailsModal } from '../components/RunDetailsModal';

const MODEL_OPTIONS = ['gemini-2.5-flash', 'gemini-2-flash', 'gemini-3-flash-preview'] as const;
type JobSelectModifiers = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

export function Dashboard({ state }: { state: AppState }) {
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [selectionAnchorJobId, setSelectionAnchorJobId] = useState<string | null>(null);
  const [modalImage, setModalImage] = useState<string | null>(null);
  const [runDetailsJobId, setRunDetailsJobId] = useState<string | null>(null);

  const {
    config,
    jobs,
    rowsState,
    error,
    selectedFiles,
    setSelectedFiles,
    uploading,
    onUpload,
    configDraft,
    onSetConcurrency,
    onSetModel,
    onTogglePause,
  } = state;

  const rows = rowsState?.rows ?? [];
  const totalRows = rowsState?.total ?? 0;
  const draftModel = configDraft?.model ?? config?.model ?? MODEL_OPTIONS[0];
  const sortedJobs = useMemo(
    () => jobs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [jobs],
  );
  const sortedJobIds = useMemo(() => sortedJobs.map((job) => job.id), [sortedJobs]);

  useEffect(() => {
    const validJobIds = new Set(jobs.map((job) => job.id));
    setSelectedJobIds((prev) => {
      const next = prev.filter((id) => validJobIds.has(id));
      return next.length === prev.length && next.every((id, index) => id === prev[index])
        ? prev
        : next;
    });
    setSelectionAnchorJobId((prev) => (prev && validJobIds.has(prev) ? prev : null));
  }, [jobs]);

  const filteredRows = useMemo(() => {
    if (selectedJobIds.length === 0) return rows;
    const selected = new Set(selectedJobIds);
    return rows.filter((row) => selected.has(row.job_id));
  }, [rows, selectedJobIds]);
  const filteredTotalRows = selectedJobIds.length === 0 ? totalRows : filteredRows.length;

  // List of filenames for modal navigation (sorted same as sidebar)
  const imageFilenames = useMemo(
    () =>
      sortedJobs
        .filter((j) => j.file_location !== 'missing')
        .map((j) => j.filename),
    [sortedJobs],
  );

  function handleSelectJob(jobId: string, modifiers: JobSelectModifiers): void {
    const { shiftKey, ctrlKey, metaKey } = modifiers;
    const isToggleMulti = ctrlKey || metaKey;
    const clickedIsSelected = selectedJobIds.includes(jobId);

    if (shiftKey) {
      const anchorId = selectionAnchorJobId ?? selectedJobIds[selectedJobIds.length - 1] ?? jobId;
      const anchorIndex = sortedJobIds.indexOf(anchorId);
      const clickedIndex = sortedJobIds.indexOf(jobId);

      if (anchorIndex !== -1 && clickedIndex !== -1) {
        const [start, end] =
          anchorIndex < clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
        const rangeIds = sortedJobIds.slice(start, end + 1);
        setSelectedJobIds((prev) => {
          if (!isToggleMulti) return rangeIds;
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return Array.from(next);
        });
        setSelectionAnchorJobId(anchorId);
        return;
      }
    }

    if (isToggleMulti) {
      if (clickedIsSelected) {
        setSelectedJobIds((prev) => prev.filter((id) => id !== jobId));
        setSelectionAnchorJobId((prev) => (prev === jobId ? null : prev));
      } else {
        setSelectedJobIds((prev) => [...prev, jobId]);
        setSelectionAnchorJobId(jobId);
      }
      return;
    }

    if (clickedIsSelected) {
      setSelectedJobIds([]);
      setSelectionAnchorJobId(null);
      return;
    }

    setSelectedJobIds([jobId]);
    setSelectionAnchorJobId(jobId);
  }

  function handleClearJobSelection(): void {
    setSelectedJobIds([]);
    setSelectionAnchorJobId(null);
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar: upload + queue controls */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <div className="flex items-center gap-2">
          <h1 className="mr-2 text-sm font-semibold text-zinc-200">Chart Reader</h1>
          <label className="cursor-pointer rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 focus-within:border-zinc-500">
            + Files
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          {selectedFiles.length > 0 ? (
            <button
              onClick={onUpload}
              disabled={uploading}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            >
              {uploading ? 'Uploading…' : `Upload (${selectedFiles.length})`}
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePause}
            disabled={!config}
            className={`rounded px-3 py-1.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:opacity-40 ${
              config?.paused
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'border border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {config?.paused ? 'Resume' : 'Pause'}
          </button>

          <div className="flex items-center gap-1.5">
            <label className="text-xs text-zinc-600" htmlFor="dash-concurrency">
              workers
            </label>
            <input
              id="dash-concurrency"
              type="number"
              min={1}
              max={10}
              value={configDraft?.concurrency ?? 2}
              onChange={(e) => {
                const value = e.currentTarget.valueAsNumber;
                if (!Number.isFinite(value)) return;
                void onSetConcurrency(value);
              }}
              className="w-12 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:border-zinc-600"
            />
            <label className="text-xs text-zinc-600" htmlFor="dash-model">
              model
            </label>
            <select
              id="dash-model"
              value={draftModel}
              onChange={(e) => void onSetModel(e.currentTarget.value)}
              className="max-w-40 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:border-zinc-600"
            >
              {MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>

        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-xs text-red-200"
        >
          {error}
        </div>
      ) : null}

      {/* Body: sidebar + table */}
      <div className="flex flex-1 overflow-hidden">
        <JobSidebar
          state={state}
          selectedJobIds={selectedJobIds}
          onSelectJob={handleSelectJob}
          onClearSelection={handleClearJobSelection}
          onOpenRunDetails={setRunDetailsJobId}
          onImageClick={setModalImage}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          <ChartDataTable rows={filteredRows} totalRows={filteredTotalRows} />
        </main>
      </div>

      {/* Fullscreen image modal */}
      <ImageModal
        filename={modalImage}
        filenames={imageFilenames}
        onClose={() => setModalImage(null)}
        onNavigate={setModalImage}
      />

      <RunDetailsModal jobId={runDetailsJobId} onClose={() => setRunDetailsJobId(null)} />
    </div>
  );
}

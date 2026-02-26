import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../useAppState';
import { JobSidebar } from '../components/JobSidebar';
import { ChartDataTable } from '../components/ChartDataTable';
import { ImageModal } from '../components/ImageModal';
import { RunDetailsModal } from '../components/RunDetailsModal';
import { PdfReviewModal } from '../components/PdfReviewModal';

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

type JobSelectModifiers = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

export function Dashboard({ state }: { state: AppState }) {
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [selectionAnchorJobId, setSelectionAnchorJobId] = useState<string | null>(null);
  const [modalImage, setModalImage] = useState<string | null>(null);
  const [runDetailsJobId, setRunDetailsJobId] = useState<string | null>(null);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const suppressNextReviewCloseRef = useRef(false);
  const dragCounter = useRef(0);

  const {
    jobs,
    rowsState,
    latestOnly,
    error,
    uploading,
    onUploadFiles,
    onSetLatestOnly,
    onSetActiveRun,
    onSetPdfPage,
  } = state;

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      if (uploading) return;
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => ACCEPTED_TYPES.has(f.type) || /\.pdf$/i.test(f.name),
      );
      if (files.length > 0) void onUploadFiles(files);
    },
    [uploading, onUploadFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const rows = rowsState?.rows ?? [];
  const totalRows = rowsState?.total ?? 0;
  const sortedJobs = useMemo(
    () => jobs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [jobs],
  );
  const sortedJobIds = useMemo(() => sortedJobs.map((job) => job.id), [sortedJobs]);
  const reviewQueueJobIds = useMemo(
    () => sortedJobs.filter((job) => job.status === 'awaiting_review' && /\.pdf$/i.test(job.filename)).map((job) => job.id),
    [sortedJobs],
  );

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
  const reviewJob = useMemo(() => jobs.find((job) => job.id === reviewJobId) ?? null, [jobs, reviewJobId]);
  const handlePdfReviewClose = useCallback(() => {
    if (suppressNextReviewCloseRef.current) {
      suppressNextReviewCloseRef.current = false;
      return;
    }
    setReviewJobId(null);
  }, []);
  const handleSetPdfPageAndAdvance = useCallback(
    async (jobId: string, page: number) => {
      const currentIndex = reviewQueueJobIds.indexOf(jobId);
      const nextReviewJobId = currentIndex >= 0 ? reviewQueueJobIds[currentIndex + 1] ?? null : null;

      await onSetPdfPage(jobId, page);

      if (nextReviewJobId) {
        suppressNextReviewCloseRef.current = true;
        setReviewJobId(nextReviewJobId);
      }
    },
    [onSetPdfPage, reviewQueueJobIds],
  );

  // List of filenames for modal navigation (sorted same as sidebar)
  const previewFilenames = useMemo(
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
    <div
      className="relative flex h-screen flex-col"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-emerald-500/60 px-12 py-8 text-sm font-medium text-emerald-400">
            Drop files to upload
          </div>
        </div>
      ) : null}

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
          onOpenPdfReview={(jobId) => setReviewJobId(jobId)}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          <ChartDataTable
            rows={filteredRows}
            totalRows={filteredTotalRows}
            latestOnly={latestOnly}
            onLatestOnlyChange={onSetLatestOnly}
          />
        </main>
      </div>

      {/* Fullscreen image modal */}
      <ImageModal
        filename={modalImage}
        filenames={previewFilenames}
        onClose={() => setModalImage(null)}
        onNavigate={setModalImage}
      />

      <RunDetailsModal jobId={runDetailsJobId} onClose={() => setRunDetailsJobId(null)} onSetActiveRun={onSetActiveRun} />

      <PdfReviewModal
        job={reviewJob}
        onClose={handlePdfReviewClose}
        onSetPdfPage={handleSetPdfPageAndAdvance}
      />
    </div>
  );
}

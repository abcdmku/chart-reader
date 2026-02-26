import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { Job } from '../types';

type PdfReviewModalProps = {
  job: Job | null;
  onClose: () => void;
  onSetPdfPage: (jobId: string, page: number) => Promise<void>;
};

function parseCandidates(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const values = parsed
      .map((value) => Number(value))
      .filter((page) => Number.isInteger(page) && page >= 1);
    return Array.from(new Set(values)).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function PdfReviewModal({ job, onClose, onSetPdfPage }: PdfReviewModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [previewPage, setPreviewPage] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadedPageCount, setLoadedPageCount] = useState<number | null>(null);
  const [pdfDocVersion, setPdfDocVersion] = useState(0);
  const [previewContainerWidth, setPreviewContainerWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<any | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const pageBitmapCacheRef = useRef<Map<number, { bitmap: ImageBitmap; width: number; height: number }>>(new Map());
  const pagePreloadInFlightRef = useRef<Set<number>>(new Set());

  useHotkeys('escape', onClose, { enabled: !!job });

  const candidates = useMemo(() => parseCandidates(job?.pdf_review_candidates ?? null), [job?.pdf_review_candidates]);
  const selectedPage = job?.selected_pdf_page ?? null;

  useEffect(() => {
    if (!job) return;
    const initialPage = selectedPage ?? candidates[0] ?? 1;
    const sanitizedInitialPage = Number.isFinite(initialPage) ? initialPage : 1;

    setManualValue(String(sanitizedInitialPage));
    setPreviewPage(sanitizedInitialPage);
    setError(null);
  }, [job?.id, selectedPage, candidates]);

  const maxPage = job?.pdf_page_count ?? loadedPageCount;
  const pdfFilename = job?.filename ?? '';
  const fileUrl = job ? `/api/files/${encodeURIComponent(pdfFilename)}` : '';
  const previewSafe = Number.isFinite(previewPage) ? previewPage : 1;
  const openPdfUrl = `${fileUrl}#page=${previewSafe}`;
  const canGoPrev = previewSafe > 1;
  const canGoNext = maxPage == null || previewSafe < maxPage;
  const getTargetRenderWidth = (maxWidth: number) => {
    const cssWidth = Math.max(320, previewContainerWidth || 960);
    return Math.min(maxWidth, Math.floor(cssWidth * Math.max(1, window.devicePixelRatio || 1)));
  };
  const preloadPage = useCallback(
    async (pageNumber: number) => {
      const pdf = pdfDocRef.current;
      const activeDoc = pdf;
      if (!pdf) return;

      const knownPageCount = Number(maxPage ?? pdf.numPages ?? 0);
      if (!Number.isFinite(knownPageCount) || knownPageCount < 1) return;
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > knownPageCount) return;
      if (pageBitmapCacheRef.current.has(pageNumber)) return;
      if (pagePreloadInFlightRef.current.has(pageNumber)) return;
      pagePreloadInFlightRef.current.add(pageNumber);

      let page: any | null = null;
      try {
        page = await pdf.getPage(pageNumber);
        if (pdfDocRef.current !== activeDoc) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = getTargetRenderWidth(1600);
        const scale = targetWidth / Math.max(1, baseViewport.width);
        const viewport = page.getViewport({ scale });

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.max(1, Math.floor(viewport.width));
        tempCanvas.height = Math.max(1, Math.floor(viewport.height));
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return;

        const renderTask = page.render({ canvasContext: tempCtx, viewport });
        await renderTask.promise;
        if (pdfDocRef.current !== activeDoc) return;

        const bitmap = await createImageBitmap(tempCanvas);
        const previous = pageBitmapCacheRef.current.get(pageNumber);
        if (previous) previous.bitmap.close?.();
        pageBitmapCacheRef.current.set(pageNumber, {
          bitmap,
          width: tempCanvas.width,
          height: tempCanvas.height,
        });
      } catch {
        // Preload is best effort. Keep active interactions responsive.
      } finally {
        if (page) page.cleanup();
        pagePreloadInFlightRef.current.delete(pageNumber);
      }
    },
    [maxPage, previewContainerWidth],
  );

  const goToPreviewPage = (targetPage: number) => {
    const boundedPage = maxPage != null ? Math.max(1, Math.min(targetPage, maxPage)) : Math.max(1, targetPage);
    if (boundedPage === previewSafe) return;
    setError(null);
    setPreviewPage(boundedPage);
    setManualValue(String(boundedPage));
  };

  const movePreviewPage = (delta: number) => {
    if (delta === 0) return;
    goToPreviewPage(previewSafe + delta);
  };

  useHotkeys(
    'left',
    (e) => {
      e.preventDefault();
      movePreviewPage(-1);
    },
    { enabled: !!job && !isSubmitting && canGoPrev, preventDefault: true },
    [job?.id, isSubmitting, canGoPrev, previewSafe, maxPage],
  );

  useHotkeys(
    'right',
    (e) => {
      e.preventDefault();
      movePreviewPage(1);
    },
    { enabled: !!job && !isSubmitting && canGoNext, preventDefault: true },
    [job?.id, isSubmitting, canGoNext, previewSafe, maxPage],
  );

  useEffect(() => {
    if (!job) return;
    const node = previewContainerRef.current;
    if (!node) return;

    const updateWidth = () => {
      setPreviewContainerWidth(node.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, [job?.id]);

  useEffect(() => {
    if (!job) return;

    let disposed = false;
    let loadingTask: { promise: Promise<any>; destroy: () => Promise<void> } | null = null;

    const loadPdf = async () => {
      setPreviewError(null);
      setLoadedPageCount(null);
      setIsPreviewLoading(true);
      for (const cached of pageBitmapCacheRef.current.values()) {
        cached.bitmap.close?.();
      }
      pageBitmapCacheRef.current.clear();
      pagePreloadInFlightRef.current.clear();

      try {
        const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
          GlobalWorkerOptions: { workerSrc: string };
          getDocument: (args: unknown) => { promise: Promise<any>; destroy: () => Promise<void> };
        };
        const workerSrcModule = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')) as { default: string };
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrcModule.default;
        loadingTask = pdfjs.getDocument({
          url: fileUrl,
          verbosity: 0,
          useWorkerFetch: false,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
          useSystemFonts: false,
          disableFontFace: true,
        });

        const nextDoc = await loadingTask.promise;
        if (disposed) {
          await nextDoc.destroy().catch(() => undefined);
          return;
        }

        const previousDoc = pdfDocRef.current;
        pdfDocRef.current = nextDoc;
        setLoadedPageCount(Number(nextDoc.numPages) || null);
        setPdfDocVersion((value) => value + 1);
        if (previousDoc) {
          await previousDoc.destroy().catch(() => undefined);
        }
      } catch (e: unknown) {
        if (disposed) return;
        setPreviewError((e as Error).message || 'Failed to load PDF.');
      } finally {
        if (!disposed) setIsPreviewLoading(false);
      }
    };

    void loadPdf();

    return () => {
      disposed = true;
      if (loadingTask) {
        void loadingTask.destroy().catch(() => undefined);
      }
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      const activeDoc = pdfDocRef.current;
      pdfDocRef.current = null;
      if (activeDoc) {
        void activeDoc.destroy().catch(() => undefined);
      }
      for (const cached of pageBitmapCacheRef.current.values()) {
        cached.bitmap.close?.();
      }
      pageBitmapCacheRef.current.clear();
      pagePreloadInFlightRef.current.clear();
    };
  }, [job?.id, fileUrl]);

  useEffect(() => {
    if (!job) return;
    const pdf = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;

    let cancelled = false;
    let page: any | null = null;

    const renderPage = async () => {
      setPreviewError(null);
      setIsPreviewLoading(true);

      try {
        const cachedPage = pageBitmapCacheRef.current.get(previewSafe);
        if (cachedPage) {
          const cachedCtx = canvas.getContext('2d');
          if (!cachedCtx) throw new Error('Canvas context unavailable');
          canvas.width = cachedPage.width;
          canvas.height = cachedPage.height;
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          cachedCtx.clearRect(0, 0, canvas.width, canvas.height);
          cachedCtx.drawImage(cachedPage.bitmap, 0, 0, cachedPage.width, cachedPage.height);
          return;
        }

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }

        page = await pdf.getPage(previewSafe);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = getTargetRenderWidth(1800);
        const scale = targetWidth / Math.max(1, baseViewport.width);
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = '100%';
        canvas.style.height = 'auto';

        const renderTask = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask as { cancel: () => void };
        await renderTask.promise;
        if (!cancelled) {
          try {
            const bitmap = await createImageBitmap(canvas);
            const previous = pageBitmapCacheRef.current.get(previewSafe);
            if (previous) previous.bitmap.close?.();
            pageBitmapCacheRef.current.set(previewSafe, {
              bitmap,
              width: canvas.width,
              height: canvas.height,
            });
          } catch {
            // Cache is best effort; rendering already succeeded.
          }
        }
      } catch (e: unknown) {
        if (cancelled) return;
        const name = (e as { name?: string }).name ?? '';
        if (name === 'RenderingCancelledException') return;
        setPreviewError((e as Error).message || 'Failed to render page.');
      } finally {
        if (page) page.cleanup();
        if (!cancelled) setIsPreviewLoading(false);
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [job?.id, previewSafe, previewContainerWidth, pdfDocVersion]);

  useEffect(() => {
    if (!job || isPreviewLoading) return;
    const pdf = pdfDocRef.current;
    if (!pdf) return;

    let cancelled = false;
    const knownPageCount = Number(maxPage ?? pdf.numPages ?? 0);
    if (!Number.isFinite(knownPageCount) || knownPageCount < 1) return;

    const neighborPages = [previewSafe - 1, previewSafe + 1].filter(
      (pageNumber, index, arr) =>
        pageNumber >= 1 && pageNumber <= knownPageCount && pageNumber !== previewSafe && arr.indexOf(pageNumber) === index,
    );
    if (neighborPages.length === 0) return;

    void (async () => {
      for (const pageNumber of neighborPages) {
        if (cancelled) break;
        await preloadPage(pageNumber);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job?.id, isPreviewLoading, maxPage, pdfDocVersion, previewContainerWidth, previewSafe, preloadPage]);

  const submitPage = async (page: number) => {
    setError(null);
    setIsSubmitting(true);
    try {
      if (!job) return;
      await onSetPdfPage(job.id, page);
      onClose();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  useHotkeys(
    'enter',
    (e) => {
      e.preventDefault();
      if (isSubmitting || !job) return;
      void submitPage(previewSafe);
    },
    { enabled: !!job && !isSubmitting },
    [job?.id, isSubmitting, previewSafe],
  );

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const page = Number(manualValue);
    if (!Number.isInteger(page) || page < 1 || (maxPage != null && page > maxPage)) {
      setError('Enter a valid page number.');
      return;
    }
    setPreviewPage(page);
    void submitPage(page);
  };

  const handleCandidateSelect = (page: number) => {
    setError(null);
    setPreviewPage(page);
    setManualValue(String(page));
  };

  const hasCandidates = candidates.length > 0;
  if (!job) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Review PDF page"
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Select PDF page</div>
            <div className="text-xs text-zinc-500">{pdfFilename}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-zinc-400 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
          >
            Close
          </button>
        </div>

        <div className="overflow-auto p-4">
          <p className="text-sm text-zinc-300">
            Choose the chart page. We found
            {` ${candidates.length ? `${candidates.length} candidate page${candidates.length === 1 ? '' : 's'}` : 'no candidate pages'}${
              maxPage != null ? ` within ${maxPage} pages` : ''
            }.`}
          </p>

          {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}
          {previewError ? <div className="mt-2 text-xs text-red-300">{previewError}</div> : null}

          <div className="mt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Candidate pages</div>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {hasCandidates ? (
                candidates.map((page) => (
                  <button
                    key={page}
                    onClick={() => handleCandidateSelect(page)}
                    onMouseEnter={() => {
                      void preloadPage(page);
                    }}
                    onFocus={() => {
                      void preloadPage(page);
                    }}
                    disabled={isSubmitting}
                    className={`rounded px-2 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400 ${
                      page === previewPage ? 'bg-emerald-700 text-white' : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    Page {page}
                  </button>
                ))
              ) : (
                <div className="text-xs text-zinc-500">No candidates were identified yet.</div>
              )}
            </div>
          </div>

          <form onSubmit={handleManualSubmit} className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-xs text-zinc-400">
              Manual page
              <input
                type="number"
                min={1}
                max={maxPage ?? undefined}
                value={manualValue}
                onChange={(e) => setManualValue(e.currentTarget.value)}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus-visible:border-zinc-500"
              />
            </label>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded px-3 py-1.5 text-xs font-medium text-zinc-100 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            >
              {isSubmitting ? 'Applying...' : 'Use page'}
            </button>
          </form>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Preview: Page {previewSafe}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => movePreviewPage(-1)}
                  disabled={!canGoPrev || isSubmitting}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => movePreviewPage(1)}
                  disabled={!canGoNext || isSubmitting}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
                >
                  Next
                </button>
              </div>
            </div>
            <div
              ref={previewContainerRef}
              className="relative flex h-[60vh] items-start justify-center overflow-auto rounded border border-zinc-800 bg-zinc-900"
            >
              <canvas ref={canvasRef} className="block h-auto w-full" />
              {isPreviewLoading ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/45 text-xs text-zinc-200">
                  Rendering page {previewSafe}...
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-300">
            <span>Open source PDF to verify page numbering.</span>
            <a
              href={openPdfUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            >
              Open PDF
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_POINTS_PER_INCH = 72;
const DEFAULT_PDF_RASTER_DPI = 300;
const MODEL_IMAGE_QUALITY = 0.9;

function makeAbortError(reason?: unknown): Error {
  const message = typeof reason === 'string' && reason.trim() ? reason : 'Aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw makeAbortError(signal.reason);
}

export async function rasterizePdfFirstPageForModel(args: {
  fileData: Buffer;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<{
  fileData: Buffer;
  mimeType: 'image/webp' | 'image/jpeg';
  dpi: number;
  pageCount: number;
  width: number;
  height: number;
}> {
  const dpi = args.dpi ?? DEFAULT_PDF_RASTER_DPI;
  const scale = dpi / PDF_POINTS_PER_INCH;
  throwIfAborted(args.abortSignal);

  const pdfBytes = new Uint8Array(args.fileData.buffer, args.fileData.byteOffset, args.fileData.byteLength);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  });

  const onAbort = () => {
    void loadingTask.destroy().catch(() => undefined);
  };
  args.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages < 1) {
        throw new Error('PDF has no pages');
      }

      throwIfAborted(args.abortSignal);
      const page = await pdf.getPage(1);
      try {
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createCanvas(width, height);

        const renderTask = page.render({
          canvas: canvas as unknown as any,
          viewport,
          background: '#ffffff',
        } as any);

        const onRenderAbort = () => {
          renderTask.cancel();
        };
        args.abortSignal?.addEventListener('abort', onRenderAbort, { once: true });

        try {
          await renderTask.promise;
        } catch (error) {
          if (
            args.abortSignal?.aborted &&
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'RenderingCancelledException')
          ) {
            throw makeAbortError(args.abortSignal.reason);
          }
          throw error;
        } finally {
          args.abortSignal?.removeEventListener('abort', onRenderAbort);
        }

        throwIfAborted(args.abortSignal);

        // Prefer WebP to reduce upload bytes while keeping OCR-friendly quality.
        try {
          return {
            fileData: canvas.toBuffer('image/webp', MODEL_IMAGE_QUALITY),
            mimeType: 'image/webp',
            dpi,
            pageCount: pdf.numPages,
            width,
            height,
          };
        } catch {
          return {
            fileData: canvas.toBuffer('image/jpeg', MODEL_IMAGE_QUALITY),
            mimeType: 'image/jpeg',
            dpi,
            pageCount: pdf.numPages,
            width,
            height,
          };
        }
      } finally {
        page.cleanup();
      }
    } finally {
      await pdf.destroy();
    }
  } finally {
    args.abortSignal?.removeEventListener('abort', onAbort);
    try {
      await loadingTask.destroy();
    } catch {
      // Ignore cleanup races if the task/document was already destroyed.
    }
  }
}

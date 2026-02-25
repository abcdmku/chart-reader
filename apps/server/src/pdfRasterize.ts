import path from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_POINTS_PER_INCH = 72;
const DEFAULT_PDF_RASTER_DPI = 300;
const MODEL_IMAGE_QUALITY = 0.9;
const MAX_RENDER_PIXELS = 12_000_000; // ~48 MB RGBA canvas before encoder overhead
const MAX_RENDER_DIMENSION = 4096;
const require = createRequire(import.meta.url);

function normalizeDirPath(dirPath: string): string {
  return dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
}

function resolvePdfJsAssetUrls(): { standardFontDataUrl?: string; wasmUrl?: string } {
  try {
    const pdfjsPkg = require.resolve('pdfjs-dist/package.json');
    const pdfjsRoot = path.dirname(pdfjsPkg);
    return {
      // In Node, pdfjs loads these via filesystem APIs; plain absolute paths work
      // more reliably than file:// URLs (especially in Docker).
      standardFontDataUrl: normalizeDirPath(path.join(pdfjsRoot, 'standard_fonts')),
      wasmUrl: normalizeDirPath(path.join(pdfjsRoot, 'wasm')),
    };
  } catch {
    return {};
  }
}

const PDFJS_ASSET_URLS = resolvePdfJsAssetUrls();

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
  const requestedDpi = args.dpi ?? DEFAULT_PDF_RASTER_DPI;
  throwIfAborted(args.abortSignal);

  const pdfBytes = new Uint8Array(args.fileData.buffer, args.fileData.byteOffset, args.fileData.byteLength);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    ...PDFJS_ASSET_URLS,
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
        const requestedScale = requestedDpi / PDF_POINTS_PER_INCH;
        const requestedViewport = page.getViewport({ scale: requestedScale });

        const requestedWidth = Math.max(1, Math.ceil(requestedViewport.width));
        const requestedHeight = Math.max(1, Math.ceil(requestedViewport.height));
        const requestedPixels = requestedWidth * requestedHeight;

        const dimensionScale = Math.min(
          1,
          MAX_RENDER_DIMENSION / requestedWidth,
          MAX_RENDER_DIMENSION / requestedHeight,
        );
        const pixelScale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / requestedPixels));
        const downscale = Math.min(dimensionScale, pixelScale);
        const effectiveScale = requestedScale * (Number.isFinite(downscale) ? downscale : 1);

        const viewport = page.getViewport({ scale: Math.max(effectiveScale, 1 / PDF_POINTS_PER_INCH) });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const actualDpi = Math.max(1, Math.round((requestedDpi * width) / Math.max(1, requestedWidth)));
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
            dpi: actualDpi,
            pageCount: pdf.numPages,
            width,
            height,
          };
        } catch {
          return {
            fileData: canvas.toBuffer('image/jpeg', MODEL_IMAGE_QUALITY),
            mimeType: 'image/jpeg',
            dpi: actualDpi,
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

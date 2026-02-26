import path from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_POINTS_PER_INCH = 72;
const DEFAULT_PDF_RASTER_DPI = 300;
// @napi-rs/canvas expects a 0-100 quality scale for JPEG/WebP in `toBuffer`.
const MODEL_IMAGE_QUALITY = 95;
const THUMBNAIL_IMAGE_QUALITY = 82;

// Model input should stay bounded for speed/cost.
const MODEL_MAX_RENDER_PIXELS = 12_000_000; // ~48 MB RGBA
const MODEL_MAX_RENDER_DIMENSION = 4096;
const THUMBNAIL_MAX_DIMENSION = 240;
const require = createRequire(import.meta.url);

function normalizeDirPath(dirPath: string): string {
  // pdfjs expects "factory" URLs to end with "/" (not Windows "\\").
  const normalized = dirPath.replaceAll('\\', '/');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
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

type RasterizedImage = {
  fileData: Buffer;
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
};

type RasterizedPdfPage = RasterizedImage & {
  dpi: number;
  pageCount: number;
  pageNumber: number;
};

type PdfLoadingTask = {
  promise: Promise<unknown>;
  destroy: () => Promise<void>;
};

function normalizePdfTextForScoring(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function countRegexMatches(text: string, re: RegExp, limit: number): number {
  // Avoid allocating huge arrays by using exec and an upper bound.
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) != null) {
    count += 1;
    if (count >= limit) break;
    // Defensive: prevent infinite loops on zero-width matches.
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return count;
}

function countLikelyRankNumbers(text: string, limit: number): number {
  const global = /\b\d{1,3}\b/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) != null) {
    const n = Number(match[0]);
    if (Number.isFinite(n) && n >= 1 && n <= 200) {
      count += 1;
      if (count >= limit) break;
    }
  }
  return count;
}

const DISCO_DANCE_PAIR_RE =
  /\b(?:dance(?:\s*music)?|disco)\s*(?:\/|&|and|\+|-)\s*(?:disco|dance(?:\s*music)?)\b/i;
const HOT_DISCO_DANCE_PAIR_RE =
  /\bhot\s*(?:dance(?:\s*music)?|disco)\s*(?:\/|&|and|\+|-)\s*(?:disco|dance(?:\s*music)?)\b/i;
const DISCO_DANCE_TOP_WITH_NUMBER_RE =
  /\b(?:dance(?:\s*music)?|disco)\s*(?:\/|&|and|\+|-)\s*(?:disco|dance(?:\s*music)?)\s*top\s*\d{2,3}\b/i;
const DISCO_DANCE_TOP_NO_NUMBER_RE =
  /\b(?:dance(?:\s*music)?|disco)\s*(?:\/|&|and|\+|-)\s*(?:disco|dance(?:\s*music)?)\s*top\b(?!\s*\d{2,3}\b)/i;
const DISCO_TOP_WITH_NUMBER_RE = /\bdisco\s*top\s*\d{2,3}\b/i;
const DISCO_TOP_NO_NUMBER_RE = /\bdisco\s*top\b(?!\s*\d{2,3}\b)/i;

function scoreDiscoDancePreferenceBoost(args: { text: string; baseScore: number; rankNumbers: number }): number {
  // Only apply preference boosts when the page already looks chart-like to avoid
  // accidentally picking pages with incidental "dance"/"disco" mentions.
  if (args.baseScore < 140 && args.rankNumbers < 18) return 0;

  // Prioritize the DISCO/DANCE pages using highly specific titles/headers. These are much less
  // likely to appear in row titles/artists than the standalone words "disco"/"dance".
  const text = args.text;

  let boost = 0;

  // Main chart titles/headers we care about (high weights to beat other chart pages like rock).
  boost += countRegexMatches(text, /\bclub\s*play\b/i, 2) * 5200;

  boost +=
    countRegexMatches(text, HOT_DISCO_DANCE_PAIR_RE, 2) * 5600;

  boost +=
    countRegexMatches(text, DISCO_DANCE_TOP_WITH_NUMBER_RE, 2) * 5600;

  boost += countRegexMatches(text, DISCO_TOP_WITH_NUMBER_RE, 2) * 5600;

  // Fallbacks when the number is dropped/garbled in the PDF text layer.
  boost +=
    countRegexMatches(text, DISCO_DANCE_TOP_NO_NUMBER_RE, 2) * 4200;

  boost += countRegexMatches(text, DISCO_TOP_NO_NUMBER_RE, 2) * 4200;

  // Weaker signals: "DANCE/DISCO" without HOT/TOP still strongly indicates the target page header.
  boost += countRegexMatches(text, DISCO_DANCE_PAIR_RE, 3) * 1800;

  // Ancillary chart titles commonly on these pages.
  boost += countRegexMatches(text, /\b12\s*inch\b/i, 2) * 900;
  boost += countRegexMatches(text, /\b12\s*in\.\b/i, 2) * 900;

  return boost;
}

export function scorePdfTextForChartPicker(rawText: string): {
  baseScore: number;
  effectiveScore: number;
  discoDanceBoost: number;
  rankNumbers: number;
  textLength: number;
} {
  const text = normalizePdfTextForScoring(rawText);
  const textLength = text.length;
  if (textLength === 0)
    return {
      baseScore: 0,
      effectiveScore: 0,
      discoDanceBoost: 0,
      rankNumbers: 0,
      textLength: 0,
    };

  const patterns: Array<{ re: RegExp; weight: number; cap: number }> = [
    { re: /\bthis\s*week\b/i, weight: 70, cap: 2 },
    { re: /\blast\s*week\b/i, weight: 60, cap: 2 },
    { re: /\btwo\s*weeks?\s*ago\b/i, weight: 45, cap: 2 },
    { re: /\bweeks?\s*on\s*chart\b/i, weight: 85, cap: 2 },
    { re: /\bwks?\s*on\s*chart\b/i, weight: 85, cap: 2 },
    { re: /\bpeak\s*position\b/i, weight: 35, cap: 2 },
    { re: /\bbillboard\b/i, weight: 18, cap: 4 },
    { re: /\bchart\b/i, weight: 12, cap: 6 },
    { re: /\bartist\b/i, weight: 14, cap: 6 },
    { re: /\btitle\b/i, weight: 14, cap: 6 },
    { re: /\blabel\b/i, weight: 14, cap: 6 },
    { re: /\bhot\s*100\b/i, weight: 28, cap: 2 },
  ];

  let baseScore = 0;
  for (const { re, weight, cap } of patterns) {
    const hits = countRegexMatches(text, re, cap);
    baseScore += hits * weight;
  }

  const rankNumbers = countLikelyRankNumbers(text, 300);
  baseScore += Math.min(300, rankNumbers) * 0.45;

  // Mild preference for pages with substantial readable text (OCR output tends to be longer on chart tables).
  baseScore += Math.min(40, textLength / 1000);

  const discoDanceBoost = scoreDiscoDancePreferenceBoost({ text, baseScore, rankNumbers });
  const effectiveScore = baseScore + discoDanceBoost;

  return { baseScore, effectiveScore, discoDanceBoost, rankNumbers, textLength };
}

function looksLikeChartPage(scored: ReturnType<typeof scorePdfTextForChartPicker>): boolean {
  return scored.baseScore >= 160 || scored.rankNumbers >= 30 || (scored.baseScore >= 110 && scored.rankNumbers >= 18);
}

export type PdfPageCandidateScanResult = {
  pageCount: number;
  candidates: number[];
};

function scoreChartLikeText(rawText: string): { score: number; textLength: number } {
  const scored = scorePdfTextForChartPicker(rawText);
  return { score: scored.effectiveScore, textLength: scored.textLength };
}

async function getPageText(page: unknown): Promise<string> {
  try {
    const content = (await (page as any).getTextContent()) as { items?: Array<{ str?: unknown }> } | undefined;
    const items = Array.isArray(content?.items) ? content!.items : [];
    return items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ');
  } catch {
    return '';
  }
}

async function pickBestChartPageNumber(args: {
  pdf: unknown;
  abortSignal?: AbortSignal;
  maxPagesToScan: number;
}): Promise<{ pageNumber: number; pageCount: number }> {
  const pdfAny = args.pdf as any;
  const pageCount = Number(pdfAny.numPages ?? 0);
  if (!Number.isFinite(pageCount) || pageCount < 1) throw new Error('PDF has no pages');

  const scanPages = Math.min(pageCount, Math.max(1, args.maxPagesToScan));
  let bestCandidatePage: number | null = null;
  let bestCandidateScore = -Infinity;
  let bestCandidateTextLength = 0;

  let bestPreferredPage: number | null = null;
  let bestPreferredScore = -Infinity;
  let bestPreferredTextLength = 0;

  for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
    throwIfAborted(args.abortSignal);
    const page = await pdfAny.getPage(pageNumber);
    try {
      const rawText = await getPageText(page);
      const scored = scorePdfTextForChartPicker(rawText);
      const score = scored.effectiveScore;
      const textLength = scored.textLength;

      const looksLikeChart = looksLikeChartPage(scored);

      if (
        looksLikeChart &&
        scored.discoDanceBoost > 0 &&
        (score > bestPreferredScore || (score === bestPreferredScore && textLength > bestPreferredTextLength))
      ) {
        bestPreferredScore = score;
        bestPreferredPage = pageNumber;
        bestPreferredTextLength = textLength;
      }

      if (looksLikeChart && (score > bestCandidateScore || (score === bestCandidateScore && textLength > bestCandidateTextLength))) {
        bestCandidateScore = score;
        bestCandidatePage = pageNumber;
        bestCandidateTextLength = textLength;
      }
    } finally {
      page.cleanup();
    }
  }

  if (bestPreferredPage != null) {
    return { pageNumber: bestPreferredPage, pageCount };
  }

  if (bestCandidatePage != null) {
    return { pageNumber: bestCandidatePage, pageCount };
  }

  // If the PDF has a text layer but none of the pages look like a chart, fall back to raster heuristics
  // (some chart PDFs are fully scanned images with non-table text elsewhere).
  // Fallback for scanned-image PDFs with little/no chart-like text: score the raster content at low DPI.
  let bestImgPage = 1;
  let bestImgScore = -Infinity;

  for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
    throwIfAborted(args.abortSignal);
    const page = await pdfAny.getPage(pageNumber);
    try {
      const { canvas } = await renderPdfPageToCanvas({
        page,
        requestedDpi: 50,
        abortSignal: args.abortSignal,
        maxRenderDimension: 900,
        maxRenderPixels: 1_200_000,
      });
      const imgScore = scoreCanvasForChartLikeContent(canvas);
      if (imgScore > bestImgScore) {
        bestImgScore = imgScore;
        bestImgPage = pageNumber;
      }
    } finally {
      page.cleanup();
    }
  }

  return { pageNumber: bestImgPage, pageCount };
}

export async function scanPdfChartPageCandidatesForModel(args: {
  fileData: Buffer;
  abortSignal?: AbortSignal;
  maxPagesToScan?: number;
  candidateLimit?: number;
}): Promise<PdfPageCandidateScanResult> {
  const maxPagesToScan = Math.max(1, args.maxPagesToScan ?? 300);
  const candidateLimit = Math.max(1, args.candidateLimit ?? 12);
  throwIfAborted(args.abortSignal);

  const pdfBytes = new Uint8Array(args.fileData);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    ...PDFJS_ASSET_URLS,
  }) as PdfLoadingTask;

  const onAbort = () => {
    void loadingTask.destroy().catch(() => undefined);
  };
  args.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const pdf = await loadingTask.promise;
    try {
      const pdfAny = pdf as any;
      const pageCount = Number(pdfAny.numPages ?? 0);
      if (!Number.isFinite(pageCount) || pageCount < 1) {
        throw new Error('PDF has no pages');
      }

      const scanPages = Math.min(pageCount, maxPagesToScan);
      const textCandidates: Array<{ pageNumber: number; scored: ReturnType<typeof scorePdfTextForChartPicker> }> = [];

      for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
        throwIfAborted(args.abortSignal);
        const page = await pdfAny.getPage(pageNumber);
        try {
          const rawText = await getPageText(page);
          const scored = scorePdfTextForChartPicker(rawText);
          if (looksLikeChartPage(scored)) {
            textCandidates.push({ pageNumber, scored });
          }
        } finally {
          page.cleanup();
        }
      }

      textCandidates.sort((a, b) => {
        const aPreferred = a.scored.discoDanceBoost > 0 ? 1 : 0;
        const bPreferred = b.scored.discoDanceBoost > 0 ? 1 : 0;
        if (aPreferred !== bPreferred) return bPreferred - aPreferred;
        if (a.scored.effectiveScore !== b.scored.effectiveScore) return b.scored.effectiveScore - a.scored.effectiveScore;
        if (a.scored.textLength !== b.scored.textLength) return b.scored.textLength - a.scored.textLength;
        return a.pageNumber - b.pageNumber;
      });

      const seen = new Set<number>();
      const candidates: number[] = [];
      const pushCandidate = (pageNumber: number) => {
        if (seen.has(pageNumber)) return;
        seen.add(pageNumber);
        candidates.push(pageNumber);
      };

      const primaryLimit = Math.min(candidateLimit, 6);
      for (const candidate of textCandidates.slice(0, primaryLimit)) {
        if (candidates.length >= candidateLimit) break;
        pushCandidate(candidate.pageNumber);
      }

      if (candidates.length < candidateLimit) {
        const rasterScores: Array<{ pageNumber: number; score: number }> = [];
        for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
          if (seen.has(pageNumber)) continue;
          throwIfAborted(args.abortSignal);
          const page = await pdfAny.getPage(pageNumber);
          try {
            const { canvas } = await renderPdfPageToCanvas({
              page,
              requestedDpi: 50,
              abortSignal: args.abortSignal,
              maxRenderDimension: 900,
              maxRenderPixels: 1_200_000,
            });
            const score = scoreCanvasForChartLikeContent(canvas);
            rasterScores.push({ pageNumber, score });
          } finally {
            page.cleanup();
          }
        }

        rasterScores.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
        for (const candidate of rasterScores) {
          if (candidates.length >= candidateLimit) break;
          pushCandidate(candidate.pageNumber);
        }
      }

      return { pageCount, candidates: candidates.slice(0, candidateLimit) };
    } finally {
      await (pdf as any).destroy();
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

export async function* rasterizePdfChartPageCandidatesForModel(args: {
  fileData: Buffer;
  dpi?: number;
  abortSignal?: AbortSignal;
  maxPagesToScan?: number;
  candidateLimit?: number;
}): AsyncGenerator<{ model: RasterizedPdfPage; thumbnailJpeg: RasterizedImage }> {
  const requestedDpi = args.dpi ?? DEFAULT_PDF_RASTER_DPI;
  const maxPagesToScan = Math.max(1, args.maxPagesToScan ?? 200);
  const candidateLimit = Math.max(1, args.candidateLimit ?? 12);
  throwIfAborted(args.abortSignal);

  // pdfjs may detach the passed ArrayBuffer; copy so callers can safely reuse the input Buffer.
  const pdfBytes = new Uint8Array(args.fileData);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    ...PDFJS_ASSET_URLS,
  }) as PdfLoadingTask;

  const onAbort = () => {
    void loadingTask.destroy().catch(() => undefined);
  };
  args.abortSignal?.addEventListener('abort', onAbort, { once: true });

  type TextCandidate = {
    pageNumber: number;
    scored: ReturnType<typeof scorePdfTextForChartPicker>;
  };

  try {
    const pdf = await loadingTask.promise;
    try {
      const pdfAny = pdf as any;
      const pageCount = Number(pdfAny.numPages ?? 0);
      if (!Number.isFinite(pageCount) || pageCount < 1) throw new Error('PDF has no pages');

      const scanPages = Math.min(pageCount, maxPagesToScan);
      const textCandidates: TextCandidate[] = [];

      for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
        throwIfAborted(args.abortSignal);
        const page = await pdfAny.getPage(pageNumber);
        try {
        const rawText = await getPageText(page);
          const scored = scorePdfTextForChartPicker(rawText);
          if (!looksLikeChartPage(scored)) continue;
          textCandidates.push({ pageNumber, scored });
        } finally {
          page.cleanup();
        }
      }

      textCandidates.sort((a, b) => {
        const aPreferred = a.scored.discoDanceBoost > 0 ? 1 : 0;
        const bPreferred = b.scored.discoDanceBoost > 0 ? 1 : 0;
        if (aPreferred !== bPreferred) return bPreferred - aPreferred;
        if (a.scored.effectiveScore !== b.scored.effectiveScore) return b.scored.effectiveScore - a.scored.effectiveScore;
        if (a.scored.textLength !== b.scored.textLength) return b.scored.textLength - a.scored.textLength;
        return a.pageNumber - b.pageNumber;
      });

      const yielded = new Set<number>();
      let yieldedCount = 0;

      const rasterizeCandidate = async (
        pageNumber: number,
      ): Promise<{ model: RasterizedPdfPage; thumbnailJpeg: RasterizedImage }> => {
        const page = await pdfAny.getPage(pageNumber);
        try {
          const { canvas, width, height, actualDpi } = await renderPdfPageToCanvas({
            page,
            requestedDpi,
            abortSignal: args.abortSignal,
            maxRenderDimension: MODEL_MAX_RENDER_DIMENSION,
            maxRenderPixels: MODEL_MAX_RENDER_PIXELS,
          });

          const model = encodeCanvasAsModelImage(canvas);
          const thumbnailJpeg = makeThumbnailFromCanvas(canvas);

          return {
            model: {
              ...model,
              dpi: actualDpi,
              pageCount,
              pageNumber,
              width,
              height,
            },
            thumbnailJpeg,
          };
        } finally {
          page.cleanup();
        }
      };

      const firstTextLimit = Math.min(candidateLimit, 6);
      for (const candidate of textCandidates.slice(0, firstTextLimit)) {
        if (yieldedCount >= candidateLimit) return;
        if (yielded.has(candidate.pageNumber)) continue;
        const rasterized = await rasterizeCandidate(candidate.pageNumber);
        yielded.add(candidate.pageNumber);
        yieldedCount += 1;
        yield rasterized;
      }

      if (yieldedCount >= candidateLimit) return;

      // Only compute raster-based candidates if the caller wants more pages (i.e. disco/dance wasn't
      // found in the first set of text-ranked candidates).
      const rasterScores: Array<{ pageNumber: number; score: number }> = [];
      for (let pageNumber = 1; pageNumber <= scanPages; pageNumber += 1) {
        if (yielded.has(pageNumber)) continue;
        throwIfAborted(args.abortSignal);
        const page = await pdfAny.getPage(pageNumber);
        try {
          const { canvas } = await renderPdfPageToCanvas({
            page,
            requestedDpi: 50,
            abortSignal: args.abortSignal,
            maxRenderDimension: 900,
            maxRenderPixels: 1_200_000,
          });
          const score = scoreCanvasForChartLikeContent(canvas);
          rasterScores.push({ pageNumber, score });
        } finally {
          page.cleanup();
        }
      }

      rasterScores.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

      const midRasterLimit = Math.min(candidateLimit - yieldedCount, textCandidates.length === 0 ? candidateLimit : 4);
      for (const candidate of rasterScores.slice(0, midRasterLimit)) {
        if (yieldedCount >= candidateLimit) return;
        if (yielded.has(candidate.pageNumber)) continue;
        const rasterized = await rasterizeCandidate(candidate.pageNumber);
        yielded.add(candidate.pageNumber);
        yieldedCount += 1;
        yield rasterized;
      }

      if (yieldedCount >= candidateLimit) return;

      for (const candidate of textCandidates.slice(firstTextLimit)) {
        if (yieldedCount >= candidateLimit) return;
        if (yielded.has(candidate.pageNumber)) continue;
        const rasterized = await rasterizeCandidate(candidate.pageNumber);
        yielded.add(candidate.pageNumber);
        yieldedCount += 1;
        yield rasterized;
      }

      if (yieldedCount >= candidateLimit) return;

      for (const candidate of rasterScores.slice(midRasterLimit)) {
        if (yieldedCount >= candidateLimit) return;
        if (yielded.has(candidate.pageNumber)) continue;
        const rasterized = await rasterizeCandidate(candidate.pageNumber);
        yielded.add(candidate.pageNumber);
        yieldedCount += 1;
        yield rasterized;
      }
    } finally {
      await (pdf as any).destroy();
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

function scoreCanvasForChartLikeContent(canvas: Canvas): number {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const total = Math.max(1, width * height);

  let black = 0;
  let mid = 0;
  let edges = 0;

  for (let y = 0; y < height; y += 1) {
    let prevLum = 255;
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = img.data[idx]!;
      const g = img.data[idx + 1]!;
      const b = img.data[idx + 2]!;

      // Fast-ish luminance approximation.
      const lum = (r * 3 + g * 6 + b) / 10;
      if (lum < 60) black += 1;
      else if (lum < 200) mid += 1;

      if (x > 0 && Math.abs(lum - prevLum) > 22) edges += 1;
      prevLum = lum;
    }
  }

  const blackDensity = black / total;
  const darkDensity = (black + mid) / total;
  const midDensity = mid / total;
  const edgeDensity = edges / total;
  const bimodal = blackDensity / Math.max(1e-6, darkDensity);

  // Heuristic: chart/table pages are mostly white with lots of crisp black text/lines.
  return blackDensity * 2.0 + edgeDensity * 1.4 + bimodal * 1.2 - midDensity * 1.0;
}

async function renderPdfPageToCanvas(args: {
  page: unknown;
  requestedDpi: number;
  abortSignal?: AbortSignal;
  maxRenderPixels: number;
  maxRenderDimension: number;
}): Promise<{ canvas: Canvas; width: number; height: number; actualDpi: number }> {
  throwIfAborted(args.abortSignal);

  const pageAny = args.page as any;
  const requestedScale = args.requestedDpi / PDF_POINTS_PER_INCH;
  const requestedViewport = pageAny.getViewport({ scale: requestedScale });

  const requestedWidth = Math.max(1, Math.ceil(requestedViewport.width));
  const requestedHeight = Math.max(1, Math.ceil(requestedViewport.height));
  const requestedPixels = requestedWidth * requestedHeight;

  const dimensionScale = Math.min(1, args.maxRenderDimension / requestedWidth, args.maxRenderDimension / requestedHeight);
  const pixelScale = Math.min(1, Math.sqrt(args.maxRenderPixels / requestedPixels));
  const downscale = Math.min(dimensionScale, pixelScale);
  const effectiveScale = requestedScale * (Number.isFinite(downscale) ? downscale : 1);

  const viewport = pageAny.getViewport({ scale: Math.max(effectiveScale, 1 / PDF_POINTS_PER_INCH) });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const actualDpi = Math.max(1, Math.round((args.requestedDpi * width) / Math.max(1, requestedWidth)));

  const canvas = createCanvas(width, height);
  const renderTask = pageAny.render({
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
  return { canvas, width, height, actualDpi };
}

function encodeCanvasAsModelImage(canvas: Canvas): RasterizedImage {
  // Prefer WebP to reduce upload bytes while keeping OCR-friendly quality.
  try {
    return {
      fileData: canvas.toBuffer('image/webp', MODEL_IMAGE_QUALITY),
      mimeType: 'image/webp',
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return {
      fileData: canvas.toBuffer('image/jpeg', MODEL_IMAGE_QUALITY),
      mimeType: 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
    };
  }
}

function encodeCanvasAsJpeg(canvas: Canvas, quality: number): RasterizedImage {
  return {
    fileData: canvas.toBuffer('image/jpeg', quality),
    mimeType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height,
  };
}

function makeThumbnailFromCanvas(canvas: Canvas): RasterizedImage {
  const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / canvas.width, THUMBNAIL_MAX_DIMENSION / canvas.height);
  const thumbWidth = Math.max(1, Math.round(canvas.width * scale));
  const thumbHeight = Math.max(1, Math.round(canvas.height * scale));

  const thumb = createCanvas(thumbWidth, thumbHeight);
  const ctx = thumb.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas as unknown as any, 0, 0, thumbWidth, thumbHeight);

  return encodeCanvasAsJpeg(thumb, THUMBNAIL_IMAGE_QUALITY);
}

async function rasterizePdfPageInternal(args: {
  fileData: Buffer;
  pageNumber: number;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<RasterizedPdfPage> {
  return (await rasterizePdfPageInternalWithCanvas(args)).model;
}

async function rasterizePdfPageInternalWithCanvas(args: {
  fileData: Buffer;
  pageNumber: number;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<{
  model: RasterizedPdfPage;
  thumbnailJpeg: RasterizedImage;
}> {
  const requestedDpi = args.dpi ?? DEFAULT_PDF_RASTER_DPI;
  throwIfAborted(args.abortSignal);

  // pdfjs may detach the passed ArrayBuffer; copy so callers can safely reuse the input Buffer.
  const pdfBytes = new Uint8Array(args.fileData);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    ...PDFJS_ASSET_URLS,
  }) as PdfLoadingTask;

  const onAbort = () => {
    void loadingTask.destroy().catch(() => undefined);
  };
  args.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const pdf = await loadingTask.promise;
    try {
      const pdfAny = pdf as any;
      if (pdfAny.numPages < 1) {
        throw new Error('PDF has no pages');
      }

      throwIfAborted(args.abortSignal);
      if (!Number.isFinite(args.pageNumber) || args.pageNumber < 1 || args.pageNumber > pdfAny.numPages) {
        throw new Error(`Invalid PDF page number: ${args.pageNumber}`);
      }

      const page = await pdfAny.getPage(args.pageNumber);
      try {
        const { canvas, width, height, actualDpi } = await renderPdfPageToCanvas({
          page,
          requestedDpi,
          abortSignal: args.abortSignal,
          maxRenderDimension: MODEL_MAX_RENDER_DIMENSION,
          maxRenderPixels: MODEL_MAX_RENDER_PIXELS,
        });

        const model = encodeCanvasAsModelImage(canvas);

        const thumbnailJpeg = makeThumbnailFromCanvas(canvas);
        return {
          model: {
            ...model,
            dpi: actualDpi,
            pageCount: pdfAny.numPages,
            pageNumber: args.pageNumber,
            width,
            height,
          },
          thumbnailJpeg,
        };
      } finally {
        page.cleanup();
      }
    } finally {
      await (pdf as any).destroy();
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

export async function rasterizePdfPageForModel(args: {
  fileData: Buffer;
  pageNumber: number;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<RasterizedPdfPage> {
  return rasterizePdfPageInternal(args);
}

export async function rasterizePdfPageForModelWithThumbnail(args: {
  fileData: Buffer;
  pageNumber: number;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<{ model: RasterizedPdfPage; thumbnailJpeg: RasterizedImage }> {
  return rasterizePdfPageInternalWithCanvas(args);
}

export async function rasterizePdfFirstPageForModel(args: {
  fileData: Buffer;
  dpi?: number;
  abortSignal?: AbortSignal;
}): Promise<Omit<RasterizedPdfPage, 'pageNumber'> & { pageCount: number }> {
  const result = await rasterizePdfPageInternal({ ...args, pageNumber: 1 });
  return {
    fileData: result.fileData,
    mimeType: result.mimeType,
    dpi: result.dpi,
    pageCount: result.pageCount,
    width: result.width,
    height: result.height,
  };
}

export async function rasterizePdfChartPageForModel(args: {
  fileData: Buffer;
  dpi?: number;
  abortSignal?: AbortSignal;
  maxPagesToScan?: number;
}): Promise<{
  model: RasterizedPdfPage;
  thumbnailJpeg: RasterizedImage;
}> {
  const requestedDpi = args.dpi ?? DEFAULT_PDF_RASTER_DPI;
  throwIfAborted(args.abortSignal);

  // pdfjs may detach the passed ArrayBuffer; copy so callers can safely reuse the input Buffer.
  const pdfBytes = new Uint8Array(args.fileData);
  const loadingTask = getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    ...PDFJS_ASSET_URLS,
  }) as PdfLoadingTask;

  const onAbort = () => {
    void loadingTask.destroy().catch(() => undefined);
  };
  args.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const pdf = await loadingTask.promise;
    try {
      const { pageNumber, pageCount } = await pickBestChartPageNumber({
        pdf,
        abortSignal: args.abortSignal,
        maxPagesToScan: args.maxPagesToScan ?? 40,
      });

      const pdfAny = pdf as any;
      const page = await pdfAny.getPage(pageNumber);
      try {
        const { canvas, width, height, actualDpi } = await renderPdfPageToCanvas({
          page,
          requestedDpi,
          abortSignal: args.abortSignal,
          maxRenderDimension: MODEL_MAX_RENDER_DIMENSION,
          maxRenderPixels: MODEL_MAX_RENDER_PIXELS,
        });

        const model = encodeCanvasAsModelImage(canvas);
        const thumbnailJpeg = makeThumbnailFromCanvas(canvas);

        return {
          model: {
            ...model,
            dpi: actualDpi,
            pageCount,
            pageNumber,
            width,
            height,
          },
          thumbnailJpeg,
        };
      } finally {
        page.cleanup();
      }
    } finally {
      await (pdf as any).destroy();
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

import path from 'node:path';

export type PdfRasterPreviewExt = 'webp' | 'jpg';

function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

export function pdfRasterPreviewFilename(sourcePdfFilename: string, ext: PdfRasterPreviewExt = 'webp'): string {
  const base = stripExtension(sourcePdfFilename);
  return `${base}__pdf_raster.${ext}`;
}

export function pdfRasterPreviewCandidateFilenames(sourcePdfFilename: string): string[] {
  return [pdfRasterPreviewFilename(sourcePdfFilename, 'webp'), pdfRasterPreviewFilename(sourcePdfFilename, 'jpg')];
}

export function pdfThumbnailFilename(sourcePdfFilename: string): string {
  const base = stripExtension(sourcePdfFilename);
  return `${base}__pdf_thumb.jpg`;
}

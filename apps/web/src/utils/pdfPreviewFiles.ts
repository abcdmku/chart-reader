export type PdfRasterPreviewExt = 'webp' | 'jpg';

function stripPdfExtension(sourcePdfFilename: string): string {
  return sourcePdfFilename.replace(/\.pdf$/i, '');
}

export function pdfRasterPreviewFilename(sourcePdfFilename: string, ext: PdfRasterPreviewExt = 'webp'): string {
  return stripPdfExtension(sourcePdfFilename) + `__pdf_raster.${ext}`;
}

export function pdfRasterPreviewCandidateFilenames(sourcePdfFilename: string): string[] {
  return [pdfRasterPreviewFilename(sourcePdfFilename, 'webp'), pdfRasterPreviewFilename(sourcePdfFilename, 'jpg')];
}

export function pdfThumbnailFilename(sourcePdfFilename: string): string {
  return stripPdfExtension(sourcePdfFilename) + '__pdf_thumb.jpg';
}

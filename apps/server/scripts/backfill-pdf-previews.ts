import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectories, getPaths } from '../src/paths.js';
import { rasterizePdfChartPageForModel } from '../src/pdfRasterize.js';
import { pdfRasterPreviewFilename, pdfThumbnailFilename } from '../src/pdfPreviewFiles.js';

const paths = getPaths();
ensureDirectories(paths);

const completedDir = paths.completedDir;
const entries = await fsp.readdir(completedDir, { withFileTypes: true });
const pdfNames = entries
  .filter((e) => e.isFile() && /\.pdf$/i.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b));

// eslint-disable-next-line no-console
console.log(`Found ${pdfNames.length} PDFs in ${completedDir}`);

for (const name of pdfNames) {
  const sourcePath = path.join(completedDir, name);
  const thumbPath = path.join(completedDir, pdfThumbnailFilename(name));

  const fileData = await fsp.readFile(sourcePath);
  const rasterDpi = Number(process.env.PDF_RASTER_DPI ?? process.env.PDF_MODEL_DPI ?? 300) || 300;
  const rasterized = await rasterizePdfChartPageForModel({
    fileData,
    dpi: rasterDpi,
    maxPagesToScan: 40,
  });

  const rasterExt = rasterized.model.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const previewPath = path.join(completedDir, pdfRasterPreviewFilename(name, rasterExt));

  await Promise.all([
    fsp.writeFile(previewPath, rasterized.model.fileData),
    fsp.writeFile(thumbPath, rasterized.thumbnailJpeg.fileData),
  ]);

  // eslint-disable-next-line no-console
  console.log(
    `${name}: selected page ${rasterized.model.pageNumber}/${rasterized.model.pageCount} -> ${path.basename(previewPath)}`,
  );
}

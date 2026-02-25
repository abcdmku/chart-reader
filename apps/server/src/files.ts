import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUPPORTED_PDF_EXTENSIONS = new Set(['.pdf']);
const SUPPORTED_EXTENSIONS = new Set([...SUPPORTED_IMAGE_EXTENSIONS, ...SUPPORTED_PDF_EXTENSIONS]);

export function isSupportedImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

export function isSupportedSourceFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function isSupportedUploadMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith('image/')) return true;
  return mimeType === 'application/pdf';
}

export function sanitizeFilename(originalName: string): string {
  const base = path.basename(originalName);
  const trimmed = base.trim();
  if (!trimmed) return 'upload';

  const sanitized = trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  return sanitized.length > 0 ? sanitized : 'upload';
}

function splitBaseAndExt(filename: string): { base: string; ext: string } {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return { base, ext };
}

export function makeUniqueFilename(
  desiredName: string,
  isTaken: (name: string) => boolean,
): string {
  const sanitized = sanitizeFilename(desiredName);
  const { base, ext } = splitBaseAndExt(sanitized);

  if (!isTaken(sanitized)) return sanitized;

  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base}_${i}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }

  throw new Error('Unable to find a unique filename');
}

export async function listSupportedSourceFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isSupportedSourceFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}


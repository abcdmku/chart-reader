import path from 'node:path';
import fs from 'node:fs';

export type AppPaths = {
  filesDir: string;
  newDir: string;
  completedDir: string;
  stateDir: string;
  dbPath: string;
  outputCsvPath: string;
};

export function getPaths(): AppPaths {
  const envDir = process.env.FILES_DIR?.trim();
  const defaultFilesDir = fs.existsSync('/files') ? '/files' : path.resolve(process.cwd(), 'files');
  const filesDir = envDir && envDir.length > 0 ? envDir : defaultFilesDir;

  const newDir = path.join(filesDir, 'new');
  const completedDir = path.join(filesDir, 'completed');
  const stateDir = path.join(filesDir, 'state');

  return {
    filesDir,
    newDir,
    completedDir,
    stateDir,
    dbPath: path.join(stateDir, 'app.db'),
    outputCsvPath: path.join(filesDir, 'output.csv'),
  };
}

export function ensureDirectories(paths: AppPaths): void {
  fs.mkdirSync(paths.newDir, { recursive: true });
  fs.mkdirSync(paths.completedDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
}


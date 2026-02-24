import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const configDir = path.dirname(fileURLToPath(import.meta.url));

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

const envUrl = process.env.DATABASE_URL?.trim();
const defaultUrl = 'file:./files/state/app.db';
const url = envUrl && envUrl.length > 0 ? envUrl : defaultUrl;

if (!envUrl || envUrl.length === 0) {
  const localDbPath = path.resolve(configDir, 'files', 'state', 'app.db');
  const rootDbPath = path.resolve(configDir, '..', '..', 'files', 'state', 'app.db');

  if (fileExists(localDbPath) && fileExists(rootDbPath)) {
    throw new Error(
      [
        'Multiple SQLite DB files detected:',
        `- ${localDbPath}`,
        `- ${rootDbPath}`,
        '',
        'Set DATABASE_URL to choose one, e.g.:',
        '- DATABASE_URL=file:./files/state/app.db',
        '- DATABASE_URL=file:../../files/state/app.db',
      ].join('\n'),
    );
  }
}

export default defineConfig({
  schema: './drizzle/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url },
});

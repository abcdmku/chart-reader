import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const srcDir = path.join(rootDir, 'apps', 'web', 'dist');
const destDir = path.join(rootDir, 'apps', 'server', 'public');

await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });
await fs.cp(srcDir, destDir, { recursive: true });

// eslint-disable-next-line no-console
console.log(`Copied ${srcDir} -> ${destDir}`);


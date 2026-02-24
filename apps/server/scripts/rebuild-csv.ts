import { exportCsv } from '../src/csv.js';
import { openDb } from '../src/db.js';
import { ensureDirectories, getPaths } from '../src/paths.js';

const paths = getPaths();
ensureDirectories(paths);

const db = openDb(paths.dbPath);
const result = await exportCsv(db, paths.outputCsvPath);

// eslint-disable-next-line no-console
console.log(JSON.stringify(result, null, 2));

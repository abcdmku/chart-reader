import { describe, expect, it } from 'vitest';
import { getConfig, migrate, openDb } from './db';

describe('migrate', () => {
  it('creates tables and seeds config', () => {
    const db = openDb(':memory:');
    // openDb runs migrate; calling migrate again should be safe.
    migrate(db);

    const config = getConfig(db);
    expect(config.concurrency).toBe(2);
    expect(config.paused).toBe(false);
    expect(config.model).toBe('gemini-2.5-flash');
  });
});

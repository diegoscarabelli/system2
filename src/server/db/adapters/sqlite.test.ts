import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseConnectionConfig } from '../../../shared/index.js';
import { createAdapter } from './sqlite.js';

describe('SQLite adapter', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-test-'));
    dbPath = join(tempDir, 'test.db');

    // Seed the database using better-sqlite3 in read-write mode
    const seedDb = new Database(dbPath);
    seedDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = seedDb.prepare('INSERT INTO items (name) VALUES (?)');
    for (let i = 1; i <= 20; i++) {
      insert.run(`item-${i}`);
    }
    seedDb.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<DatabaseConnectionConfig>): DatabaseConnectionConfig {
    return { type: 'sqlite', database: dbPath, ...overrides };
  }

  it('connects and queries SELECT 1 as val', async () => {
    const adapter = createAdapter(makeConfig());

    await adapter.connect();
    const rows = await adapter.query('SELECT 1 as val');

    expect(rows).toEqual([{ val: 1 }]);
  });

  it('respects max_rows cap', async () => {
    const adapter = createAdapter(makeConfig({ max_rows: 5 }));

    await adapter.connect();
    const rows = await adapter.query('SELECT * FROM items');

    expect(rows).toHaveLength(5);
  });

  it('disconnect sets connected to false', async () => {
    const adapter = createAdapter(makeConfig());

    await adapter.connect();
    expect(adapter.connected).toBe(true);

    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });

  it('auto-reconnects when querying after disconnect', async () => {
    const adapter = createAdapter(makeConfig());

    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);

    // query() should re-open the database transparently
    const rows = await adapter.query('SELECT 1 as val');
    expect(rows).toEqual([{ val: 1 }]);
    expect(adapter.connected).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createDb, createDbFromEnv } from './client';

// No live database required: the pool is lazy, so these assert validation and handle shape only.
describe('createDb', () => {
  it('rejects a non-postgres URL scheme', () => {
    expect(() => createDb('https://example.com/db')).toThrow();
  });

  it('rejects an empty connection string', () => {
    expect(() => createDb('')).toThrow();
  });

  it('builds a handle for a valid postgres:// URL without opening a connection', async () => {
    const handle = createDb('postgres://flank:flank@localhost:5432/flank');

    expect(handle.db).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await handle.close();
  });

  it('accepts the postgresql:// scheme', async () => {
    const handle = createDb('postgresql://flank:flank@localhost:5432/flank');

    expect(handle.db).toBeDefined();
    await handle.close();
  });
});

describe('createDbFromEnv', () => {
  it('throws a guiding error when DATABASE_URL is absent', () => {
    expect(() => createDbFromEnv({})).toThrow(/DATABASE_URL is not set/);
  });

  it('builds a handle from DATABASE_URL', async () => {
    const handle = createDbFromEnv({
      DATABASE_URL: 'postgres://flank:flank@localhost:5432/flank',
    });

    expect(handle.db).toBeDefined();
    await handle.close();
  });
});

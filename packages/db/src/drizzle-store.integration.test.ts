import { runFlankStoreContract } from '@flank/pipeline/store-contract';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { createDbFromEnv, type DbHandle } from './client';
import { DrizzleFlankStore } from './drizzle-store';

// Gated on DATABASE_URL: skipped on a normal local run, exercised in CI (pgvector service) or
// locally after `just db-up` + export. The suite applies migrations itself (programmatic migrator,
// not the drizzle-kit CLI) and truncates between tests, so it is fully self-contained.
const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

if (databaseUrl === undefined || databaseUrl === '') {
  // A visible skip keeps the absence of DB-backed coverage legible rather than silent.
  describe.skip('DrizzleFlankStore (integration — set DATABASE_URL to run)', () => {
    it('is skipped without DATABASE_URL', () => {});
  });
} else {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDbFromEnv();
    await migrate(handle.db, { migrationsFolder });
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    // Reset between tests; the shared suite re-seeds the same tenant ids each time.
    await handle.client.unsafe(
      'TRUNCATE TABLE "workspace","competitor","source","snapshot","delta","claim","coverage_run" RESTART IDENTITY CASCADE',
    );
  });

  runFlankStoreContract('DrizzleFlankStore', () => new DrizzleFlankStore(handle.db));
}

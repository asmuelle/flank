import { runFlankStoreContract } from '@flank/pipeline/store-contract';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      'TRUNCATE TABLE "workspace","competitor","source","snapshot","delta","claim","coverage_run","dossier_section","battlecard_section","app_user","membership","alert","alert_channel_config" RESTART IDENTITY CASCADE',
    );
  });

  runFlankStoreContract('DrizzleFlankStore', () => new DrizzleFlankStore(handle.db));

  // DB-tier append-only enforcement (migration 0002): prove the triggers reject raw SQL that
  // bypasses the app layer. These are Postgres-specific and so live beyond the shared contract.
  describe('append-only guards reject raw SQL (Invariants 3 & 5)', () => {
    const AT = new Date('2026-06-08T06:00:00Z');

    beforeEach(async () => {
      const store = new DrizzleFlankStore(handle.db);
      await store.seedWorkspace({ id: 'ws', name: 'W', planTier: 'growth' });
      await store.seedCompetitor({
        id: 'comp',
        workspaceId: 'ws',
        name: 'C',
        primaryDomain: 'c.example',
      });
      await store.seedSource({
        id: 'src',
        competitorId: 'comp',
        type: 'pricing',
        url: 'https://c.example/p',
        adapter: 'html',
        cadence: '0 6 * * *',
        legalStatus: 'open',
      });
      await store.insertSnapshot('ws', {
        id: 'snap',
        sourceId: 'src',
        contentHash: 'h',
        normalizedText: 't',
        fetchedAt: AT,
        httpStatus: 200,
        vantage: null,
      });
      await store.insertDelta('ws', {
        id: 'd-feat',
        sourceId: 'src',
        fromSnapshotId: null,
        toSnapshotId: 'snap',
        changedSpans: [],
        triageClass: 'feature_launch',
        materiality: 2,
        rationale: 'r',
        state: 'pending',
        confirmedBySnapshotId: null,
        createdAt: AT,
      });
      await store.insertDelta('ws', {
        id: 'd-price',
        sourceId: 'src',
        fromSnapshotId: null,
        toSnapshotId: 'snap',
        changedSpans: [],
        triageClass: 'pricing_change',
        materiality: 3,
        rationale: 'price',
        state: 'pending',
        confirmedBySnapshotId: null,
        createdAt: AT,
      });
      await store.insertClaim('ws', {
        id: 'c',
        deltaId: 'd-feat',
        snapshotId: 'snap',
        quoteText: 'q',
        charStart: 0,
        charEnd: 1,
        sourceUrl: 'https://c.example/p',
        capturedAt: AT,
        verifiedAt: null,
      });
    });

    const raw = (sql: string): Promise<unknown> => handle.client.unsafe(sql);

    it('rejects UPDATE and DELETE on snapshot', async () => {
      await expect(
        raw(`UPDATE "snapshot" SET "content_hash"='x' WHERE "id"='snap'`),
      ).rejects.toThrow(/append-only/);
      await expect(raw(`DELETE FROM "snapshot" WHERE "id"='snap'`)).rejects.toThrow(/append-only/);
    });

    it('rejects UPDATE and DELETE on claim', async () => {
      await expect(raw(`UPDATE "claim" SET "quote_text"='x' WHERE "id"='c'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(raw(`DELETE FROM "claim" WHERE "id"='c'`)).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE on delta', async () => {
      await expect(raw(`DELETE FROM "delta" WHERE "id"='d-feat'`)).rejects.toThrow(/append-only/);
    });

    it('rejects mutating an immutable delta column via raw SQL', async () => {
      await expect(
        raw(`UPDATE "delta" SET "rationale"='hacked' WHERE "id"='d-feat'`),
      ).rejects.toThrow(/only state and confirmed_by_snapshot_id/);
    });

    it('rejects a raw pricing pending -> published, bypassing confirmation (Invariant 3)', async () => {
      await expect(
        raw(`UPDATE "delta" SET "state"='published' WHERE "id"='d-price'`),
      ).rejects.toThrow(/confirmation required/);
    });

    it('allows the legal state advance a store transition performs', async () => {
      // Mirrors DrizzleFlankStore.transitionDelta — a legal pending -> published on a non-pricing
      // delta must pass the trigger.
      await expect(
        raw(`UPDATE "delta" SET "state"='published' WHERE "id"='d-feat'`),
      ).resolves.toBeDefined();
    });

    it('enforces UNIQUE(competitor, kind, version) on dossier sections (#7)', async () => {
      await raw(
        `INSERT INTO "dossier_section" ("id","competitor_id","kind","version","content_md") VALUES ('ds1','comp','overview',1,'a')`,
      );
      await expect(
        raw(
          `INSERT INTO "dossier_section" ("id","competitor_id","kind","version","content_md") VALUES ('ds2','comp','overview',1,'b')`,
        ),
      ).rejects.toThrow();
    });

    it('raw SQL cannot un-deliver, delete, or rewrite a delivered alert (M3 delivery guard)', async () => {
      const store = new DrizzleFlankStore(handle.db);
      await store.seedChannelConfig({
        id: 'cfg',
        workspaceId: 'ws',
        channel: 'email',
        destination: 'alerts@c.example',
        label: null,
        enabled: true,
        createdAt: AT,
      });
      await store.enqueueAlert('ws', {
        id: 'al',
        workspaceId: 'ws',
        deltaId: 'd-feat',
        channel: 'email',
        channelConfigId: 'cfg',
        target: 'alerts@c.example',
        payload: { deltaId: 'd-feat' },
        status: 'queued',
        attemptCount: 0,
        providerRef: null,
        lastError: null,
        enqueuedAt: AT,
        lastAttemptAt: null,
        deliveredAt: null,
      });
      await store.recordAlertOutcome('ws', 'al', 'delivered', { providerRef: 'ref-1' }, AT);

      // delivered is terminal: no path (raw SQL included) flips it back and re-sends.
      await expect(raw(`UPDATE "alert" SET "status"='queued' WHERE "id"='al'`)).rejects.toThrow(
        /terminal/,
      );
      // identity/provenance columns are immutable.
      await expect(raw(`UPDATE "alert" SET "target"='evil@x' WHERE "id"='al'`)).rejects.toThrow(
        /immutable/,
      );
      // the delivery log is never deleted.
      await expect(raw(`DELETE FROM "alert" WHERE "id"='al'`)).rejects.toThrow(/append-only/);

      // A proofless delivery is rejected even via raw SQL (use a fresh queued alert).
      await store.enqueueAlert('ws', {
        id: 'al2',
        workspaceId: 'ws',
        deltaId: 'd-price',
        channel: 'email',
        channelConfigId: 'cfg',
        target: 'alerts@c.example',
        payload: { deltaId: 'd-price' },
        status: 'queued',
        attemptCount: 0,
        providerRef: null,
        lastError: null,
        enqueuedAt: AT,
        lastAttemptAt: null,
        deliveredAt: null,
      });
      await expect(
        raw(`UPDATE "alert" SET "status"='delivered', "delivered_at"=now() WHERE "id"='al2'`),
      ).rejects.toThrow(/proof/);
    });
  });
}

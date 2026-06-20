import {
  AppendOnlyViolationError,
  CrossTenantError,
  IllegalTransitionError,
  UnknownEntityError,
  type BattlecardSection,
  type Claim,
  type CoverageRun,
  type Delta,
  type DossierSection,
  type FlankStore,
  type Snapshot,
} from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The canonical behavioural contract every {@link FlankStore} implementation must satisfy. It is a
 * function of a store factory so the same suite runs against `MemoryFlankStore` today and against a
 * `DrizzleFlankStore` later — the interface is frozen behind these assertions, so the DB store is a
 * mechanical implementation of a tested spec rather than a fresh design.
 *
 * Covers: append-only history (Invariant 5), workspace-scoped writes AND reads (Invariant 8), the
 * pricing-confirmation firewall (Invariant 3), and atomic {@link FlankStore.withTransaction}.
 */
const AT = new Date('2026-06-08T06:00:00Z');

const WS_A = { id: 'ws-a', name: 'Tenant A', planTier: 'growth' } as const;
const WS_B = { id: 'ws-b', name: 'Tenant B', planTier: 'starter' } as const;
const COMP_A = {
  id: 'comp-a',
  workspaceId: 'ws-a',
  name: 'Rival A',
  primaryDomain: 'a.example',
} as const;
const COMP_B = {
  id: 'comp-b',
  workspaceId: 'ws-b',
  name: 'Rival B',
  primaryDomain: 'b.example',
} as const;
const SRC_A = {
  id: 'src-a',
  competitorId: 'comp-a',
  type: 'pricing',
  url: 'https://a.example/pricing',
  adapter: 'html',
  cadence: '0 6 * * *',
  legalStatus: 'open',
} as const;
const SRC_B = {
  id: 'src-b',
  competitorId: 'comp-b',
  type: 'pricing',
  url: 'https://b.example/pricing',
  adapter: 'html',
  cadence: '0 6 * * *',
  legalStatus: 'open',
} as const;

const snapshotOn = (sourceId: string, id: string, contentHash = `hash-${id}`): Snapshot => ({
  id,
  sourceId,
  contentHash,
  normalizedText: 'normalized text',
  fetchedAt: AT,
  httpStatus: 200,
  vantage: null,
});

const deltaOn = (sourceId: string, id: string, overrides: Partial<Delta> = {}): Delta => ({
  id,
  sourceId,
  fromSnapshotId: null,
  toSnapshotId: `${id}-to`,
  changedSpans: [],
  triageClass: 'feature_launch',
  materiality: 2,
  rationale: 'reason',
  state: 'pending',
  confirmedBySnapshotId: null,
  createdAt: AT,
  ...overrides,
});

const claimOn = (deltaId: string, id: string, snapshotId: string): Claim => ({
  id,
  deltaId,
  snapshotId,
  quoteText: 'quote',
  charStart: 0,
  charEnd: 5,
  sourceUrl: 'https://a.example/pricing',
  capturedAt: AT,
  verifiedAt: null,
});

const coverageOn = (
  workspaceId: string,
  id: string,
  over: Partial<CoverageRun> = {},
): CoverageRun => ({
  id,
  workspaceId,
  period: '2026-06-08',
  sourcesChecked: 1,
  fetchFailures: 0,
  deltasFound: 1,
  materialDeltas: 1,
  llmCalls: 1,
  llmCostMicros: 0,
  createdAt: AT,
  ...over,
});

const dossierOn = (
  competitorId: string,
  id: string,
  version: number,
  over: Partial<DossierSection> = {},
): DossierSection => ({
  id,
  competitorId,
  kind: 'pricing',
  version,
  contentMd: `# pricing v${version}`,
  claimIds: [],
  model: 'claude-sonnet-4-6',
  batchId: 'batch-1',
  supersedesId: null,
  createdAt: AT,
  ...over,
});

const battlecardOn = (
  competitorId: string,
  id: string,
  version: number,
  over: Partial<BattlecardSection> = {},
): BattlecardSection => ({
  id,
  competitorId,
  kind: 'pricing_counter',
  version,
  contentMd: `# pricing_counter v${version}`,
  claimIds: [],
  supersedesId: null,
  createdAt: AT,
  ...over,
});

export const runFlankStoreContract = (label: string, makeStore: () => FlankStore): void => {
  describe(`FlankStore contract: ${label}`, () => {
    let store: FlankStore;

    /** Insert a delta's referenced snapshot first, then the delta — FK-realistic for any backend. */
    const seedDelta = async (
      workspaceId: string,
      sourceId: string,
      deltaId: string,
      overrides: Partial<Delta> = {},
    ): Promise<Delta> => {
      const snapshotId = `${deltaId}-snap`;
      await store.insertSnapshot(workspaceId, snapshotOn(sourceId, snapshotId));
      return store.insertDelta(
        workspaceId,
        deltaOn(sourceId, deltaId, { toSnapshotId: snapshotId, ...overrides }),
      );
    };

    beforeEach(async () => {
      store = makeStore();
      await store.seedWorkspace(WS_A);
      await store.seedCompetitor(COMP_A);
      await store.seedSource(SRC_A);
      await store.seedWorkspace(WS_B);
      await store.seedCompetitor(COMP_B);
      await store.seedSource(SRC_B);
    });

    describe('append-only history (Invariant 5)', () => {
      it('rejects a duplicate snapshot id', async () => {
        await store.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-1'));
        await expect(
          store.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-1')),
        ).rejects.toBeInstanceOf(AppendOnlyViolationError);
      });

      it('rejects a duplicate delta id', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-1');
        // Reuse the seeded snapshot so only the primary key collides — a FK-backed store must not
        // surface a foreign-key error here instead of the append-only breach.
        await expect(
          store.insertDelta(WS_A.id, deltaOn(SRC_A.id, 'd-1', { toSnapshotId: 'd-1-snap' })),
        ).rejects.toBeInstanceOf(AppendOnlyViolationError);
      });

      it('rejects a duplicate claim id', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-1');
        await store.insertClaim(WS_A.id, claimOn('d-1', 'c-1', 'd-1-snap'));
        await expect(
          store.insertClaim(WS_A.id, claimOn('d-1', 'c-1', 'd-1-snap')),
        ).rejects.toBeInstanceOf(AppendOnlyViolationError);
      });
    });

    describe('unknown parents fail explicitly', () => {
      it('rejects a snapshot for an unknown source', async () => {
        await expect(
          store.insertSnapshot(WS_A.id, snapshotOn('nope', 'snap-x')),
        ).rejects.toBeInstanceOf(UnknownEntityError);
      });

      it('rejects a delta for an unknown source', async () => {
        await expect(store.insertDelta(WS_A.id, deltaOn('nope', 'd-x'))).rejects.toBeInstanceOf(
          UnknownEntityError,
        );
      });

      it('rejects a claim for an unknown delta', async () => {
        await expect(
          store.insertClaim(WS_A.id, claimOn('nope', 'c-x', 'snap-x')),
        ).rejects.toBeInstanceOf(UnknownEntityError);
      });
    });

    describe('workspace-scoped writes fail closed (Invariant 8)', () => {
      it('refuses to insert a snapshot into another tenant’s source', async () => {
        await expect(
          store.insertSnapshot(WS_B.id, snapshotOn(SRC_A.id, 'snap-leak')),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });

      it('refuses to insert a delta onto another tenant’s source', async () => {
        await expect(
          store.insertDelta(WS_B.id, deltaOn(SRC_A.id, 'd-leak')),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });

      it('refuses to transition another tenant’s delta', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-a');
        await expect(store.transitionDelta(WS_B.id, 'd-a', 'dismissed')).rejects.toBeInstanceOf(
          CrossTenantError,
        );
      });

      it('refuses to attach a claim to another tenant’s delta', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-a');
        await expect(
          store.insertClaim(WS_B.id, claimOn('d-a', 'c-leak', 'd-a-snap')),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });

      it('refuses a latest-snapshot lookup against another tenant’s source', async () => {
        await expect(store.latestSnapshot(WS_B.id, SRC_A.id)).rejects.toBeInstanceOf(
          CrossTenantError,
        );
      });
    });

    describe('getSnapshot is workspace-scoped', () => {
      it('returns a snapshot to its owner, null to other tenants and unknown ids', async () => {
        await store.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-x'));

        expect((await store.getSnapshot(WS_A.id, 'snap-x'))?.id).toBe('snap-x');
        expect(await store.getSnapshot(WS_B.id, 'snap-x')).toBeNull();
        expect(await store.getSnapshot(WS_A.id, 'missing')).toBeNull();
      });
    });

    describe('workspace-scoped reads never leak (Invariant 8)', () => {
      beforeEach(async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-a');
        await store.insertClaim(WS_A.id, claimOn('d-a', 'c-a', 'd-a-snap'));
        await store.insertCoverageRun(coverageOn(WS_A.id, 'cov-a'));
      });

      it('does not return another workspace’s deltas, claims, or coverage', async () => {
        expect(await store.listDeltas(WS_B.id)).toEqual([]);
        expect(await store.listClaimsForDelta(WS_B.id, 'd-a')).toEqual([]);
        expect(await store.listCoverageRuns(WS_B.id)).toEqual([]);
      });

      it('returns the owning workspace’s rows', async () => {
        expect(await store.listDeltas(WS_A.id)).toHaveLength(1);
        expect(await store.listClaimsForDelta(WS_A.id, 'd-a')).toHaveLength(1);
        expect(await store.listCoverageRuns(WS_A.id)).toHaveLength(1);
      });
    });

    describe('delta state machine & pricing firewall (Invariant 3)', () => {
      it('publishes a non-pricing delta directly', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-feat', { triageClass: 'feature_launch' });
        const published = await store.transitionDelta(WS_A.id, 'd-feat', 'published');
        expect(published.state).toBe('published');
      });

      it('forbids a pricing delta from going pending → published', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-price', { triageClass: 'pricing_change' });
        await expect(store.transitionDelta(WS_A.id, 'd-price', 'published')).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
      });

      it('refuses to confirm without a reproducing snapshot', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-price', { triageClass: 'pricing_change' });
        await expect(store.transitionDelta(WS_A.id, 'd-price', 'confirmed')).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
      });

      it('lets a confirmed pricing delta publish and retains the confirming snapshot', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-price', { triageClass: 'pricing_change' });
        await store.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-confirm'));

        const confirmed = await store.transitionDelta(
          WS_A.id,
          'd-price',
          'confirmed',
          'snap-confirm',
        );
        expect(confirmed.state).toBe('confirmed');
        expect(confirmed.confirmedBySnapshotId).toBe('snap-confirm');

        const published = await store.transitionDelta(WS_A.id, 'd-price', 'published');
        expect(published.state).toBe('published');
        expect(published.confirmedBySnapshotId).toBe('snap-confirm');
      });

      it('keeps dismissed terminal (evidence retained, never resurrected)', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-noise', { triageClass: 'noise' });
        await store.transitionDelta(WS_A.id, 'd-noise', 'dismissed');
        await expect(store.transitionDelta(WS_A.id, 'd-noise', 'published')).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
      });
    });

    describe('scheduler surface (cross-tenant)', () => {
      it('lists every tenant’s sources with health and records fetched/failed', async () => {
        const initial = await store.listSourcesForScheduling();
        expect(initial.map((s) => s.source.id).sort()).toEqual(['src-a', 'src-b']);
        expect(initial.every((s) => s.lastFetchedAt === null && s.consecutiveFailures === 0)).toBe(
          true,
        );

        await store.markSourceFailed('src-a');
        await store.markSourceFailed('src-a');
        await store.markSourceFetched('src-b', AT);

        const after = await store.listSourcesForScheduling();
        const a = after.find((s) => s.source.id === 'src-a');
        const b = after.find((s) => s.source.id === 'src-b');
        expect(a?.consecutiveFailures).toBe(2);
        expect(b?.consecutiveFailures).toBe(0);
        expect(b?.lastFetchedAt?.getTime()).toBe(AT.getTime());
      });

      it('marking a source fetched resets its failure streak', async () => {
        await store.markSourceFailed('src-a');
        await store.markSourceFetched('src-a', AT);
        const a = (await store.listSourcesForScheduling()).find((s) => s.source.id === 'src-a');
        expect(a?.consecutiveFailures).toBe(0);
      });

      it('lists only pending pricing deltas across tenants, with context', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-price', { triageClass: 'pricing_change' });
        await seedDelta(WS_A.id, SRC_A.id, 'd-feat', { triageClass: 'feature_launch' });

        const pending = await store.listPendingPricingDeltasForScheduling();
        expect(pending.map((p) => p.delta.id)).toEqual(['d-price']);
        expect(pending[0]?.workspace.id).toBe(WS_A.id);
        expect(pending[0]?.source.id).toBe(SRC_A.id);
      });
    });

    describe('monthToDateCostMicros (budget gate sum)', () => {
      it('sums only the workspace and the period prefix', async () => {
        await store.insertCoverageRun(
          coverageOn(WS_A.id, 'cov-1', { period: '2026-06-08', llmCostMicros: 300 }),
        );
        await store.insertCoverageRun(
          coverageOn(WS_A.id, 'cov-2', { period: '2026-06-20', llmCostMicros: 700 }),
        );
        await store.insertCoverageRun(
          coverageOn(WS_A.id, 'cov-may', { period: '2026-05-31', llmCostMicros: 9999 }),
        );
        await store.insertCoverageRun(
          coverageOn(WS_B.id, 'cov-b', { period: '2026-06-08', llmCostMicros: 5000 }),
        );

        expect(await store.monthToDateCostMicros(WS_A.id, '2026-06')).toBe(1000);
        expect(await store.monthToDateCostMicros(WS_B.id, '2026-06')).toBe(5000);
        expect(await store.monthToDateCostMicros(WS_A.id, '2026-07')).toBe(0);
      });
    });

    describe('synthesis surface: section version chains (M2)', () => {
      it('builds an append-only (competitor, kind) version chain via supersedesId', async () => {
        const v1 = await store.insertDossierSection(WS_A.id, dossierOn(COMP_A.id, 'ds-1', 1));
        expect(v1.supersedesId).toBeNull();
        expect((await store.latestDossierSection(WS_A.id, COMP_A.id, 'pricing'))?.id).toBe('ds-1');

        const v2 = await store.insertDossierSection(
          WS_A.id,
          dossierOn(COMP_A.id, 'ds-2', 2, { supersedesId: 'ds-1' }),
        );
        expect(v2.version).toBe(2);
        // The chain pointer actually references the prior version — not decorative.
        expect(v2.supersedesId).toBe('ds-1');
        const head = await store.latestDossierSection(WS_A.id, COMP_A.id, 'pricing');
        expect(head?.id).toBe('ds-2');
        expect(await store.listDossierSections(WS_A.id, COMP_A.id)).toHaveLength(2);
      });

      it('rejects a duplicate (competitor, kind, version)', async () => {
        await store.insertDossierSection(WS_A.id, dossierOn(COMP_A.id, 'ds-1', 1));
        await expect(
          store.insertDossierSection(WS_A.id, dossierOn(COMP_A.id, 'ds-dup', 1)),
        ).rejects.toBeInstanceOf(AppendOnlyViolationError);
      });

      it('scopes section writes and reads to the owning workspace (Invariant 8)', async () => {
        await expect(
          store.insertDossierSection(WS_B.id, dossierOn(COMP_A.id, 'ds-leak', 1)),
        ).rejects.toBeInstanceOf(CrossTenantError);
        await expect(
          store.latestDossierSection(WS_B.id, COMP_A.id, 'pricing'),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });

      it('supports battlecard chains too', async () => {
        await store.insertBattlecardSection(WS_A.id, battlecardOn(COMP_A.id, 'bc-1', 1));
        expect(
          (await store.latestBattlecardSection(WS_A.id, COMP_A.id, 'pricing_counter'))?.id,
        ).toBe('bc-1');
      });

      it('frees the reserved version when an inserting transaction rolls back', async () => {
        await expect(
          store.withTransaction(async (tx) => {
            await tx.insertDossierSection(WS_A.id, dossierOn(COMP_A.id, 'ds-rb', 1));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        // v1 must be insertable again — the rolled-back reservation was released.
        const again = await store.insertDossierSection(WS_A.id, dossierOn(COMP_A.id, 'ds-ok', 1));
        expect(again.version).toBe(1);
      });
    });

    describe('synthesis surface: claim resolver + confirmed material deltas (M2)', () => {
      it('resolves claim ids workspace-scoped (foreign tenant gets nothing)', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-1');
        await store.insertClaim(WS_A.id, claimOn('d-1', 'c-1', 'd-1-snap'));

        const resolved = await store.getClaimsByIds(WS_A.id, ['c-1', 'missing']);
        expect(resolved.map((c) => c.id)).toEqual(['c-1']);
        expect(await store.getClaimsByIds(WS_B.id, ['c-1'])).toEqual([]);
      });

      it('lists only confirmed/published, material, non-noise deltas for a competitor', async () => {
        await seedDelta(WS_A.id, SRC_A.id, 'd-pub', {
          state: 'published',
          materiality: 2,
          triageClass: 'feature_launch',
        });
        await seedDelta(WS_A.id, SRC_A.id, 'd-pending', {
          state: 'pending',
          materiality: 3,
          triageClass: 'pricing_change',
        });
        await seedDelta(WS_A.id, SRC_A.id, 'd-noise', {
          state: 'published',
          materiality: 0,
          triageClass: 'noise',
        });

        const material = await store.listConfirmedMaterialDeltasForCompetitor(WS_A.id, COMP_A.id);
        expect(material.map((d) => d.id)).toEqual(['d-pub']);
      });
    });

    describe('withTransaction is atomic', () => {
      it('rolls back every write when the transaction throws', async () => {
        await expect(
          store.withTransaction(async (tx) => {
            await tx.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-rollback'));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        expect(await store.latestSnapshot(WS_A.id, SRC_A.id)).toBeNull();
      });

      it('commits every write when the transaction resolves', async () => {
        await store.withTransaction(async (tx) => {
          await tx.insertSnapshot(WS_A.id, snapshotOn(SRC_A.id, 'snap-commit'));
          await tx.insertDelta(
            WS_A.id,
            deltaOn(SRC_A.id, 'd-commit', { toSnapshotId: 'snap-commit' }),
          );
        });

        const latest = await store.latestSnapshot(WS_A.id, SRC_A.id);
        expect(latest?.id).toBe('snap-commit');
        expect(await store.listDeltas(WS_A.id)).toHaveLength(1);
      });
    });
  });
};

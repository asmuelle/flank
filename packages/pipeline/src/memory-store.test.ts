import {
  AppendOnlyViolationError,
  IllegalTransitionError,
  UnknownEntityError,
  type Delta,
  type Snapshot,
} from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFlankStore } from './memory-store';

const WORKSPACE = { id: 'ws-1', name: 'One', planTier: 'starter' } as const;
const COMPETITOR = {
  id: 'comp-1',
  workspaceId: 'ws-1',
  name: 'Periscope Labs',
  primaryDomain: 'periscope.example',
} as const;
const SOURCE = {
  id: 'src-1',
  competitorId: 'comp-1',
  type: 'pricing',
  url: 'https://periscope.example/pricing',
  adapter: 'html',
  cadence: '0 6 * * *',
  legalStatus: 'open',
} as const;

const snapshot = (id: string): Snapshot => ({
  id,
  sourceId: 'src-1',
  contentHash: `hash-${id}`,
  normalizedText: 'text',
  fetchedAt: new Date('2026-06-01T06:00:00Z'),
  httpStatus: 200,
});

const delta = (id: string): Delta => ({
  id,
  sourceId: 'src-1',
  fromSnapshotId: 'snap-1',
  toSnapshotId: 'snap-2',
  changedSpans: [],
  triageClass: 'pricing_change',
  materiality: 3,
  rationale: 'price changed',
  state: 'pending',
  createdAt: new Date('2026-06-08T06:30:00Z'),
});

describe('MemoryFlankStore', () => {
  let store: MemoryFlankStore;

  beforeEach(async () => {
    store = new MemoryFlankStore();
    await store.seedWorkspace(WORKSPACE);
    await store.seedCompetitor(COMPETITOR);
    await store.seedSource(SOURCE);
  });

  it('rejects inserts referencing unknown parents (explicit boundary errors)', async () => {
    // Arrange
    const fresh = new MemoryFlankStore();

    // Act & Assert
    await expect(
      fresh.seedCompetitor({ ...COMPETITOR, workspaceId: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownEntityError);
    await expect(
      store.insertSnapshot({ ...snapshot('s1'), sourceId: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownEntityError);
  });

  describe('append-only history (Invariant 5)', () => {
    it('rejects duplicate snapshot ids', async () => {
      // Arrange
      await store.insertSnapshot(snapshot('snap-1'));

      // Act & Assert
      await expect(store.insertSnapshot(snapshot('snap-1'))).rejects.toBeInstanceOf(
        AppendOnlyViolationError,
      );
    });

    it('returns frozen records that cannot be mutated', async () => {
      // Arrange
      const stored = await store.insertSnapshot(snapshot('snap-1'));

      // Act & Assert
      expect(Object.isFrozen(stored)).toBe(true);
      expect(() => {
        (stored as { contentHash: string }).contentHash = 'tampered';
      }).toThrow(TypeError);
    });

    it('exposes no delete operation for history records', () => {
      // Arrange & Act
      const methodNames = Object.getOwnPropertyNames(MemoryFlankStore.prototype);

      // Assert
      expect(methodNames.filter((name) => /delete|remove|drop/i.test(name))).toEqual([]);
    });
  });

  describe('delta state machine (Invariant 3 firewall)', () => {
    it('allows pending → confirmed and confirmed → published', async () => {
      // Arrange
      await store.insertSnapshot(snapshot('snap-1'));
      await store.insertSnapshot(snapshot('snap-2'));
      await store.insertDelta(delta('d-1'));

      // Act
      const confirmed = await store.transitionDelta('d-1', 'confirmed');
      const published = await store.transitionDelta('d-1', 'published');

      // Assert
      expect(confirmed.state).toBe('confirmed');
      expect(published.state).toBe('published');
    });

    it('rejects transitions out of dismissed (evidence is retained, never resurrected)', async () => {
      // Arrange
      await store.insertDelta(delta('d-1'));
      await store.transitionDelta('d-1', 'dismissed');

      // Act & Assert
      await expect(store.transitionDelta('d-1', 'published')).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );
    });
  });

  describe('workspace scoping (Invariant 8: tenant isolation)', () => {
    it('never returns another workspace’s deltas, claims, or coverage', async () => {
      // Arrange: second tenant with its own graph
      await store.seedWorkspace({ id: 'ws-2', name: 'Two', planTier: 'starter' });
      await store.seedCompetitor({
        id: 'comp-2',
        workspaceId: 'ws-2',
        name: 'Other Corp',
        primaryDomain: 'other.example',
      });
      await store.seedSource({ ...SOURCE, id: 'src-2', competitorId: 'comp-2' });
      await store.insertDelta(delta('d-1'));
      await store.insertClaim({
        id: 'c-1',
        deltaId: 'd-1',
        snapshotId: 'snap-2',
        quoteText: '$39 per month',
        charStart: 0,
        charEnd: 13,
        sourceUrl: SOURCE.url,
        capturedAt: new Date(),
        verifiedAt: null,
      });
      await store.insertCoverageRun({
        id: 'cov-1',
        workspaceId: 'ws-1',
        period: '2026-06-08',
        sourcesChecked: 1,
        fetchFailures: 0,
        deltasFound: 1,
        materialDeltas: 1,
        llmCalls: 1,
        llmCostCents: 0,
        createdAt: new Date(),
      });

      // Act & Assert
      expect(await store.listDeltas('ws-2')).toEqual([]);
      expect(await store.listClaimsForDelta('ws-2', 'd-1')).toEqual([]);
      expect(await store.listCoverageRuns('ws-2')).toEqual([]);
      expect(await store.listDeltas('ws-1')).toHaveLength(1);
      expect(await store.listClaimsForDelta('ws-1', 'd-1')).toHaveLength(1);
    });
  });
});

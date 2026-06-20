import { type Snapshot } from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFlankStore } from './memory-store';

// The behavioural FlankStore contract (append-only, tenant scoping, the pricing firewall, atomic
// transactions) is exercised by the shared suite in memory-store.contract.test.ts. This file keeps
// only assertions specific to the in-memory implementation.

const WS = { id: 'ws-1', name: 'One', planTier: 'starter' } as const;
const COMP = {
  id: 'comp-1',
  workspaceId: 'ws-1',
  name: 'Periscope Labs',
  primaryDomain: 'periscope.example',
} as const;
const SRC = {
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
  vantage: null,
});

describe('MemoryFlankStore implementation specifics', () => {
  let store: MemoryFlankStore;

  beforeEach(async () => {
    store = new MemoryFlankStore();
    await store.seedWorkspace(WS);
    await store.seedCompetitor(COMP);
    await store.seedSource(SRC);
  });

  it('returns frozen records that cannot be mutated (Invariant 5)', async () => {
    // Arrange
    const stored = await store.insertSnapshot('ws-1', snapshot('snap-1'));

    // Act & Assert
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { contentHash: string }).contentHash = 'tampered';
    }).toThrow(TypeError);
  });

  it('exposes no delete operation for history records (Invariant 5)', () => {
    // Arrange & Act
    const methodNames = Object.getOwnPropertyNames(MemoryFlankStore.prototype);

    // Assert
    expect(methodNames.filter((name) => /delete|remove|drop/i.test(name))).toEqual([]);
  });
});

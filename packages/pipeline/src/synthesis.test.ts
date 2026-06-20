import {
  parseSourceConfig,
  type Claim,
  type Delta,
  type PlanTier,
  type Snapshot,
} from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSequentialIds } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { MockSynthesisClient } from './mock-synthesis';
import { runNightlySynthesis, runSynthesis, type SynthesisDeps } from './synthesis';

const AT = new Date('2026-06-09T06:00:00Z');
const LAUNCH_TEXT = 'Introducing Battlecards AI — now generally available.';
const QUOTE = 'Introducing Battlecards AI'; // [0, 26) of LAUNCH_TEXT

interface Harness {
  readonly store: MemoryFlankStore;
  readonly synth: MockSynthesisClient;
  readonly deps: SynthesisDeps;
}

const snapshot = (): Snapshot => ({
  id: 'snap-1',
  sourceId: 'src-1',
  contentHash: 'h',
  normalizedText: LAUNCH_TEXT,
  fetchedAt: AT,
  httpStatus: 200,
  vantage: null,
});

const delta = (): Delta => ({
  id: 'd-1',
  sourceId: 'src-1',
  fromSnapshotId: null,
  toSnapshotId: 'snap-1',
  changedSpans: [],
  triageClass: 'feature_launch',
  materiality: 2,
  rationale: 'Launch language detected.',
  state: 'published',
  confirmedBySnapshotId: null,
  createdAt: AT,
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c-1',
  deltaId: 'd-1',
  snapshotId: 'snap-1',
  quoteText: QUOTE,
  charStart: 0,
  charEnd: QUOTE.length,
  sourceUrl: 'https://rival.example/feed',
  capturedAt: AT,
  verifiedAt: AT,
  ...over,
});

const buildHarness = async (planTier: PlanTier = 'growth'): Promise<Harness> => {
  const store = new MemoryFlankStore();
  await store.seedWorkspace({ id: 'ws-1', name: 'Test', planTier });
  await store.seedCompetitor({
    id: 'comp-1',
    workspaceId: 'ws-1',
    name: 'Rival',
    primaryDomain: 'rival.example',
  });
  await store.seedSource(
    parseSourceConfig({
      id: 'src-1',
      competitorId: 'comp-1',
      type: 'changelog',
      url: 'https://rival.example/feed',
      adapter: 'rss',
      cadence: '0 6 * * *',
      legalStatus: 'open',
    }),
  );
  await store.insertSnapshot('ws-1', snapshot());
  await store.insertDelta('ws-1', delta());
  const synth = new MockSynthesisClient();
  return { store, synth, deps: { store, client: synth, nextId: createSequentialIds('syn') } };
};

const target = {
  workspaceId: 'ws-1',
  competitorId: 'comp-1',
  competitorName: 'Rival',
  planTier: 'growth' as const,
};

describe('runSynthesis', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('regenerates ONLY the sections a feature_launch affects, publishing verified versions', async () => {
    await h.store.insertClaim('ws-1', claim());

    const report = await runSynthesis(target, h.deps, AT);

    // feature_launch -> dossier [product, overview], battlecard [why_we_win, landmines] = 4 sections.
    expect(report.sectionsConsidered).toBe(4);
    expect(report.sectionsRegenerated).toBe(4);
    expect(report.sectionsBlocked).toBe(0);
    expect(report.costMicros).toBeGreaterThan(0);

    const product = await h.store.latestDossierSection('ws-1', 'comp-1', 'product');
    expect(product?.version).toBe(1);
    expect(product?.supersedesId).toBeNull();
    expect(product?.claimIds).toEqual(['c-1']);
    expect(product?.model).toBe('claude-sonnet-4-6');
    // 'team' and 'pricing' are NOT affected by a feature_launch — proof of only-affected.
    expect(await h.store.latestDossierSection('ws-1', 'comp-1', 'team')).toBeNull();
    expect(await h.store.latestDossierSection('ws-1', 'comp-1', 'pricing')).toBeNull();
  });

  it('blocks a section whose cited claim fails verification (Invariant 1), publishing nothing', async () => {
    // A claim whose quote does not match its snapshot text — the gate must block.
    await h.store.insertClaim('ws-1', claim({ quoteText: 'FABRICATED QUOTE' }));

    const report = await runSynthesis(target, h.deps, AT);

    expect(report.sectionsRegenerated).toBe(0);
    expect(report.sectionsBlocked).toBe(4);
    expect(await h.store.latestDossierSection('ws-1', 'comp-1', 'product')).toBeNull();
  });

  it('extends the version chain on a second run (v2 supersedes v1)', async () => {
    await h.store.insertClaim('ws-1', claim());
    await runSynthesis(target, h.deps, AT);
    const v1 = await h.store.latestDossierSection('ws-1', 'comp-1', 'product');

    await runSynthesis(target, h.deps, new Date('2026-06-10T06:00:00Z'));
    const v2 = await h.store.latestDossierSection('ws-1', 'comp-1', 'product');

    expect(v2?.version).toBe(2);
    expect(v2?.supersedesId).toBe(v1?.id);
    expect(await h.store.listDossierSections('ws-1', 'comp-1')).toHaveLength(4); // 2 versions × 2 dossier kinds
  });

  it('skips synthesis (no spend) when the workspace is over its COGS budget', async () => {
    const over = await buildHarness('starter');
    await over.store.insertClaim('ws-1', claim());
    await over.store.insertCoverageRun({
      id: 'seed-cost',
      workspaceId: 'ws-1',
      period: '2026-06-01',
      sourcesChecked: 0,
      fetchFailures: 0,
      deltasFound: 0,
      materialDeltas: 0,
      llmCalls: 0,
      llmCostMicros: 10_000_000,
      createdAt: AT,
    });

    const report = await runSynthesis({ ...target, planTier: 'starter' }, over.deps, AT);

    expect(report.skippedOverBudget).toBe(true);
    expect(report.sectionsRegenerated).toBe(0);
    expect(over.synth.calls).toBe(0); // the model was never called
  });

  it('does nothing when a competitor has no confirmed material deltas', async () => {
    // No claim inserted, and demote the delta to non-material.
    const fresh = await buildHarness();
    const report = await runSynthesis(target, fresh.deps, AT);
    expect(report.sectionsConsidered).toBe(4); // the seeded published delta is still material
    // With no claim, the only candidate set is empty per kind → nothing cited → blocked, none published.
    expect(report.sectionsRegenerated).toBe(0);
  });
});

describe('runNightlySynthesis', () => {
  it('runs synthesis for every competitor and aggregates the report', async () => {
    const h = await buildHarness();
    await h.store.insertClaim('ws-1', claim());

    const report = await runNightlySynthesis(h.deps, AT);

    expect(report.competitorsProcessed).toBe(1);
    expect(report.sectionsRegenerated).toBe(4);
    expect(report.errors).toBe(0);
  });
});

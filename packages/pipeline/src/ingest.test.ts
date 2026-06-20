import { parseSourceConfig, type Source, type Workspace } from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSequentialIds, ingestFetch, type IngestDeps } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { MockTriageClient } from './mock-triage';

const FETCHED_AT = new Date('2026-06-08T06:00:00Z');
const LATER = new Date('2026-06-09T06:00:00Z');

const PRICING_V1 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$59 per month</p></body></html>';
const PRICING_V2 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$39 per month</p></body></html>';
const ABOUT_V1 = '<html><body><p>About us</p></body></html>';
const ABOUT_V2 = '<html><body><p>About our team</p></body></html>';

interface Harness {
  readonly workspace: Workspace;
  readonly store: MemoryFlankStore;
  readonly triage: MockTriageClient;
  readonly deps: IngestDeps;
  readonly makeSource: (
    overrides?: Partial<Record<'type' | 'legalStatus', string>>,
  ) => Promise<Source>;
}

const buildHarness = async (): Promise<Harness> => {
  const store = new MemoryFlankStore();
  const triage = new MockTriageClient();
  const workspace = await store.seedWorkspace({ id: 'ws-1', name: 'Test', planTier: 'starter' });
  await store.seedCompetitor({
    id: 'comp-1',
    workspaceId: 'ws-1',
    name: 'Rival',
    primaryDomain: 'rival.example',
  });
  const makeSource = async (
    overrides: Partial<Record<'type' | 'legalStatus', string>> = {},
  ): Promise<Source> =>
    store.seedSource(
      parseSourceConfig({
        id: `src-${overrides.type ?? 'pricing'}-${overrides.legalStatus ?? 'open'}`,
        competitorId: 'comp-1',
        type: overrides.type ?? 'pricing',
        url: 'https://rival.example/page',
        adapter: 'html',
        cadence: '0 6 * * *',
        legalStatus: overrides.legalStatus ?? 'open',
      }),
    );
  return {
    workspace,
    store,
    triage,
    deps: { store, triage, nextId: createSequentialIds('t') },
    makeSource,
  };
};

describe('ingestFetch', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it('skips a legally blocked source and records the failure visibly (Invariants 4 & 7)', async () => {
    const source = await harness.makeSource({ legalStatus: 'blocked' });

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('skipped_blocked');
    expect(harness.triage.calls).toBe(0);
    expect(await harness.store.latestSnapshot(harness.workspace.id, source.id)).toBeNull();
    const runs = await harness.store.listCoverageRuns('ws-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].fetchFailures).toBe(1);
  });

  it('reports a fetch failure as first-class data when the payload is invalid', async () => {
    const source = await harness.makeSource({ type: 'jobs' });

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      'not json at all {',
      FETCHED_AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('fetch_failed');
    expect(harness.triage.calls).toBe(0);
    const runs = await harness.store.listCoverageRuns('ws-1');
    expect(runs[0].fetchFailures).toBe(1);
  });

  it('treats the first fetch as a baseline snapshot without any model call', async () => {
    const source = await harness.makeSource();

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('baseline');
    expect(harness.triage.calls).toBe(0);
    expect(await harness.store.latestSnapshot(harness.workspace.id, source.id)).not.toBeNull();
  });

  it('stops before any LLM call when the content hash is unchanged (Invariant 2)', async () => {
    const source = await harness.makeSource();
    await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      LATER,
      harness.deps,
    );

    expect(outcome.kind).toBe('unchanged');
    expect(harness.triage.calls).toBe(0);
    const runs = await harness.store.listCoverageRuns('ws-1');
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.llmCalls === 0)).toBe(true);
  });

  it('creates a pending pricing delta on a price change — never auto-published (Invariant 3)', async () => {
    const source = await harness.makeSource();
    await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V2,
      LATER,
      harness.deps,
    );

    expect(outcome.kind).toBe('delta');
    if (outcome.kind !== 'delta') throw new Error('unreachable');
    expect(outcome.delta.triageClass).toBe('pricing_change');
    expect(outcome.delta.state).toBe('pending');
    expect(harness.triage.calls).toBe(1);
    expect(outcome.claims.every((claim) => claim.verifiedAt !== null)).toBe(true);
  });

  it('dismisses noise deltas while still counting them in coverage (Invariant 7)', async () => {
    const source = await harness.makeSource({ type: 'docs' });
    await ingestFetch({ workspace: harness.workspace, source }, ABOUT_V1, FETCHED_AT, harness.deps);

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      ABOUT_V2,
      LATER,
      harness.deps,
    );

    expect(outcome.kind).toBe('delta');
    if (outcome.kind !== 'delta') throw new Error('unreachable');
    expect(outcome.delta.triageClass).toBe('noise');
    expect(outcome.delta.state).toBe('dismissed');
    const runs = await harness.store.listCoverageRuns('ws-1');
    expect(runs[1].deltasFound).toBe(1);
    expect(runs[1].materialDeltas).toBe(0);
  });

  it('skips the model when the workspace is over its monthly COGS budget (Invariant 6)', async () => {
    const source = await harness.makeSource();
    await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );
    // Push month-to-date spend to the starter-tier cap ($10) for the current month.
    await harness.store.insertCoverageRun({
      id: 'seed-cost',
      workspaceId: 'ws-1',
      period: '2026-06-01',
      sourcesChecked: 0,
      fetchFailures: 0,
      deltasFound: 0,
      materialDeltas: 0,
      llmCalls: 0,
      llmCostMicros: 10_000_000,
      createdAt: FETCHED_AT,
    });
    const callsBefore = harness.triage.calls;

    const outcome = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V2,
      LATER,
      harness.deps,
    );

    expect(outcome.kind).toBe('skipped_over_budget');
    expect(harness.triage.calls).toBe(callsBefore); // the model was never called
  });

  it('does not absorb the change when over budget — a later in-budget tick still yields the delta', async () => {
    const source = await harness.makeSource();
    await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V1,
      FETCHED_AT,
      harness.deps,
    );
    await harness.store.insertCoverageRun({
      id: 'seed-cost',
      workspaceId: 'ws-1',
      period: '2026-06-01',
      sourcesChecked: 0,
      fetchFailures: 0,
      deltasFound: 0,
      materialDeltas: 0,
      llmCalls: 0,
      llmCostMicros: 10_000_000,
      createdAt: FETCHED_AT,
    });

    const over = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V2,
      LATER,
      harness.deps,
    );
    expect(over.kind).toBe('skipped_over_budget');
    // The V2 snapshot was NOT persisted — the baseline is still V1, so the change isn't lost.
    const latest = await harness.store.latestSnapshot('ws-1', source.id);
    expect(latest?.normalizedText).toContain('$59');
    expect(await harness.store.listDeltas('ws-1')).toHaveLength(0);

    // Next month the budget is fresh; the same V2 change is finally triaged into a delta.
    const nextMonth = new Date('2026-07-08T06:00:00Z');
    const after = await ingestFetch(
      { workspace: harness.workspace, source },
      PRICING_V2,
      nextMonth,
      harness.deps,
    );
    expect(after.kind).toBe('delta');
    expect(await harness.store.listDeltas('ws-1')).toHaveLength(1);
  });

  it('fails closed when the budget read fails — no model call, nothing persisted', async () => {
    const store = new (class extends MemoryFlankStore {
      override async monthToDateCostMicros(): Promise<number> {
        throw new Error('budget read down');
      }
    })();
    const workspace = await store.seedWorkspace({ id: 'ws-1', name: 'Test', planTier: 'starter' });
    await store.seedCompetitor({
      id: 'comp-1',
      workspaceId: 'ws-1',
      name: 'Rival',
      primaryDomain: 'rival.example',
    });
    const source = await store.seedSource(
      parseSourceConfig({
        id: 'src-1',
        competitorId: 'comp-1',
        type: 'pricing',
        url: 'https://rival.example/pricing',
        adapter: 'html',
        cadence: '0 6 * * *',
        legalStatus: 'open',
      }),
    );
    const triage = new MockTriageClient();
    const deps = { store, triage, nextId: createSequentialIds('t') };
    await ingestFetch({ workspace, source }, PRICING_V1, FETCHED_AT, deps); // baseline (no budget read)

    await expect(ingestFetch({ workspace, source }, PRICING_V2, LATER, deps)).rejects.toThrow(
      'budget read down',
    );
    expect(triage.calls).toBe(0); // the model was never called
    expect(await store.listDeltas('ws-1')).toHaveLength(0); // nothing persisted
  });
});

import { parseSourceConfig, type Fetcher } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { confirmPricingDelta } from './pricing-confirmation';
import { FetchError } from './http-fetcher';
import { createSequentialIds, ingestFetch, type IngestContext, type IngestDeps } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { MockTriageClient } from './mock-triage';

const BASELINE_AT = new Date('2026-06-08T06:00:00Z');
const CHANGE_AT = new Date('2026-06-09T06:00:00Z');
const CONFIRM_AT = new Date('2026-06-09T18:00:00Z');

const PRICING_V1 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$59 per month</p></body></html>';
const PRICING_V2 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$39 per month</p></body></html>';

const fetcherReturning = (rawContent: string, httpStatus = 200): Fetcher => ({
  fetch: async () => ({ rawContent, httpStatus, finalUrl: 'https://rival.example/pricing' }),
});

interface Harness {
  readonly store: MemoryFlankStore;
  readonly deps: IngestDeps;
  readonly ctx: IngestContext;
  readonly deltaId: string;
}

/** Seed a workspace and drive a real $59 -> $39 change to a pending pricing_change delta. */
const buildPendingPricing = async (): Promise<Harness> => {
  const store = new MemoryFlankStore();
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
  const deps: IngestDeps = {
    store,
    triage: new MockTriageClient(),
    nextId: createSequentialIds('t'),
  };
  const ctx: IngestContext = { workspace, source };
  await ingestFetch(ctx, PRICING_V1, BASELINE_AT, deps);
  const changed = await ingestFetch(ctx, PRICING_V2, CHANGE_AT, deps);
  if (changed.kind !== 'delta' || changed.delta.triageClass !== 'pricing_change') {
    throw new Error('fixture did not produce a pricing delta');
  }
  return { store, deps, ctx, deltaId: changed.delta.id };
};

const currentDelta = async (h: Harness) =>
  (await h.store.listDeltas('ws-1')).find((delta) => delta.id === h.deltaId);

const pendingDelta = async (h: Harness) => {
  const delta = await currentDelta(h);
  if (delta === undefined) throw new Error('delta missing');
  return delta;
};

describe('confirmPricingDelta', () => {
  it('confirms when the re-fetch reproduces the change, recording the confirming snapshot', async () => {
    const h = await buildPendingPricing();

    const outcome = await confirmPricingDelta(
      h.ctx,
      await pendingDelta(h),
      fetcherReturning(PRICING_V2),
      CONFIRM_AT,
      h.deps,
    );

    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind !== 'confirmed') throw new Error('unreachable');
    expect(outcome.delta.state).toBe('confirmed');
    expect(outcome.delta.confirmedBySnapshotId).toBe(outcome.snapshot.id);
    expect(outcome.snapshot.vantage).toBe('confirmation');
    expect((await currentDelta(h))?.state).toBe('confirmed');
  });

  it('dismisses a flap when the re-fetch does not reproduce the change', async () => {
    const h = await buildPendingPricing();

    const outcome = await confirmPricingDelta(
      h.ctx,
      await pendingDelta(h),
      fetcherReturning(PRICING_V1), // reverted to the old price
      CONFIRM_AT,
      h.deps,
    );

    expect(outcome.kind).toBe('dismissed');
    if (outcome.kind !== 'dismissed') throw new Error('unreachable');
    expect(outcome.delta.state).toBe('dismissed');
    expect((await currentDelta(h))?.state).toBe('dismissed');
  });

  it('leaves the delta pending and counts a fetch failure when the re-fetch fails', async () => {
    const h = await buildPendingPricing();
    const fetcher: Fetcher = {
      fetch: async () => {
        throw new FetchError('SSRF guard');
      },
    };

    const outcome = await confirmPricingDelta(
      h.ctx,
      await pendingDelta(h),
      fetcher,
      CONFIRM_AT,
      h.deps,
    );

    expect(outcome.kind).toBe('fetch_failed');
    expect((await currentDelta(h))?.state).toBe('pending');
    const runs = await h.store.listCoverageRuns('ws-1');
    expect(runs[runs.length - 1].fetchFailures).toBe(1);
  });

  it('treats a non-2xx confirmation re-fetch as a fetch failure', async () => {
    const h = await buildPendingPricing();

    const outcome = await confirmPricingDelta(
      h.ctx,
      await pendingDelta(h),
      fetcherReturning(PRICING_V2, 503),
      CONFIRM_AT,
      h.deps,
    );

    expect(outcome.kind).toBe('fetch_failed');
    expect((await currentDelta(h))?.state).toBe('pending');
  });

  it('ignores a delta that is not a pending pricing_change', async () => {
    const h = await buildPendingPricing();
    const notPricing = { ...(await pendingDelta(h)), triageClass: 'feature_launch' as const };

    const outcome = await confirmPricingDelta(
      h.ctx,
      notPricing,
      fetcherReturning(PRICING_V2),
      CONFIRM_AT,
      h.deps,
    );

    expect(outcome.kind).toBe('not_applicable');
  });
});

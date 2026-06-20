import { parseSourceConfig, type Fetcher } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { FetchError } from './http-fetcher';
import { createSequentialIds, ingestFetch, type IngestDeps } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { MockTriageClient } from './mock-triage';
import { isSourceDue, runScheduledTick } from './scheduler';

const PRICING_V1 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$59 per month</p></body></html>';
const PRICING_V2 = '<html><body><h1>Pricing</h1><p>Growth</p><p>$39 per month</p></body></html>';
const NOW = new Date('2026-06-09T07:00:00Z'); // after the daily 06:00 UTC fire

const htmlFetcher = (rawContent: string, httpStatus = 200): Fetcher => ({
  fetch: async () => ({ rawContent, httpStatus, finalUrl: 'https://rival.example/pricing' }),
});

const seedSource = (store: MemoryFlankStore, id: string, cadence = '0 6 * * *') =>
  store.seedSource(
    parseSourceConfig({
      id,
      competitorId: 'comp-1',
      type: 'pricing',
      url: `https://rival.example/${id}`,
      adapter: 'html',
      cadence,
      legalStatus: 'open',
    }),
  );

const buildStore = async (): Promise<{ store: MemoryFlankStore; deps: IngestDeps }> => {
  const store = new MemoryFlankStore();
  await store.seedWorkspace({ id: 'ws-1', name: 'Test', planTier: 'starter' });
  await store.seedCompetitor({
    id: 'comp-1',
    workspaceId: 'ws-1',
    name: 'Rival',
    primaryDomain: 'rival.example',
  });
  return {
    store,
    deps: { store, triage: new MockTriageClient(), nextId: createSequentialIds('t') },
  };
};

describe('isSourceDue', () => {
  it('is due when never fetched', () => {
    expect(isSourceDue('0 6 * * *', null, NOW)).toBe(true);
  });

  it('is due when the last fetch predates the most recent scheduled fire', () => {
    expect(isSourceDue('0 6 * * *', new Date('2026-06-08T06:30:00Z'), NOW)).toBe(true);
  });

  it('is not due when fetched after the most recent scheduled fire', () => {
    expect(isSourceDue('0 6 * * *', new Date('2026-06-09T06:30:00Z'), NOW)).toBe(false);
  });

  it('treats an unparseable cadence as never-due', () => {
    expect(isSourceDue('not a cron', null, NOW)).toBe(false);
  });
});

describe('runScheduledTick', () => {
  it('fetches only due sources and updates health so they are not re-fetched next tick', async () => {
    const { store, deps } = await buildStore();
    await seedSource(store, 'src-due');
    await seedSource(store, 'src-fresh');
    await store.markSourceFetched('src-fresh', new Date('2026-06-09T06:30:00Z')); // already fetched today

    const report = await runScheduledTick(deps, htmlFetcher(PRICING_V1), NOW);

    expect(report.sourcesScheduled).toBe(2);
    expect(report.sourcesDue).toBe(1);
    expect(report.fetched).toBe(1);

    const next = await runScheduledTick(
      deps,
      htmlFetcher(PRICING_V1),
      new Date('2026-06-09T07:05:00Z'),
    );
    expect(next.sourcesDue).toBe(0); // src-due was stamped fetched
  });

  it('increments the failure streak on fetch failure and pauses past the threshold', async () => {
    const { store, deps } = await buildStore();
    await seedSource(store, 'src-1');
    const failing: Fetcher = {
      fetch: async () => {
        throw new FetchError('blocked address (SSRF guard)');
      },
    };

    const r1 = await runScheduledTick(deps, failing, NOW, { pauseAfter: 2 });
    expect(r1.fetchFailures).toBe(1);
    const r2 = await runScheduledTick(deps, failing, NOW, { pauseAfter: 2 });
    expect(r2.fetchFailures).toBe(1);
    const r3 = await runScheduledTick(deps, failing, NOW, { pauseAfter: 2 });
    expect(r3.skippedPaused).toBe(1);
    expect(r3.fetchFailures).toBe(0);
    expect(r3.sourcesDue).toBe(0);
  });

  it('runs the confirmation firewall over pending pricing deltas', async () => {
    const { store, deps } = await buildStore();
    const source = await seedSource(store, 'src-1');
    const ctx = { workspace: { id: 'ws-1', name: 'Test', planTier: 'starter' as const }, source };
    await ingestFetch(ctx, PRICING_V1, new Date('2026-06-08T06:00:00Z'), deps);
    await ingestFetch(ctx, PRICING_V2, new Date('2026-06-08T06:30:00Z'), deps); // pending pricing delta
    await store.markSourceFetched('src-1', new Date('2026-06-09T06:30:00Z')); // not due, so only confirmation runs

    const report = await runScheduledTick(deps, htmlFetcher(PRICING_V2), NOW);

    expect(report.sourcesDue).toBe(0);
    expect(report.confirmationsRun).toBe(1);
    expect(report.confirmed).toBe(1);
    const pricing = (await store.listDeltas('ws-1')).find(
      (d) => d.triageClass === 'pricing_change',
    );
    expect(pricing?.state).toBe('confirmed');
  });
});

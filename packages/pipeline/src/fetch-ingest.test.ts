import {
  parseSourceConfig,
  type Fetcher,
  type FetchResult,
  type Source,
  type Workspace,
} from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchAndIngest } from './fetch-ingest';
import { FetchError } from './http-fetcher';
import { createSequentialIds, type IngestDeps } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { MockTriageClient } from './mock-triage';

const AT = new Date('2026-06-08T06:00:00Z');
const PRICING_HTML = '<html><body><h1>Pricing</h1><p>$59 per month</p></body></html>';

interface Harness {
  readonly store: MemoryFlankStore;
  readonly workspace: Workspace;
  readonly source: Source;
  readonly deps: IngestDeps;
}

const buildHarness = async (legalStatus = 'open'): Promise<Harness> => {
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
      legalStatus,
    }),
  );
  return {
    store,
    workspace,
    source,
    deps: { store, triage: new MockTriageClient(), nextId: createSequentialIds('t') },
  };
};

const fetcherReturning = (result: Partial<FetchResult>): { fetcher: Fetcher; calls: number } => {
  const state = { calls: 0 };
  const fetcher: Fetcher = {
    fetch: async () => {
      state.calls += 1;
      return {
        rawContent: PRICING_HTML,
        httpStatus: 200,
        finalUrl: 'https://rival.example/pricing',
        ...result,
      };
    },
  };
  return {
    get fetcher() {
      return fetcher;
    },
    get calls() {
      return state.calls;
    },
  };
};

describe('fetchAndIngest', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it('fetches and ingests a 200 as a baseline snapshot, storing the real status', async () => {
    const { fetcher } = fetcherReturning({ httpStatus: 201 });

    const outcome = await fetchAndIngest(
      { workspace: harness.workspace, source: harness.source },
      fetcher,
      AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('baseline');
    const snapshot = await harness.store.latestSnapshot('ws-1', harness.source.id);
    expect(snapshot?.httpStatus).toBe(201);
    expect(await harness.store.listCoverageRuns('ws-1')).toHaveLength(1);
  });

  it('records a fetch failure when the fetcher throws — no snapshot, no model call', async () => {
    const fetcher: Fetcher = {
      fetch: async () => {
        throw new FetchError('refusing to fetch blocked address 10.0.0.1 (SSRF guard)');
      },
    };

    const outcome = await fetchAndIngest(
      { workspace: harness.workspace, source: harness.source },
      fetcher,
      AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('fetch_failed');
    expect(await harness.store.latestSnapshot('ws-1', harness.source.id)).toBeNull();
    const runs = await harness.store.listCoverageRuns('ws-1');
    expect(runs[0].fetchFailures).toBe(1);
  });

  it('treats a non-2xx response as a fetch failure', async () => {
    const { fetcher } = fetcherReturning({ httpStatus: 404, rawContent: 'not found' });

    const outcome = await fetchAndIngest(
      { workspace: harness.workspace, source: harness.source },
      fetcher,
      AT,
      harness.deps,
    );

    expect(outcome.kind).toBe('fetch_failed');
    expect(await harness.store.latestSnapshot('ws-1', harness.source.id)).toBeNull();
    expect((await harness.store.listCoverageRuns('ws-1'))[0].fetchFailures).toBe(1);
  });

  it('never fetches a legally blocked source (Invariant 4)', async () => {
    const blocked = await buildHarness('blocked');
    const spy = fetcherReturning({});

    const outcome = await fetchAndIngest(
      { workspace: blocked.workspace, source: blocked.source },
      spy.fetcher,
      AT,
      blocked.deps,
    );

    expect(outcome.kind).toBe('skipped_blocked');
    expect(spy.calls).toBe(0);
    expect((await blocked.store.listCoverageRuns('ws-1'))[0].fetchFailures).toBe(1);
  });
});

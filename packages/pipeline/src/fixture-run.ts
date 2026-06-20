import {
  parseSourceConfig,
  type Claim,
  type Competitor,
  type CoverageRun,
  type Delta,
  type Source,
  type Workspace,
} from '@flank/core';
import { ingestFetch, createSequentialIds, type IngestOutcome } from './ingest';
import { MemoryFlankStore } from './memory-store';
import { createMockTriageClient } from './mock-triage';

/** The six checked-in sample documents (two versions of three sources). */
export interface FixtureBundle {
  readonly changelogV1: string;
  readonly changelogV2: string;
  readonly jobsV1: string;
  readonly jobsV2: string;
  readonly pricingV1: string;
  readonly pricingV2: string;
}

export const FIXTURE_FILE_NAMES = Object.freeze({
  changelogV1: 'changelog.v1.xml',
  changelogV2: 'changelog.v2.xml',
  jobsV1: 'jobs.v1.json',
  jobsV2: 'jobs.v2.json',
  pricingV1: 'pricing.v1.html',
  pricingV2: 'pricing.v2.html',
} as const);

export interface ScenarioResult {
  readonly workspace: Workspace;
  readonly competitor: Competitor;
  readonly sources: readonly Source[];
  readonly deltas: readonly Delta[];
  readonly claimsByDelta: ReadonlyMap<string, readonly Claim[]>;
  readonly coverageRuns: readonly CoverageRun[];
  readonly outcomes: readonly IngestOutcome[];
  readonly triageCalls: number;
  readonly triageCallsOnUnchanged: number;
  readonly triageMode: string;
}

const BASELINE_AT = new Date('2026-06-01T06:00:00Z');
const CHANGE_TIMES = Object.freeze({
  changelog: new Date('2026-06-08T06:10:00Z'),
  jobs: new Date('2026-06-08T06:20:00Z'),
  pricing: new Date('2026-06-08T06:30:00Z'),
} as const);
const QUIET_AT = new Date('2026-06-09T06:00:00Z');

const seedGraph = async (store: MemoryFlankStore) => {
  const workspace = await store.seedWorkspace({
    id: 'ws-demo',
    name: 'Demo Workspace',
    planTier: 'growth',
  });
  const competitor = await store.seedCompetitor({
    id: 'comp-periscope',
    workspaceId: workspace.id,
    name: 'Periscope Labs',
    primaryDomain: 'periscope.example',
  });
  const sources = [
    parseSourceConfig({
      id: 'src-changelog',
      competitorId: competitor.id,
      type: 'changelog',
      url: 'https://periscope.example/changelog.rss',
      adapter: 'rss',
      cadence: '0 6 * * *',
    }),
    parseSourceConfig({
      id: 'src-jobs',
      competitorId: competitor.id,
      type: 'jobs',
      url: 'https://boards-api.greenhouse.io/v1/boards/periscopelabs/jobs',
      adapter: 'json',
      cadence: '0 6 * * 1',
    }),
    parseSourceConfig({
      id: 'src-pricing',
      competitorId: competitor.id,
      type: 'pricing',
      url: 'https://periscope.example/pricing',
      adapter: 'html',
      cadence: '0 6 * * *',
    }),
  ];
  for (const source of sources) await store.seedSource(source);
  return { workspace, competitor, sources };
};

/**
 * Run the M1 slice over the checked-in fixtures: baseline pass (v1 of all
 * three sources), change pass (v2 — three deltas), then a quiet pass (v2
 * again — three unchanged fetches that must trigger zero model calls).
 */
export const runFixtureScenario = async (
  bundle: FixtureBundle,
  // env is accepted for signature compatibility but deliberately ignored: the fixture run is
  // hermetic and ALWAYS uses the deterministic mock, even when ANTHROPIC_API_KEY is present.
  _env: Readonly<Record<string, string | undefined>> = {},
): Promise<ScenarioResult> => {
  const store = new MemoryFlankStore();
  const { client, mode } = createMockTriageClient();
  const nextId = createSequentialIds('rec');
  const { workspace, competitor, sources } = await seedGraph(store);
  const [changelog, jobs, pricing] = sources;
  const deps = { store, triage: client, nextId };

  const passes: readonly (readonly [Source, string, Date])[] = [
    [changelog, bundle.changelogV1, BASELINE_AT],
    [jobs, bundle.jobsV1, BASELINE_AT],
    [pricing, bundle.pricingV1, BASELINE_AT],
    [changelog, bundle.changelogV2, CHANGE_TIMES.changelog],
    [jobs, bundle.jobsV2, CHANGE_TIMES.jobs],
    [pricing, bundle.pricingV2, CHANGE_TIMES.pricing],
  ];
  const outcomes: IngestOutcome[] = [];
  for (const [source, content, at] of passes) {
    outcomes.push(await ingestFetch({ workspace, source }, content, at, deps));
  }
  const callsAfterChanges = client.calls;
  for (const [source, content] of [
    [changelog, bundle.changelogV2],
    [jobs, bundle.jobsV2],
    [pricing, bundle.pricingV2],
  ] as const) {
    outcomes.push(await ingestFetch({ workspace, source }, content, QUIET_AT, deps));
  }

  const deltas = await store.listDeltas(workspace.id);
  const claimEntries = await Promise.all(
    deltas.map(
      async (delta) => [delta.id, await store.listClaimsForDelta(workspace.id, delta.id)] as const,
    ),
  );
  return Object.freeze({
    workspace,
    competitor,
    sources,
    deltas,
    claimsByDelta: new Map(claimEntries),
    coverageRuns: await store.listCoverageRuns(workspace.id),
    outcomes: Object.freeze(outcomes),
    triageCalls: client.calls,
    triageCallsOnUnchanged: client.calls - callsAfterChanges,
    triageMode: mode,
  });
};

import type { Claim, CoverageRun, Delta, Source } from '@flank/core';
import { describe, expect, it } from 'vitest';
import {
  aggregateCoverage,
  buildTimelineEntries,
  latestByKind,
  toCitationView,
  toSectionView,
  versionDiffLinks,
  versionsOfKind,
  type SectionLike,
} from './sections';

const claimOn = (id: string, deltaId: string, overrides: Partial<Claim> = {}): Claim => ({
  id,
  deltaId,
  snapshotId: `${deltaId}-snap`,
  quoteText: `quote ${id}`,
  charStart: 0,
  charEnd: 5,
  sourceUrl: 'https://c.example/p',
  capturedAt: new Date('2026-06-10T00:00:00Z'),
  verifiedAt: new Date('2026-06-10T00:00:00Z'),
  ...overrides,
});

const deltaOn = (id: string, sourceId: string, overrides: Partial<Delta> = {}): Delta => ({
  id,
  sourceId,
  fromSnapshotId: null,
  toSnapshotId: `${id}-snap`,
  changedSpans: [],
  triageClass: 'feature_launch',
  materiality: 2,
  rationale: `why ${id}`,
  state: 'published',
  confirmedBySnapshotId: null,
  createdAt: new Date('2026-06-10T00:00:00Z'),
  ...overrides,
});

const sourceOn = (id: string, overrides: Partial<Source> = {}): Source => ({
  id,
  competitorId: 'comp',
  type: 'pricing',
  url: `https://c.example/${id}`,
  adapter: 'html',
  cadence: '0 6 * * *',
  legalStatus: 'open',
  ...overrides,
});

describe('toCitationView', () => {
  it('maps a verified claim, stringifying the timestamp', () => {
    expect(toCitationView(claimOn('c-1', 'd-1'))).toMatchObject({
      quote: 'quote c-1',
      sourceUrl: 'https://c.example/p',
      capturedAt: '2026-06-10T00:00:00.000Z',
      verified: true,
    });
  });

  it('flags an unverified claim (verifiedAt null)', () => {
    expect(toCitationView(claimOn('c-2', 'd-1', { verifiedAt: null })).verified).toBe(false);
  });
});

describe('buildTimelineEntries', () => {
  it('orders newest first and attaches each delta its source + claims', () => {
    const sources = [sourceOn('src')];
    const deltas = [
      deltaOn('d-old', 'src', { createdAt: new Date('2026-06-01T00:00:00Z') }),
      deltaOn('d-new', 'src', { createdAt: new Date('2026-06-09T00:00:00Z') }),
    ];
    const claims = new Map([['d-new', [claimOn('c-1', 'd-new')]]]);
    const entries = buildTimelineEntries(deltas, sources, claims);

    expect(entries.map((e) => e.id)).toEqual(['d-new', 'd-old']);
    expect(entries[0].sourceType).toBe('pricing');
    expect(entries[0].citations).toHaveLength(1);
    expect(entries[1].citations).toEqual([]);
  });

  it('flags a pending pricing delta as awaiting confirmation', () => {
    const entries = buildTimelineEntries(
      [deltaOn('d-1', 'src', { triageClass: 'pricing_change', state: 'pending' })],
      [sourceOn('src')],
      new Map(),
    );
    expect(entries[0].awaitingConfirmation).toBe(true);
  });

  it('falls back to "unknown" when a delta references a missing source', () => {
    const entries = buildTimelineEntries([deltaOn('d-1', 'gone')], [], new Map());
    expect(entries[0]).toMatchObject({ sourceType: 'unknown', sourceUrl: '' });
  });
});

describe('toSectionView', () => {
  const section: SectionLike = {
    kind: 'overview',
    version: 3,
    contentMd: '# Overview',
    claimIds: ['c-1', 'c-missing', 'c-2'],
    createdAt: new Date('2026-06-12T00:00:00Z'),
  };

  it('resolves cited claim ids and drops ones not in the map', () => {
    const claimsById = new Map([
      ['c-1', claimOn('c-1', 'd-1')],
      ['c-2', claimOn('c-2', 'd-1', { verifiedAt: null })],
    ]);
    const view = toSectionView(section, claimsById);
    expect(view).toMatchObject({ kind: 'overview', version: 3, contentMd: '# Overview' });
    expect(view.citations.map((c) => c.quote)).toEqual(['quote c-1', 'quote c-2']);
    expect(view.createdAt).toBe('2026-06-12T00:00:00.000Z');
  });
});

describe('latestByKind / versionsOfKind', () => {
  const sections = [
    { kind: 'overview', version: 1 },
    { kind: 'overview', version: 3 },
    { kind: 'pricing', version: 2 },
    { kind: 'overview', version: 2 },
  ];

  it('keeps the highest version per kind, ordered by kind', () => {
    expect(latestByKind(sections)).toEqual([
      { kind: 'overview', version: 3 },
      { kind: 'pricing', version: 2 },
    ]);
  });

  it('returns all versions of one kind, oldest first', () => {
    expect(versionsOfKind(sections, 'overview').map((s) => s.version)).toEqual([1, 2, 3]);
    expect(versionsOfKind(sections, 'team')).toEqual([]);
  });
});

describe('versionDiffLinks', () => {
  it('pairs each version with its immediate predecessor (oldest is a baseline)', () => {
    expect(versionDiffLinks([{ version: 1 }, { version: 2 }, { version: 3 }])).toEqual([
      { toVersion: 1, fromVersion: null },
      { toVersion: 2, fromVersion: 1 },
      { toVersion: 3, fromVersion: 2 },
    ]);
  });

  it('never produces a self-diff or an inverted diff', () => {
    const links = versionDiffLinks([
      { version: 4 },
      { version: 1 },
      { version: 7 },
      { version: 2 },
    ]);
    for (const link of links) {
      if (link.fromVersion !== null) {
        expect(link.fromVersion).toBeLessThan(link.toVersion);
      }
    }
  });

  it('treats a single version as a lone baseline (nothing to diff)', () => {
    expect(versionDiffLinks([{ version: 1 }])).toEqual([{ toVersion: 1, fromVersion: null }]);
  });
});

describe('aggregateCoverage', () => {
  const runOn = (overrides: Partial<CoverageRun>): CoverageRun => ({
    id: 'run',
    workspaceId: 'ws',
    period: '2026-06',
    sourcesChecked: 0,
    fetchFailures: 0,
    deltasFound: 0,
    materialDeltas: 0,
    llmCalls: 0,
    llmCostMicros: 0,
    createdAt: new Date('2026-06-12T00:00:00Z'),
    ...overrides,
  });

  it('sums every counter across runs', () => {
    const total = aggregateCoverage([
      runOn({
        sourcesChecked: 3,
        deltasFound: 2,
        materialDeltas: 1,
        llmCalls: 4,
        llmCostMicros: 120,
      }),
      runOn({
        sourcesChecked: 2,
        fetchFailures: 1,
        deltasFound: 1,
        llmCalls: 1,
        llmCostMicros: 30,
      }),
    ]);
    expect(total).toEqual({
      fetches: 5,
      deltasFound: 3,
      materialDeltas: 1,
      fetchFailures: 1,
      llmCalls: 5,
      llmCostMicros: 150,
    });
  });

  it('returns an all-zero receipt for no runs', () => {
    expect(aggregateCoverage([])).toEqual({
      fetches: 0,
      deltasFound: 0,
      materialDeltas: 0,
      fetchFailures: 0,
      llmCalls: 0,
      llmCostMicros: 0,
    });
  });
});

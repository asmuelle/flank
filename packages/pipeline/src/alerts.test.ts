import type { Claim, Competitor, Delta } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { composeAlerts } from './alerts';

const COMPETITOR: Competitor = {
  id: 'comp-1',
  workspaceId: 'ws-1',
  name: 'Periscope Labs',
  primaryDomain: 'periscope.example',
};

const CREATED_AT = new Date('2026-06-08T06:10:00Z');

const makeDelta = (overrides: Partial<Delta>): Delta => ({
  id: 'd-1',
  sourceId: 'src-1',
  fromSnapshotId: 's-1',
  toSnapshotId: 's-2',
  changedSpans: [],
  triageClass: 'feature_launch',
  materiality: 2,
  rationale: 'Launch language detected in changed content.',
  state: 'published',
  createdAt: CREATED_AT,
  ...overrides,
});

const makeClaim = (deltaId: string): Claim => ({
  id: `claim-${deltaId}`,
  deltaId,
  snapshotId: 's-2',
  quoteText: 'Introducing Battlecards AI',
  charStart: 0,
  charEnd: 26,
  sourceUrl: 'https://periscope.example/changelog.rss',
  capturedAt: CREATED_AT,
  verifiedAt: CREATED_AT,
});

describe('composeAlerts', () => {
  it('alerts on a published delta with quote + link + timestamp + rationale', () => {
    // Arrange
    const delta = makeDelta({});
    const claims = new Map([[delta.id, [makeClaim(delta.id)]]]);

    // Act
    const alerts = composeAlerts([delta], claims, COMPETITOR);

    // Assert
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      deltaId: 'd-1',
      competitorName: 'Periscope Labs',
      quote: 'Introducing Battlecards AI',
      sourceUrl: 'https://periscope.example/changelog.rss',
      capturedAt: CREATED_AT,
      rationale: 'Launch language detected in changed content.',
    });
  });

  it('never alerts on pending or dismissed deltas', () => {
    const pending = makeDelta({ id: 'd-2', state: 'pending' });
    const dismissed = makeDelta({ id: 'd-3', state: 'dismissed', triageClass: 'noise' });

    const alerts = composeAlerts([pending, dismissed], new Map(), COMPETITOR);

    expect(alerts).toHaveLength(0);
  });

  it('excludes pricing deltas even if marked published — double enforcement (Invariant 3)', () => {
    const pricing = makeDelta({ id: 'd-4', triageClass: 'pricing_change', state: 'published' });

    const alerts = composeAlerts([pricing], new Map(), COMPETITOR);

    expect(alerts).toHaveLength(0);
  });
});

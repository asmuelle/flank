import type { Alert } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { summarizeAlerts, toAlertRows } from './alerts';

const alertOn = (id: string, over: Partial<Alert> = {}): Alert => ({
  id,
  workspaceId: 'ws',
  deltaId: 'd-1',
  channel: 'email',
  channelConfigId: 'cfg',
  target: 'gtm@acme.test',
  payload: { competitorName: 'Acme', whatChanged: 'feature_launch (materiality 2/3)' },
  status: 'delivered',
  attemptCount: 1,
  providerRef: 'ref',
  lastError: null,
  enqueuedAt: new Date('2026-06-14T08:00:00Z'),
  lastAttemptAt: new Date('2026-06-14T08:00:05Z'),
  deliveredAt: new Date('2026-06-14T08:00:05Z'),
  ...over,
});

describe('toAlertRows', () => {
  it('projects what/who from the payload and stringifies timestamps', () => {
    const [row] = toAlertRows([alertOn('al-1')]);
    expect(row).toMatchObject({
      id: 'al-1',
      competitorName: 'Acme',
      whatChanged: 'feature_launch (materiality 2/3)',
      channel: 'email',
      status: 'delivered',
      attemptCount: 1,
    });
    expect(row.deliveredAt).toBe('2026-06-14T08:00:05.000Z');
  });

  it('keeps deliveredAt null and surfaces lastError for a failed alert', () => {
    const [row] = toAlertRows([
      alertOn('al-2', { status: 'failed', deliveredAt: null, lastError: '503 upstream' }),
    ]);
    expect(row.deliveredAt).toBeNull();
    expect(row.lastError).toBe('503 upstream');
  });

  it('tolerates a payload missing the display fields', () => {
    const [row] = toAlertRows([alertOn('al-3', { payload: {} })]);
    expect(row).toMatchObject({ competitorName: '', whatChanged: '' });
  });
});

describe('summarizeAlerts', () => {
  it('counts by status', () => {
    const summary = summarizeAlerts([
      alertOn('a', { status: 'delivered' }),
      alertOn('b', { status: 'failed', deliveredAt: null }),
      alertOn('c', { status: 'failed', deliveredAt: null }),
      alertOn('d', { status: 'queued', deliveredAt: null }),
    ]);
    expect(summary).toEqual({ delivered: 1, failed: 2, queued: 1 });
  });
});

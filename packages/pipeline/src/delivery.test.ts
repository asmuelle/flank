import type { Notifier, NotifyRequest, NotifyResult } from '@flank/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDeliverySweep } from './delivery';
import { MemoryFlankStore } from './memory-store';

const NOW = new Date('2026-06-14T08:00:00Z');

const idGen = () => {
  let n = 0;
  return () => `al-${++n}`;
};

const okNotifier = (calls: NotifyRequest[]): Notifier => ({
  async send(request): Promise<NotifyResult> {
    calls.push(request);
    return { ok: true, providerRef: `ref-${request.idempotencyKey}`, httpStatus: 200 };
  },
});

const failNotifier: Notifier = {
  async send(): Promise<NotifyResult> {
    return { ok: false, error: '503 upstream', httpStatus: 503 };
  },
};

const seedAlertable = async (store: MemoryFlankStore): Promise<void> => {
  await store.seedWorkspace({ id: 'ws', name: 'Acme GTM', planTier: 'growth' });
  await store.seedCompetitor({
    id: 'comp',
    workspaceId: 'ws',
    name: 'Acme',
    primaryDomain: 'acme.test',
  });
  await store.seedSource({
    id: 'src',
    competitorId: 'comp',
    type: 'blog',
    url: 'https://acme.test/blog',
    adapter: 'rss',
    cadence: '0 6 * * *',
    legalStatus: 'open',
  });
  await store.insertSnapshot('ws', {
    id: 'snap',
    sourceId: 'src',
    contentHash: 'h',
    normalizedText: 't',
    fetchedAt: NOW,
    httpStatus: 200,
    vantage: null,
  });
  await store.insertDelta('ws', {
    id: 'd1',
    sourceId: 'src',
    fromSnapshotId: null,
    toSnapshotId: 'snap',
    changedSpans: [],
    triageClass: 'feature_launch',
    materiality: 2,
    rationale: 'Acme ships Enterprise tier',
    state: 'published',
    confirmedBySnapshotId: null,
    createdAt: NOW,
  });
  await store.insertClaim('ws', {
    id: 'c1',
    deltaId: 'd1',
    snapshotId: 'snap',
    quoteText: 'We now ship an Enterprise tier.',
    charStart: 0,
    charEnd: 10,
    sourceUrl: 'https://acme.test/blog',
    capturedAt: NOW,
    verifiedAt: NOW,
  });
  await store.seedChannelConfig({
    id: 'cfg',
    workspaceId: 'ws',
    channel: 'email',
    destination: 'gtm@acme.test',
    label: null,
    enabled: true,
    createdAt: NOW,
  });
};

describe('runDeliverySweep', () => {
  let store: MemoryFlankStore;
  beforeEach(async () => {
    store = new MemoryFlankStore();
    await seedAlertable(store);
  });

  it('enqueues and delivers an alertable delta to an enabled channel', async () => {
    const calls: NotifyRequest[] = [];
    const report = await runDeliverySweep(
      { store, notifier: okNotifier(calls), nextId: idGen() },
      NOW,
    );

    expect(report).toMatchObject({
      channelsEnabled: 1,
      considered: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      errors: 0,
    });
    expect(calls[0]).toMatchObject({ channel: 'email', target: 'gtm@acme.test' });
    expect(calls[0].subject).toContain('Acme');

    const [alert] = await store.listAlertsForWorkspace('ws');
    expect(alert).toMatchObject({ status: 'delivered', providerRef: 'ref-al-1', attemptCount: 1 });
  });

  it('records a failure (not thrown) and leaves the alert deliverable for the next sweep', async () => {
    const report = await runDeliverySweep({ store, notifier: failNotifier, nextId: idGen() }, NOW);
    expect(report).toMatchObject({ delivered: 0, failed: 1, errors: 0 });

    const [alert] = await store.listAlertsForWorkspace('ws');
    expect(alert).toMatchObject({ status: 'failed', lastError: '503 upstream' });

    // The failed alert is retried next sweep (still deliverable), not re-enqueued as a new row.
    const second = await runDeliverySweep({ store, notifier: failNotifier, nextId: idGen() }, NOW);
    expect(second).toMatchObject({ considered: 1, attempted: 1, failed: 1 });
    expect((await store.listAlertsForWorkspace('ws')).length).toBe(1);
  });

  it('never re-sends a delivered alert on a re-run (idempotent sweep)', async () => {
    const calls: NotifyRequest[] = [];
    await runDeliverySweep({ store, notifier: okNotifier(calls), nextId: idGen() }, NOW);
    const second = await runDeliverySweep(
      { store, notifier: okNotifier(calls), nextId: idGen() },
      NOW,
    );

    // Enqueue dedups (considered=1), but nothing is deliverable, so no second send.
    expect(second).toMatchObject({ considered: 1, attempted: 0, delivered: 0 });
    expect(calls.length).toBe(1);
  });

  it('defaults to the hermetic liveBan notifier — a forgotten injection never dials out', async () => {
    const report = await runDeliverySweep({ store, nextId: idGen() }, NOW);
    // The send throws (liveBan); the per-alert guard counts it, the tick completes, nothing delivered.
    expect(report).toMatchObject({ attempted: 1, delivered: 0, errors: 1 });
    const [alert] = await store.listAlertsForWorkspace('ws');
    expect(alert.status).toBe('queued'); // untouched — no outcome recorded
  });

  it('renders a Block Kit message for a slack channel', async () => {
    await store.seedChannelConfig({
      id: 'cfg-slack',
      workspaceId: 'ws',
      channel: 'slack',
      destination: 'https://hooks.slack.test/z',
      label: null,
      enabled: true,
      createdAt: NOW,
    });
    const calls: NotifyRequest[] = [];
    const report = await runDeliverySweep(
      { store, notifier: okNotifier(calls), nextId: idGen() },
      NOW,
    );

    expect(report.considered).toBe(2); // 1 alertable delta × 2 enabled channels
    const slack = calls.find((c) => c.channel === 'slack');
    expect(slack?.target).toBe('https://hooks.slack.test/z');
    expect(Array.isArray(slack?.blocks)).toBe(true);
  });

  it('does nothing when a workspace has no enabled channels', async () => {
    const bare = new MemoryFlankStore();
    await bare.seedWorkspace({ id: 'ws2', name: 'Quiet', planTier: 'starter' });
    const report = await runDeliverySweep(
      { store: bare, notifier: okNotifier([]), nextId: idGen() },
      NOW,
    );
    expect(report).toMatchObject({ channelsEnabled: 0, considered: 0, attempted: 0 });
  });
});

import type { Alert, AlertChannelConfig, FlankStore, Notifier, Workspace } from '@flank/core';
import { composeAlerts, parseStoredAlertPayload, type AlertPayload } from './alerts';
import { renderEmailAlert, renderSlackAlert } from './alert-render';
import { liveBanNotifier } from './notifier-impls';

const DEFAULT_MAX_SENDS = 100;

export interface DeliveryDeps {
  readonly store: FlankStore;
  /** Defaults to {@link liveBanNotifier} so a test that forgets to inject one fails loud, not live. */
  readonly notifier?: Notifier;
  readonly nextId: () => string;
}

export interface DeliveryOptions {
  /** Max alerts to attempt to send per sweep (back-pressure). */
  readonly maxSends?: number;
}

export interface DeliveryReport {
  readonly channelsEnabled: number;
  /** Enqueue fan-out size this sweep (alertable deltas × enabled channels); dedup absorbs repeats. */
  readonly considered: number;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly errors: number;
}

const buildAlert = (
  payload: AlertPayload,
  config: AlertChannelConfig,
  workspace: Workspace,
  id: string,
  now: Date,
): Alert =>
  Object.freeze({
    id,
    workspaceId: workspace.id,
    deltaId: payload.deltaId,
    channel: config.channel,
    channelConfigId: config.id,
    target: config.destination,
    payload: { ...payload }, // frozen at enqueue time for provenance (capturedAt survives as a Date/ISO)
    status: 'queued',
    attemptCount: 0,
    providerRef: null,
    lastError: null,
    enqueuedAt: now,
    lastAttemptAt: null,
    deliveredAt: null,
  });

/** Group a workspace's enabled channels so its alertable deltas are computed once per workspace. */
const groupByWorkspace = (
  channels: readonly { readonly workspace: Workspace; readonly config: AlertChannelConfig }[],
): Map<string, { workspace: Workspace; configs: AlertChannelConfig[] }> => {
  const grouped = new Map<string, { workspace: Workspace; configs: AlertChannelConfig[] }>();
  for (const { workspace, config } of channels) {
    const entry = grouped.get(workspace.id) ?? { workspace, configs: [] };
    entry.configs.push(config);
    grouped.set(workspace.id, entry);
  }
  return grouped;
};

/** Every alertable payload for one workspace (composeAlerts is the single firewall gate). */
const alertablePayloadsFor = async (
  store: FlankStore,
  workspaceId: string,
): Promise<readonly AlertPayload[]> => {
  const competitors = await store.listCompetitors(workspaceId);
  const all: AlertPayload[] = [];
  for (const competitor of competitors) {
    const deltas = await store.listDeltasForCompetitor(workspaceId, competitor.id);
    const claimsByDelta = new Map(
      await Promise.all(
        deltas.map(async (d) => [d.id, await store.listClaimsForDelta(workspaceId, d.id)] as const),
      ),
    );
    all.push(...composeAlerts(deltas, claimsByDelta, competitor));
  }
  return all;
};

/**
 * One delivery sweep (what the delivery cron invokes). Two phases, both re-runnable:
 *  1. Enqueue — for every enabled channel × alertable delta, idempotently insert a queued alert
 *     (the UNIQUE(delta, channel) constraint absorbs repeats), durably committing the intent.
 *  2. Send — for every still-deliverable alert (queued/failed), render + send via the notifier and
 *     record the outcome. Each alert is isolated in its own try/catch, so one failure never aborts
 *     the sweep (mirrors runScheduledTick). I/O happens outside any DB transaction.
 */
export const runDeliverySweep = async (
  deps: DeliveryDeps,
  now: Date,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> => {
  const notifier = deps.notifier ?? liveBanNotifier;
  const maxSends = options.maxSends ?? DEFAULT_MAX_SENDS;
  let considered = 0;
  let errors = 0;

  // Phase 1 — enqueue.
  const channels = await deps.store.listEnabledChannelConfigs();
  for (const { workspace, configs } of groupByWorkspace(channels).values()) {
    const payloads = await alertablePayloadsFor(deps.store, workspace.id);
    for (const payload of payloads) {
      for (const config of configs) {
        considered += 1;
        try {
          await deps.store.enqueueAlert(
            workspace.id,
            buildAlert(payload, config, workspace, deps.nextId(), now),
          );
        } catch {
          errors += 1;
        }
      }
    }
  }

  // Phase 2 — send.
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  const deliverable = await deps.store.listDeliverableAlerts(maxSends);
  for (const { workspace, alert } of deliverable) {
    attempted += 1;
    try {
      const payload = parseStoredAlertPayload(alert.payload);
      const result = await notifier.send(toNotifyRequest(alert, payload));
      if (result.ok) {
        await deps.store.recordAlertOutcome(
          workspace.id,
          alert.id,
          'delivered',
          { providerRef: result.providerRef },
          now,
        );
        delivered += 1;
      } else {
        await deps.store.recordAlertOutcome(
          workspace.id,
          alert.id,
          'failed',
          { error: result.error },
          now,
        );
        failed += 1;
      }
    } catch {
      // An unexpected error (render/store) — counted, never aborts the sweep. The row stays
      // queued/failed and is retried next sweep.
      errors += 1;
    }
  }

  return Object.freeze({
    channelsEnabled: channels.length,
    considered,
    attempted,
    delivered,
    failed,
    errors,
  });
};

const toNotifyRequest = (alert: Alert, payload: AlertPayload) => {
  if (alert.channel === 'slack') {
    const message = renderSlackAlert(payload);
    return {
      channel: 'slack' as const,
      target: alert.target,
      subject: '',
      text: message.text,
      blocks: message.blocks,
      idempotencyKey: alert.id,
    };
  }
  const message = renderEmailAlert(payload);
  return {
    channel: 'email' as const,
    target: alert.target,
    subject: message.subject,
    text: message.text,
    html: message.html,
    idempotencyKey: alert.id,
  };
};

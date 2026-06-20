import {
  assertAlertTransition,
  CrossTenantError,
  UnknownEntityError,
  type Alert,
  type AlertChannelConfig,
  type AlertStatus,
  type DeliverableAlert,
  type EnabledChannel,
} from '@flank/core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FlankDatabase } from './client';
import { toAlert, toAlertChannelConfig, toWorkspace } from './drizzle-mappers';
import { alertChannelConfigs, alerts, deltas, workspaces } from './schema';

// The M3 alert-delivery store methods, kept out of drizzle-store.ts so neither file exceeds its size
// budget. DrizzleFlankStore delegates its alert/channel methods to these free functions.

export const seedChannelConfig = async (
  db: FlankDatabase,
  config: AlertChannelConfig,
): Promise<AlertChannelConfig> => {
  const [row] = await db
    .insert(alertChannelConfigs)
    .values({
      id: config.id,
      workspaceId: config.workspaceId,
      channel: config.channel,
      destination: config.destination,
      label: config.label,
      enabled: config.enabled,
      createdAt: config.createdAt,
    })
    .returning();
  return toAlertChannelConfig(row);
};

export const listChannelConfigs = async (
  db: FlankDatabase,
  workspaceId: string,
): Promise<readonly AlertChannelConfig[]> => {
  const rows = await db
    .select()
    .from(alertChannelConfigs)
    .where(eq(alertChannelConfigs.workspaceId, workspaceId))
    .orderBy(asc(alertChannelConfigs.createdAt), asc(alertChannelConfigs.id));
  return Object.freeze(rows.map(toAlertChannelConfig));
};

export const listEnabledChannelConfigs = async (
  db: FlankDatabase,
): Promise<readonly EnabledChannel[]> => {
  const rows = await db
    .select({ config: alertChannelConfigs, workspace: workspaces })
    .from(alertChannelConfigs)
    .innerJoin(workspaces, eq(alertChannelConfigs.workspaceId, workspaces.id))
    .where(eq(alertChannelConfigs.enabled, true))
    .orderBy(asc(alertChannelConfigs.createdAt), asc(alertChannelConfigs.id));
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        workspace: toWorkspace(row.workspace),
        config: toAlertChannelConfig(row.config),
      }),
    ),
  );
};

export const enqueueAlert = async (
  db: FlankDatabase,
  workspaceId: string,
  alert: Alert,
): Promise<Alert> => {
  // Fail closed if the delta is unknown or belongs to another tenant (Invariant 8).
  const owner = await db
    .select({ workspaceId: deltas.workspaceId })
    .from(deltas)
    .where(eq(deltas.id, alert.deltaId))
    .limit(1);
  if (owner[0] === undefined) throw new UnknownEntityError(`delta ${alert.deltaId} does not exist`);
  if (owner[0].workspaceId !== workspaceId || alert.workspaceId !== workspaceId) {
    throw new CrossTenantError(`alert ${alert.id} is not in workspace ${workspaceId}`);
  }

  // Idempotent enqueue: a repeat (delta, channel config) is absorbed by the UNIQUE constraint, then
  // we re-select so the caller always gets the canonical row (freshly inserted OR pre-existing).
  await db
    .insert(alerts)
    .values({
      id: alert.id,
      workspaceId: alert.workspaceId,
      deltaId: alert.deltaId,
      channel: alert.channel,
      channelConfigId: alert.channelConfigId,
      target: alert.target,
      payload: alert.payload,
      status: alert.status,
      attemptCount: alert.attemptCount,
      providerRef: alert.providerRef,
      lastError: alert.lastError,
      enqueuedAt: alert.enqueuedAt,
      lastAttemptAt: alert.lastAttemptAt,
      deliveredAt: alert.deliveredAt,
    })
    .onConflictDoNothing({ target: [alerts.deltaId, alerts.channelConfigId] });

  const [row] = await db
    .select()
    .from(alerts)
    .where(
      and(eq(alerts.deltaId, alert.deltaId), eq(alerts.channelConfigId, alert.channelConfigId)),
    )
    .limit(1);
  return toAlert(row);
};

export const listDeliverableAlerts = async (
  db: FlankDatabase,
  limit: number,
): Promise<readonly DeliverableAlert[]> => {
  const rows = await db
    .select({ alert: alerts, workspace: workspaces })
    .from(alerts)
    .innerJoin(workspaces, eq(alerts.workspaceId, workspaces.id))
    .where(inArray(alerts.status, ['queued', 'failed']))
    .orderBy(asc(alerts.enqueuedAt), asc(alerts.id))
    .limit(Math.max(0, limit));
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({ workspace: toWorkspace(row.workspace), alert: toAlert(row.alert) }),
    ),
  );
};

export const recordAlertOutcome = async (
  db: FlankDatabase,
  workspaceId: string,
  alertId: string,
  to: AlertStatus,
  detail: { readonly providerRef?: string | null; readonly error?: string | null },
  at: Date,
): Promise<Alert> => {
  const [current] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (current === undefined) throw new UnknownEntityError(`alert ${alertId} does not exist`);
  if (current.workspaceId !== workspaceId) {
    throw new CrossTenantError(`alert ${alertId} is not in workspace ${workspaceId}`);
  }
  // App-tier guard (matches the DB trigger): an illegal transition / proofless delivery throws here.
  assertAlertTransition(current, to, detail.providerRef);

  const [updated] = await db
    .update(alerts)
    .set({
      status: to,
      attemptCount: current.attemptCount + 1,
      providerRef: to === 'delivered' ? (detail.providerRef ?? null) : current.providerRef,
      lastError: to === 'failed' ? (detail.error ?? null) : current.lastError,
      lastAttemptAt: at,
      deliveredAt: to === 'delivered' ? at : current.deliveredAt,
    })
    .where(eq(alerts.id, alertId))
    .returning();
  return toAlert(updated);
};

export const listAlertsForWorkspace = async (
  db: FlankDatabase,
  workspaceId: string,
): Promise<readonly Alert[]> => {
  const rows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.workspaceId, workspaceId))
    .orderBy(desc(alerts.enqueuedAt), desc(alerts.id));
  return Object.freeze(rows.map(toAlert));
};

import type { Alert, AlertStatus } from '@flank/core';

export interface AlertRowView {
  readonly id: string;
  readonly competitorName: string;
  readonly whatChanged: string;
  readonly channel: string;
  readonly status: AlertStatus;
  readonly target: string;
  readonly enqueuedAt: string;
  readonly deliveredAt: string | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
}

export interface AlertSummary {
  readonly delivered: number;
  readonly failed: number;
  readonly queued: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Shape delivery-log rows for the read-only /authed/alerts view (payload carries what/who). */
export const toAlertRows = (alerts: readonly Alert[]): readonly AlertRowView[] =>
  Object.freeze(
    alerts.map((alert) =>
      Object.freeze({
        id: alert.id,
        competitorName: str(alert.payload.competitorName),
        whatChanged: str(alert.payload.whatChanged),
        channel: alert.channel,
        status: alert.status,
        target: alert.target,
        enqueuedAt: alert.enqueuedAt.toISOString(),
        deliveredAt: alert.deliveredAt === null ? null : alert.deliveredAt.toISOString(),
        attemptCount: alert.attemptCount,
        lastError: alert.lastError,
      }),
    ),
  );

/** Counts by status — the operator's at-a-glance "did my alerts go out" (Invariant 7, made visible). */
export const summarizeAlerts = (alerts: readonly Alert[]): AlertSummary =>
  alerts.reduce<AlertSummary>(
    (acc, alert) => ({
      delivered: acc.delivered + (alert.status === 'delivered' ? 1 : 0),
      failed: acc.failed + (alert.status === 'failed' ? 1 : 0),
      queued: acc.queued + (alert.status === 'queued' ? 1 : 0),
    }),
    { delivered: 0, failed: 0, queued: 0 },
  );

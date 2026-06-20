import type { AlertChannel } from './entities';

/** One channel destination plus the already-rendered message for it. */
export interface NotifyRequest {
  readonly channel: AlertChannel;
  /** Webhook URL (slack) or recipient address (email). */
  readonly target: string;
  readonly subject: string;
  /** Plain-text body / notification fallback. */
  readonly text: string;
  /** Email HTML body (ignored by slack). */
  readonly html?: string;
  /** Slack Block Kit payload (opaque to core; ignored by email). */
  readonly blocks?: readonly unknown[];
  /** Stable key (the alert id) — providers that support it (Resend) dedupe on this. */
  readonly idempotencyKey: string;
}

/**
 * The outcome of ONE delivery attempt. A transport failure (4xx/5xx/timeout) is expected operational
 * data, NOT an exception — it is reported as `{ ok: false }` and retried on the next sweep. Only an
 * unexpected programming error throws (and is caught by the sweep's per-row guard).
 */
export type NotifyResult =
  | { readonly ok: true; readonly providerRef: string; readonly httpStatus: number }
  | { readonly ok: false; readonly error: string; readonly httpStatus: number | null };

/**
 * Transport port for sending an alert to a channel. The port lives in core (like {@link Fetcher});
 * concrete Slack/email implementations live in the pipeline, and unit tests inject a fake or the
 * hermetic `liveBanNotifier` so the suite makes zero live calls.
 */
export interface Notifier {
  send(request: NotifyRequest): Promise<NotifyResult>;
}

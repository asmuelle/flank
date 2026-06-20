import type { Notifier, NotifyRequest, NotifyResult } from '@flank/core';

const DEFAULT_TIMEOUT_MS = 10_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface NotifierOptions {
  readonly fetchImpl?: FetchImpl;
  readonly timeoutMs?: number;
}

/** Thrown by {@link liveBanNotifier}: any send in a hermetic test is a breach (mirrors liveBanMessageCreator). */
export class LiveNotificationBannedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveNotificationBannedError';
  }
}

/** Default for unit tests: any send throws instead of dialing out. Inject a fake to actually deliver. */
export const liveBanNotifier: Notifier = {
  async send(): Promise<NotifyResult> {
    throw new LiveNotificationBannedError(
      'refusing a live notification: tests/CI are hermetic — inject a fake notifier',
    );
  },
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const truncate = (text: string, max = 500): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

interface PostOutcome {
  readonly httpStatus: number;
  readonly body: string;
}

const postJson = async (
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<PostOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return { httpStatus: response.status, body: text };
  } finally {
    clearTimeout(timer);
  }
};

const isOk = (status: number): boolean => status >= 200 && status < 300;

// Slack incoming webhooks have NO idempotency key, so Slack delivery is at-least-once: if the POST
// succeeds but recordAlertOutcome('delivered') then fails (or the process dies in that gap), the next
// sweep re-sends and the channel sees a duplicate message. Email is effectively exactly-once (Resend
// dedupes on the idempotency key below). Fully closing the Slack gap needs a persisted "sending" state
// (the deferred alert_attempt work); for M3 the duplicate is a rare, informational re-post.
const sendSlack = async (
  request: NotifyRequest,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<NotifyResult> => {
  try {
    const { httpStatus, body } = await postJson(
      request.target,
      { text: request.text, blocks: request.blocks ?? [] },
      {},
      fetchImpl,
      timeoutMs,
    );
    if (isOk(httpStatus)) {
      // Slack incoming webhooks return a bare 'ok' with no message ts — synthesize a deterministic
      // reference so a delivered alert still carries proof (required by the status machine).
      return { ok: true, providerRef: `slack:${request.idempotencyKey}`, httpStatus };
    }
    return { ok: false, error: `slack webhook ${httpStatus}: ${truncate(body)}`, httpStatus };
  } catch (error) {
    return { ok: false, error: messageOf(error), httpStatus: null };
  }
};

const sendEmail = async (
  request: NotifyRequest,
  apiKey: string | undefined,
  from: string | undefined,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<NotifyResult> => {
  if (apiKey === undefined || apiKey === '' || from === undefined || from === '') {
    // Keep silence visible (Invariant 7): record a failure rather than dialing out half-configured.
    return {
      ok: false,
      error: 'email channel not configured (RESEND_API_KEY / FLANK_ALERT_FROM)',
      httpStatus: null,
    };
  }
  try {
    const { httpStatus, body } = await postJson(
      RESEND_ENDPOINT,
      {
        from,
        to: request.target,
        subject: request.subject,
        text: request.text,
        html: request.html,
      },
      // Resend dedupes on the idempotency key — narrows the send-succeeds-but-record-fails window.
      { authorization: `Bearer ${apiKey}`, 'idempotency-key': request.idempotencyKey },
      fetchImpl,
      timeoutMs,
    );
    if (isOk(httpStatus)) {
      let providerRef = `resend:${request.idempotencyKey}`;
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
          const id = (parsed as { readonly id?: unknown }).id;
          if (typeof id === 'string' && id !== '') providerRef = id;
        }
      } catch {
        // Non-JSON 2xx body — keep the synthetic ref.
      }
      return { ok: true, providerRef, httpStatus };
    }
    return { ok: false, error: `resend ${httpStatus}: ${truncate(body)}`, httpStatus };
  } catch (error) {
    return { ok: false, error: messageOf(error), httpStatus: null };
  }
};

/**
 * Build the production notifier from env. One notifier dispatches by channel: Slack posts the
 * per-workspace incoming-webhook URL (`target`, no global secret); email posts the Resend API with
 * the global `RESEND_API_KEY` + `FLANK_ALERT_FROM`. A transport failure is returned as `{ ok: false }`
 * (never thrown), so the delivery sweep records it as `failed` and retries — it never aborts the tick.
 */
export const createNotifier = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: NotifierOptions = {},
): Notifier => {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = env.RESEND_API_KEY;
  const from = env.FLANK_ALERT_FROM;
  return {
    send(request: NotifyRequest): Promise<NotifyResult> {
      return request.channel === 'slack'
        ? sendSlack(request, fetchImpl, timeoutMs)
        : sendEmail(request, apiKey, from, fetchImpl, timeoutMs);
    },
  };
};

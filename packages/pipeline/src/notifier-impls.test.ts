import type { NotifyRequest } from '@flank/core';
import { describe, expect, it, vi } from 'vitest';
import { createNotifier, liveBanNotifier, LiveNotificationBannedError } from './notifier-impls';

const slackReq = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  channel: 'slack',
  target: 'https://hooks.slack.test/abc',
  subject: 'ignored',
  text: 'fallback',
  blocks: [{ type: 'section' }],
  idempotencyKey: 'al-1',
  ...over,
});

const emailReq = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  channel: 'email',
  target: 'gtm@acme.test',
  subject: '[Flank] Acme',
  text: 'plain',
  html: '<p>html</p>',
  idempotencyKey: 'al-2',
  ...over,
});

const okResponse = (body = 'ok', status = 200): Response =>
  ({ status, text: async () => body }) as unknown as Response;

describe('liveBanNotifier', () => {
  it('throws on any send (hermetic default)', async () => {
    await expect(liveBanNotifier.send(slackReq())).rejects.toBeInstanceOf(
      LiveNotificationBannedError,
    );
  });
});

describe('createNotifier — slack', () => {
  it('posts the webhook and reports a providerRef on 2xx', async () => {
    const fetchImpl = vi.fn(async () => okResponse('ok'));
    const result = await createNotifier({}, { fetchImpl }).send(slackReq());
    expect(result).toEqual({ ok: true, providerRef: 'slack:al-1', httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledWith('https://hooks.slack.test/abc', expect.any(Object));
  });

  it('reports failed (not thrown) on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => okResponse('invalid_payload', 400));
    const result = await createNotifier({}, { fetchImpl }).send(slackReq());
    expect(result).toMatchObject({ ok: false, httpStatus: 400 });
  });

  it('reports failed with null status when the transport throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const result = await createNotifier({}, { fetchImpl }).send(slackReq());
    expect(result).toEqual({ ok: false, error: 'network down', httpStatus: null });
  });
});

describe('createNotifier — email', () => {
  const env = { RESEND_API_KEY: 'rk_test', FLANK_ALERT_FROM: 'radar@flank.test' };

  it('posts Resend with the api key + idempotency key and returns the provider id', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(JSON.stringify({ id: 'resend-123' })),
    );
    const result = await createNotifier(env, { fetchImpl }).send(emailReq());
    expect(result).toEqual({ ok: true, providerRef: 'resend-123', httpStatus: 200 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer rk_test');
    expect(headers['idempotency-key']).toBe('al-2');
  });

  it('records a failure (never dials out) when email is not configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const result = await createNotifier({}, { fetchImpl }).send(emailReq());
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

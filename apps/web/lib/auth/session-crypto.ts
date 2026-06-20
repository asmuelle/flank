import { createHmac, timingSafeEqual } from 'node:crypto';

/** Bump to invalidate every existing session (e.g. payload-shape change). */
export const SESSION_VERSION = 1;

/** The signed session payload — carries ONLY identity + expiry, NEVER tenancy (re-derived per request). */
export interface SessionPrincipal {
  readonly v: number;
  readonly uid: string;
  readonly exp: number; // epoch milliseconds
}

export type SessionVerifyResult =
  | { readonly ok: true; readonly principal: SessionPrincipal }
  | {
      readonly ok: false;
      readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'bad_version';
    };

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const decode = (b64: string): string => Buffer.from(b64, 'base64url').toString('utf8');

/** HMAC-SHA256 over the EXACT payload string (the base64url text before the dot), not re-serialized
 * JSON — so key order / whitespace / unicode escaping can never desync sign and verify. */
const mac = (payloadB64: string, secret: string): string =>
  createHmac('sha256', secret).update(payloadB64).digest('base64url');

/** Mint `payloadB64.sigB64`. Total — always returns a token. */
export const signSession = (
  principal: { readonly uid: string; readonly exp: number },
  secret: string,
): string => {
  const payload: SessionPrincipal = { v: SESSION_VERSION, uid: principal.uid, exp: principal.exp };
  const payloadB64 = encode(JSON.stringify(payload));
  return `${payloadB64}.${mac(payloadB64, secret)}`;
};

const isPrincipal = (value: unknown): value is SessionPrincipal => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.v === 'number' &&
    typeof candidate.uid === 'string' &&
    candidate.uid !== '' &&
    typeof candidate.exp === 'number'
  );
};

/**
 * Verify a session token. NEVER throws — returns a discriminated result. Signature is checked first
 * in constant time (length mismatch fails before {@link timingSafeEqual}); only then is the payload
 * trusted enough to parse, version-check, and expiry-check.
 */
export const verifySession = (
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): SessionVerifyResult => {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = parts;
  const actual = Buffer.from(sigB64, 'utf8');
  const expected = Buffer.from(mac(payloadB64, secret), 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(payloadB64));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPrincipal(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.v !== SESSION_VERSION) return { ok: false, reason: 'bad_version' };
  if (parsed.exp <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, principal: parsed };
};

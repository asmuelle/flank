import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signSession, verifySession, SESSION_VERSION } from './session-crypto';

const SECRET = 'a'.repeat(32);
const NOW = 1_900_000_000_000;
const future = NOW + 60_000;

describe('session crypto', () => {
  it('round-trips a signed session', () => {
    const token = signSession({ uid: 'u-1', exp: future }, SECRET);
    const result = verifySession(token, SECRET, NOW);
    expect(result).toEqual({
      ok: true,
      principal: { v: SESSION_VERSION, uid: 'u-1', exp: future },
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSession({ uid: 'u-1', exp: future }, SECRET);
    expect(verifySession(token, 'b'.repeat(32), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signSession({ uid: 'u-1', exp: future }, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ v: 1, uid: 'admin', exp: future })).toString('base64url')}.${sig}`;
    expect(verifySession(forged, SECRET, NOW).ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = signSession({ uid: 'u-1', exp: NOW - 1 }, SECRET);
    expect(verifySession(token, SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a wrong version', () => {
    const payload = Buffer.from(JSON.stringify({ v: 99, uid: 'u-1', exp: future })).toString(
      'base64url',
    );
    // sign manually with a valid mac so the signature passes but the version is wrong
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifySession(`${payload}.${sig}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_version',
    });
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of ['', 'nodot', 'a.b.c', '.sig', 'payload.', 'not%base64.x']) {
      expect(verifySession(bad, SECRET, NOW).ok).toBe(false);
    }
  });
});

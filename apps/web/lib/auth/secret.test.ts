import { describe, expect, it } from 'vitest';
import { getSessionSecret } from './secret';

const STRONG = 'a'.repeat(32);

describe('getSessionSecret', () => {
  it('returns a provided AUTH_SESSION_SECRET when long enough', () => {
    expect(getSessionSecret({ AUTH_SESSION_SECRET: STRONG })).toEqual({
      value: STRONG,
      isDevDefault: false,
    });
  });

  it('falls back to NEXTAUTH_SECRET when AUTH_SESSION_SECRET is absent', () => {
    const result = getSessionSecret({ NEXTAUTH_SECRET: STRONG });
    expect(result.value).toBe(STRONG);
    expect(result.isDevDefault).toBe(false);
  });

  it('prefers AUTH_SESSION_SECRET over NEXTAUTH_SECRET', () => {
    const result = getSessionSecret({
      AUTH_SESSION_SECRET: STRONG,
      NEXTAUTH_SECRET: 'b'.repeat(40),
    });
    expect(result.value).toBe(STRONG);
  });

  it('rejects a too-short provided secret in every environment', () => {
    expect(() => getSessionSecret({ AUTH_SESSION_SECRET: 'short' })).toThrow(/at least 32 bytes/);
    expect(() =>
      getSessionSecret({ AUTH_SESSION_SECRET: 'short', NODE_ENV: 'production' }),
    ).toThrow(/at least 32 bytes/);
  });

  it('treats an empty-string secret as absent', () => {
    const result = getSessionSecret({ AUTH_SESSION_SECRET: '', NODE_ENV: 'development' });
    expect(result.isDevDefault).toBe(true);
  });

  it('throws when no secret is set in production', () => {
    expect(() => getSessionSecret({ NODE_ENV: 'production' })).toThrow(/required in production/);
  });

  it('falls back to an obvious insecure default outside production', () => {
    const result = getSessionSecret({ NODE_ENV: 'development' });
    expect(result.isDevDefault).toBe(true);
    expect(result.value.length).toBeGreaterThanOrEqual(32);
    expect(result.value).toMatch(/insecure/);
  });
});

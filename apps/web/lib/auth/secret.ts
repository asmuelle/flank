const MIN_SECRET_BYTES = 32;
/** An obvious, never-confusable-with-real insecure default for non-production only. */
const DEV_DEFAULT_SECRET = 'flank-dev-insecure-session-secret-do-not-ship-0000';

export interface SessionSecret {
  readonly value: string;
  /** True when the insecure dev fallback is in use — callers must NOT set Secure cookies. */
  readonly isDevDefault: boolean;
}

/**
 * Resolve and VALIDATE the session HMAC secret (pure; env injected). A provided secret is rejected in
 * ALL environments if shorter than 32 bytes (a weak secret forges every session). An absent secret
 * throws in production and falls back to an obvious insecure default elsewhere.
 */
export const getSessionSecret = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionSecret => {
  const provided = env.AUTH_SESSION_SECRET ?? env.NEXTAUTH_SECRET;
  if (provided !== undefined && provided !== '') {
    if (Buffer.byteLength(provided, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(`session secret must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return Object.freeze({ value: provided, isDevDefault: false });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('AUTH_SESSION_SECRET (or NEXTAUTH_SECRET) is required in production');
  }
  return Object.freeze({ value: DEV_DEFAULT_SECRET, isDevDefault: true });
};

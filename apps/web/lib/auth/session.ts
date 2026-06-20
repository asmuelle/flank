import 'server-only';
import type { MembershipRole, MembershipWithWorkspace } from '@flank/core';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getStore } from '../store';
import { resolveWorkspace } from './resolver';
import { getSessionSecret } from './secret';
import { signSession } from './session-crypto';

export const SESSION_COOKIE = 'flank_session';
/** Non-authoritative: only ever SELECTS among the user's live memberships (see resolveWorkspace). */
export const WORKSPACE_HINT_COOKIE = 'flank_ws';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SIGN_IN_PATH = '/auth/sign-in';

export interface ActiveWorkspace {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: MembershipRole;
  readonly memberships: readonly MembershipWithWorkspace[];
}

// HttpOnly + SameSite=Lax + signed cookie. Secure tracks "is this a real secret": a real secret
// implies a deployed (HTTPS) origin, while the insecure dev default must work over plain-http localhost.
const cookieOptions = (secure: boolean) =>
  ({ httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_MS / 1000 }) as const;

/**
 * Resolve the request's active workspace, or redirect to sign-in. `cache` dedupes the cookie read +
 * membership query across every Server Component in a single render. Tenancy is re-derived from live
 * memberships each request, so this is the single trusted gate every authed surface calls.
 */
export const resolveActiveWorkspace = cache(async (): Promise<ActiveWorkspace> => {
  const jar = await cookies();
  const result = await resolveWorkspace({
    token: jar.get(SESSION_COOKIE)?.value ?? null,
    workspaceHint: jar.get(WORKSPACE_HINT_COOKIE)?.value ?? null,
    secret: getSessionSecret().value,
    store: getStore(),
    nowMs: Date.now(),
  });
  if (!result.ok) {
    redirect(result.reason === 'no_workspace' ? `${SIGN_IN_PATH}?e=no_workspace` : SIGN_IN_PATH);
  }
  return result;
});

/** Mint + set the signed session cookie for a user (called from the sign-in Server Action). */
export const startSession = async (userId: string): Promise<void> => {
  const secret = getSessionSecret();
  const token = signSession({ uid: userId, exp: Date.now() + SESSION_TTL_MS }, secret.value);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(!secret.isDevDefault));
};

/** Clear session + workspace-hint cookies (sign-out). */
export const endSession = async (): Promise<void> => {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(WORKSPACE_HINT_COOKIE);
};

/** Persist the user's preferred workspace; only ever selects among live memberships at resolve time. */
export const setWorkspaceHint = async (workspaceId: string): Promise<void> => {
  const secret = getSessionSecret();
  const jar = await cookies();
  jar.set(WORKSPACE_HINT_COOKIE, workspaceId, cookieOptions(!secret.isDevDefault));
};

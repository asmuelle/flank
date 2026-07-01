import 'server-only';
import type { MembershipRole, MembershipWithWorkspace } from '@flank/core';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '../../auth';
import { getStore } from '../store';
import { resolveWorkspace } from './resolver';

/** Non-authoritative: only ever SELECTS among the user's live memberships (see resolveWorkspace). */
export const WORKSPACE_HINT_COOKIE = 'flank_ws';
const HINT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days — a UI preference, not a credential
const SIGN_IN_PATH = '/auth/sign-in';

export interface ActiveWorkspace {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: MembershipRole;
  readonly memberships: readonly MembershipWithWorkspace[];
}

// The hint is a plain (unsigned) preference cookie — it carries no authority, so it never needs a
// signature. Secure tracks deployment: HTTPS in production, plain-http localhost in dev.
const hintCookieOptions = () =>
  ({
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: HINT_TTL_MS / 1000,
  }) as const;

/**
 * Resolve the request's active workspace, or redirect to sign-in. Identity comes from the Auth.js /
 * FerrisKey session; tenancy is re-derived from live memberships. `cache` dedupes the session read +
 * membership query across every Server Component in a single render. This is the single trusted gate
 * every authed surface calls.
 */
export const resolveActiveWorkspace = cache(async (): Promise<ActiveWorkspace> => {
  const session = await auth();
  const jar = await cookies();
  const result = await resolveWorkspace({
    userId: session?.user?.id ?? null,
    workspaceHint: jar.get(WORKSPACE_HINT_COOKIE)?.value ?? null,
    store: getStore(),
  });
  if (!result.ok) {
    redirect(result.reason === 'no_workspace' ? `${SIGN_IN_PATH}?e=no_workspace` : SIGN_IN_PATH);
  }
  return result;
});

/** Persist the user's preferred workspace; only ever selects among live memberships at resolve time. */
export const setWorkspaceHint = async (workspaceId: string): Promise<void> => {
  const jar = await cookies();
  jar.set(WORKSPACE_HINT_COOKIE, workspaceId, hintCookieOptions());
};

/** Drop the workspace-hint cookie (called on sign-out, alongside Auth.js signOut). */
export const clearWorkspaceHint = async (): Promise<void> => {
  const jar = await cookies();
  jar.delete(WORKSPACE_HINT_COOKIE);
};

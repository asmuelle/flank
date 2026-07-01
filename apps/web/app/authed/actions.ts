'use server';

import { redirect } from 'next/navigation';
import { signOut as authSignOut } from '../../auth';
import {
  clearWorkspaceHint,
  resolveActiveWorkspace,
  setWorkspaceHint,
} from '../../lib/auth/session';

/**
 * Sign out: drop the workspace-hint cookie, then clear the Auth.js session and return to sign-in.
 * (Local session only — full RP-initiated FerrisKey logout via the realm end-session endpoint is a
 * later enhancement; the next protected request already redirects to a fresh FerrisKey login.)
 */
export const signOut = async (): Promise<void> => {
  await clearWorkspaceHint();
  await authSignOut({ redirectTo: '/auth/sign-in' });
};

/**
 * Switch the active workspace by writing a hint cookie. The hint is non-authoritative: the request
 * resolver only ever honors it if it names a workspace the user actually belongs to (else it falls
 * back to the first membership), so a forged id can never widen access.
 */
export const switchWorkspace = async (formData: FormData): Promise<void> => {
  // Fail closed before touching any state: an unauthenticated POST to this action redirects to
  // sign-in instead of writing a hint cookie.
  await resolveActiveWorkspace();
  const workspaceId = formData.get('workspaceId');
  if (typeof workspaceId === 'string' && workspaceId !== '') {
    await setWorkspaceHint(workspaceId);
  }
  redirect('/authed');
};

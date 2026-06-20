'use server';

import { redirect } from 'next/navigation';
import { endSession, setWorkspaceHint } from '../../lib/auth/session';

export const signOut = async (): Promise<void> => {
  await endSession();
  redirect('/auth/sign-in');
};

/**
 * Switch the active workspace by writing a hint cookie. The hint is non-authoritative: the request
 * resolver only ever honors it if it names a workspace the user actually belongs to (else it falls
 * back to the first membership), so a forged id can never widen access.
 */
export const switchWorkspace = async (formData: FormData): Promise<void> => {
  const workspaceId = formData.get('workspaceId');
  if (typeof workspaceId === 'string' && workspaceId !== '') {
    await setWorkspaceHint(workspaceId);
  }
  redirect('/authed');
};

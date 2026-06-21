'use server';

import { signIn } from '../../../auth';

/**
 * Start the FerrisKey OIDC login. Auth.js redirects to the realm's authorization endpoint (PKCE),
 * and the callback returns the user to `/authed`. No email/password is handled here — identity is
 * owned entirely by FerrisKey.
 */
export const signInWithFerrisKey = async (): Promise<void> => {
  await signIn('ferriskey', { redirectTo: '/authed' });
};

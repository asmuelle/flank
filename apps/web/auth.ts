import { EmailSchema, type ExternalIdentity } from '@flank/core';
import NextAuth, { type DefaultSession, type Profile } from 'next-auth';
import { getStore } from './lib/store';

/**
 * Auth.js (NextAuth v5) wired to FerrisKey as the sole identity provider.
 *
 * Scope is authentication ONLY: FerrisKey proves *who* the user is over OIDC; *tenancy* (which
 * workspace, which role) is never carried in the token — it is re-derived per request from the
 * local `memberships` table in {@link resolveActiveWorkspace} (Product Invariant 8). The bridge
 * between the two is the local `AppUser`: on every sign-in we map the verified OIDC identity to
 * exactly one local user via {@link FlankStore.linkOrCreateUserBySubject} and stash that local id
 * on the token, so all downstream code keys off a stable internal id, not the raw IdP `sub`.
 *
 * Lazy config form (`NextAuth(() => ...)`) defers every env read to request time, mirroring the
 * repo's deferred-validation pattern (see `lib/store.ts`) so `next build` never needs the secrets.
 */

const requiredEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`${key} is required for FerrisKey OIDC (see TOOLS.md / .env.example)`);
  }
  return value;
};

/** Realm-scoped OIDC issuer; Auth.js discovers endpoints from its `.well-known/openid-configuration`. */
const ferriskeyIssuer = (): string =>
  `${requiredEnv('FERRISKEY_ISSUER').replace(/\/$/, '')}/realms/${requiredEnv('FERRISKEY_REALM')}`;

/** Validate the OIDC profile at the boundary (AGENTS.md: never trust external data). */
const toIdentity = (profile: Profile | undefined): ExternalIdentity | null => {
  if (profile === undefined) return null;
  const subject = profile.sub;
  const email = EmailSchema.safeParse(profile.email);
  if (typeof subject !== 'string' || subject === '' || !email.success) return null;
  const name = typeof profile.name === 'string' && profile.name !== '' ? profile.name : null;
  // Only a verified email may adopt a pre-provisioned local account (anti-hijack); absent/false fails closed.
  const emailVerified = profile.email_verified === true;
  return { subject, email: email.data, emailVerified, name };
};

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // Route Auth.js's built-in sign-in + error pages to our own surface, so an OIDC error (cancelled
  // login, state mismatch) lands on the branded sign-in card instead of the default Auth.js page.
  pages: { signIn: '/auth/sign-in', error: '/auth/sign-in' },
  providers: [
    {
      id: 'ferriskey',
      name: 'FerrisKey',
      type: 'oidc',
      issuer: ferriskeyIssuer(),
      clientId: requiredEnv('FERRISKEY_CLIENT_ID'),
      clientSecret: requiredEnv('FERRISKEY_CLIENT_SECRET'),
      authorization: { params: { scope: 'openid email profile' } },
      checks: ['pkce', 'state'],
    },
  ],
  callbacks: {
    // First leg of a sign-in carries `profile`; provision/link the local user and pin its id.
    // Throwing here fails the sign-in closed — we never establish a session we can't attribute.
    async jwt({ token, profile }) {
      if (profile !== undefined) {
        const identity = toIdentity(profile);
        if (identity === null) {
          throw new Error('FerrisKey did not return a usable subject + email');
        }
        const user = await getStore().linkOrCreateUserBySubject(identity);
        token.uid = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.uid === 'string') {
        session.user.id = token.uid;
      }
      return session;
    },
  },
}));

declare module 'next-auth' {
  /** The local AppUser id (not the IdP `sub`) every server surface reads. */
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

// JWT carries the local user id as `token.uid`. Auth.js's JWT extends Record<string, unknown>, so
// no module augmentation is needed — reads are narrowed with `typeof token.uid === 'string'`.

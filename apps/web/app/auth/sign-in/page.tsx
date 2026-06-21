import type { Metadata } from 'next';
import { signInWithFerrisKey } from './actions';

export const metadata: Metadata = { title: 'Sign in — Flank' };

const MESSAGES: Readonly<Record<string, string>> = {
  no_workspace: 'That account has no workspace yet. Ask an owner to add you.',
  oidc: 'Sign-in failed. Please try again.',
};

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly e?: string }>;
}) {
  const { e } = await searchParams;
  const message = e !== undefined ? MESSAGES[e] : undefined;

  return (
    <div className="auth-shell">
      <main className="auth-card">
        <p className="masthead-kicker mono">Flank · competitor radar</p>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">
          Continue with FerrisKey to verify your identity. We resolve every request to a live
          membership — no tenancy is ever trusted from the token.
        </p>

        {message !== undefined ? (
          <p className="auth-error" role="alert">
            {message}
          </p>
        ) : null}

        <form action={signInWithFerrisKey} className="auth-form">
          <button type="submit" className="auth-button">
            Continue with FerrisKey
          </button>
        </form>

        <p className="auth-foot mono">single sign-on · identity managed by FerrisKey (OIDC)</p>
      </main>
    </div>
  );
}

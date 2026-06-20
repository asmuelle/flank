import type { Metadata } from 'next';
import { signIn } from './actions';

export const metadata: Metadata = { title: 'Sign in — Flank' };

const MESSAGES: Readonly<Record<string, string>> = {
  invalid: 'We could not sign you in with that email. Check it and try again.',
  no_workspace: 'That account has no workspace yet. Ask an owner to add you.',
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
          Enter the email tied to your workspace. We resolve every request to a live membership — no
          stale tenancy is ever trusted from the cookie.
        </p>

        {message !== undefined ? (
          <p className="auth-error" role="alert">
            {message}
          </p>
        ) : null}

        <form action={signIn} className="auth-form">
          <label className="auth-label" htmlFor="email">
            Work email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            className="auth-input mono"
          />
          <button type="submit" className="auth-button">
            Continue
          </button>
        </form>

        <p className="auth-foot mono">
          dev sign-in · password &amp; SSO deferred to a later milestone
        </p>
      </main>
    </div>
  );
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import { resolveActiveWorkspace } from '../../lib/auth/session';
import { signOut, switchWorkspace } from './actions';

export default async function AuthedLayout({ children }: { readonly children: ReactNode }) {
  const active = await resolveActiveWorkspace();
  const current = active.memberships.find((m) => m.workspace.id === active.workspaceId);
  const hasMany = active.memberships.length > 1;

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar-lead">
          <Link href="/authed" className="app-mark">
            Flank
          </Link>
          <nav aria-label="Primary" className="app-nav">
            <Link href="/authed">Competitors</Link>
            <Link href="/authed/coverage">Coverage</Link>
          </nav>
        </div>

        <div className="app-bar-trail">
          {hasMany ? (
            <form action={switchWorkspace} className="ws-switch">
              <label htmlFor="ws" className="visually-hidden">
                Active workspace
              </label>
              <select
                id="ws"
                name="workspaceId"
                defaultValue={active.workspaceId}
                className="ws-select mono"
              >
                {active.memberships.map((m) => (
                  <option key={m.workspace.id} value={m.workspace.id}>
                    {m.workspace.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="ws-go">
                Switch
              </button>
            </form>
          ) : (
            <span className="ws-name mono">{current?.workspace.name ?? 'workspace'}</span>
          )}
          <span className="ws-role mono" aria-label={`your role: ${active.role}`}>
            {active.role}
          </span>
          <form action={signOut}>
            <button type="submit" className="app-signout">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="app-main">{children}</div>
    </div>
  );
}

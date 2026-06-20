import Link from 'next/link';
import { resolveActiveWorkspace } from '../../lib/auth/session';
import { getStore } from '../../lib/store';

export default async function CompetitorIndexPage() {
  const active = await resolveActiveWorkspace();
  const competitors = await getStore().listCompetitors(active.workspaceId);
  const workspaceName =
    active.memberships.find((m) => m.workspace.id === active.workspaceId)?.workspace.name ??
    'workspace';

  return (
    <div className="surface">
      <header className="surface-head">
        <p className="masthead-kicker mono">{workspaceName} · radar</p>
        <h1 className="surface-title">Competitors</h1>
        <p className="surface-sub">
          {competitors.length} tracked. Each dossier is a versioned, citation-gated record — open
          one for its change timeline and battlecard.
        </p>
      </header>

      {competitors.length === 0 ? (
        <p className="empty">
          No competitors yet. Seed one with <code className="mono">just seed</code> or add sources
          via the pipeline.
        </p>
      ) : (
        <ul className="competitor-grid">
          {competitors.map((competitor) => (
            <li key={competitor.id}>
              <Link href={`/authed/c/${competitor.id}`} className="competitor-card">
                <span className="competitor-name">{competitor.name}</span>
                <span className="competitor-domain mono">{competitor.primaryDomain}</span>
                <span className="competitor-cta mono" aria-hidden="true">
                  open dossier →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

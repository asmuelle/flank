import { notFound } from 'next/navigation';
import { SectionCard } from '../../../../components/section';
import { Timeline } from '../../../../components/timeline';
import { resolveActiveWorkspace } from '../../../../lib/auth/session';
import { getStore } from '../../../../lib/store';
import {
  buildTimelineEntries,
  latestByKind,
  toSectionView,
  versionsOfKind,
} from '../../../../lib/views/sections';
import type { Claim } from '@flank/core';

export default async function CompetitorPage({
  params,
}: {
  readonly params: Promise<{ readonly competitorId: string }>;
}) {
  const { competitorId } = await params;
  const active = await resolveActiveWorkspace();
  const ws = active.workspaceId;
  const store = getStore();

  // listCompetitors is workspace-scoped, so a competitor from another tenant simply isn't here → 404.
  const competitor = (await store.listCompetitors(ws)).find((c) => c.id === competitorId);
  if (competitor === undefined) notFound();

  const [deltas, sources, dossier, battlecard] = await Promise.all([
    store.listDeltasForCompetitor(ws, competitorId),
    store.listSourcesForCompetitor(ws, competitorId),
    store.listDossierSections(ws, competitorId),
    store.listBattlecardSections(ws, competitorId),
  ]);

  // Claims per delta (bounded by deltas-for-this-competitor); fetched in parallel.
  const claimsByDelta = new Map<string, readonly Claim[]>(
    await Promise.all(
      deltas.map(async (d) => [d.id, await store.listClaimsForDelta(ws, d.id)] as const),
    ),
  );
  const entries = buildTimelineEntries(deltas, sources, claimsByDelta);

  const latestDossier = latestByKind(dossier);
  const latestBattlecard = latestByKind(battlecard);
  const citedClaims = await store.getClaimsByIds(
    ws,
    [...latestDossier, ...latestBattlecard].flatMap((s) => s.claimIds),
  );
  const claimsById = new Map(citedClaims.map((c) => [c.id, c]));

  const held = entries.filter((e) => e.awaitingConfirmation).length;
  const hasSections = latestDossier.length > 0 || latestBattlecard.length > 0;

  return (
    <div className="surface">
      <header className="surface-head">
        <p className="masthead-kicker mono">
          <a href="/authed">competitors</a> / {competitor.primaryDomain}
        </p>
        <h1 className="surface-title">{competitor.name}</h1>
        <p className="surface-sub">
          {sources.length} sources tracked · {entries.length} deltas on record · {held} held for
          confirmation
        </p>
      </header>

      <div className="competitor-body">
        <section aria-labelledby="timeline-heading" className="timeline-section">
          <h2 id="timeline-heading">Change timeline</h2>
          {entries.length === 0 ? (
            <p className="empty">
              No changes recorded yet. The scheduler logs a coverage run on every check even when
              nothing fires.
            </p>
          ) : (
            <Timeline entries={entries} />
          )}
        </section>

        <aside aria-labelledby="dossier-heading" className="dossier">
          <h2 id="dossier-heading">Dossier &amp; battlecard</h2>
          {hasSections ? (
            <div className="section-stack">
              {latestDossier.map((section) => (
                <SectionCard
                  key={`dossier-${section.kind}`}
                  section={toSectionView(section, claimsById)}
                  versionCount={versionsOfKind(dossier, section.kind).length}
                  diffHref={`/authed/c/${competitorId}/${section.kind}/diff`}
                />
              ))}
              {latestBattlecard.map((section) => (
                <SectionCard
                  key={`battlecard-${section.kind}`}
                  section={toSectionView(section, claimsById)}
                  versionCount={versionsOfKind(battlecard, section.kind).length}
                  diffHref={`/authed/c/${competitorId}/${section.kind}/diff`}
                />
              ))}
            </div>
          ) : (
            <p className="empty">No synthesized sections yet — the nightly worker writes them.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

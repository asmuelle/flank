import {
  BATTLECARD_SECTION_KINDS,
  DOSSIER_SECTION_KINDS,
  type BattlecardSectionKind,
  type DossierSectionKind,
} from '@flank/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SECTION_LABELS } from '../../../../../../components/section';
import { VersionDiff } from '../../../../../../components/version-diff';
import { resolveActiveWorkspace } from '../../../../../../lib/auth/session';
import { getStore } from '../../../../../../lib/store';
import { diffLines, diffStats } from '../../../../../../lib/views/diff';
import { versionDiffLinks, versionsOfKind } from '../../../../../../lib/views/sections';
import type { DrizzleFlankStore } from '@flank/db';

interface SectionVersion {
  readonly version: number;
  readonly contentMd: string;
}

/** Kinds partition cleanly across the two surfaces, so the kind alone selects which list to read. */
const loadVersions = async (
  store: DrizzleFlankStore,
  ws: string,
  competitorId: string,
  kind: string,
): Promise<readonly SectionVersion[] | null> => {
  if ((DOSSIER_SECTION_KINDS as readonly string[]).includes(kind)) {
    return versionsOfKind(
      await store.listDossierSections(ws, competitorId),
      kind as DossierSectionKind,
    );
  }
  if ((BATTLECARD_SECTION_KINDS as readonly string[]).includes(kind)) {
    return versionsOfKind(
      await store.listBattlecardSections(ws, competitorId),
      kind as BattlecardSectionKind,
    );
  }
  return null;
};

/** Pick a requested version from the chain, or undefined if the param is absent/unparseable/unknown. */
const pickVersion = (
  versions: readonly SectionVersion[],
  raw: string | undefined,
): SectionVersion | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : versions.find((v) => v.version === parsed);
};

export default async function VersionDiffPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly competitorId: string; readonly kind: string }>;
  readonly searchParams: Promise<{ readonly from?: string; readonly to?: string }>;
}) {
  const { competitorId, kind } = await params;
  const { from, to } = await searchParams;
  const active = await resolveActiveWorkspace();
  const ws = active.workspaceId;
  const store = getStore();

  const competitor = (await store.listCompetitors(ws)).find((c) => c.id === competitorId);
  if (competitor === undefined) notFound();

  const versions = await loadVersions(store, ws, competitorId, kind);
  if (versions === null) notFound();

  const label = SECTION_LABELS[kind] ?? kind;
  const backHref = `/authed/c/${competitorId}`;

  const header = (
    <header className="surface-head">
      <p className="masthead-kicker mono">
        <Link href={backHref}>{competitor.name}</Link> / {label}
      </p>
      <h1 className="surface-title">{label} — version history</h1>
    </header>
  );

  if (versions.length < 2) {
    return (
      <div className="surface">
        {header}
        <p className="empty">
          {versions.length === 0
            ? 'No versions of this section exist yet.'
            : 'Only one version exists — nothing to diff. A new version appears each time the nightly synthesis re-writes this section.'}
        </p>
        <p>
          <Link href={backHref}>← back to dossier</Link>
        </p>
      </div>
    );
  }

  // Default to the two most recent versions; honor explicit ?from/?to when they name real versions.
  const newest = versions[versions.length - 1];
  const prior = versions[versions.length - 2];
  const toVersion = pickVersion(versions, to) ?? newest;
  const fromVersion = pickVersion(versions, from) ?? prior;
  const lines = diffLines(fromVersion.contentMd, toVersion.contentMd);

  return (
    <div className="surface">
      {header}
      <nav
        className="diff-versions mono"
        aria-label="Pick a version to compare against its predecessor"
      >
        {versionDiffLinks(versions).map((link) =>
          link.fromVersion === null ? (
            // Oldest version has no predecessor — it is the baseline, not a diff.
            <span key={link.toVersion} className="diff-version-link diff-version-base">
              v{link.toVersion}
            </span>
          ) : (
            <Link
              key={link.toVersion}
              href={`/authed/c/${competitorId}/${kind}/diff?from=${link.fromVersion}&to=${link.toVersion}`}
              aria-current={link.toVersion === toVersion.version ? 'true' : undefined}
              className="diff-version-link"
            >
              v{link.toVersion}
            </Link>
          ),
        )}
      </nav>
      <VersionDiff
        fromVersion={fromVersion.version}
        toVersion={toVersion.version}
        lines={lines}
        stats={diffStats(lines)}
      />
      <p>
        <Link href={backHref}>← back to dossier</Link>
      </p>
    </div>
  );
}

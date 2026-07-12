import type { Claim, Competitor } from '@flank/core';
import {
  buildBundle,
  generateIndex,
  slugify,
  validateBundle,
  type ConceptDoc,
  type IndexEntry,
  type LintFinding,
} from '@okf/core';
import { versionLog } from './log';
import {
  BATTLECARD_KIND_TITLES,
  DOSSIER_KIND_TITLES,
  headsByKind,
  sectionDoc,
} from './sections';
import type { CompetitorExport, WorkspaceBundle, WorkspaceExportInput } from './types';

/** Stable, collision-free slug per competitor (name slug; id-suffixed on clash). */
const competitorSlugs = (
  competitors: readonly CompetitorExport[],
): ReadonlyMap<string, string> => {
  const byName = new Map<string, number>();
  for (const { competitor } of competitors) {
    const slug = slugify(competitor.name);
    byName.set(slug, (byName.get(slug) ?? 0) + 1);
  }
  const slugs = new Map<string, string>();
  for (const { competitor } of competitors) {
    const slug = slugify(competitor.name);
    slugs.set(
      competitor.id,
      (byName.get(slug) ?? 0) > 1 ? `${slug}-${slugify(competitor.id)}` : slug,
    );
  }
  return slugs;
};

const competitorIndexDoc = (
  competitor: Competitor,
  slug: string,
  baseUrl: string,
  sectionDocs: readonly ConceptDoc[],
): ConceptDoc => {
  const group = (family: 'dossier' | 'battlecard'): string =>
    sectionDocs
      .filter((doc) => doc.path.includes(`/${family}/`))
      .map((doc) => `- [${doc.frontmatter.title ?? doc.path}](${doc.path.split('/').slice(2).join('/')})`)
      .join('\n');

  const dossier = group('dossier');
  const battlecard = group('battlecard');
  const body = [
    ...(dossier === '' ? [] : [`## Dossier\n\n${dossier}`]),
    ...(battlecard === '' ? [] : [`## Battlecard\n\n${battlecard}`]),
  ].join('\n\n');

  return {
    path: `competitors/${slug}/index.md`,
    frontmatter: {
      type: 'Competitor',
      title: competitor.name,
      description: `Competitive dossier for ${competitor.name} (${competitor.primaryDomain}).`,
      resource: `${baseUrl}/authed/c/${competitor.id}`,
      extra: { domain: competitor.primaryDomain },
    },
    body,
  };
};

/**
 * Project a workspace's published competitive knowledge into an OKF bundle.
 * Pure and byte-deterministic: same input rows → identical bytes. Sections
 * render at their chain heads only; claims render only when verified — every
 * violation surfaces as a finding, and any `error` finding means the caller
 * must not ship the bundle (projection-only rule).
 */
export const projectWorkspaceBundle = (input: WorkspaceExportInput): WorkspaceBundle => {
  const slugs = competitorSlugs(input.competitors);
  const docs: ConceptDoc[] = [];
  const findings: LintFinding[] = [];
  const rootEntries: IndexEntry[] = [];

  for (const competitorExport of input.competitors) {
    const { competitor, dossierSections, battlecardSections, claims } = competitorExport;
    const slug = slugs.get(competitor.id) ?? slugify(competitor.id);
    const claimsById: ReadonlyMap<string, Claim> = new Map(claims.map((c) => [c.id, c]));
    const context = { competitor, competitorSlug: slug, baseUrl: input.baseUrl, claimsById };

    const sectionDocs: ConceptDoc[] = [];
    for (const head of headsByKind(dossierSections)) {
      const result = sectionDoc(head, 'dossier', DOSSIER_KIND_TITLES[head.kind], context);
      sectionDocs.push(result.doc);
      findings.push(...result.findings);
    }
    for (const head of headsByKind(battlecardSections)) {
      const result = sectionDoc(head, 'battlecard', BATTLECARD_KIND_TITLES[head.kind], context);
      sectionDocs.push(result.doc);
      findings.push(...result.findings);
    }

    docs.push(competitorIndexDoc(competitor, slug, input.baseUrl, sectionDocs), ...sectionDocs);
    rootEntries.push({
      path: `competitors/${slug}/index.md`,
      title: competitor.name,
      description: competitor.primaryDomain,
    });
  }

  docs.push(
    generateIndex({
      title: `${input.workspace.name} — competitive knowledge`,
      description:
        'OKF bundle projected from published, claim-verified dossiers and battlecards. See log.md for the change history.',
      entries: rootEntries,
    }),
    versionLog(input.competitors),
  );

  return {
    files: buildBundle(docs),
    findings: [...findings, ...validateBundle(docs)],
  };
};

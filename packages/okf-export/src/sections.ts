import type {
  BattlecardSection,
  BattlecardSectionKind,
  Claim,
  Competitor,
  DossierSection,
  DossierSectionKind,
} from '@flank/core';
import { slugify, type ConceptDoc, type LintFinding } from '@okf/core';

export const DOSSIER_KIND_TITLES: Readonly<Record<DossierSectionKind, string>> = {
  overview: 'Overview',
  pricing: 'Pricing',
  product: 'Product',
  gtm: 'Go-to-market',
  team: 'Team',
};

export const BATTLECARD_KIND_TITLES: Readonly<Record<BattlecardSectionKind, string>> = {
  why_we_win: 'Why we win',
  landmines: 'Landmines',
  pricing_counter: 'Pricing counter',
  objections: 'Objection handling',
};

type AnySection = DossierSection | BattlecardSection;

/** Head of each (kind) version chain — the only version that renders as a doc. */
export const headsByKind = <S extends AnySection>(sections: readonly S[]): readonly S[] => {
  const heads = new Map<string, S>();
  for (const section of sections) {
    const current = heads.get(section.kind);
    if (current === undefined || section.version > current.version) {
      heads.set(section.kind, section);
    }
  }
  return [...heads.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1));
};

const collapseWhitespace = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const claimLine = (claim: Claim): string => {
  const quote = collapseWhitespace(claim.quoteText);
  const captured = claim.capturedAt.toISOString();
  const verified = claim.verifiedAt?.toISOString() ?? '';
  return `- "${quote}" — [${hostOf(claim.sourceUrl)}](${claim.sourceUrl}), captured ${captured}, verified ${verified}`;
};

export interface SectionDocResult {
  readonly doc: ConceptDoc;
  readonly findings: readonly LintFinding[];
}

export interface SectionDocContext {
  readonly competitor: Competitor;
  readonly competitorSlug: string;
  readonly baseUrl: string;
  readonly claimsById: ReadonlyMap<string, Claim>;
}

/**
 * Render one section head as a concept doc. Only VERIFIED claims render into
 * the Sources block (Invariant 1); a cited claim that is missing or
 * unverified yields an UNVERIFIED_CITATION error finding — the projection
 * gate that keeps unproven provenance out of shipped bundles.
 */
export const sectionDoc = (
  section: AnySection,
  family: 'dossier' | 'battlecard',
  kindTitle: string,
  context: SectionDocContext,
): SectionDocResult => {
  const path = `competitors/${context.competitorSlug}/${family}/${slugify(section.kind)}.md`;

  const findings: LintFinding[] = [];
  const verified: Claim[] = [];
  for (const claimId of section.claimIds) {
    const claim = context.claimsById.get(claimId);
    if (claim === undefined) {
      findings.push({
        check: 'UNVERIFIED_CITATION',
        severity: 'error',
        path,
        message: `cited claim ${claimId} could not be resolved`,
      });
    } else if (claim.verifiedAt === null) {
      findings.push({
        check: 'UNVERIFIED_CITATION',
        severity: 'error',
        path,
        message: `cited claim ${claimId} is unverified`,
      });
    } else {
      verified.push(claim);
    }
  }

  const bodyParts = [
    section.contentMd.trim(),
    ...(verified.length > 0 ? [`## Sources\n\n${verified.map(claimLine).join('\n')}`] : []),
    `[← ${context.competitor.name}](../index.md)`,
  ];

  const doc: ConceptDoc = {
    path,
    frontmatter: {
      type: family === 'dossier' ? 'Dossier Section' : 'Battlecard Section',
      title: `${context.competitor.name} — ${kindTitle}`,
      resource: `${context.baseUrl}/authed/c/${context.competitor.id}`,
      timestamp: section.createdAt.toISOString(),
      extra: {
        kind: section.kind,
        version: String(section.version),
        ...('model' in section && section.model !== null && { model: section.model }),
      },
    },
    body: bodyParts.join('\n\n'),
  };

  return { doc, findings };
};

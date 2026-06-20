import type { Claim, CoverageRun, Delta, Source, TriageClass } from '@flank/core';

/** A verified quote backing a delta or a synthesized section — the Invariant 1 receipt, view-shaped. */
export interface CitationView {
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly sourceUrl: string;
  readonly capturedAt: string;
  readonly verified: boolean;
}

/** One change in a competitor's activity feed, with its citations. */
export interface TimelineEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly sourceType: string;
  readonly sourceUrl: string;
  readonly triageClass: TriageClass;
  readonly materiality: number;
  readonly rationale: string;
  readonly state: string;
  readonly awaitingConfirmation: boolean;
  readonly citations: readonly CitationView[];
}

/** One version of a synthesized dossier/battlecard section, with the claims it cites. */
export interface SectionView {
  readonly kind: string;
  readonly version: number;
  readonly createdAt: string;
  readonly contentMd: string;
  readonly citations: readonly CitationView[];
}

/** Rolled-up coverage receipt across a workspace's runs (the honest-COGS meter). */
export interface CoverageView {
  readonly fetches: number;
  readonly deltasFound: number;
  readonly materialDeltas: number;
  readonly fetchFailures: number;
  readonly llmCalls: number;
  readonly llmCostMicros: number;
}

/** The minimal section shape both dossier and battlecard rows satisfy — keeps the mapper kind-agnostic. */
export interface SectionLike {
  readonly kind: string;
  readonly version: number;
  readonly contentMd: string;
  readonly claimIds: readonly string[];
  readonly createdAt: Date;
}

export const toCitationView = (claim: Claim): CitationView =>
  Object.freeze({
    quote: claim.quoteText,
    charStart: claim.charStart,
    charEnd: claim.charEnd,
    sourceUrl: claim.sourceUrl,
    capturedAt: claim.capturedAt.toISOString(),
    verified: claim.verifiedAt !== null,
  });

const toTimelineEntry = (
  delta: Delta,
  source: Source | undefined,
  claims: readonly Claim[],
): TimelineEntryView =>
  Object.freeze({
    id: delta.id,
    occurredAt: delta.createdAt.toISOString(),
    sourceType: source?.type ?? 'unknown',
    sourceUrl: source?.url ?? '',
    triageClass: delta.triageClass,
    materiality: delta.materiality,
    rationale: delta.rationale,
    state: delta.state,
    awaitingConfirmation: delta.triageClass === 'pricing_change' && delta.state === 'pending',
    citations: Object.freeze(claims.map(toCitationView)),
  });

/**
 * Build a competitor's activity feed, newest first. Pure over already-fetched rows so it is unit
 * testable without a store; the page does the workspace-scoped reads and hands the results in.
 */
export const buildTimelineEntries = (
  deltas: readonly Delta[],
  sources: readonly Source[],
  claimsByDelta: ReadonlyMap<string, readonly Claim[]>,
): readonly TimelineEntryView[] => {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return Object.freeze(
    [...deltas]
      .map((delta) =>
        toTimelineEntry(delta, sourceById.get(delta.sourceId), claimsByDelta.get(delta.id) ?? []),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  );
};

/** Shape one section version for display, resolving its cited claim ids against the provided map. */
export const toSectionView = (
  section: SectionLike,
  claimsById: ReadonlyMap<string, Claim>,
): SectionView =>
  Object.freeze({
    kind: section.kind,
    version: section.version,
    createdAt: section.createdAt.toISOString(),
    contentMd: section.contentMd,
    citations: Object.freeze(
      section.claimIds
        .map((id) => claimsById.get(id))
        .filter((claim): claim is Claim => claim !== undefined)
        .map(toCitationView),
    ),
  });

/** Keep only the head (highest-version) row of each `kind`, ordered by kind for stable rendering. */
export const latestByKind = <T extends { kind: string; version: number }>(
  sections: readonly T[],
): readonly T[] => {
  const headByKind = new Map<string, T>();
  for (const section of sections) {
    const current = headByKind.get(section.kind);
    if (current === undefined || section.version > current.version) {
      headByKind.set(section.kind, section);
    }
  }
  return Object.freeze([...headByKind.values()].sort((a, b) => a.kind.localeCompare(b.kind)));
};

/** All versions of one kind, oldest → newest — the version picker / diff source list. */
export const versionsOfKind = <T extends { kind: string; version: number }>(
  sections: readonly T[],
  kind: string,
): readonly T[] =>
  Object.freeze(
    sections.filter((section) => section.kind === kind).sort((a, b) => a.version - b.version),
  );

export interface VersionDiffLink {
  readonly toVersion: number;
  /** The immediate chronological predecessor, or null for the oldest version (a baseline, not a diff). */
  readonly fromVersion: number | null;
}

/**
 * The version-picker links: each version paired with its immediate predecessor, so clicking vK always
 * compares vK-1 → vK (forward, chronological). Guarantees `fromVersion < toVersion` for every diffable
 * link — never a self-diff and never inverted. The oldest version has `fromVersion: null` (baseline).
 */
export const versionDiffLinks = (
  versions: readonly { readonly version: number }[],
): readonly VersionDiffLink[] => {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  return Object.freeze(
    ordered.map((v, index) => ({
      toVersion: v.version,
      fromVersion: index > 0 ? ordered[index - 1].version : null,
    })),
  );
};

export const aggregateCoverage = (runs: readonly CoverageRun[]): CoverageView =>
  runs.reduce<CoverageView>(
    (acc, run) => ({
      fetches: acc.fetches + run.sourcesChecked,
      deltasFound: acc.deltasFound + run.deltasFound,
      materialDeltas: acc.materialDeltas + run.materialDeltas,
      fetchFailures: acc.fetchFailures + run.fetchFailures,
      llmCalls: acc.llmCalls + run.llmCalls,
      llmCostMicros: acc.llmCostMicros + run.llmCostMicros,
    }),
    {
      fetches: 0,
      deltasFound: 0,
      materialDeltas: 0,
      fetchFailures: 0,
      llmCalls: 0,
      llmCostMicros: 0,
    },
  );

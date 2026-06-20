import { z } from 'zod';

export const PLAN_TIERS = ['starter', 'growth', 'team'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const SOURCE_TYPES = [
  'pricing',
  'changelog',
  'docs',
  'jobs',
  'reviews',
  'status',
  'blog',
  'appstore',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_ADAPTERS = ['rss', 'json', 'html', 'firecrawl', 'zyte'] as const;
export type SourceAdapter = (typeof SOURCE_ADAPTERS)[number];

export const LEGAL_STATUSES = ['open', 'licensed', 'blocked'] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

export const TRIAGE_CLASSES = [
  'pricing_change',
  'feature_launch',
  'repositioning',
  'leadership_hire',
  'hiring_signal',
  'noise',
] as const;
export type TriageClass = (typeof TRIAGE_CLASSES)[number];

export const DELTA_STATES = ['pending', 'confirmed', 'dismissed', 'published'] as const;
export type DeltaState = (typeof DELTA_STATES)[number];

/** A changed region of normalized snapshot text, pinned by character offsets. */
export interface Span {
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly planTier: PlanTier;
}

export interface Competitor {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly primaryDomain: string;
}

export interface Source {
  readonly id: string;
  readonly competitorId: string;
  readonly type: SourceType;
  readonly url: string;
  readonly adapter: SourceAdapter;
  readonly cadence: string;
  readonly legalStatus: LegalStatus;
}

/** Append-only (Invariant 5): a snapshot's content never changes after insert. */
export interface Snapshot {
  readonly id: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly normalizedText: string;
  readonly fetchedAt: Date;
  readonly httpStatus: number;
  /**
   * Region/context of the fetch. The confirmation re-fetch (Invariant 3) sets a distinct vantage
   * so a flapping pricing page reads as the same change from a second viewpoint. `null` on the
   * primary pass.
   */
  readonly vantage: string | null;
}

export interface Delta {
  readonly id: string;
  readonly sourceId: string;
  readonly fromSnapshotId: string | null;
  readonly toSnapshotId: string;
  readonly changedSpans: readonly Span[];
  readonly triageClass: TriageClass;
  readonly materiality: number;
  readonly rationale: string;
  readonly state: DeltaState;
  /**
   * The reproducing snapshot that promoted a pricing delta out of `pending` (Invariant 3). Set only
   * on `confirmed`/`published` pricing deltas; `null` otherwise.
   */
  readonly confirmedBySnapshotId: string | null;
  readonly createdAt: Date;
}

/** Quote + offsets + URL + timestamp: the unit of provenance (Invariant 1). */
export interface Claim {
  readonly id: string;
  readonly deltaId: string;
  readonly snapshotId: string;
  readonly quoteText: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly sourceUrl: string;
  readonly capturedAt: Date;
  readonly verifiedAt: Date | null;
}

/** One row per fetch attempt: silence stays visible (Invariant 7). */
export interface CoverageRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly period: string;
  readonly sourcesChecked: number;
  readonly fetchFailures: number;
  readonly deltasFound: number;
  readonly materialDeltas: number;
  readonly llmCalls: number;
  /** Metered LLM spend in exact integer micro-USD (USD × 1e6) — never float (Invariant 6). */
  readonly llmCostMicros: number;
  readonly createdAt: Date;
}

// Section kind value-sets — the single source of truth the Drizzle pgEnums mirror. ORDER IS LOAD-
// BEARING: it must match the existing Postgres enum value order, or a destructive enum migration is
// required. Do not reorder.
export const DOSSIER_SECTION_KINDS = ['overview', 'pricing', 'product', 'gtm', 'team'] as const;
export type DossierSectionKind = (typeof DOSSIER_SECTION_KINDS)[number];

export const BATTLECARD_SECTION_KINDS = [
  'why_we_win',
  'landmines',
  'pricing_counter',
  'objections',
] as const;
export type BattlecardSectionKind = (typeof BATTLECARD_SECTION_KINDS)[number];

/**
 * Append-only version chain (Invariant 5): one published row per (competitor, kind, version), each
 * superseding the prior via supersedesId. The accumulating chain IS the moat.
 */
export interface DossierSection {
  readonly id: string;
  readonly competitorId: string;
  readonly kind: DossierSectionKind;
  readonly version: number;
  readonly contentMd: string;
  readonly claimIds: readonly string[];
  readonly model: string | null;
  readonly batchId: string | null;
  readonly supersedesId: string | null;
  readonly createdAt: Date;
}

/** Append-only version chain (Invariant 5). Battlecards carry no model/batch provenance columns. */
export interface BattlecardSection {
  readonly id: string;
  readonly competitorId: string;
  readonly kind: BattlecardSectionKind;
  readonly version: number;
  readonly contentMd: string;
  readonly claimIds: readonly string[];
  readonly supersedesId: string | null;
  readonly createdAt: Date;
}

/** Boundary validation for source definitions arriving from config/UI (AGENTS.md: validate external data). */
export const SourceConfigSchema = z.object({
  id: z.string().min(1),
  competitorId: z.string().min(1),
  type: z.enum(SOURCE_TYPES),
  url: z.string().url(),
  adapter: z.enum(SOURCE_ADAPTERS),
  cadence: z.string().min(1),
  legalStatus: z.enum(LEGAL_STATUSES).default('open'),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const parseSourceConfig = (input: unknown): Source => {
  const parsed = SourceConfigSchema.parse(input);
  return Object.freeze({ ...parsed });
};

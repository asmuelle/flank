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

// --- Identity & membership (M2 auth) ---

export const MEMBERSHIP_ROLES = ['owner', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** A person who can sign in. Identity is global; tenancy comes from {@link Membership}. */
export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly createdAt: Date;
}

/** Grants a user access to a workspace with a role — the only thing that confers tenancy. */
export interface Membership {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: MembershipRole;
  readonly createdAt: Date;
}

/** Normalized email at the boundary (lowercased, trimmed) — never trust raw input (AGENTS.md). */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.string().email().max(320));

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

// --- Alert delivery (M3) ---

/** The channels an alert can be delivered to. (`crm` exists in the DB enum but has no impl yet.) */
export const ALERT_CHANNELS = ['slack', 'email'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/** Delivery lifecycle: queued on enqueue, then delivered (terminal) or failed (retried next sweep). */
export const ALERT_STATUSES = ['queued', 'delivered', 'failed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** A per-workspace delivery destination (mutable settings, not history). One workspace has 0..N. */
export interface AlertChannelConfig {
  readonly id: string;
  readonly workspaceId: string;
  readonly channel: AlertChannel;
  /** Channel-specific: a Slack incoming-webhook URL, or an email recipient address. */
  readonly destination: string;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/**
 * A deduplicated delivery intent + its current status. Exactly one row per (delta, channelConfig) —
 * the UNIQUE constraint is the deliver-once guarantee, keyed per DESTINATION so a workspace with two
 * enabled configs of the same channel delivers to both. Status advances on a strict machine
 * ({@link assertAlertTransition}); `delivered` is terminal and must carry a `providerRef` (proof of
 * delivery, mirroring a confirmed pricing delta's `confirmedBySnapshotId`).
 */
export interface Alert {
  readonly id: string;
  readonly workspaceId: string;
  readonly deltaId: string;
  readonly channel: AlertChannel;
  readonly channelConfigId: string;
  /** The destination resolved at enqueue time — captured for provenance, never rewritten. */
  readonly target: string;
  /** The frozen AlertPayload we decided to send (what, with proof). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: AlertStatus;
  readonly attemptCount: number;
  readonly providerRef: string | null;
  readonly lastError: string | null;
  readonly enqueuedAt: Date;
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
}

/** Boundary validation for a channel config arriving from settings/UI — never trust raw input. */
export const AlertChannelConfigSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    channel: z.enum(ALERT_CHANNELS),
    destination: z.string().min(1),
    label: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // A Slack destination must be an https webhook URL; an email destination a valid address.
    if (value.channel === 'slack') {
      const ok = /^https:\/\//.test(value.destination);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['destination'],
          message: 'slack destination must be an https webhook URL',
        });
      }
    } else if (!z.string().email().safeParse(value.destination).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'email destination must be a valid email address',
      });
    }
  });

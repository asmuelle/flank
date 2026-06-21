import type {
  Alert,
  AlertChannelConfig,
  AlertStatus,
  AppUser,
  BattlecardSection,
  BattlecardSectionKind,
  Claim,
  Competitor,
  CoverageRun,
  Delta,
  DeltaState,
  DossierSection,
  DossierSectionKind,
  ExternalIdentity,
  Membership,
  Snapshot,
  Source,
  TriageClass,
  Workspace,
} from './entities';

export class AppendOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppendOnlyViolationError';
  }
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

export class UnknownEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownEntityError';
  }
}

/**
 * Raised when a workspace-scoped operation references an entity owned by a different workspace
 * (Invariant 8). Distinct from {@link UnknownEntityError} so a leak attempt is never silently
 * indistinguishable from a typo, and so the contract test can assert fail-closed scoping.
 */
export class CrossTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossTenantError';
  }
}

/**
 * An unverified OIDC email collided with an existing local account during identity linking. Thrown
 * (never linked) to prevent account takeover: only a verified email may adopt a pre-provisioned user.
 */
export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

/**
 * Structural delta state machine: which states may follow which. The pricing-confirmation
 * refinement (Invariant 3) is `triageClass`-dependent and therefore cannot live in this static
 * table — see {@link assertDeltaTransition}.
 */
export const ALLOWED_DELTA_TRANSITIONS: Readonly<Record<DeltaState, readonly DeltaState[]>> =
  Object.freeze({
    pending: Object.freeze(['confirmed', 'dismissed', 'published'] as const),
    confirmed: Object.freeze(['published'] as const),
    dismissed: Object.freeze([] as const),
    published: Object.freeze([] as const),
  });

/** The minimal delta shape a transition guard needs — every store has this much in hand. */
export type DeltaTransitionInput = Pick<Delta, 'id' | 'state' | 'triageClass'>;

const isPricingClass = (triageClass: TriageClass): boolean => triageClass === 'pricing_change';

/**
 * Authorize a delta state transition. Enforces, in order:
 *  - the structural state machine ({@link ALLOWED_DELTA_TRANSITIONS});
 *  - Invariant 3: a `pricing_change` delta may never go `pending → published` directly — it must
 *    pass through `confirmed` (the false-pricing-alert firewall);
 *  - that any `→ confirmed` transition carries the reproducing snapshot id, because `confirmed`
 *    *means* "a second snapshot reproduced this change".
 *
 * This is the single source of transition truth, shared by every {@link FlankStore} implementation
 * and (later) mirrored by a DB `UPDATE` trigger, so the firewall cannot be bypassed by a new store.
 */
export const assertDeltaTransition = (
  delta: DeltaTransitionInput,
  to: DeltaState,
  confirmedBySnapshotId?: string | null,
): void => {
  if (!ALLOWED_DELTA_TRANSITIONS[delta.state].includes(to)) {
    throw new IllegalTransitionError(`delta ${delta.id}: ${delta.state} → ${to} is not allowed`);
  }
  if (isPricingClass(delta.triageClass) && delta.state === 'pending' && to === 'published') {
    throw new IllegalTransitionError(
      `delta ${delta.id}: pricing_change cannot go pending → published; confirmation required (Invariant 3)`,
    );
  }
  if (
    to === 'confirmed' &&
    (confirmedBySnapshotId === undefined || confirmedBySnapshotId === null)
  ) {
    throw new IllegalTransitionError(
      `delta ${delta.id}: → confirmed requires a confirmedBySnapshotId (Invariant 3 firewall)`,
    );
  }
};

/**
 * Alert delivery state machine: queued may advance to delivered or failed; a failed alert may be
 * retried (failed → delivered/failed); delivered is TERMINAL (a delivered alert is never re-sent or
 * un-delivered). This is the single source of transition truth shared by both stores and mirrored by
 * a DB `UPDATE` trigger, so deliver-once cannot be bypassed by a new store or by raw SQL.
 */
export const ALLOWED_ALERT_TRANSITIONS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> =
  Object.freeze({
    queued: Object.freeze(['delivered', 'failed'] as const),
    failed: Object.freeze(['delivered', 'failed'] as const),
    delivered: Object.freeze([] as const),
  });

/**
 * Authorize an alert status transition. Enforces the machine above and that any `→ delivered`
 * carries a `providerRef` — a delivery *means* "a provider accepted it and returned a reference", so
 * an alert can never be marked delivered without proof (parallel to a confirmed pricing delta
 * requiring `confirmedBySnapshotId`).
 */
export const assertAlertTransition = (
  alert: Pick<Alert, 'id' | 'status'>,
  to: AlertStatus,
  providerRef?: string | null,
): void => {
  if (!ALLOWED_ALERT_TRANSITIONS[alert.status].includes(to)) {
    throw new IllegalTransitionError(`alert ${alert.id}: ${alert.status} → ${to} is not allowed`);
  }
  if (to === 'delivered' && (providerRef === undefined || providerRef === null)) {
    throw new IllegalTransitionError(
      `alert ${alert.id}: → delivered requires a providerRef (proof of delivery)`,
    );
  }
};

/**
 * Repository contract. History tables (snapshots, deltas, claims) are append-only (Invariant 5):
 * no update or delete operations exist beyond the delta state machine and one-shot claim
 * verification.
 *
 * Every write and single-entity lookup is **workspace-scoped** (Invariant 8): callers pass the
 * acting `workspaceId` and the store fails closed ({@link CrossTenantError}) if the referenced
 * entity belongs to another tenant — tenant isolation is a property of the contract, not of any one
 * implementation. The write set of a single ingest pass is committed atomically via
 * {@link FlankStore.withTransaction} so a mid-write failure can never leave an orphan snapshot or a
 * delta with partial claims (which would violate Invariant 1).
 */
/** A source plus the tenant context and health the scheduler needs to decide and process a fetch. */
export interface ScheduledSource {
  readonly workspace: Workspace;
  readonly source: Source;
  readonly lastFetchedAt: Date | null;
  readonly consecutiveFailures: number;
}

/** A pending pricing delta plus the context its confirmation re-fetch needs. */
export interface ScheduledDelta {
  readonly workspace: Workspace;
  readonly source: Source;
  readonly delta: Delta;
}

/** A competitor plus its tenant, for the nightly synthesis worker. */
export interface SynthesisCompetitor {
  readonly workspace: Workspace;
  readonly competitor: Competitor;
}

/** An enabled delivery destination plus its tenant — the delivery sweep's cross-tenant fan-out. */
export interface EnabledChannel {
  readonly workspace: Workspace;
  readonly config: AlertChannelConfig;
}

/** An alert still needing a send (queued/failed) plus its tenant — the sweep's work item. */
export interface DeliverableAlert {
  readonly workspace: Workspace;
  readonly alert: Alert;
}

/** A user's membership joined to the workspace it grants — what the request resolver authorizes against. */
export interface MembershipWithWorkspace {
  readonly membership: Membership;
  readonly workspace: Workspace;
}

export interface FlankStore {
  seedWorkspace(workspace: Workspace): Promise<Workspace>;
  seedCompetitor(competitor: Competitor): Promise<Competitor>;
  seedSource(source: Source): Promise<Source>;

  insertSnapshot(workspaceId: string, snapshot: Snapshot): Promise<Snapshot>;
  latestSnapshot(workspaceId: string, sourceId: string): Promise<Snapshot | null>;
  /** Fetch a snapshot by id, workspace-scoped; null if missing or owned by another tenant. */
  getSnapshot(workspaceId: string, snapshotId: string): Promise<Snapshot | null>;

  insertDelta(workspaceId: string, delta: Delta): Promise<Delta>;
  transitionDelta(
    workspaceId: string,
    deltaId: string,
    to: DeltaState,
    confirmedBySnapshotId?: string | null,
  ): Promise<Delta>;

  insertClaim(workspaceId: string, claim: Claim): Promise<Claim>;

  insertCoverageRun(run: CoverageRun): Promise<CoverageRun>;

  listDeltas(workspaceId: string): Promise<readonly Delta[]>;
  listClaimsForDelta(workspaceId: string, deltaId: string): Promise<readonly Claim[]>;
  listCoverageRuns(workspaceId: string): Promise<readonly CoverageRun[]>;
  /**
   * Sum of metered LLM spend (micro-USD) for a workspace across coverage runs whose period starts
   * with `periodPrefix` (e.g. 'YYYY-MM' for month-to-date). The budget gate's gating number;
   * read failures propagate so the gate fails closed.
   */
  monthToDateCostMicros(workspaceId: string, periodPrefix: string): Promise<number>;

  // --- Scheduler surface ---
  // Deliberately cross-tenant: the background worker processes every workspace's sources. These are
  // the only methods that span tenants, and they are never reachable from a request-scoped path.

  /** Every source with the context the scheduler needs (tenant + last-fetch + failure streak). */
  listSourcesForScheduling(): Promise<readonly ScheduledSource[]>;
  /** Record a successful check: stamp last_fetched_at and reset the consecutive-failure streak. */
  markSourceFetched(sourceId: string, fetchedAt: Date): Promise<void>;
  /** Record a failed check: increment the consecutive-failure streak (the scheduler pauses on it). */
  markSourceFailed(sourceId: string): Promise<void>;
  /** Pending pricing deltas awaiting the confirmation firewall, with re-fetch context. */
  listPendingPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]>;
  /**
   * Confirmed-but-not-yet-published pricing deltas, cross-tenant. The scheduler publishes these
   * (confirmed → published) so a delta that has passed the re-fetch firewall becomes alertable —
   * the previously-missing edge of the pricing lifecycle.
   */
  listConfirmedPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]>;

  // --- Synthesis surface (M2) ---
  // Sections have no workspace_id column; every method scopes via the competitor's workspace.

  insertDossierSection(workspaceId: string, section: DossierSection): Promise<DossierSection>;
  insertBattlecardSection(
    workspaceId: string,
    section: BattlecardSection,
  ): Promise<BattlecardSection>;
  /** Head of the (competitor, kind) version chain, or null if none published yet. */
  latestDossierSection(
    workspaceId: string,
    competitorId: string,
    kind: DossierSectionKind,
  ): Promise<DossierSection | null>;
  latestBattlecardSection(
    workspaceId: string,
    competitorId: string,
    kind: BattlecardSectionKind,
  ): Promise<BattlecardSection | null>;
  listDossierSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly DossierSection[]>;
  listBattlecardSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly BattlecardSection[]>;
  /** Resolve claim ids to rows (workspace-scoped); the section citation gate's claim resolver. */
  getClaimsByIds(workspaceId: string, claimIds: readonly string[]): Promise<readonly Claim[]>;
  /** Confirmed/published, material (materiality>0, non-noise) deltas for a competitor's sources. */
  listConfirmedMaterialDeltasForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Delta[]>;
  /** Every competitor with its tenant — the nightly synthesis worker's cross-tenant fan-out. */
  listCompetitorsForSynthesis(): Promise<readonly SynthesisCompetitor[]>;

  // --- Identity & membership (M2 auth) ---
  seedUser(user: AppUser): Promise<AppUser>;
  seedMembership(membership: Membership): Promise<Membership>;
  /**
   * Resolve a verified OIDC identity (FerrisKey) to the one local {@link AppUser}, creating or
   * linking exactly one row — the JIT-provisioning seam called from the auth callback. Match order:
   * (1) by immutable `externalSubject`; (2) by normalized email — but ONLY when `emailVerified`,
   * backfilling the subject so a pre-OIDC/seed row adopts its IdP identity on first login (an
   * unverified email colliding with an existing account is rejected, never linked — anti-hijack);
   * (3) else create a fresh user. Never grants a workspace — a brand-new user has zero memberships
   * and fails closed at `resolveWorkspace`.
   */
  linkOrCreateUserBySubject(identity: ExternalIdentity, createdAt?: Date): Promise<AppUser>;
  /** Look up a user by (normalized) email; null if none. Identity is global, not workspace-scoped. */
  findUserByEmail(email: string): Promise<AppUser | null>;
  getUserById(userId: string): Promise<AppUser | null>;
  /** A user's workspace grants, joined to each workspace, ordered (createdAt, id) — the auth set. */
  listMembershipsForUser(userId: string): Promise<readonly MembershipWithWorkspace[]>;
  /** The grant for (user, workspace) or null — checked before honoring an active-workspace switch. */
  getMembership(userId: string, workspaceId: string): Promise<Membership | null>;
  /** Workspace-scoped competitor list — the request-safe read (NOT listCompetitorsForSynthesis). */
  listCompetitors(workspaceId: string): Promise<readonly Competitor[]>;
  /** Sources for one competitor (workspace-scoped) — the timeline's delta→source join. */
  listSourcesForCompetitor(workspaceId: string, competitorId: string): Promise<readonly Source[]>;
  /** Every delta for a competitor's sources (workspace-scoped) — the per-competitor activity feed. */
  listDeltasForCompetitor(workspaceId: string, competitorId: string): Promise<readonly Delta[]>;

  // --- Alert delivery (M3) ---
  // Cross-tenant sweep methods (never request-reachable, like the scheduler surface) plus
  // workspace-scoped settings/log reads (fail closed with CrossTenantError, Invariant 8).

  /** Create a delivery destination (mutable settings; not workspace-arg'd, mirrors seedSource). */
  seedChannelConfig(config: AlertChannelConfig): Promise<AlertChannelConfig>;
  /** A workspace's delivery destinations (request-safe settings read). */
  listChannelConfigs(workspaceId: string): Promise<readonly AlertChannelConfig[]>;
  /** Every enabled destination across tenants — the sweep's fan-out (cross-tenant). */
  listEnabledChannelConfigs(): Promise<readonly EnabledChannel[]>;
  /**
   * Idempotently enqueue one alert per (delta, channelConfig): a duplicate is a no-op and returns the
   * existing row (NOT an append-only breach — enqueue is the dedup point), so each enabled destination
   * delivers exactly once. Workspace-scoped: the delta must belong to the workspace, else
   * {@link CrossTenantError}.
   */
  enqueueAlert(workspaceId: string, alert: Alert): Promise<Alert>;
  /** Alerts still needing a send across tenants (status queued|failed), capped (cross-tenant). */
  listDeliverableAlerts(limit: number): Promise<readonly DeliverableAlert[]>;
  /**
   * Record one delivery attempt: advance the alert status via {@link assertAlertTransition}, bump the
   * attempt count, and stamp providerRef/lastError/timestamps. `delivered` requires a providerRef.
   */
  recordAlertOutcome(
    workspaceId: string,
    alertId: string,
    to: AlertStatus,
    detail: { readonly providerRef?: string | null; readonly error?: string | null },
    at: Date,
  ): Promise<Alert>;
  /** A workspace's delivery log, newest first (request-safe, for the /authed/alerts view). */
  listAlertsForWorkspace(workspaceId: string): Promise<readonly Alert[]>;

  /**
   * Run `fn` as a single atomic unit of work. The handle passed to `fn` is a {@link FlankStore}
   * bound to the transaction; if `fn` throws, every write performed through that handle is rolled
   * back. The in-memory store implements this by checkpoint/restore; the Drizzle store will map it
   * to a real DB transaction.
   */
  withTransaction<T>(fn: (tx: FlankStore) => Promise<T>): Promise<T>;
}

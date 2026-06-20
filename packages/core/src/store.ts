import type {
  BattlecardSection,
  BattlecardSectionKind,
  Claim,
  Competitor,
  CoverageRun,
  Delta,
  DeltaState,
  DossierSection,
  DossierSectionKind,
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

  /**
   * Run `fn` as a single atomic unit of work. The handle passed to `fn` is a {@link FlankStore}
   * bound to the transaction; if `fn` throws, every write performed through that handle is rolled
   * back. The in-memory store implements this by checkpoint/restore; the Drizzle store will map it
   * to a real DB transaction.
   */
  withTransaction<T>(fn: (tx: FlankStore) => Promise<T>): Promise<T>;
}

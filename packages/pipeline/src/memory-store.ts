import { randomUUID } from 'node:crypto';
import {
  AppendOnlyViolationError,
  assertAlertTransition,
  assertDeltaTransition,
  CrossTenantError,
  IdentityConflictError,
  UnknownEntityError,
  type Alert,
  type AlertChannelConfig,
  type AlertStatus,
  type AppUser,
  type BattlecardSection,
  type BattlecardSectionKind,
  type Claim,
  type Competitor,
  type CoverageRun,
  type Delta,
  type DeltaState,
  type DeliverableAlert,
  type DossierSection,
  type DossierSectionKind,
  type EnabledChannel,
  type ExternalIdentity,
  type FlankStore,
  type Membership,
  type MembershipWithWorkspace,
  type ScheduledDelta,
  type ScheduledSource,
  type Snapshot,
  type Source,
  type SynthesisCompetitor,
  type Workspace,
} from '@flank/core';

interface SourceHealth {
  lastFetchedAt: Date | null;
  consecutiveFailures: number;
}

const freezeDeep = <T extends object>(value: T): T => Object.freeze({ ...value });

/** The mutable maps that make up the store's state, captured/restored as one unit by a transaction. */
interface StoreState {
  readonly workspaces: Map<string, Workspace>;
  readonly competitors: Map<string, Competitor>;
  readonly sources: Map<string, Source>;
  readonly snapshots: Map<string, Snapshot>;
  readonly snapshotsBySource: Map<string, string[]>;
  readonly deltas: Map<string, Delta>;
  readonly claims: Map<string, Claim>;
  readonly coverageRuns: Map<string, CoverageRun>;
  readonly sourceHealth: Map<string, SourceHealth>;
  readonly dossierSections: Map<string, DossierSection>;
  readonly battlecardSections: Map<string, BattlecardSection>;
  /** Reserved (surface:competitor:kind:version) keys — mirrors the DB UNIQUE(competitor,kind,version). */
  readonly sectionVersions: Set<string>;
  readonly users: Map<string, AppUser>;
  readonly memberships: Map<string, Membership>;
  readonly channelConfigs: Map<string, AlertChannelConfig>;
  readonly alerts: Map<string, Alert>;
}

/**
 * In-memory FlankStore for M1 tests and the fixture-rendered web brief.
 *
 * Honours the full {@link FlankStore} contract: append-only semantics (Invariant 5) — inserts
 * reject duplicate ids, records are frozen, and no delete operation exists; workspace-scoped writes
 * and lookups (Invariant 8) — a reference to another tenant's source or delta fails closed with
 * {@link CrossTenantError}; the pricing-confirmation firewall (Invariant 3) via the shared
 * {@link assertDeltaTransition} guard; and atomic {@link withTransaction} via checkpoint/restore.
 */
export class MemoryFlankStore implements FlankStore {
  private readonly state: StoreState = {
    workspaces: new Map(),
    competitors: new Map(),
    sources: new Map(),
    snapshots: new Map(),
    snapshotsBySource: new Map(),
    deltas: new Map(),
    claims: new Map(),
    coverageRuns: new Map(),
    sourceHealth: new Map(),
    dossierSections: new Map(),
    battlecardSections: new Map(),
    sectionVersions: new Set(),
    users: new Map(),
    memberships: new Map(),
    channelConfigs: new Map(),
    alerts: new Map(),
  };

  private insertUnique<T extends { readonly id: string }>(
    map: Map<string, T>,
    record: T,
    kind: string,
  ): T {
    if (map.has(record.id)) {
      throw new AppendOnlyViolationError(
        `${kind} ${record.id} already exists — history is append-only`,
      );
    }
    const frozen = freezeDeep(record);
    map.set(record.id, frozen);
    return frozen;
  }

  /** Resolve a source's owning workspace, or null if the source is unknown. */
  private workspaceIdForSource(sourceId: string): string | null {
    const source = this.state.sources.get(sourceId);
    if (!source) return null;
    const competitor = this.state.competitors.get(source.competitorId);
    return competitor?.workspaceId ?? null;
  }

  /** Require that `sourceId` exists and belongs to `workspaceId` (Invariant 8); return it. */
  private requireSourceInWorkspace(workspaceId: string, sourceId: string): Source {
    const source = this.state.sources.get(sourceId);
    if (!source) throw new UnknownEntityError(`source ${sourceId} does not exist`);
    if (this.workspaceIdForSource(sourceId) !== workspaceId) {
      throw new CrossTenantError(`source ${sourceId} is not in workspace ${workspaceId}`);
    }
    return source;
  }

  /** Require that `deltaId` exists and belongs to `workspaceId` (Invariant 8); return it. */
  private requireDeltaInWorkspace(workspaceId: string, deltaId: string): Delta {
    const delta = this.state.deltas.get(deltaId);
    if (!delta) throw new UnknownEntityError(`delta ${deltaId} does not exist`);
    if (this.workspaceIdForSource(delta.sourceId) !== workspaceId) {
      throw new CrossTenantError(`delta ${deltaId} is not in workspace ${workspaceId}`);
    }
    return delta;
  }

  async seedWorkspace(workspace: Workspace): Promise<Workspace> {
    return this.insertUnique(this.state.workspaces, workspace, 'workspace');
  }

  async seedCompetitor(competitor: Competitor): Promise<Competitor> {
    if (!this.state.workspaces.has(competitor.workspaceId)) {
      throw new UnknownEntityError(`workspace ${competitor.workspaceId} does not exist`);
    }
    return this.insertUnique(this.state.competitors, competitor, 'competitor');
  }

  async seedSource(source: Source): Promise<Source> {
    if (!this.state.competitors.has(source.competitorId)) {
      throw new UnknownEntityError(`competitor ${source.competitorId} does not exist`);
    }
    const stored = this.insertUnique(this.state.sources, source, 'source');
    this.state.sourceHealth.set(source.id, { lastFetchedAt: null, consecutiveFailures: 0 });
    return stored;
  }

  async insertSnapshot(workspaceId: string, snapshot: Snapshot): Promise<Snapshot> {
    this.requireSourceInWorkspace(workspaceId, snapshot.sourceId);
    const frozen = this.insertUnique(this.state.snapshots, snapshot, 'snapshot');
    const existing = this.state.snapshotsBySource.get(snapshot.sourceId) ?? [];
    this.state.snapshotsBySource.set(snapshot.sourceId, [...existing, snapshot.id]);
    return frozen;
  }

  async latestSnapshot(workspaceId: string, sourceId: string): Promise<Snapshot | null> {
    this.requireSourceInWorkspace(workspaceId, sourceId);
    const ids = this.state.snapshotsBySource.get(sourceId) ?? [];
    const lastId = ids[ids.length - 1];
    return lastId === undefined ? null : (this.state.snapshots.get(lastId) ?? null);
  }

  async getSnapshot(workspaceId: string, snapshotId: string): Promise<Snapshot | null> {
    const snapshot = this.state.snapshots.get(snapshotId);
    if (!snapshot || this.workspaceIdForSource(snapshot.sourceId) !== workspaceId) return null;
    return snapshot;
  }

  async insertDelta(workspaceId: string, delta: Delta): Promise<Delta> {
    this.requireSourceInWorkspace(workspaceId, delta.sourceId);
    return this.insertUnique(this.state.deltas, delta, 'delta');
  }

  async transitionDelta(
    workspaceId: string,
    deltaId: string,
    to: DeltaState,
    confirmedBySnapshotId: string | null = null,
  ): Promise<Delta> {
    const current = this.requireDeltaInWorkspace(workspaceId, deltaId);
    assertDeltaTransition(current, to, confirmedBySnapshotId);
    const next = freezeDeep({
      ...current,
      state: to,
      confirmedBySnapshotId:
        to === 'confirmed' ? confirmedBySnapshotId : current.confirmedBySnapshotId,
    });
    this.state.deltas.set(deltaId, next);
    return next;
  }

  async insertClaim(workspaceId: string, claim: Claim): Promise<Claim> {
    this.requireDeltaInWorkspace(workspaceId, claim.deltaId);
    return this.insertUnique(this.state.claims, claim, 'claim');
  }

  async insertCoverageRun(run: CoverageRun): Promise<CoverageRun> {
    if (!this.state.workspaces.has(run.workspaceId)) {
      throw new UnknownEntityError(`workspace ${run.workspaceId} does not exist`);
    }
    return this.insertUnique(this.state.coverageRuns, run, 'coverage_run');
  }

  async listDeltas(workspaceId: string): Promise<readonly Delta[]> {
    return Object.freeze(
      [...this.state.deltas.values()].filter(
        (delta) => this.workspaceIdForSource(delta.sourceId) === workspaceId,
      ),
    );
  }

  async listClaimsForDelta(workspaceId: string, deltaId: string): Promise<readonly Claim[]> {
    const delta = this.state.deltas.get(deltaId);
    if (!delta || this.workspaceIdForSource(delta.sourceId) !== workspaceId) {
      return Object.freeze([]);
    }
    return Object.freeze(
      [...this.state.claims.values()].filter((claim) => claim.deltaId === deltaId),
    );
  }

  async listCoverageRuns(workspaceId: string): Promise<readonly CoverageRun[]> {
    return Object.freeze(
      [...this.state.coverageRuns.values()].filter((run) => run.workspaceId === workspaceId),
    );
  }

  async monthToDateCostMicros(workspaceId: string, periodPrefix: string): Promise<number> {
    let total = 0;
    for (const run of this.state.coverageRuns.values()) {
      if (run.workspaceId === workspaceId && run.period.startsWith(periodPrefix)) {
        total += run.llmCostMicros;
      }
    }
    return total;
  }

  private scheduledSourceFor(source: Source): ScheduledSource | null {
    const competitor = this.state.competitors.get(source.competitorId);
    const workspace = competitor ? this.state.workspaces.get(competitor.workspaceId) : undefined;
    if (workspace === undefined) return null;
    const health = this.state.sourceHealth.get(source.id) ?? {
      lastFetchedAt: null,
      consecutiveFailures: 0,
    };
    return Object.freeze({
      workspace,
      source,
      lastFetchedAt: health.lastFetchedAt,
      consecutiveFailures: health.consecutiveFailures,
    });
  }

  async listSourcesForScheduling(): Promise<readonly ScheduledSource[]> {
    return Object.freeze(
      [...this.state.sources.values()]
        .map((source) => this.scheduledSourceFor(source))
        .filter((entry): entry is ScheduledSource => entry !== null),
    );
  }

  async markSourceFetched(sourceId: string, fetchedAt: Date): Promise<void> {
    if (!this.state.sources.has(sourceId)) {
      throw new UnknownEntityError(`source ${sourceId} does not exist`);
    }
    this.state.sourceHealth.set(sourceId, { lastFetchedAt: fetchedAt, consecutiveFailures: 0 });
  }

  async markSourceFailed(sourceId: string): Promise<void> {
    const current = this.state.sourceHealth.get(sourceId);
    if (!this.state.sources.has(sourceId) || current === undefined) {
      throw new UnknownEntityError(`source ${sourceId} does not exist`);
    }
    this.state.sourceHealth.set(sourceId, {
      lastFetchedAt: current.lastFetchedAt,
      consecutiveFailures: current.consecutiveFailures + 1,
    });
  }

  async listPendingPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]> {
    return this.scheduledPricingDeltas('pending');
  }

  async listConfirmedPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]> {
    return this.scheduledPricingDeltas('confirmed');
  }

  private scheduledPricingDeltas(state: DeltaState): readonly ScheduledDelta[] {
    const entries: ScheduledDelta[] = [];
    for (const delta of this.state.deltas.values()) {
      if (delta.state !== state || delta.triageClass !== 'pricing_change') continue;
      const source = this.state.sources.get(delta.sourceId);
      const competitor = source ? this.state.competitors.get(source.competitorId) : undefined;
      const workspace = competitor ? this.state.workspaces.get(competitor.workspaceId) : undefined;
      if (source === undefined || workspace === undefined) continue;
      entries.push(Object.freeze({ workspace, source, delta }));
    }
    return Object.freeze(entries);
  }

  /** Require that `competitorId` exists and is owned by `workspaceId` — section scoping (Invariant 8). */
  private requireCompetitorInWorkspace(workspaceId: string, competitorId: string): Competitor {
    const competitor = this.state.competitors.get(competitorId);
    if (!competitor) throw new UnknownEntityError(`competitor ${competitorId} does not exist`);
    if (competitor.workspaceId !== workspaceId) {
      throw new CrossTenantError(`competitor ${competitorId} is not in workspace ${workspaceId}`);
    }
    return competitor;
  }

  /** Assert the (surface, competitor, kind, version) slot is free; returns the reservation key. */
  private sectionVersionKey(surface: string, section: DossierSection | BattlecardSection): string {
    const key = `${surface}:${section.competitorId}:${section.kind}:${section.version}`;
    if (this.state.sectionVersions.has(key)) {
      throw new AppendOnlyViolationError(
        `${surface}_section (${section.competitorId}, ${section.kind}, v${section.version}) already exists`,
      );
    }
    return key;
  }

  async insertDossierSection(
    workspaceId: string,
    section: DossierSection,
  ): Promise<DossierSection> {
    this.requireCompetitorInWorkspace(workspaceId, section.competitorId);
    // Check version free, then id (insertUnique adds the row), then reserve — so a duplicate-id
    // insert never leaves a phantom version reservation.
    const key = this.sectionVersionKey('dossier', section);
    const stored = this.insertUnique(this.state.dossierSections, section, 'dossier_section');
    this.state.sectionVersions.add(key);
    return stored;
  }

  async insertBattlecardSection(
    workspaceId: string,
    section: BattlecardSection,
  ): Promise<BattlecardSection> {
    this.requireCompetitorInWorkspace(workspaceId, section.competitorId);
    const key = this.sectionVersionKey('battlecard', section);
    const stored = this.insertUnique(this.state.battlecardSections, section, 'battlecard_section');
    this.state.sectionVersions.add(key);
    return stored;
  }

  async latestDossierSection(
    workspaceId: string,
    competitorId: string,
    kind: DossierSectionKind,
  ): Promise<DossierSection | null> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    let head: DossierSection | null = null;
    for (const section of this.state.dossierSections.values()) {
      if (section.competitorId !== competitorId || section.kind !== kind) continue;
      if (head === null || section.version > head.version) head = section;
    }
    return head;
  }

  async latestBattlecardSection(
    workspaceId: string,
    competitorId: string,
    kind: BattlecardSectionKind,
  ): Promise<BattlecardSection | null> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    let head: BattlecardSection | null = null;
    for (const section of this.state.battlecardSections.values()) {
      if (section.competitorId !== competitorId || section.kind !== kind) continue;
      if (head === null || section.version > head.version) head = section;
    }
    return head;
  }

  async listDossierSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly DossierSection[]> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    return Object.freeze(
      [...this.state.dossierSections.values()].filter((s) => s.competitorId === competitorId),
    );
  }

  async listBattlecardSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly BattlecardSection[]> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    return Object.freeze(
      [...this.state.battlecardSections.values()].filter((s) => s.competitorId === competitorId),
    );
  }

  async getClaimsByIds(
    workspaceId: string,
    claimIds: readonly string[],
  ): Promise<readonly Claim[]> {
    const wanted = new Set(claimIds);
    const result: Claim[] = [];
    for (const claim of this.state.claims.values()) {
      if (!wanted.has(claim.id)) continue;
      const delta = this.state.deltas.get(claim.deltaId);
      if (delta && this.workspaceIdForSource(delta.sourceId) === workspaceId) result.push(claim);
    }
    return Object.freeze(result);
  }

  async listConfirmedMaterialDeltasForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Delta[]> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const sourceIds = new Set(
      [...this.state.sources.values()]
        .filter((s) => s.competitorId === competitorId)
        .map((s) => s.id),
    );
    return Object.freeze(
      [...this.state.deltas.values()].filter(
        (d) =>
          sourceIds.has(d.sourceId) &&
          (d.state === 'confirmed' || d.state === 'published') &&
          d.materiality > 0 &&
          d.triageClass !== 'noise',
      ),
    );
  }

  async listSourcesForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Source[]> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    return Object.freeze(
      [...this.state.sources.values()].filter((s) => s.competitorId === competitorId),
    );
  }

  async listDeltasForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Delta[]> {
    this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const sourceIds = new Set(
      [...this.state.sources.values()]
        .filter((s) => s.competitorId === competitorId)
        .map((s) => s.id),
    );
    return Object.freeze([...this.state.deltas.values()].filter((d) => sourceIds.has(d.sourceId)));
  }

  async seedUser(user: AppUser): Promise<AppUser> {
    return this.insertUnique(
      this.state.users,
      { ...user, email: user.email.toLowerCase() },
      'app_user',
    );
  }

  async seedMembership(membership: Membership): Promise<Membership> {
    if (!this.state.users.has(membership.userId)) {
      throw new UnknownEntityError(`user ${membership.userId} does not exist`);
    }
    if (!this.state.workspaces.has(membership.workspaceId)) {
      throw new UnknownEntityError(`workspace ${membership.workspaceId} does not exist`);
    }
    for (const existing of this.state.memberships.values()) {
      if (
        existing.userId === membership.userId &&
        existing.workspaceId === membership.workspaceId
      ) {
        throw new AppendOnlyViolationError(
          `membership (${membership.userId}, ${membership.workspaceId}) already exists`,
        );
      }
    }
    return this.insertUnique(this.state.memberships, membership, 'membership');
  }

  async linkOrCreateUserBySubject(
    identity: ExternalIdentity,
    createdAt: Date = new Date(),
  ): Promise<AppUser> {
    const email = identity.email.toLowerCase();
    // (1) Stable subject match — the authoritative link once established.
    for (const user of this.state.users.values()) {
      if (user.externalSubject !== null && user.externalSubject === identity.subject) return user;
    }
    // (2) Email match — a pre-OIDC/seed row adopts its IdP subject on first login (backfill), but
    // ONLY for a verified email. An unverified email colliding with an existing account is rejected,
    // never linked: otherwise anyone who registers that address at the IdP hijacks the workspace.
    for (const user of this.state.users.values()) {
      if (user.email.toLowerCase() === email) {
        if (!identity.emailVerified) {
          throw new IdentityConflictError(
            `unverified email ${email} collides with an existing account — refusing to link`,
          );
        }
        const linked = freezeDeep({
          ...user,
          externalSubject: identity.subject,
          name: user.name ?? identity.name,
        });
        this.state.users.set(user.id, linked);
        return linked;
      }
    }
    // (3) First time we have ever seen this identity — JIT-create. Confers NO membership.
    const created: AppUser = {
      id: `user_${randomUUID()}`,
      email,
      name: identity.name,
      externalSubject: identity.subject,
      createdAt,
    };
    return this.insertUnique(this.state.users, created, 'app_user');
  }

  async findUserByEmail(email: string): Promise<AppUser | null> {
    const normalized = email.toLowerCase();
    for (const user of this.state.users.values()) {
      if (user.email.toLowerCase() === normalized) return user;
    }
    return null;
  }

  async getUserById(userId: string): Promise<AppUser | null> {
    return this.state.users.get(userId) ?? null;
  }

  async listMembershipsForUser(userId: string): Promise<readonly MembershipWithWorkspace[]> {
    const pairs: MembershipWithWorkspace[] = [];
    for (const membership of this.state.memberships.values()) {
      if (membership.userId !== userId) continue;
      const workspace = this.state.workspaces.get(membership.workspaceId);
      if (workspace !== undefined) pairs.push(Object.freeze({ membership, workspace }));
    }
    pairs.sort((a, b) => {
      const byTime = a.membership.createdAt.getTime() - b.membership.createdAt.getTime();
      return byTime !== 0 ? byTime : a.membership.id.localeCompare(b.membership.id);
    });
    return Object.freeze(pairs);
  }

  async getMembership(userId: string, workspaceId: string): Promise<Membership | null> {
    for (const membership of this.state.memberships.values()) {
      if (membership.userId === userId && membership.workspaceId === workspaceId) return membership;
    }
    return null;
  }

  async listCompetitors(workspaceId: string): Promise<readonly Competitor[]> {
    return Object.freeze(
      [...this.state.competitors.values()].filter((c) => c.workspaceId === workspaceId),
    );
  }

  async listCompetitorsForSynthesis(): Promise<readonly SynthesisCompetitor[]> {
    const out: SynthesisCompetitor[] = [];
    for (const competitor of this.state.competitors.values()) {
      const workspace = this.state.workspaces.get(competitor.workspaceId);
      if (workspace !== undefined) out.push(Object.freeze({ workspace, competitor }));
    }
    return Object.freeze(out);
  }

  // --- Alert delivery (M3) ---

  async seedChannelConfig(config: AlertChannelConfig): Promise<AlertChannelConfig> {
    if (!this.state.workspaces.has(config.workspaceId)) {
      throw new UnknownEntityError(`workspace ${config.workspaceId} does not exist`);
    }
    return this.insertUnique(this.state.channelConfigs, config, 'alert_channel_config');
  }

  async listChannelConfigs(workspaceId: string): Promise<readonly AlertChannelConfig[]> {
    return Object.freeze(
      [...this.state.channelConfigs.values()]
        .filter((c) => c.workspaceId === workspaceId)
        .sort((a, b) => byCreatedThenId(a.createdAt, a.id, b.createdAt, b.id)),
    );
  }

  async listEnabledChannelConfigs(): Promise<readonly EnabledChannel[]> {
    const out: EnabledChannel[] = [];
    for (const config of this.state.channelConfigs.values()) {
      if (!config.enabled) continue;
      const workspace = this.state.workspaces.get(config.workspaceId);
      if (workspace !== undefined) out.push(Object.freeze({ workspace, config }));
    }
    out.sort((a, b) =>
      byCreatedThenId(a.config.createdAt, a.config.id, b.config.createdAt, b.config.id),
    );
    return Object.freeze(out);
  }

  async enqueueAlert(workspaceId: string, alert: Alert): Promise<Alert> {
    this.requireDeltaInWorkspace(workspaceId, alert.deltaId);
    if (alert.workspaceId !== workspaceId) {
      throw new CrossTenantError(`alert ${alert.id} is not in workspace ${workspaceId}`);
    }
    // Dedup on (delta, channel config) — the UNIQUE constraint's in-memory mirror. A repeat is a
    // no-op returning the pre-existing row (NOT an append-only breach), so the sweep re-runs safely.
    // Keyed per config (not per channel type) so each enabled destination delivers exactly once.
    for (const existing of this.state.alerts.values()) {
      if (
        existing.deltaId === alert.deltaId &&
        existing.channelConfigId === alert.channelConfigId
      ) {
        return existing;
      }
    }
    return this.insertUnique(this.state.alerts, alert, 'alert');
  }

  async listDeliverableAlerts(limit: number): Promise<readonly DeliverableAlert[]> {
    const out: DeliverableAlert[] = [];
    for (const alert of this.state.alerts.values()) {
      if (alert.status !== 'queued' && alert.status !== 'failed') continue;
      const workspace = this.state.workspaces.get(alert.workspaceId);
      if (workspace !== undefined) out.push(Object.freeze({ workspace, alert }));
    }
    out.sort((a, b) =>
      byCreatedThenId(a.alert.enqueuedAt, a.alert.id, b.alert.enqueuedAt, b.alert.id),
    );
    return Object.freeze(out.slice(0, Math.max(0, limit)));
  }

  async recordAlertOutcome(
    workspaceId: string,
    alertId: string,
    to: AlertStatus,
    detail: { readonly providerRef?: string | null; readonly error?: string | null },
    at: Date,
  ): Promise<Alert> {
    const current = this.state.alerts.get(alertId);
    if (!current) throw new UnknownEntityError(`alert ${alertId} does not exist`);
    if (current.workspaceId !== workspaceId) {
      throw new CrossTenantError(`alert ${alertId} is not in workspace ${workspaceId}`);
    }
    assertAlertTransition(current, to, detail.providerRef);
    const next = freezeDeep({
      ...current,
      status: to,
      attemptCount: current.attemptCount + 1,
      providerRef: to === 'delivered' ? (detail.providerRef ?? null) : current.providerRef,
      lastError: to === 'failed' ? (detail.error ?? null) : current.lastError,
      lastAttemptAt: at,
      deliveredAt: to === 'delivered' ? at : current.deliveredAt,
    });
    this.state.alerts.set(alertId, next);
    return next;
  }

  async listAlertsForWorkspace(workspaceId: string): Promise<readonly Alert[]> {
    return Object.freeze(
      [...this.state.alerts.values()]
        .filter((a) => a.workspaceId === workspaceId)
        // Newest first for the delivery-log view.
        .sort((a, b) => byCreatedThenId(b.enqueuedAt, b.id, a.enqueuedAt, a.id)),
    );
  }

  async withTransaction<T>(fn: (tx: FlankStore) => Promise<T>): Promise<T> {
    const checkpoint = this.captureState();
    try {
      return await fn(this);
    } catch (error) {
      this.restoreState(checkpoint);
      throw error;
    }
  }

  /** Shallow-copy every map (records are frozen and append-only, so shallow is enough to roll back). */
  private captureState(): StoreState {
    return {
      workspaces: new Map(this.state.workspaces),
      competitors: new Map(this.state.competitors),
      sources: new Map(this.state.sources),
      snapshots: new Map(this.state.snapshots),
      snapshotsBySource: new Map(
        [...this.state.snapshotsBySource].map(([sourceId, ids]) => [sourceId, [...ids]]),
      ),
      deltas: new Map(this.state.deltas),
      claims: new Map(this.state.claims),
      coverageRuns: new Map(this.state.coverageRuns),
      sourceHealth: new Map(
        [...this.state.sourceHealth].map(([id, health]) => [id, { ...health }]),
      ),
      dossierSections: new Map(this.state.dossierSections),
      battlecardSections: new Map(this.state.battlecardSections),
      sectionVersions: new Set(this.state.sectionVersions),
      users: new Map(this.state.users),
      memberships: new Map(this.state.memberships),
      channelConfigs: new Map(this.state.channelConfigs),
      alerts: new Map(this.state.alerts),
    };
  }

  private restoreState(checkpoint: StoreState): void {
    replaceMap(this.state.workspaces, checkpoint.workspaces);
    replaceMap(this.state.competitors, checkpoint.competitors);
    replaceMap(this.state.sources, checkpoint.sources);
    replaceMap(this.state.snapshots, checkpoint.snapshots);
    replaceMap(this.state.snapshotsBySource, checkpoint.snapshotsBySource);
    replaceMap(this.state.deltas, checkpoint.deltas);
    replaceMap(this.state.claims, checkpoint.claims);
    replaceMap(this.state.coverageRuns, checkpoint.coverageRuns);
    replaceMap(this.state.sourceHealth, checkpoint.sourceHealth);
    replaceMap(this.state.dossierSections, checkpoint.dossierSections);
    replaceMap(this.state.battlecardSections, checkpoint.battlecardSections);
    this.state.sectionVersions.clear();
    for (const key of checkpoint.sectionVersions) this.state.sectionVersions.add(key);
    replaceMap(this.state.users, checkpoint.users);
    replaceMap(this.state.memberships, checkpoint.memberships);
    replaceMap(this.state.channelConfigs, checkpoint.channelConfigs);
    replaceMap(this.state.alerts, checkpoint.alerts);
  }
}

const replaceMap = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
};

/** Stable ordering by timestamp then id — deterministic across runs (mirrors the SQL ORDER BY). */
const byCreatedThenId = (aTime: Date, aId: string, bTime: Date, bId: string): number => {
  const delta = aTime.getTime() - bTime.getTime();
  return delta !== 0 ? delta : aId.localeCompare(bId);
};

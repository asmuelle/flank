import {
  AppendOnlyViolationError,
  assertDeltaTransition,
  CrossTenantError,
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
import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import type { FlankDatabase } from './client';
import {
  appUsers,
  battlecardSections,
  claims,
  competitors,
  coverageRuns,
  deltas,
  dossierSections,
  memberships,
  snapshots,
  sources,
  workspaces,
} from './schema';
import {
  assertSafeInteger,
  isUniqueViolation,
  toAppUser,
  toBattlecardSection,
  toClaim,
  toCompetitor,
  toCoverageRun,
  toDelta,
  toDossierSection,
  toMembership,
  toSnapshot,
  toSource,
  toWorkspace,
} from './drizzle-mappers';
import * as alertStore from './drizzle-alerts';

/**
 * Postgres-backed FlankStore, held to the exact same `runFlankStoreContract` suite as
 * `MemoryFlankStore`. History tables stay append-only (duplicate-id inserts surface as
 * {@link AppendOnlyViolationError}); every write and single-entity lookup is workspace-scoped by
 * walking source → competitor → workspace and failing closed with {@link CrossTenantError}
 * (Invariant 8 — until `workspace_id` is denormalised onto history tables, this is a join, not a
 * single column); the pricing firewall (Invariant 3) runs through the shared
 * {@link assertDeltaTransition} guard; and {@link withTransaction} maps to a real DB transaction so
 * the ingest write set commits atomically (Invariant 1).
 */
export class DrizzleFlankStore implements FlankStore {
  constructor(private readonly db: FlankDatabase) {}

  private async insertOne<TRow, TOut>(
    run: () => Promise<readonly TRow[]>,
    map: (row: TRow) => TOut,
    kind: string,
  ): Promise<TOut> {
    try {
      const [row] = await run();
      return map(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppendOnlyViolationError(`${kind} already exists — history is append-only`);
      }
      throw error;
    }
  }

  /** Require that `sourceId` exists and is owned by `workspaceId` (Invariant 8). */
  private async requireSourceInWorkspace(workspaceId: string, sourceId: string): Promise<void> {
    const rows = await this.db
      .select({ ownerWorkspaceId: competitors.workspaceId })
      .from(sources)
      .innerJoin(competitors, eq(sources.competitorId, competitors.id))
      .where(eq(sources.id, sourceId))
      .limit(1);
    const owner = rows[0]?.ownerWorkspaceId;
    if (owner === undefined) throw new UnknownEntityError(`source ${sourceId} does not exist`);
    if (owner !== workspaceId) {
      throw new CrossTenantError(`source ${sourceId} is not in workspace ${workspaceId}`);
    }
  }

  /** Require that `deltaId` exists and is owned by `workspaceId`; return the current delta. */
  private async requireDeltaInWorkspace(workspaceId: string, deltaId: string): Promise<Delta> {
    // Single-table lookup thanks to the denormalized delta.workspace_id (no source/competitor join).
    const rows = await this.db.select().from(deltas).where(eq(deltas.id, deltaId)).limit(1);
    const row = rows[0];
    if (row === undefined) throw new UnknownEntityError(`delta ${deltaId} does not exist`);
    if (row.workspaceId !== workspaceId) {
      throw new CrossTenantError(`delta ${deltaId} is not in workspace ${workspaceId}`);
    }
    return toDelta(row);
  }

  async seedWorkspace(workspace: Workspace): Promise<Workspace> {
    return this.insertOne(
      () =>
        this.db
          .insert(workspaces)
          .values({ id: workspace.id, name: workspace.name, planTier: workspace.planTier })
          .returning(),
      toWorkspace,
      'workspace',
    );
  }

  async seedCompetitor(competitor: Competitor): Promise<Competitor> {
    const parent = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, competitor.workspaceId))
      .limit(1);
    if (parent[0] === undefined) {
      throw new UnknownEntityError(`workspace ${competitor.workspaceId} does not exist`);
    }
    return this.insertOne(
      () =>
        this.db
          .insert(competitors)
          .values({
            id: competitor.id,
            workspaceId: competitor.workspaceId,
            name: competitor.name,
            primaryDomain: competitor.primaryDomain,
          })
          .returning(),
      toCompetitor,
      'competitor',
    );
  }

  async seedSource(source: Source): Promise<Source> {
    const parent = await this.db
      .select({ id: competitors.id })
      .from(competitors)
      .where(eq(competitors.id, source.competitorId))
      .limit(1);
    if (parent[0] === undefined) {
      throw new UnknownEntityError(`competitor ${source.competitorId} does not exist`);
    }
    return this.insertOne(
      () =>
        this.db
          .insert(sources)
          .values({
            id: source.id,
            competitorId: source.competitorId,
            type: source.type,
            url: source.url,
            adapter: source.adapter,
            cadence: source.cadence,
            legalStatus: source.legalStatus,
          })
          .returning(),
      toSource,
      'source',
    );
  }

  async insertSnapshot(workspaceId: string, snapshot: Snapshot): Promise<Snapshot> {
    await this.requireSourceInWorkspace(workspaceId, snapshot.sourceId);
    return this.insertOne(
      () =>
        this.db
          .insert(snapshots)
          .values({
            id: snapshot.id,
            sourceId: snapshot.sourceId,
            workspaceId,
            contentHash: snapshot.contentHash,
            normalizedText: snapshot.normalizedText,
            fetchedAt: snapshot.fetchedAt,
            httpStatus: snapshot.httpStatus,
            vantage: snapshot.vantage,
            s3Key: null,
          })
          .returning(),
      toSnapshot,
      'snapshot',
    );
  }

  async latestSnapshot(workspaceId: string, sourceId: string): Promise<Snapshot | null> {
    await this.requireSourceInWorkspace(workspaceId, sourceId);
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.sourceId, sourceId))
      .orderBy(desc(snapshots.fetchedAt))
      .limit(1);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async getSnapshot(workspaceId: string, snapshotId: string): Promise<Snapshot | null> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.id, snapshotId), eq(snapshots.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async insertDelta(workspaceId: string, delta: Delta): Promise<Delta> {
    await this.requireSourceInWorkspace(workspaceId, delta.sourceId);
    return this.insertOne(
      () =>
        this.db
          .insert(deltas)
          .values({
            id: delta.id,
            sourceId: delta.sourceId,
            workspaceId,
            fromSnapshotId: delta.fromSnapshotId,
            toSnapshotId: delta.toSnapshotId,
            changedSpans: delta.changedSpans,
            triageClass: delta.triageClass,
            materiality: delta.materiality,
            rationale: delta.rationale,
            state: delta.state,
            confirmedBySnapshotId: delta.confirmedBySnapshotId,
            createdAt: delta.createdAt,
          })
          .returning(),
      toDelta,
      'delta',
    );
  }

  async transitionDelta(
    workspaceId: string,
    deltaId: string,
    to: DeltaState,
    confirmedBySnapshotId: string | null = null,
  ): Promise<Delta> {
    const current = await this.requireDeltaInWorkspace(workspaceId, deltaId);
    assertDeltaTransition(current, to, confirmedBySnapshotId);
    const [row] = await this.db
      .update(deltas)
      .set({
        state: to,
        confirmedBySnapshotId:
          to === 'confirmed' ? confirmedBySnapshotId : current.confirmedBySnapshotId,
      })
      .where(eq(deltas.id, deltaId))
      .returning();
    return toDelta(row);
  }

  async insertClaim(workspaceId: string, claim: Claim): Promise<Claim> {
    await this.requireDeltaInWorkspace(workspaceId, claim.deltaId);
    return this.insertOne(
      () =>
        this.db
          .insert(claims)
          .values({
            id: claim.id,
            deltaId: claim.deltaId,
            workspaceId,
            snapshotId: claim.snapshotId,
            quoteText: claim.quoteText,
            charStart: claim.charStart,
            charEnd: claim.charEnd,
            sourceUrl: claim.sourceUrl,
            capturedAt: claim.capturedAt,
            verifiedAt: claim.verifiedAt,
          })
          .returning(),
      toClaim,
      'claim',
    );
  }

  async insertCoverageRun(run: CoverageRun): Promise<CoverageRun> {
    const parent = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, run.workspaceId))
      .limit(1);
    if (parent[0] === undefined) {
      throw new UnknownEntityError(`workspace ${run.workspaceId} does not exist`);
    }
    return this.insertOne(
      () =>
        this.db
          .insert(coverageRuns)
          .values({
            id: run.id,
            workspaceId: run.workspaceId,
            period: run.period,
            sourcesChecked: run.sourcesChecked,
            fetchFailures: run.fetchFailures,
            deltasFound: run.deltasFound,
            materialDeltas: run.materialDeltas,
            llmCalls: run.llmCalls,
            llmCostMicros: run.llmCostMicros,
            createdAt: run.createdAt,
          })
          .returning(),
      toCoverageRun,
      'coverage_run',
    );
  }

  async listDeltas(workspaceId: string): Promise<readonly Delta[]> {
    // Single-table scope via the denormalized workspace_id (Invariant 8) — no joins.
    const rows = await this.db.select().from(deltas).where(eq(deltas.workspaceId, workspaceId));
    return Object.freeze(rows.map(toDelta));
  }

  async listClaimsForDelta(workspaceId: string, deltaId: string): Promise<readonly Claim[]> {
    // Scope on claim.workspace_id directly; a foreign-tenant or unknown delta yields no rows.
    const rows = await this.db
      .select()
      .from(claims)
      .where(and(eq(claims.deltaId, deltaId), eq(claims.workspaceId, workspaceId)));
    return Object.freeze(rows.map(toClaim));
  }

  async listCoverageRuns(workspaceId: string): Promise<readonly CoverageRun[]> {
    const rows = await this.db
      .select()
      .from(coverageRuns)
      .where(eq(coverageRuns.workspaceId, workspaceId));
    return Object.freeze(rows.map(toCoverageRun));
  }

  async monthToDateCostMicros(workspaceId: string, periodPrefix: string): Promise<number> {
    // sum(bigint) returns NUMERIC; cast to bigint and coerce through Number with a safety check.
    const rows = await this.db
      .select({ total: sql<string>`coalesce(sum(${coverageRuns.llmCostMicros}), 0)::bigint` })
      .from(coverageRuns)
      .where(
        and(
          eq(coverageRuns.workspaceId, workspaceId),
          like(coverageRuns.period, `${periodPrefix}%`),
        ),
      );
    return assertSafeInteger(Number(rows[0]?.total ?? 0), 'monthToDateCostMicros');
  }

  async listSourcesForScheduling(): Promise<readonly ScheduledSource[]> {
    const rows = await this.db
      .select({ source: sources, workspace: workspaces })
      .from(sources)
      .innerJoin(competitors, eq(sources.competitorId, competitors.id))
      .innerJoin(workspaces, eq(competitors.workspaceId, workspaces.id));
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          workspace: toWorkspace(row.workspace),
          source: toSource(row.source),
          lastFetchedAt: row.source.lastFetchedAt,
          consecutiveFailures: row.source.consecutiveFailures,
        }),
      ),
    );
  }

  async markSourceFetched(sourceId: string, fetchedAt: Date): Promise<void> {
    await this.db
      .update(sources)
      .set({ lastFetchedAt: fetchedAt, consecutiveFailures: 0 })
      .where(eq(sources.id, sourceId));
  }

  async markSourceFailed(sourceId: string): Promise<void> {
    await this.db
      .update(sources)
      .set({ consecutiveFailures: sql`${sources.consecutiveFailures} + 1` })
      .where(eq(sources.id, sourceId));
  }

  async listPendingPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]> {
    const rows = await this.db
      .select({ delta: deltas, source: sources, workspace: workspaces })
      .from(deltas)
      .innerJoin(sources, eq(deltas.sourceId, sources.id))
      .innerJoin(workspaces, eq(deltas.workspaceId, workspaces.id))
      .where(and(eq(deltas.state, 'pending'), eq(deltas.triageClass, 'pricing_change')));
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          workspace: toWorkspace(row.workspace),
          source: toSource(row.source),
          delta: toDelta(row.delta),
        }),
      ),
    );
  }

  async listConfirmedPricingDeltasForScheduling(): Promise<readonly ScheduledDelta[]> {
    const rows = await this.db
      .select({ delta: deltas, source: sources, workspace: workspaces })
      .from(deltas)
      .innerJoin(sources, eq(deltas.sourceId, sources.id))
      .innerJoin(workspaces, eq(deltas.workspaceId, workspaces.id))
      .where(and(eq(deltas.state, 'confirmed'), eq(deltas.triageClass, 'pricing_change')));
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          workspace: toWorkspace(row.workspace),
          source: toSource(row.source),
          delta: toDelta(row.delta),
        }),
      ),
    );
  }

  private async requireCompetitorInWorkspace(
    workspaceId: string,
    competitorId: string,
  ): Promise<void> {
    const rows = await this.db
      .select({ ownerWorkspaceId: competitors.workspaceId })
      .from(competitors)
      .where(eq(competitors.id, competitorId))
      .limit(1);
    const owner = rows[0]?.ownerWorkspaceId;
    if (owner === undefined) {
      throw new UnknownEntityError(`competitor ${competitorId} does not exist`);
    }
    if (owner !== workspaceId) {
      throw new CrossTenantError(`competitor ${competitorId} is not in workspace ${workspaceId}`);
    }
  }

  async insertDossierSection(
    workspaceId: string,
    section: DossierSection,
  ): Promise<DossierSection> {
    await this.requireCompetitorInWorkspace(workspaceId, section.competitorId);
    return this.insertOne(
      () =>
        this.db
          .insert(dossierSections)
          .values({
            id: section.id,
            competitorId: section.competitorId,
            kind: section.kind,
            version: section.version,
            contentMd: section.contentMd,
            claimIds: section.claimIds,
            model: section.model,
            batchId: section.batchId,
            supersedesId: section.supersedesId,
            createdAt: section.createdAt,
          })
          .returning(),
      toDossierSection,
      'dossier_section',
    );
  }

  async insertBattlecardSection(
    workspaceId: string,
    section: BattlecardSection,
  ): Promise<BattlecardSection> {
    await this.requireCompetitorInWorkspace(workspaceId, section.competitorId);
    return this.insertOne(
      () =>
        this.db
          .insert(battlecardSections)
          .values({
            id: section.id,
            competitorId: section.competitorId,
            kind: section.kind,
            version: section.version,
            contentMd: section.contentMd,
            claimIds: section.claimIds,
            supersedesId: section.supersedesId,
            createdAt: section.createdAt,
          })
          .returning(),
      toBattlecardSection,
      'battlecard_section',
    );
  }

  async latestDossierSection(
    workspaceId: string,
    competitorId: string,
    kind: DossierSectionKind,
  ): Promise<DossierSection | null> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select()
      .from(dossierSections)
      .where(and(eq(dossierSections.competitorId, competitorId), eq(dossierSections.kind, kind)))
      .orderBy(desc(dossierSections.version))
      .limit(1);
    return rows[0] ? toDossierSection(rows[0]) : null;
  }

  async latestBattlecardSection(
    workspaceId: string,
    competitorId: string,
    kind: BattlecardSectionKind,
  ): Promise<BattlecardSection | null> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select()
      .from(battlecardSections)
      .where(
        and(eq(battlecardSections.competitorId, competitorId), eq(battlecardSections.kind, kind)),
      )
      .orderBy(desc(battlecardSections.version))
      .limit(1);
    return rows[0] ? toBattlecardSection(rows[0]) : null;
  }

  async listDossierSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly DossierSection[]> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select()
      .from(dossierSections)
      .where(eq(dossierSections.competitorId, competitorId));
    return Object.freeze(rows.map(toDossierSection));
  }

  async listBattlecardSections(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly BattlecardSection[]> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select()
      .from(battlecardSections)
      .where(eq(battlecardSections.competitorId, competitorId));
    return Object.freeze(rows.map(toBattlecardSection));
  }

  async getClaimsByIds(
    workspaceId: string,
    claimIds: readonly string[],
  ): Promise<readonly Claim[]> {
    if (claimIds.length === 0) return Object.freeze([]);
    const rows = await this.db
      .select()
      .from(claims)
      .where(and(inArray(claims.id, [...claimIds]), eq(claims.workspaceId, workspaceId)));
    return Object.freeze(rows.map(toClaim));
  }

  async listConfirmedMaterialDeltasForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Delta[]> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select({ delta: deltas })
      .from(deltas)
      .innerJoin(sources, eq(deltas.sourceId, sources.id))
      .where(
        and(
          eq(sources.competitorId, competitorId),
          eq(deltas.workspaceId, workspaceId),
          inArray(deltas.state, ['confirmed', 'published']),
          sql`${deltas.materiality} > 0`,
          ne(deltas.triageClass, 'noise'),
        ),
      );
    return Object.freeze(rows.map((row) => toDelta(row.delta)));
  }

  async listSourcesForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Source[]> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db.select().from(sources).where(eq(sources.competitorId, competitorId));
    return Object.freeze(rows.map(toSource));
  }

  async listDeltasForCompetitor(
    workspaceId: string,
    competitorId: string,
  ): Promise<readonly Delta[]> {
    await this.requireCompetitorInWorkspace(workspaceId, competitorId);
    const rows = await this.db
      .select({ delta: deltas })
      .from(deltas)
      .innerJoin(sources, eq(deltas.sourceId, sources.id))
      .where(and(eq(sources.competitorId, competitorId), eq(deltas.workspaceId, workspaceId)));
    return Object.freeze(rows.map((row) => toDelta(row.delta)));
  }

  async seedUser(user: AppUser): Promise<AppUser> {
    return this.insertOne(
      () =>
        this.db
          .insert(appUsers)
          .values({
            id: user.id,
            email: user.email.toLowerCase(),
            name: user.name,
            createdAt: user.createdAt,
          })
          .returning(),
      toAppUser,
      'app_user',
    );
  }

  async seedMembership(membership: Membership): Promise<Membership> {
    return this.insertOne(
      () =>
        this.db
          .insert(memberships)
          .values({
            id: membership.id,
            userId: membership.userId,
            workspaceId: membership.workspaceId,
            role: membership.role,
            createdAt: membership.createdAt,
          })
          .returning(),
      toMembership,
      'membership',
    );
  }

  async findUserByEmail(email: string): Promise<AppUser | null> {
    const rows = await this.db
      .select()
      .from(appUsers)
      .where(eq(appUsers.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ? toAppUser(rows[0]) : null;
  }

  async getUserById(userId: string): Promise<AppUser | null> {
    const rows = await this.db.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1);
    return rows[0] ? toAppUser(rows[0]) : null;
  }

  async listMembershipsForUser(userId: string): Promise<readonly MembershipWithWorkspace[]> {
    const rows = await this.db
      .select({ membership: memberships, workspace: workspaces })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, userId))
      .orderBy(memberships.createdAt, memberships.id);
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          membership: toMembership(row.membership),
          workspace: toWorkspace(row.workspace),
        }),
      ),
    );
  }

  async getMembership(userId: string, workspaceId: string): Promise<Membership | null> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? toMembership(rows[0]) : null;
  }

  async listCompetitors(workspaceId: string): Promise<readonly Competitor[]> {
    const rows = await this.db
      .select()
      .from(competitors)
      .where(eq(competitors.workspaceId, workspaceId));
    return Object.freeze(rows.map(toCompetitor));
  }

  async listCompetitorsForSynthesis(): Promise<readonly SynthesisCompetitor[]> {
    const rows = await this.db
      .select({ competitor: competitors, workspace: workspaces })
      .from(competitors)
      .innerJoin(workspaces, eq(competitors.workspaceId, workspaces.id));
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          workspace: toWorkspace(row.workspace),
          competitor: toCompetitor(row.competitor),
        }),
      ),
    );
  }

  // --- Alert delivery (M3) --- delegated to ./drizzle-alerts to keep this file within budget.

  seedChannelConfig(config: AlertChannelConfig): Promise<AlertChannelConfig> {
    return alertStore.seedChannelConfig(this.db, config);
  }
  listChannelConfigs(workspaceId: string): Promise<readonly AlertChannelConfig[]> {
    return alertStore.listChannelConfigs(this.db, workspaceId);
  }
  listEnabledChannelConfigs(): Promise<readonly EnabledChannel[]> {
    return alertStore.listEnabledChannelConfigs(this.db);
  }
  enqueueAlert(workspaceId: string, alert: Alert): Promise<Alert> {
    return alertStore.enqueueAlert(this.db, workspaceId, alert);
  }
  listDeliverableAlerts(limit: number): Promise<readonly DeliverableAlert[]> {
    return alertStore.listDeliverableAlerts(this.db, limit);
  }
  recordAlertOutcome(
    workspaceId: string,
    alertId: string,
    to: AlertStatus,
    detail: { readonly providerRef?: string | null; readonly error?: string | null },
    at: Date,
  ): Promise<Alert> {
    return alertStore.recordAlertOutcome(this.db, workspaceId, alertId, to, detail, at);
  }
  listAlertsForWorkspace(workspaceId: string): Promise<readonly Alert[]> {
    return alertStore.listAlertsForWorkspace(this.db, workspaceId);
  }

  async withTransaction<T>(fn: (tx: FlankStore) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      // `tx` is a transaction-bound handle exposing the same query builder used throughout this
      // class; the cast is the standard drizzle pattern for threading a tx into a repository.
      fn(new DrizzleFlankStore(tx as unknown as FlankDatabase)),
    );
  }
}

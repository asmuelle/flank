import {
  AppendOnlyViolationError,
  assertDeltaTransition,
  CrossTenantError,
  UnknownEntityError,
  type Claim,
  type Competitor,
  type CoverageRun,
  type Delta,
  type DeltaState,
  type FlankStore,
  type Snapshot,
  type Source,
  type Workspace,
} from '@flank/core';
import { and, desc, eq } from 'drizzle-orm';
import type { FlankDatabase } from './client';
import {
  claims,
  competitors,
  coverageRuns,
  deltas,
  snapshots,
  sources,
  workspaces,
} from './schema';

// Row → core-entity mappers. The schema carries a few columns the domain does not model yet
// (snapshot.s3Key, workspace.competitorLimit, …); the domain layer sees only the canonical shape.
const toWorkspace = (row: typeof workspaces.$inferSelect): Workspace =>
  Object.freeze({ id: row.id, name: row.name, planTier: row.planTier });

const toCompetitor = (row: typeof competitors.$inferSelect): Competitor =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    primaryDomain: row.primaryDomain,
  });

const toSource = (row: typeof sources.$inferSelect): Source =>
  Object.freeze({
    id: row.id,
    competitorId: row.competitorId,
    type: row.type,
    url: row.url,
    adapter: row.adapter,
    cadence: row.cadence,
    legalStatus: row.legalStatus,
  });

const toSnapshot = (row: typeof snapshots.$inferSelect): Snapshot =>
  Object.freeze({
    id: row.id,
    sourceId: row.sourceId,
    contentHash: row.contentHash,
    normalizedText: row.normalizedText,
    fetchedAt: row.fetchedAt,
    httpStatus: row.httpStatus,
    vantage: row.vantage,
  });

const toDelta = (row: typeof deltas.$inferSelect): Delta =>
  Object.freeze({
    id: row.id,
    sourceId: row.sourceId,
    fromSnapshotId: row.fromSnapshotId,
    toSnapshotId: row.toSnapshotId,
    changedSpans: row.changedSpans,
    triageClass: row.triageClass,
    materiality: row.materiality,
    rationale: row.rationale,
    state: row.state,
    confirmedBySnapshotId: row.confirmedBySnapshotId,
    createdAt: row.createdAt,
  });

const toClaim = (row: typeof claims.$inferSelect): Claim =>
  Object.freeze({
    id: row.id,
    deltaId: row.deltaId,
    snapshotId: row.snapshotId,
    quoteText: row.quoteText,
    charStart: row.charStart,
    charEnd: row.charEnd,
    sourceUrl: row.sourceUrl,
    capturedAt: row.capturedAt,
    verifiedAt: row.verifiedAt,
  });

const toCoverageRun = (row: typeof coverageRuns.$inferSelect): CoverageRun =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    period: row.period,
    sourcesChecked: row.sourcesChecked,
    fetchFailures: row.fetchFailures,
    deltasFound: row.deltasFound,
    materialDeltas: row.materialDeltas,
    llmCalls: row.llmCalls,
    llmCostCents: row.llmCostCents,
    createdAt: row.createdAt,
  });

/**
 * Postgres unique-violation (duplicate primary key) → append-only breach (Invariant 5). Drizzle
 * wraps the driver error, so the postgres-js `PostgresError` (carrying `code`) is reached via the
 * `cause` chain rather than the top-level error.
 */
const PG_UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object') break;
    if (
      'code' in current &&
      (current as { readonly code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = 'cause' in current ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
};

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
            llmCostCents: run.llmCostCents,
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

  async withTransaction<T>(fn: (tx: FlankStore) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      // `tx` is a transaction-bound handle exposing the same query builder used throughout this
      // class; the cast is the standard drizzle pattern for threading a tx into a repository.
      fn(new DrizzleFlankStore(tx as unknown as FlankDatabase)),
    );
  }
}

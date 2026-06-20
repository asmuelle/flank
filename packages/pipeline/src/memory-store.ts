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
    return this.insertUnique(this.state.sources, source, 'source');
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
  }
}

const replaceMap = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
};

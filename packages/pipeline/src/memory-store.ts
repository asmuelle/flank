import {
  ALLOWED_DELTA_TRANSITIONS,
  AppendOnlyViolationError,
  IllegalTransitionError,
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

/**
 * In-memory FlankStore for M1 tests and the fixture-rendered web brief.
 * Append-only semantics (Invariant 5): inserts reject duplicate ids, records
 * are frozen, and no delete operation exists. Reads are workspace-scoped
 * (Invariant 8) by walking delta → source → competitor → workspace.
 */
export class MemoryFlankStore implements FlankStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly competitors = new Map<string, Competitor>();
  private readonly sources = new Map<string, Source>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly snapshotsBySource = new Map<string, string[]>();
  private readonly deltas = new Map<string, Delta>();
  private readonly claims = new Map<string, Claim>();
  private readonly coverageRuns = new Map<string, CoverageRun>();

  private insertUnique<T extends { readonly id: string }>(map: Map<string, T>, record: T, kind: string): T {
    if (map.has(record.id)) {
      throw new AppendOnlyViolationError(`${kind} ${record.id} already exists — history is append-only`);
    }
    const frozen = freezeDeep(record);
    map.set(record.id, frozen);
    return frozen;
  }

  async seedWorkspace(workspace: Workspace): Promise<Workspace> {
    return this.insertUnique(this.workspaces, workspace, 'workspace');
  }

  async seedCompetitor(competitor: Competitor): Promise<Competitor> {
    if (!this.workspaces.has(competitor.workspaceId)) {
      throw new UnknownEntityError(`workspace ${competitor.workspaceId} does not exist`);
    }
    return this.insertUnique(this.competitors, competitor, 'competitor');
  }

  async seedSource(source: Source): Promise<Source> {
    if (!this.competitors.has(source.competitorId)) {
      throw new UnknownEntityError(`competitor ${source.competitorId} does not exist`);
    }
    return this.insertUnique(this.sources, source, 'source');
  }

  async insertSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    if (!this.sources.has(snapshot.sourceId)) {
      throw new UnknownEntityError(`source ${snapshot.sourceId} does not exist`);
    }
    const frozen = this.insertUnique(this.snapshots, snapshot, 'snapshot');
    const existing = this.snapshotsBySource.get(snapshot.sourceId) ?? [];
    this.snapshotsBySource.set(snapshot.sourceId, [...existing, snapshot.id]);
    return frozen;
  }

  async latestSnapshot(sourceId: string): Promise<Snapshot | null> {
    const ids = this.snapshotsBySource.get(sourceId) ?? [];
    const lastId = ids[ids.length - 1];
    return lastId === undefined ? null : (this.snapshots.get(lastId) ?? null);
  }

  async insertDelta(delta: Delta): Promise<Delta> {
    if (!this.sources.has(delta.sourceId)) {
      throw new UnknownEntityError(`source ${delta.sourceId} does not exist`);
    }
    return this.insertUnique(this.deltas, delta, 'delta');
  }

  async transitionDelta(deltaId: string, to: DeltaState): Promise<Delta> {
    const current = this.deltas.get(deltaId);
    if (!current) throw new UnknownEntityError(`delta ${deltaId} does not exist`);
    if (!ALLOWED_DELTA_TRANSITIONS[current.state].includes(to)) {
      throw new IllegalTransitionError(`delta ${deltaId}: ${current.state} → ${to} is not allowed`);
    }
    const next = freezeDeep({ ...current, state: to });
    this.deltas.set(deltaId, next);
    return next;
  }

  async insertClaim(claim: Claim): Promise<Claim> {
    if (!this.deltas.has(claim.deltaId)) {
      throw new UnknownEntityError(`delta ${claim.deltaId} does not exist`);
    }
    return this.insertUnique(this.claims, claim, 'claim');
  }

  async insertCoverageRun(run: CoverageRun): Promise<CoverageRun> {
    if (!this.workspaces.has(run.workspaceId)) {
      throw new UnknownEntityError(`workspace ${run.workspaceId} does not exist`);
    }
    return this.insertUnique(this.coverageRuns, run, 'coverage_run');
  }

  private workspaceIdForSource(sourceId: string): string | null {
    const source = this.sources.get(sourceId);
    if (!source) return null;
    const competitor = this.competitors.get(source.competitorId);
    return competitor?.workspaceId ?? null;
  }

  async listDeltas(workspaceId: string): Promise<readonly Delta[]> {
    return Object.freeze(
      [...this.deltas.values()].filter(
        (delta) => this.workspaceIdForSource(delta.sourceId) === workspaceId,
      ),
    );
  }

  async listClaimsForDelta(workspaceId: string, deltaId: string): Promise<readonly Claim[]> {
    const delta = this.deltas.get(deltaId);
    if (!delta || this.workspaceIdForSource(delta.sourceId) !== workspaceId) {
      return Object.freeze([]);
    }
    return Object.freeze([...this.claims.values()].filter((claim) => claim.deltaId === deltaId));
  }

  async listCoverageRuns(workspaceId: string): Promise<readonly CoverageRun[]> {
    return Object.freeze(
      [...this.coverageRuns.values()].filter((run) => run.workspaceId === workspaceId),
    );
  }
}

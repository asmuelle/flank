import type {
  Claim,
  Competitor,
  CoverageRun,
  Delta,
  DeltaState,
  Snapshot,
  Source,
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

/** Delta state machine: pending is the only mutable state (Invariant 3 firewall lives here). */
export const ALLOWED_DELTA_TRANSITIONS: Readonly<Record<DeltaState, readonly DeltaState[]>> =
  Object.freeze({
    pending: Object.freeze(['confirmed', 'dismissed', 'published'] as const),
    confirmed: Object.freeze(['published'] as const),
    dismissed: Object.freeze([] as const),
    published: Object.freeze([] as const),
  });

/**
 * Repository contract. History tables (snapshots, deltas, claims) are
 * append-only (Invariant 5): no update or delete operations exist on this
 * interface beyond the delta state machine and one-shot claim verification.
 * Every read is workspace-scoped (Invariant 8).
 */
export interface FlankStore {
  seedWorkspace(workspace: Workspace): Promise<Workspace>;
  seedCompetitor(competitor: Competitor): Promise<Competitor>;
  seedSource(source: Source): Promise<Source>;

  insertSnapshot(snapshot: Snapshot): Promise<Snapshot>;
  latestSnapshot(sourceId: string): Promise<Snapshot | null>;

  insertDelta(delta: Delta): Promise<Delta>;
  transitionDelta(deltaId: string, to: DeltaState): Promise<Delta>;

  insertClaim(claim: Claim): Promise<Claim>;

  insertCoverageRun(run: CoverageRun): Promise<CoverageRun>;

  listDeltas(workspaceId: string): Promise<readonly Delta[]>;
  listClaimsForDelta(workspaceId: string, deltaId: string): Promise<readonly Claim[]>;
  listCoverageRuns(workspaceId: string): Promise<readonly CoverageRun[]>;
}

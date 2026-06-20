import {
  assertTriageAllowed,
  contentHash,
  diffChangedSpans,
  estimateTriageCostCents,
  gatePublish,
  pinClaims,
  TriageResultSchema,
  type Claim,
  type Delta,
  type DeltaState,
  type FlankStore,
  type Snapshot,
  type Source,
  type TriageClient,
  type TriageResult,
  type Workspace,
} from '@flank/core';
import { AdapterError, normalizeForSource } from './adapters/index';

export interface IngestContext {
  readonly workspace: Workspace;
  readonly source: Source;
}

export interface IngestDeps {
  readonly store: FlankStore;
  readonly triage: TriageClient;
  readonly nextId: () => string;
}

export type IngestOutcome =
  | { readonly kind: 'skipped_blocked'; readonly reason: string }
  | { readonly kind: 'fetch_failed'; readonly error: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'baseline'; readonly snapshot: Snapshot }
  | { readonly kind: 'delta'; readonly delta: Delta; readonly claims: readonly Claim[] };

interface CoverageInput {
  readonly fetchFailures?: number;
  readonly deltasFound?: number;
  readonly materialDeltas?: number;
  readonly llmCalls?: number;
  readonly llmCostCents?: number;
}

/** Sequential id factory — deterministic ids for tests and the fixture-rendered brief. */
export const createSequentialIds = (prefix: string): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
};

export const recordCoverage = async (
  ctx: IngestContext,
  deps: IngestDeps,
  fetchedAt: Date,
  input: CoverageInput,
): Promise<void> => {
  await deps.store.insertCoverageRun({
    id: deps.nextId(),
    workspaceId: ctx.workspace.id,
    period: fetchedAt.toISOString().slice(0, 10),
    sourcesChecked: 1,
    fetchFailures: input.fetchFailures ?? 0,
    deltasFound: input.deltasFound ?? 0,
    materialDeltas: input.materialDeltas ?? 0,
    llmCalls: input.llmCalls ?? 0,
    llmCostCents: input.llmCostCents ?? 0,
    createdAt: fetchedAt,
  });
};

const deltaStateFor = (triage: TriageResult, publishable: boolean): DeltaState => {
  if (triage.triageClass === 'noise') return 'dismissed';
  // Invariant 1: fail closed — unverifiable claims never publish.
  if (!publishable) return 'pending';
  // Invariant 3: pricing deltas require re-fetch confirmation before leaving pending.
  if (triage.triageClass === 'pricing_change') return 'pending';
  return 'published';
};

const handleChangedContent = async (
  ctx: IngestContext,
  deps: IngestDeps,
  previous: Snapshot,
  snapshot: Snapshot,
  fetchedAt: Date,
): Promise<IngestOutcome> => {
  const spans = diffChangedSpans(previous.normalizedText, snapshot.normalizedText);
  // Invariant 2: the model only ever sees changed spans, and only after a hash change.
  assertTriageAllowed(previous.contentHash, snapshot.contentHash, spans);
  const rawResult = await deps.triage.classify({
    sourceType: ctx.source.type,
    changedSpans: spans,
  });
  const triage = TriageResultSchema.parse(rawResult);
  const llmCostCents = estimateTriageCostCents(spans.reduce((sum, s) => sum + s.text.length, 0));

  const drafts = pinClaims(spans, ctx.source.url, fetchedAt);
  const gate = gatePublish(drafts, snapshot.normalizedText);
  const state = deltaStateFor(triage, gate.publishable);
  const workspaceId = ctx.workspace.id;

  const delta = await deps.store.insertDelta(workspaceId, {
    id: deps.nextId(),
    sourceId: ctx.source.id,
    fromSnapshotId: previous.id,
    toSnapshotId: snapshot.id,
    changedSpans: spans,
    triageClass: triage.triageClass,
    materiality: triage.materiality,
    rationale: triage.rationale,
    state,
    // Invariant 3: confirmation is a later pass (M2 fetch track); a fresh pricing delta has no
    // reproducing snapshot yet and stays pending until one arrives.
    confirmedBySnapshotId: null,
    createdAt: fetchedAt,
  });
  const claims = await Promise.all(
    drafts.map((draft) =>
      deps.store.insertClaim(workspaceId, {
        id: deps.nextId(),
        deltaId: delta.id,
        snapshotId: snapshot.id,
        ...draft,
        verifiedAt: gate.publishable ? fetchedAt : null,
      }),
    ),
  );
  await recordCoverage(ctx, deps, fetchedAt, {
    deltasFound: 1,
    materialDeltas: triage.materiality > 0 ? 1 : 0,
    llmCalls: 1,
    llmCostCents,
  });
  return { kind: 'delta', delta, claims };
};

/**
 * The M1 vertical slice: fetched content → normalize → hash gate → snapshot →
 * span diff → triage → delta + pinned claims, with coverage accounting on
 * every path (Invariant 7: silence must be visible).
 */
export const ingestFetch = async (
  ctx: IngestContext,
  rawContent: string,
  fetchedAt: Date,
  deps: IngestDeps,
  httpStatus = 200,
): Promise<IngestOutcome> => {
  if (ctx.source.legalStatus === 'blocked') {
    // Invariant 4: a blocked source degrades coverage visibly, it is never evaded.
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'skipped_blocked', reason: `source ${ctx.source.id} is legally blocked` };
  }
  let normalizedText: string;
  try {
    normalizedText = normalizeForSource(ctx.source.type, rawContent);
  } catch (error) {
    const message = error instanceof AdapterError ? error.message : `unexpected: ${String(error)}`;
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'fetch_failed', error: message };
  }
  const hash = contentHash(normalizedText);
  const workspaceId = ctx.workspace.id;
  const previous = await deps.store.latestSnapshot(workspaceId, ctx.source.id);
  if (previous !== null && previous.contentHash === hash) {
    // Unchanged: STOP before any model call (Invariant 2); still counted (Invariant 7).
    await recordCoverage(ctx, deps, fetchedAt, {});
    return { kind: 'unchanged' };
  }
  // Atomic write set (Invariant 1): the snapshot, its delta + pinned claims, and the coverage row
  // commit together or not at all, so a mid-write failure never leaves an orphan snapshot or a
  // delta with partial claims. recordCoverage/handleChangedContent write through the tx handle.
  return deps.store.withTransaction(async (tx) => {
    const txDeps: IngestDeps = { ...deps, store: tx };
    const snapshot = await tx.insertSnapshot(workspaceId, {
      id: deps.nextId(),
      sourceId: ctx.source.id,
      contentHash: hash,
      normalizedText,
      fetchedAt,
      httpStatus,
      vantage: null,
    });
    if (previous === null) {
      await recordCoverage(ctx, txDeps, fetchedAt, {});
      return { kind: 'baseline', snapshot };
    }
    return handleChangedContent(ctx, txDeps, previous, snapshot, fetchedAt);
  });
};

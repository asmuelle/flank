import {
  contentHash,
  type Delta,
  type Fetcher,
  type FetchResult,
  type Snapshot,
} from '@flank/core';
import { AdapterError, normalizeForSource } from './adapters/index';
import { recordCoverage, type IngestContext, type IngestDeps } from './ingest';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type ConfirmationOutcome =
  | { readonly kind: 'confirmed'; readonly delta: Delta; readonly snapshot: Snapshot }
  | { readonly kind: 'dismissed'; readonly delta: Delta; readonly snapshot: Snapshot }
  | { readonly kind: 'fetch_failed'; readonly error: string }
  | { readonly kind: 'not_applicable'; readonly reason: string };

/**
 * The pricing false-positive firewall (Invariant 3): a pending `pricing_change` delta never alerts
 * on a single fetch. This re-fetches the source from a clean context (a distinct vantage) and only
 * promotes the delta to `confirmed` if the change reproduces exactly against the snapshot that
 * introduced it; an A/B flap or revert is `dismissed` with both snapshots retained as evidence.
 * Every confirmation attempt is counted in coverage (Invariant 7).
 */
export const confirmPricingDelta = async (
  ctx: IngestContext,
  delta: Delta,
  fetcher: Fetcher,
  fetchedAt: Date,
  deps: IngestDeps,
  vantage = 'confirmation',
): Promise<ConfirmationOutcome> => {
  if (delta.triageClass !== 'pricing_change' || delta.state !== 'pending') {
    return { kind: 'not_applicable', reason: `delta ${delta.id} is not a pending pricing_change` };
  }
  const target = await deps.store.getSnapshot(ctx.workspace.id, delta.toSnapshotId);
  if (target === null) {
    return { kind: 'not_applicable', reason: `to_snapshot ${delta.toSnapshotId} is unavailable` };
  }

  let result: FetchResult;
  try {
    result = await fetcher.fetch({
      url: ctx.source.url,
      sourceType: ctx.source.type,
      adapter: ctx.source.adapter,
    });
  } catch (error) {
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'fetch_failed', error: messageOf(error) };
  }
  if (result.httpStatus >= 400) {
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'fetch_failed', error: `HTTP ${result.httpStatus} for ${ctx.source.url}` };
  }

  let normalizedText: string;
  try {
    normalizedText = normalizeForSource(ctx.source.type, result.rawContent);
  } catch (error) {
    const message = error instanceof AdapterError ? error.message : `unexpected: ${String(error)}`;
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'fetch_failed', error: message };
  }

  const reproduces = contentHash(normalizedText) === target.contentHash;

  // Append the confirmation snapshot and advance the delta atomically (Invariant 1).
  return deps.store.withTransaction(async (tx) => {
    const txDeps: IngestDeps = { ...deps, store: tx };
    const snapshot = await tx.insertSnapshot(ctx.workspace.id, {
      id: deps.nextId(),
      sourceId: ctx.source.id,
      contentHash: contentHash(normalizedText),
      normalizedText,
      fetchedAt,
      httpStatus: result.httpStatus,
      vantage,
    });
    const next = reproduces
      ? await tx.transitionDelta(ctx.workspace.id, delta.id, 'confirmed', snapshot.id)
      : await tx.transitionDelta(ctx.workspace.id, delta.id, 'dismissed');
    await recordCoverage(ctx, txDeps, fetchedAt, {});
    return reproduces
      ? { kind: 'confirmed', delta: next, snapshot }
      : { kind: 'dismissed', delta: next, snapshot };
  });
};

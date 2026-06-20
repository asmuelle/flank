import type { Fetcher, FetchResult } from '@flank/core';
import {
  ingestFetch,
  recordCoverage,
  type IngestContext,
  type IngestDeps,
  type IngestOutcome,
} from './ingest';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Fetch a source through the {@link Fetcher} port, then run the M1 ingest pipeline on the real
 * content and HTTP status. A blocked source is never fetched (Invariant 4); fetch errors and non-2xx
 * responses are recorded as first-class fetch failures (Invariant 7) and never reach the model.
 */
export const fetchAndIngest = async (
  ctx: IngestContext,
  fetcher: Fetcher,
  fetchedAt: Date,
  deps: IngestDeps,
): Promise<IngestOutcome> => {
  if (ctx.source.legalStatus === 'blocked') {
    await recordCoverage(ctx, deps, fetchedAt, { fetchFailures: 1 });
    return { kind: 'skipped_blocked', reason: `source ${ctx.source.id} is legally blocked` };
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

  return ingestFetch(ctx, result.rawContent, fetchedAt, deps, result.httpStatus);
};

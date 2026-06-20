import type { Fetcher } from '@flank/core';
import { CronExpressionParser } from 'cron-parser';
import { fetchAndIngest } from './fetch-ingest';
import type { IngestDeps } from './ingest';
import { confirmPricingDelta } from './pricing-confirmation';

/** A source is paused (skipped) once its consecutive-failure streak reaches this many. */
export const DEFAULT_PAUSE_AFTER = 5;

/**
 * Is a source due for a fetch? A never-fetched source is always due; otherwise it is due when the
 * most recent scheduled fire time (cadence evaluated in UTC) is newer than its last fetch. An
 * unparseable cadence is treated as never-due — a misconfigured source is fixed, not crawled.
 */
export const isSourceDue = (cadence: string, lastFetchedAt: Date | null, now: Date): boolean => {
  let previousFire: Date;
  try {
    previousFire = CronExpressionParser.parse(cadence, { currentDate: now, tz: 'UTC' })
      .prev()
      .toDate();
  } catch {
    return false;
  }
  return lastFetchedAt === null || lastFetchedAt.getTime() < previousFire.getTime();
};

export interface TickReport {
  readonly sourcesScheduled: number;
  readonly sourcesDue: number;
  readonly fetched: number;
  readonly fetchFailures: number;
  readonly skippedPaused: number;
  readonly pausedOverBudget: number;
  readonly confirmationsRun: number;
  readonly confirmed: number;
  readonly dismissed: number;
  /** Confirmed pricing deltas advanced to `published` this tick (the firewall's publish edge). */
  readonly published: number;
  readonly errors: number;
}

export interface SchedulerOptions {
  readonly pauseAfter?: number;
}

/**
 * One scheduler tick (what the Inngest cron invokes): fetch every due, un-paused source through the
 * ingest pipeline and update its health, then run the confirmation firewall over every pending
 * pricing delta. A failure on one source never aborts the tick — it is counted and the run
 * continues, so a single bad source can't starve the rest.
 */
export const runScheduledTick = async (
  deps: IngestDeps,
  fetcher: Fetcher,
  now: Date,
  options: SchedulerOptions = {},
): Promise<TickReport> => {
  const pauseAfter = options.pauseAfter ?? DEFAULT_PAUSE_AFTER;
  let sourcesDue = 0;
  let fetched = 0;
  let fetchFailures = 0;
  let skippedPaused = 0;
  let pausedOverBudget = 0;
  let errors = 0;

  const scheduled = await deps.store.listSourcesForScheduling();
  for (const entry of scheduled) {
    if (entry.consecutiveFailures >= pauseAfter) {
      skippedPaused += 1;
      continue;
    }
    if (!isSourceDue(entry.source.cadence, entry.lastFetchedAt, now)) continue;
    sourcesDue += 1;
    try {
      const outcome = await fetchAndIngest(
        { workspace: entry.workspace, source: entry.source },
        fetcher,
        now,
        deps,
      );
      if (outcome.kind === 'fetch_failed') {
        fetchFailures += 1;
        await deps.store.markSourceFailed(entry.source.id);
      } else if (outcome.kind === 'skipped_over_budget') {
        // Invariant 6: the workspace is over budget — neither a success nor a failure. Leave health
        // untouched so it retries next tick once the month rolls over or spend is reviewed.
        pausedOverBudget += 1;
      } else {
        // baseline / delta / unchanged / skipped_blocked are all a completed check.
        fetched += 1;
        await deps.store.markSourceFetched(entry.source.id, now);
      }
    } catch {
      errors += 1;
    }
  }

  let confirmationsRun = 0;
  let confirmed = 0;
  let dismissed = 0;
  const pending = await deps.store.listPendingPricingDeltasForScheduling();
  for (const entry of pending) {
    confirmationsRun += 1;
    try {
      const outcome = await confirmPricingDelta(
        { workspace: entry.workspace, source: entry.source },
        entry.delta,
        fetcher,
        now,
        deps,
      );
      if (outcome.kind === 'confirmed') confirmed += 1;
      else if (outcome.kind === 'dismissed') dismissed += 1;
    } catch {
      errors += 1;
    }
  }

  // Publish edge: a pricing delta that has passed the re-fetch firewall (confirmed) is advanced to
  // `published` so it becomes alertable. (Material non-pricing deltas already publish at ingest.)
  // This includes deltas confirmed earlier in THIS tick, so a clean confirmation alerts promptly.
  let published = 0;
  const confirmedPricing = await deps.store.listConfirmedPricingDeltasForScheduling();
  for (const entry of confirmedPricing) {
    try {
      await deps.store.transitionDelta(entry.workspace.id, entry.delta.id, 'published');
      published += 1;
    } catch {
      errors += 1;
    }
  }

  return Object.freeze({
    sourcesScheduled: scheduled.length,
    sourcesDue,
    fetched,
    fetchFailures,
    skippedPaused,
    pausedOverBudget,
    confirmationsRun,
    confirmed,
    dismissed,
    published,
    errors,
  });
};

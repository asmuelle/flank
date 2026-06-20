import type { FlankStore, TriageClient } from '@flank/core';
import { Inngest } from 'inngest';
import { randomUUID } from 'node:crypto';
import { HttpFetcher } from './http-fetcher';
import { runScheduledTick, type SchedulerOptions } from './scheduler';

export const inngest = new Inngest({ id: 'flank' });

/** Concrete runtime the app supplies to the cron: its real store and triage client. */
export interface SchedulerRuntime {
  readonly store: FlankStore;
  readonly triage: TriageClient;
}

export interface ScheduledTickConfig {
  /** Cron cadence for the scheduler tick itself (default every 15 minutes). */
  readonly cron?: string;
  readonly options?: SchedulerOptions;
}

/**
 * The standing fetch+confirm cron (DESIGN: Inngest co-deployed with the Next.js app). The app passes
 * a runtime builder (its DrizzleFlankStore + triage client); the function builds an HttpFetcher and
 * runs exactly one {@link runScheduledTick}. Inngest provides the schedule, retries and concurrency.
 */
export const createScheduledTickFunction = (
  buildRuntime: () => Promise<SchedulerRuntime>,
  config: ScheduledTickConfig = {},
) =>
  inngest.createFunction(
    { id: 'scheduled-source-tick' },
    { cron: config.cron ?? '*/15 * * * *' },
    async () => {
      const { store, triage } = await buildRuntime();
      const deps = { store, triage, nextId: () => randomUUID() };
      return runScheduledTick(deps, new HttpFetcher(), new Date(), config.options ?? {});
    },
  );

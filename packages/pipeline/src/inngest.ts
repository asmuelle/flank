import type { FlankStore, Notifier, SynthesisClient, TriageClient } from '@flank/core';
import { Inngest } from 'inngest';
import { randomUUID } from 'node:crypto';
import { runDeliverySweep, type DeliveryOptions } from './delivery';
import { HttpFetcher } from './http-fetcher';
import { runScheduledTick, type SchedulerOptions } from './scheduler';
import { runNightlySynthesis } from './synthesis';

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
    // inngest v4: the trigger moved into the options object as `triggers`.
    { id: 'scheduled-source-tick', triggers: [{ cron: config.cron ?? '*/15 * * * *' }] },
    async () => {
      const { store, triage } = await buildRuntime();
      const deps = { store, triage, nextId: () => randomUUID() };
      return runScheduledTick(deps, new HttpFetcher(), new Date(), config.options ?? {});
    },
  );

/** Concrete runtime the nightly synthesis cron needs: the real store + synthesis client. */
export interface SynthesisRuntime {
  readonly store: FlankStore;
  readonly client: SynthesisClient;
}

export interface NightlySynthesisConfig {
  /** Cron cadence (default 04:00 daily). */
  readonly cron?: string;
}

/**
 * The nightly synthesis cron (DESIGN flow 3): regenerate affected dossier/battlecard sections for
 * every competitor from confirmed material deltas. The app supplies the runtime (DrizzleFlankStore +
 * the keyed Sonnet client, or the mock when unkeyed).
 */
export const createNightlySynthesisFunction = (
  buildRuntime: () => Promise<SynthesisRuntime>,
  config: NightlySynthesisConfig = {},
) =>
  inngest.createFunction(
    { id: 'nightly-synthesis', triggers: [{ cron: config.cron ?? '0 4 * * *' }] },
    async () => {
      const { store, client } = await buildRuntime();
      return runNightlySynthesis({ store, client, nextId: () => randomUUID() }, new Date());
    },
  );

/** Concrete runtime the delivery sweep needs: the real store + a channel-dispatching notifier. */
export interface DeliveryRuntime {
  readonly store: FlankStore;
  readonly notifier: Notifier;
}

export interface DeliverySweepConfig {
  /** Cron cadence (default every 5 minutes). */
  readonly cron?: string;
  readonly options?: DeliveryOptions;
}

/**
 * The alert-delivery sweep (M3). `concurrency: { limit: 1 }` makes it a singleton so two ticks can
 * never double-claim — the testable concurrency guard, backed in depth by the UNIQUE(delta, channel)
 * constraint and the `delivered`-is-terminal trigger. Runs more often than the fetch tick (~3 retries
 * inside the 15-min detection window) and is cheap when there's nothing to send.
 */
export const createDeliverySweepFunction = (
  buildRuntime: () => Promise<DeliveryRuntime>,
  config: DeliverySweepConfig = {},
) =>
  inngest.createFunction(
    {
      id: 'delivery-sweep',
      concurrency: { limit: 1 },
      triggers: [{ cron: config.cron ?? '*/5 * * * *' }],
    },
    async () => {
      const { store, notifier } = await buildRuntime();
      return runDeliverySweep(
        { store, notifier, nextId: () => randomUUID() },
        new Date(),
        config.options ?? {},
      );
    },
  );

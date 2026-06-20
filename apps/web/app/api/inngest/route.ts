import { createDbFromEnv, DrizzleFlankStore } from '@flank/db';
import { createSynthesisClient, createTriageClient } from '@flank/pipeline';
import {
  createNightlySynthesisFunction,
  createScheduledTickFunction,
  inngest,
  type SchedulerRuntime,
  type SynthesisRuntime,
} from '@flank/pipeline/inngest';
import { serve } from 'inngest/next';

// Node runtime: the crons open a Postgres pool (postgres-js), resolve DNS, and may call the SDK.
export const runtime = 'nodejs';

// Lazily build one DB-backed store + clients, reused across invocations. Deferred so neither the DB
// connection nor DATABASE_URL validation runs at build time.
let cachedStore: DrizzleFlankStore | undefined;
const store = (): DrizzleFlankStore => {
  if (cachedStore === undefined) {
    const { db } = createDbFromEnv();
    cachedStore = new DrizzleFlankStore(db);
  }
  return cachedStore;
};

const buildSchedulerRuntime = async (): Promise<SchedulerRuntime> => ({
  store: store(),
  triage: createTriageClient(process.env).client,
});

const buildSynthesisRuntime = async (): Promise<SynthesisRuntime> => ({
  store: store(),
  client: createSynthesisClient(process.env).client,
});

const scheduledTick = createScheduledTickFunction(buildSchedulerRuntime);
const nightlySynthesis = createNightlySynthesisFunction(buildSynthesisRuntime);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [scheduledTick, nightlySynthesis],
});

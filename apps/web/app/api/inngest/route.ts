import { createDbFromEnv, DrizzleFlankStore } from '@flank/db';
import { createTriageClient } from '@flank/pipeline';
import {
  createScheduledTickFunction,
  inngest,
  type SchedulerRuntime,
} from '@flank/pipeline/inngest';
import { serve } from 'inngest/next';

// Node runtime: the scheduler tick opens a Postgres pool (postgres-js) and resolves DNS.
export const runtime = 'nodejs';

// Lazily build the scheduler runtime once and reuse it across invocations. Deferred so neither the
// DB connection nor DATABASE_URL validation runs at build time.
let cached: SchedulerRuntime | undefined;
const buildRuntime = async (): Promise<SchedulerRuntime> => {
  if (cached === undefined) {
    const { db } = createDbFromEnv();
    const { client } = createTriageClient(process.env);
    cached = { store: new DrizzleFlankStore(db), triage: client };
  }
  return cached;
};

const scheduledTick = createScheduledTickFunction(buildRuntime);

export const { GET, POST, PUT } = serve({ client: inngest, functions: [scheduledTick] });

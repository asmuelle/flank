import { createSynthesisClient, createTriageClient } from '@flank/pipeline';
import {
  createNightlySynthesisFunction,
  createScheduledTickFunction,
  inngest,
  type SchedulerRuntime,
  type SynthesisRuntime,
} from '@flank/pipeline/inngest';
import { serve } from 'inngest/next';
import { getStore as store } from '../../../lib/store';

// Node runtime: the crons open a Postgres pool (postgres-js), resolve DNS, and may call the SDK.
export const runtime = 'nodejs';

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

import { createNotifier, createSynthesisClient, createTriageClient } from '@flank/pipeline';
import {
  createDeliverySweepFunction,
  createNightlySynthesisFunction,
  createScheduledTickFunction,
  inngest,
  type DeliveryRuntime,
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

const buildDeliveryRuntime = async (): Promise<DeliveryRuntime> => ({
  store: store(),
  // Slack uses the per-workspace webhook (no global secret); email needs RESEND_API_KEY +
  // FLANK_ALERT_FROM. Absent email creds → the notifier records 'failed' rather than dialing out.
  notifier: createNotifier(process.env),
});

const scheduledTick = createScheduledTickFunction(buildSchedulerRuntime);
const nightlySynthesis = createNightlySynthesisFunction(buildSynthesisRuntime);
const deliverySweep = createDeliverySweepFunction(buildDeliveryRuntime);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [scheduledTick, nightlySynthesis, deliverySweep],
});

import {
  createNotifier,
  createOkfPublisher,
  createSynthesisClient,
  createTriageClient,
  parseOkfTargets,
} from '@flank/pipeline';
import {
  createDeliverySweepFunction,
  createNightlySynthesisFunction,
  createOkfDeliveryFunction,
  createScheduledTickFunction,
  inngest,
  type DeliveryRuntime,
  type OkfDeliveryRuntime,
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

const buildOkfDeliveryRuntime = async (): Promise<OkfDeliveryRuntime> => ({
  store: store(),
  // Real GitHub publisher when FLANK_OKF_GITHUB_TOKEN is set; targets come from FLANK_OKF_TARGETS
  // (JSON). With neither configured the sweep has no targets and no-ops.
  publisher: createOkfPublisher(process.env),
  targets: parseOkfTargets(process.env.FLANK_OKF_TARGETS),
  baseUrl: process.env.FLANK_APP_ORIGIN ?? 'https://app.flank.example',
});

const scheduledTick = createScheduledTickFunction(buildSchedulerRuntime);
const nightlySynthesis = createNightlySynthesisFunction(buildSynthesisRuntime);
const deliverySweep = createDeliverySweepFunction(buildDeliveryRuntime);
const okfDelivery = createOkfDeliveryFunction(buildOkfDeliveryRuntime);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [scheduledTick, nightlySynthesis, deliverySweep, okfDelivery],
});

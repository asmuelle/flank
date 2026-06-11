import { z } from 'zod';
import { AdapterError } from './errors';

/** Greenhouse public job-board JSON (legal, no scraping — Invariant 4). */
const GreenhouseJobSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  absolute_url: z.string().url(),
  location: z.object({ name: z.string() }).optional(),
});

const GreenhouseResponseSchema = z.object({
  jobs: z.array(GreenhouseJobSchema),
});

/**
 * Normalize a Greenhouse boards-api payload into canonical text: one line per
 * job, sorted by id so payload ordering churn never produces a false delta.
 * `updated_at` is deliberately excluded — timestamp drift is not a signal.
 */
export const normalizeGreenhouse = (json: string): string => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new AdapterError('job board payload is not valid JSON', { cause: error });
  }
  const parsed = GreenhouseResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError(`job board payload failed schema validation: ${parsed.error.message}`);
  }
  const lines = [...parsed.data.jobs]
    .sort((a, b) => a.id - b.id)
    .map((job) => `${job.id} | ${job.title} | ${job.location?.name ?? 'Unspecified'} | ${job.absolute_url}`);
  return lines.join('\n');
};

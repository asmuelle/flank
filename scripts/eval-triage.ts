/**
 * Opt-in triage eval (the ONLY live-LLM surface — never run by `just ci`). Requires
 * ANTHROPIC_API_KEY. Runs the real AnthropicTriageClient over sample changed-spans with
 * claude-haiku-4-5, prints each classification + reported usage + metered micros, and with
 * `--record` writes a replayable cassette to packages/pipeline/fixtures/cassettes/triage.json.
 *
 *   just eval-triage            # classify + print cost
 *   just eval-triage -- --record   # also (re)record the cassette
 *
 * The Sonnet row is intentionally not exercised until its model id + rates are verified.
 */
import Anthropic from '@anthropic-ai/sdk';
import { meterCost, type SourceType, type Span } from '@flank/core';
import {
  AnthropicTriageClient,
  type Cassette,
  type CassetteEntry,
  type MessageCreateParams,
  type MessageCreator,
  type MessageResponse,
} from '@flank/pipeline';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'claude-haiku-4-5' as const;

const SAMPLES: ReadonlyArray<{
  readonly label: string;
  readonly sourceType: SourceType;
  readonly text: string;
}> = [
  {
    label: 'pricing cut',
    sourceType: 'pricing',
    text: 'Growth plan is now $39 per month (was $59).',
  },
  {
    label: 'feature launch',
    sourceType: 'changelog',
    text: 'Introducing Battlecards AI — now generally available.',
  },
  { label: 'leadership hire', sourceType: 'jobs', text: 'New role: VP of Revenue Operations.' },
  { label: 'noise', sourceType: 'docs', text: 'Fixed a typo in the getting-started guide.' },
];

const span = (text: string): Span => ({ charStart: 0, charEnd: text.length, text });

const main = async (): Promise<void> => {
  if (process.env.FLANK_NO_LLM !== undefined) {
    console.error('FLANK_NO_LLM is set — refusing to make live calls.');
    process.exit(1);
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    console.error('ANTHROPIC_API_KEY is required for the triage eval.');
    process.exit(1);
    return;
  }
  const record = process.argv.includes('--record');
  const anthropic = new Anthropic({ apiKey });
  const entries: CassetteEntry[] = [];

  const createMessage: MessageCreator = async (
    params: MessageCreateParams,
  ): Promise<MessageResponse> => {
    const message = await anthropic.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const response = message as unknown as MessageResponse;
    if (record) {
      entries.push({
        request: { model: params.model, messages: params.messages },
        response,
        expectedMicros: 0, // filled in after metering below
      });
    }
    return response;
  };

  const client = new AnthropicTriageClient({ createMessage, model: MODEL });

  for (const sample of SAMPLES) {
    const result = await client.classify({
      sourceType: sample.sourceType,
      changedSpans: [span(sample.text)],
    });
    const micros = result.usage ? meterCost(result.usage) : 0;
    if (record && entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last !== undefined) entries[entries.length - 1] = { ...last, expectedMicros: micros };
    }
    console.log(
      `[${sample.label}] -> ${result.triageClass} (m${result.materiality}) | ${micros} micros | ${result.rationale}`,
    );
  }

  if (record) {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = join(here, '..', 'packages', 'pipeline', 'fixtures', 'cassettes', 'triage.json');
    const cassette: Cassette = { entries };
    await writeFile(out, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
    console.log(`recorded ${entries.length} cassette entries -> ${out}`);
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

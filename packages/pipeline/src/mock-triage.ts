import {
  classifyDeterministic,
  estimateTokens,
  type ModelId,
  type TokenUsage,
  type TriageClient,
  type TriageRequest,
  type TriageResult,
} from '@flank/core';
import { AnthropicTriageClient } from './anthropic-triage';
import type { MessageCreator, MessageResponse } from './cassette';

const DEFAULT_TRIAGE_MODEL: ModelId = 'claude-haiku-4-5';
/** A small, plausible output-token count so the mock meters a realistic (non-zero) cost. */
const MOCK_OUTPUT_TOKENS = 40;

/**
 * Deterministic mock triage client: the materiality rule engine behind the TriageClient protocol.
 * Counts calls so tests can assert Invariant 2, performs no network I/O ever, and reports SYNTHETIC
 * Haiku usage so the metered COGS on the mock path is a real meter (input + output), not an
 * input-only estimate masquerading as truth.
 */
export class MockTriageClient implements TriageClient {
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  async classify(request: TriageRequest): Promise<TriageResult> {
    this.#calls += 1;
    const base = classifyDeterministic(request);
    const inputChars = request.changedSpans.reduce((sum, span) => sum + span.text.length, 0);
    const usage: TokenUsage = {
      model: DEFAULT_TRIAGE_MODEL,
      inputTokens: estimateTokens(inputChars),
      outputTokens: MOCK_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return Object.freeze({ ...base, usage });
  }
}

/** The real-SDK transport, lazy-imported so @anthropic-ai/sdk stays out of the web bundle. A
 * runtime tripwire makes a live call IMPOSSIBLE under test/CI, even if the seam is mis-wired. */
const realSdkMessageCreator =
  (apiKey: string): MessageCreator =>
  async (params) => {
    if (process.env.VITEST !== undefined || process.env.FLANK_NO_LLM !== undefined) {
      throw new Error('refusing a live LLM call under VITEST/FLANK_NO_LLM (hermetic tripwire)');
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return message as unknown as MessageResponse;
  };

export interface MockTriageHandle {
  readonly client: MockTriageClient;
  readonly mode: string;
}

/** Hermetic factory: ALWAYS the deterministic mock (keeps `client.calls`). Used by the fixture run
 * regardless of env — the fixture brief never dials out even if ANTHROPIC_API_KEY is set. */
export const createMockTriageClient = (): MockTriageHandle =>
  Object.freeze({
    client: new MockTriageClient(),
    mode: 'deterministic mock (fixtures are hermetic)',
  });

export interface TriageHandle {
  readonly client: TriageClient;
  readonly mode: string;
}

/**
 * Production factory (the cron uses this): a live Anthropic Haiku client when ANTHROPIC_API_KEY is
 * present, otherwise the deterministic mock. No key is ever required to build, test, or run.
 */
export const createTriageClient = (
  env: Readonly<Record<string, string | undefined>>,
): TriageHandle => {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key === 'string' && key.length > 0) {
    return Object.freeze({
      client: new AnthropicTriageClient({
        createMessage: realSdkMessageCreator(key),
        model: DEFAULT_TRIAGE_MODEL,
      }),
      mode: 'live haiku via anthropic sdk',
    });
  }
  return Object.freeze({
    client: new MockTriageClient(),
    mode: 'deterministic mock (no ANTHROPIC_API_KEY)',
  });
};

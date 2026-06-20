import {
  estimateTokens,
  type ModelId,
  type SynthesisClient,
  type SynthesisRequest,
  type SynthesisResult,
  type TokenUsage,
} from '@flank/core';
import { AnthropicSynthesisClient } from './anthropic-synthesis';
import { realSdkMessageCreator } from './mock-triage';

const SYNTHESIS_MODEL: ModelId = 'claude-sonnet-4-6';

/**
 * Deterministic mock synthesis client: regenerates a section from its candidate claims, cites all of
 * them, and reports SYNTHETIC Sonnet usage so the metered cost on the mock path is real. No I/O.
 */
export class MockSynthesisClient implements SynthesisClient {
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.#calls += 1;
    const bullets = request.candidateClaims
      .map((claim) => `- ${claim.quoteText} (${claim.triageClass})`)
      .join('\n');
    const contentMd = `# ${request.kind}\n\n${bullets || '_no material change_'}`;
    const citedClaimIds = request.candidateClaims.map((claim) => claim.id);
    const inputChars =
      (request.previousContentMd ?? '').length +
      request.candidateClaims.reduce((sum, claim) => sum + claim.quoteText.length, 0);
    const usage: TokenUsage = {
      model: SYNTHESIS_MODEL,
      inputTokens: estimateTokens(inputChars),
      outputTokens: estimateTokens(contentMd.length),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return Object.freeze({ contentMd, citedClaimIds, usage });
  }
}

export interface MockSynthesisHandle {
  readonly client: MockSynthesisClient;
  readonly mode: string;
}

/** Hermetic factory: ALWAYS the deterministic mock (keeps `client.calls`). */
export const createMockSynthesisClient = (): MockSynthesisHandle =>
  Object.freeze({
    client: new MockSynthesisClient(),
    mode: 'deterministic mock (fixtures are hermetic)',
  });

export interface SynthesisHandle {
  readonly client: SynthesisClient;
  readonly mode: string;
}

/** Production factory: live Sonnet when ANTHROPIC_API_KEY is present, else the deterministic mock. */
export const createSynthesisClient = (
  env: Readonly<Record<string, string | undefined>>,
): SynthesisHandle => {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key === 'string' && key.length > 0) {
    return Object.freeze({
      client: new AnthropicSynthesisClient({
        createMessage: realSdkMessageCreator(key),
        model: SYNTHESIS_MODEL,
      }),
      mode: 'live sonnet via anthropic sdk',
    });
  }
  return Object.freeze({
    client: new MockSynthesisClient(),
    mode: 'deterministic mock (no ANTHROPIC_API_KEY)',
  });
};

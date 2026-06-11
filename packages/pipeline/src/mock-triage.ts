import {
  classifyDeterministic,
  type TriageClient,
  type TriageRequest,
  type TriageResult,
} from '@flank/core';

/**
 * Deterministic mock triage client: the materiality rule engine behind the
 * TriageClient protocol. Counts calls so tests can assert Invariant 2
 * (zero model calls on unchanged content). Performs no network I/O, ever.
 */
export class MockTriageClient implements TriageClient {
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  async classify(request: TriageRequest): Promise<TriageResult> {
    this.#calls += 1;
    return classifyDeterministic(request);
  }
}

export interface TriageClientHandle {
  readonly client: MockTriageClient;
  readonly mode: string;
}

/**
 * Factory for the triage client. M1 always returns the deterministic mock;
 * an ANTHROPIC_API_KEY in the environment is acknowledged but a live
 * Haiku-class client only lands with M2 synthesis. No key is ever required
 * to build, test, or run the product.
 */
export const createTriageClient = (
  env: Readonly<Record<string, string | undefined>>,
): TriageClientHandle => {
  const hasKey = typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0;
  return Object.freeze({
    client: new MockTriageClient(),
    mode: hasKey
      ? 'deterministic mock (ANTHROPIC_API_KEY detected — live Haiku triage lands in M2)'
      : 'deterministic mock (no ANTHROPIC_API_KEY)',
  });
};

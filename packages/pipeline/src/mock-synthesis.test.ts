import { meterCost } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { AnthropicSynthesisClient } from './anthropic-synthesis';
import {
  MockSynthesisClient,
  createMockSynthesisClient,
  createSynthesisClient,
} from './mock-synthesis';

const request = {
  surface: 'dossier' as const,
  kind: 'pricing',
  competitorName: 'Rival',
  previousContentMd: null,
  candidateClaims: [
    {
      id: 'c1',
      quoteText: '$39 per month',
      sourceUrl: 'https://x.example/p',
      triageClass: 'pricing_change' as const,
      rationale: 'cut',
    },
  ],
};

describe('MockSynthesisClient', () => {
  it('cites every candidate claim and reports real (non-zero) synthetic Sonnet usage', async () => {
    const client = new MockSynthesisClient();
    const result = await client.synthesize(request);

    expect(result.citedClaimIds).toEqual(['c1']);
    expect(result.contentMd).toContain('$39 per month');
    expect(result.usage?.model).toBe('claude-sonnet-4-6');
    expect(meterCost(result.usage!)).toBeGreaterThan(0);
    expect(client.calls).toBe(1);
  });
});

describe('synthesis factories', () => {
  it('createMockSynthesisClient is always the deterministic mock', () => {
    const { client, mode } = createMockSynthesisClient();
    expect(client).toBeInstanceOf(MockSynthesisClient);
    expect(mode).toContain('deterministic mock');
  });

  it('createSynthesisClient returns the mock without a key and the live client with one', () => {
    expect(createSynthesisClient({}).client).toBeInstanceOf(MockSynthesisClient);
    const { client, mode } = createSynthesisClient({ ANTHROPIC_API_KEY: 'fake' });
    expect(client).toBeInstanceOf(AnthropicSynthesisClient);
    expect(mode).toContain('live sonnet');
  });
});

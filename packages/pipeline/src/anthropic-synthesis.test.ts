import { meterCost } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { AnthropicSynthesisClient, AnthropicSynthesisError } from './anthropic-synthesis';
import type { MessageResponse } from './cassette';

const request = {
  surface: 'dossier' as const,
  kind: 'pricing',
  competitorName: 'Periscope',
  previousContentMd: '# pricing\nGrowth was $59/mo.',
  candidateClaims: [
    {
      id: 'c1',
      quoteText: '$39 per month',
      sourceUrl: 'https://x.example/pricing',
      triageClass: 'pricing_change' as const,
      rationale: 'price cut',
    },
  ],
};

const answer = (json: string, usage: MessageResponse['usage']): MessageResponse => ({
  content: [{ type: 'text', text: json }],
  usage,
});

const good = answer('{"contentMd":"# Pricing\\nNow $39/mo.","citedClaimIds":["c1"]}', {
  input_tokens: 800,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const client = (response: MessageResponse) =>
  new AnthropicSynthesisClient({ createMessage: async () => response, model: 'claude-sonnet-4-6' });

describe('AnthropicSynthesisClient', () => {
  it('parses the section answer and attaches validated usage priced under the requested model', async () => {
    const result = await client(good).synthesize(request);

    expect(result.contentMd).toContain('Pricing');
    expect(result.citedClaimIds).toEqual(['c1']);
    expect(result.usage?.model).toBe('claude-sonnet-4-6');
    // 800 in × 3 + 200 out × 15 = (2400 + 3000)M numerator → 5400 micros.
    expect(meterCost(result.usage!)).toBe(5400);
  });

  it('throws on a non-JSON answer', async () => {
    await expect(
      client(answer('not json', { input_tokens: 1, output_tokens: 1 })).synthesize(request),
    ).rejects.toBeInstanceOf(AnthropicSynthesisError);
  });

  it('rejects an answer with zero citations (fail closed)', async () => {
    await expect(
      client(
        answer('{"contentMd":"x","citedClaimIds":[]}', { input_tokens: 1, output_tokens: 1 }),
      ).synthesize(request),
    ).rejects.toThrow();
  });
});

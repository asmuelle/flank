import { meterCost } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { AnthropicTriageClient } from './anthropic-triage';
import { MockTriageClient, createMockTriageClient, createTriageClient } from './mock-triage';

const span = (text: string) => ({ charStart: 0, charEnd: text.length, text });

describe('MockTriageClient', () => {
  it('returns deterministic classifications and counts calls', async () => {
    const client = new MockTriageClient();
    const request = { sourceType: 'pricing', changedSpans: [span('$39 per month')] } as const;

    const first = await client.classify(request);
    const second = await client.classify(request);

    expect(first).toEqual(second);
    expect(first.triageClass).toBe('pricing_change');
    expect(client.calls).toBe(2);
  });

  it('reports synthetic Haiku usage so the metered cost is real (input + output), not zero', async () => {
    const client = new MockTriageClient();
    const result = await client.classify({
      sourceType: 'pricing',
      changedSpans: [span('$39 per month')],
    });

    expect(result.usage?.model).toBe('claude-haiku-4-5');
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(meterCost(result.usage!)).toBeGreaterThan(0);
  });
});

describe('createMockTriageClient (hermetic fixture factory)', () => {
  it('always returns the deterministic mock with a calls counter', () => {
    const { client, mode } = createMockTriageClient();
    expect(client).toBeInstanceOf(MockTriageClient);
    expect(client.calls).toBe(0);
    expect(mode).toContain('deterministic mock');
  });
});

describe('createTriageClient (production factory)', () => {
  it('returns the deterministic mock when no API key is present', () => {
    const { client, mode } = createTriageClient({});
    expect(client).toBeInstanceOf(MockTriageClient);
    expect(mode).toContain('no ANTHROPIC_API_KEY');
  });

  it('returns a live Anthropic client when a key is present, without embedding the key', () => {
    const { client, mode } = createTriageClient({ ANTHROPIC_API_KEY: 'fake-key-for-test' });
    expect(client).toBeInstanceOf(AnthropicTriageClient);
    expect(mode).toContain('live haiku');
    expect(mode).not.toContain('fake-key-for-test');
  });

  it('never constructs a live client on the no-key path (no live client type leaks)', () => {
    const { client } = createTriageClient({ ANTHROPIC_API_KEY: '' });
    expect(client).toBeInstanceOf(MockTriageClient);
  });
});

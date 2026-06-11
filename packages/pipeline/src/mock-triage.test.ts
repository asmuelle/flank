import { describe, expect, it } from 'vitest';
import { MockTriageClient, createTriageClient } from './mock-triage';

const span = (text: string) => ({ charStart: 0, charEnd: text.length, text });

describe('MockTriageClient', () => {
  it('returns deterministic classifications and counts calls', async () => {
    // Arrange
    const client = new MockTriageClient();
    const request = { sourceType: 'pricing', changedSpans: [span('$39 per month')] } as const;

    // Act
    const first = await client.classify(request);
    const second = await client.classify(request);

    // Assert
    expect(first).toEqual(second);
    expect(first.triageClass).toBe('pricing_change');
    expect(client.calls).toBe(2);
  });
});

describe('createTriageClient (LLM behind a protocol; env read, never required)', () => {
  it('returns the deterministic mock when no API key is present', () => {
    // Arrange & Act
    const { client, mode } = createTriageClient({});

    // Assert
    expect(client).toBeInstanceOf(MockTriageClient);
    expect(mode).toContain('no ANTHROPIC_API_KEY');
  });

  it('still returns the mock when a key is present (live client is M2) and never embeds the key', () => {
    // Arrange
    const env = { ANTHROPIC_API_KEY: 'fake-key-for-test' };

    // Act
    const { client, mode } = createTriageClient(env);

    // Assert
    expect(client).toBeInstanceOf(MockTriageClient);
    expect(mode).toContain('lands in M2');
    expect(mode).not.toContain('fake-key-for-test');
  });
});

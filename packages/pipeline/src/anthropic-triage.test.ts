import { meterCost } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { AnthropicTriageClient, AnthropicTriageError } from './anthropic-triage';
import {
  cassetteMessageCreator,
  type Cassette,
  type MessageCreateParams,
  type MessageCreator,
  type MessageResponse,
} from './cassette';

const request = {
  sourceType: 'pricing',
  changedSpans: [{ charStart: 0, charEnd: 13, text: '$39 per month' }],
} as const;

const answer = (json: string, usage: MessageResponse['usage']): MessageResponse => ({
  content: [{ type: 'text', text: json }],
  usage,
});

const goodResponse = answer(
  '{"triageClass":"pricing_change","materiality":3,"rationale":"Price changed."}',
  {
    input_tokens: 120,
    output_tokens: 40,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
);

const clientWith = (createMessage: MessageCreator) =>
  new AnthropicTriageClient({ createMessage, model: 'claude-haiku-4-5' });

describe('AnthropicTriageClient', () => {
  it('parses the answer and attaches validated usage priced under the requested model', async () => {
    const result = await clientWith(async () => goodResponse).classify(request);

    expect(result.triageClass).toBe('pricing_change');
    expect(result.materiality).toBe(3);
    expect(result.usage).toEqual({
      model: 'claude-haiku-4-5',
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 120 in × 1 + 40 out × 5 = (120 + 200)M numerator → 320 micros.
    expect(meterCost(result.usage!)).toBe(320);
  });

  it('tolerates ```json fences around the answer', async () => {
    const fenced = answer(
      '```json\n{"triageClass":"noise","materiality":0,"rationale":"none"}\n```',
      {
        input_tokens: 10,
        output_tokens: 5,
      },
    );
    const result = await clientWith(async () => fenced).classify(request);
    expect(result.triageClass).toBe('noise');
  });

  it('throws AnthropicTriageError on a non-JSON answer', async () => {
    await expect(
      clientWith(async () =>
        answer('not json at all', { input_tokens: 1, output_tokens: 1 }),
      ).classify(request),
    ).rejects.toBeInstanceOf(AnthropicTriageError);
  });

  it('throws AnthropicTriageError when there is no text block (refusal)', async () => {
    const empty: MessageResponse = { content: [], usage: { input_tokens: 1, output_tokens: 0 } };
    await expect(clientWith(async () => empty).classify(request)).rejects.toBeInstanceOf(
      AnthropicTriageError,
    );
  });

  it('rejects an out-of-range materiality via the answer schema', async () => {
    const bad = answer('{"triageClass":"noise","materiality":7,"rationale":"x"}', {
      input_tokens: 1,
      output_tokens: 1,
    });
    await expect(clientWith(async () => bad).classify(request)).rejects.toThrow();
  });

  it('rejects negative token usage via the cost-input schema', async () => {
    const bad = answer('{"triageClass":"noise","materiality":0,"rationale":"x"}', {
      input_tokens: -1,
      output_tokens: 1,
    });
    await expect(clientWith(async () => bad).classify(request)).rejects.toThrow();
  });

  it('round-trips through a recorded cassette: record the request, then replay it offline', async () => {
    let recorded: Pick<MessageCreateParams, 'model' | 'messages'> | undefined;
    const recording: MessageCreator = async (params) => {
      recorded = { model: params.model, messages: params.messages };
      return goodResponse;
    };
    const live = await clientWith(recording).classify(request);

    const cassette: Cassette = {
      entries: [
        { request: recorded!, response: goodResponse, expectedMicros: meterCost(live.usage!) },
      ],
    };
    const replayed = await clientWith(cassetteMessageCreator(cassette)).classify(request);

    expect(replayed).toEqual(live);
    expect(meterCost(replayed.usage!)).toBe(cassette.entries[0]!.expectedMicros);
  });
});

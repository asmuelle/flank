import { describe, expect, it } from 'vitest';
import {
  CassetteMissError,
  LiveCallBannedError,
  cassetteMessageCreator,
  liveBanMessageCreator,
  type Cassette,
  type MessageCreateParams,
  type MessageResponse,
} from './cassette';

const params: MessageCreateParams = {
  model: 'claude-haiku-4-5',
  max_tokens: 256,
  system: 'system prompt',
  messages: [{ role: 'user', content: 'changed: $39 per month' }],
};

const response: MessageResponse = {
  content: [
    { type: 'text', text: '{"triageClass":"pricing_change","materiality":3,"rationale":"x"}' },
  ],
  usage: { input_tokens: 100, output_tokens: 40 },
};

const cassette: Cassette = {
  entries: [
    { request: { model: params.model, messages: params.messages }, response, expectedMicros: 300 },
  ],
};

describe('cassetteMessageCreator', () => {
  it('replays a recorded response for a fingerprint-matching request', async () => {
    const creator = cassetteMessageCreator(cassette);
    const replayed = await creator(params);
    expect(replayed.usage.output_tokens).toBe(40);
  });

  it('throws CassetteMissError on an unrecorded request', async () => {
    const creator = cassetteMessageCreator(cassette);
    await expect(
      creator({ ...params, messages: [{ role: 'user', content: 'something else' }] }),
    ).rejects.toBeInstanceOf(CassetteMissError);
  });
});

describe('liveBanMessageCreator', () => {
  it('always throws — the hermetic default for tests', async () => {
    await expect(liveBanMessageCreator(params)).rejects.toBeInstanceOf(LiveCallBannedError);
  });
});

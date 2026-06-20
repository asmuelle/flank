import { contentHash } from '@flank/core';

/** The subset of Anthropic's messages.create params Flank sends. Mirrors the SDK shape. */
export interface MessageCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
}

/** The subset of the Anthropic message response Flank reads. */
export interface MessageResponse {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    // The SDK returns null (not undefined) when caching is unused; `?? 0` handles both.
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  };
}

/** The injectable transport seam (production binds the real SDK; tests inject a cassette/ban). */
export type MessageCreator = (params: MessageCreateParams) => Promise<MessageResponse>;

export class LiveCallBannedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCallBannedError';
  }
}

export class CassetteMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteMissError';
  }
}

/**
 * The default creator for unit tests: any call is a hermeticity breach. A test that forgets to
 * inject a cassette throws here instead of dialing out — the structural zero-live-call guarantee.
 */
export const liveBanMessageCreator: MessageCreator = async () => {
  throw new LiveCallBannedError(
    'refusing a live LLM call: tests/CI are hermetic — inject a cassette or mock creator',
  );
};

/** A recorded request/response pair plus the cost it should meter to (self-checking in tests). */
export interface CassetteEntry {
  readonly request: Pick<MessageCreateParams, 'model' | 'messages'>;
  readonly response: MessageResponse;
  readonly expectedMicros: number;
}

export interface Cassette {
  readonly entries: readonly CassetteEntry[];
}

/** Stable fingerprint over the priced inputs (model + messages); order- and key-stable. */
export const cassetteFingerprint = (
  model: string,
  messages: MessageCreateParams['messages'],
): string => contentHash(JSON.stringify({ model, messages }));

/**
 * Replay a cassette: returns the recorded response for a matching (model, messages) fingerprint and
 * throws {@link CassetteMissError} on any unrecorded request. No network, no filesystem — the
 * cassette object is passed in (loaded from a checked-in JSON fixture by the caller).
 */
export const cassetteMessageCreator = (cassette: Cassette): MessageCreator => {
  const byFingerprint = new Map(
    cassette.entries.map((entry) => [
      cassetteFingerprint(entry.request.model, entry.request.messages),
      entry.response,
    ]),
  );
  return async (params) => {
    const response = byFingerprint.get(cassetteFingerprint(params.model, params.messages));
    if (response === undefined) {
      throw new CassetteMissError(
        `no cassette entry for model ${params.model} (re-run the eval recorder)`,
      );
    }
    return response;
  };
};

import {
  TokenUsageSchema,
  TRIAGE_CLASSES,
  TriageResultSchema,
  type ModelId,
  type TriageClient,
  type TriageRequest,
  type TriageResult,
} from '@flank/core';
import type { MessageCreator, MessageResponse } from './cassette';

export class AnthropicTriageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnthropicTriageError';
  }
}

const SYSTEM_PROMPT = [
  'You are a competitive-intelligence triage classifier. You receive ONE delta: the changed region',
  "of a competitor's web source. Classify it into exactly one class and a materiality score.",
  `Allowed triageClass values: ${TRIAGE_CLASSES.join(', ')}.`,
  'materiality is an integer 0..3 (0 = noise, 3 = highly material to a sales/PMM team).',
  'Output STRICT JSON only — no prose, no markdown fences. Shape:',
  '{"triageClass": "<class>", "materiality": <0-3>, "rationale": "<one short sentence>"}',
].join('\n');

const DEFAULT_MAX_TOKENS = 256;

export interface AnthropicTriageOptions {
  /** Injected transport (production binds the real SDK; tests inject a cassette). */
  readonly createMessage: MessageCreator;
  readonly model: ModelId;
  readonly maxTokens?: number;
}

const extractText = (response: MessageResponse): string => {
  const block = response.content.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  if (block?.text === undefined || block.text.trim() === '') {
    throw new AnthropicTriageError('model returned no text block (refusal or empty response)');
  }
  return block.text;
};

const parseAnswerJson = (text: string): unknown => {
  // Tolerate ```json fences the model may add despite instructions.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new AnthropicTriageError(`model answer was not valid JSON: ${cleaned.slice(0, 120)}`, {
      cause: error,
    });
  }
};

/**
 * Live triage via the Anthropic Messages API, behind the injected {@link MessageCreator} seam (the
 * structural reason CI never dials out). The model's ANSWER is validated by TriageResultSchema; the
 * SDK's reported usage is validated separately by TokenUsageSchema and priced under the model we
 * REQUESTED (not the dated id the SDK echoes), so metering never fails on a versioned model string.
 */
export class AnthropicTriageClient implements TriageClient {
  private readonly createMessage: MessageCreator;
  private readonly model: ModelId;
  private readonly maxTokens: number;

  constructor(options: AnthropicTriageOptions) {
    this.createMessage = options.createMessage;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async classify(request: TriageRequest): Promise<TriageResult> {
    const userContent = [
      `Source type: ${request.sourceType}`,
      'Changed content:',
      request.changedSpans.map((span) => span.text).join('\n---\n'),
    ].join('\n');

    const response = await this.createMessage({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const answer = TriageResultSchema.parse(parseAnswerJson(extractText(response)));
    const usage = TokenUsageSchema.parse({
      model: this.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    });

    return Object.freeze({ ...answer, usage });
  }
}

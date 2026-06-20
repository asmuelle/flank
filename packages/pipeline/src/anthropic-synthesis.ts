import {
  SynthesisResultSchema,
  TokenUsageSchema,
  type ModelId,
  type SynthesisClient,
  type SynthesisRequest,
  type SynthesisResult,
} from '@flank/core';
import type { MessageCreator, MessageResponse } from './cassette';

export class AnthropicSynthesisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnthropicSynthesisError';
  }
}

const SYSTEM_PROMPT = [
  'You regenerate ONE competitor-intelligence section (a dossier or battlecard section) for a sales',
  'team. You are given the prior section content and a set of NEW material claims (each with an id,',
  'a verbatim quote, its source URL, and why it matters). Rewrite the section in concise markdown,',
  'incorporating the new claims, and report which claim ids you actually cite.',
  'You MUST only cite claim ids from the provided candidates — never invent ids. Every factual',
  'statement must be backed by a cited claim.',
  'Output STRICT JSON only — no prose, no markdown fences. Shape:',
  '{"contentMd": "<section markdown>", "citedClaimIds": ["<id>", ...]}',
].join('\n');

const DEFAULT_MAX_TOKENS = 1500;

export interface AnthropicSynthesisOptions {
  readonly createMessage: MessageCreator;
  readonly model: ModelId;
  readonly maxTokens?: number;
}

const extractText = (response: MessageResponse): string => {
  const block = response.content.find(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
  if (block?.text === undefined || block.text.trim() === '') {
    throw new AnthropicSynthesisError('model returned no text block (refusal or empty response)');
  }
  return block.text;
};

const parseAnswerJson = (text: string): unknown => {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new AnthropicSynthesisError(`model answer was not valid JSON: ${cleaned.slice(0, 120)}`, {
      cause: error,
    });
  }
};

const renderRequest = (request: SynthesisRequest): string =>
  [
    `Surface: ${request.surface}`,
    `Section: ${request.kind}`,
    `Competitor: ${request.competitorName}`,
    'Prior section content:',
    request.previousContentMd ?? '(none — this is the first version)',
    'Candidate claims (cite by id):',
    ...request.candidateClaims.map(
      (claim) =>
        `- id=${claim.id} [${claim.triageClass}] "${claim.quoteText}" (${claim.sourceUrl}) — ${claim.rationale}`,
    ),
  ].join('\n');

/**
 * Live section synthesis via the Anthropic Messages API, behind the injected {@link MessageCreator}
 * seam (the structural reason CI never dials out). Mirrors AnthropicTriageClient: the ANSWER is
 * validated by SynthesisResultSchema; the SDK usage by TokenUsageSchema, priced under the REQUESTED
 * model id. Batch is a metering flag applied by the caller, not a separate SDK endpoint.
 */
export class AnthropicSynthesisClient implements SynthesisClient {
  private readonly createMessage: MessageCreator;
  private readonly model: ModelId;
  private readonly maxTokens: number;

  constructor(options: AnthropicSynthesisOptions) {
    this.createMessage = options.createMessage;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const response = await this.createMessage({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: renderRequest(request) }],
    });

    const answer = SynthesisResultSchema.parse(parseAnswerJson(extractText(response)));
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

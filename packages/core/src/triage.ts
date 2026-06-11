import { z } from 'zod';
import { TRIAGE_CLASSES, type SourceType, type Span, type TriageClass } from './entities';

export interface TriageRequest {
  readonly sourceType: SourceType;
  readonly changedSpans: readonly Span[];
}

export interface TriageResult {
  readonly triageClass: TriageClass;
  readonly materiality: number;
  readonly rationale: string;
}

/** Anything classifying deltas (mock today, Haiku in M2) implements this. */
export interface TriageClient {
  classify(request: TriageRequest): Promise<TriageResult>;
}

/** Boundary validation for model output — never trust an LLM response (AGENTS.md). */
export const TriageResultSchema = z.object({
  triageClass: z.enum(TRIAGE_CLASSES),
  materiality: z.number().int().min(0).max(3),
  rationale: z.string().min(1),
});

export class TriageGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageGateError';
  }
}

/**
 * Invariant 2 enforcement: a model call on source content is only permitted
 * when the content hash changed and there are changed spans to look at.
 */
export const assertTriageAllowed = (
  previousHash: string | null,
  nextHash: string,
  changedSpans: readonly Span[],
): void => {
  if (previousHash !== null && previousHash === nextHash) {
    throw new TriageGateError(
      'refusing to call a model on unchanged content (Invariant 2: deterministic diff before any LLM)',
    );
  }
  if (changedSpans.length === 0) {
    throw new TriageGateError('refusing to call a model without changed spans (Invariant 2)');
  }
};

const PRICE_RE = /[$€£]\s?\d/;
const PRICING_CONTEXT_RE = /(per month|\/\s?mo\b|monthly|annual|pricing|plan\b|tier\b|seat\b)/i;
const LEADERSHIP_RE = /\b(vp|vice president|chief|c[etopr]o|head of|director)\b/i;
const LAUNCH_RE = /\b(introducing|launch(?:ed|ing)?|now available|announcing|general availability)\b/i;
const REPOSITION_RE = /\b(rebrand(?:ing)?|repositioning|the platform for)\b/i;

const result = (triageClass: TriageClass, materiality: number, rationale: string): TriageResult =>
  Object.freeze({ triageClass, materiality, rationale });

/**
 * Deterministic materiality rule engine. Doubles as the mock triage brain:
 * same changed spans always produce the same classification.
 */
export const classifyDeterministic = (request: TriageRequest): TriageResult => {
  const text = request.changedSpans.map((span) => span.text).join('\n');
  const pricingContext = request.sourceType === 'pricing' || PRICING_CONTEXT_RE.test(text);
  if (PRICE_RE.test(text) && pricingContext) {
    return result('pricing_change', 3, 'A currency amount changed in a pricing context.');
  }
  if (request.sourceType === 'jobs' && LEADERSHIP_RE.test(text)) {
    return result('leadership_hire', 2, 'A senior leadership role appeared on the job board.');
  }
  if (request.sourceType === 'jobs') {
    return result('hiring_signal', 1, 'Job-board postings changed — hiring trajectory signal.');
  }
  if (LAUNCH_RE.test(text)) {
    return result('feature_launch', 2, 'Launch language detected in changed content.');
  }
  if (REPOSITION_RE.test(text)) {
    return result('repositioning', 2, 'Positioning language shifted in changed content.');
  }
  return result('noise', 0, 'No material pattern matched the changed spans.');
};

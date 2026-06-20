import type { PlanTier } from './entities';

/**
 * COGS meter (Invariant 6): cost is metered per account in exact integer MICRO-DOLLARS (USD × 1e6),
 * never float cents — so a month of per-call costs sums by plain integer addition with zero drift,
 * and the ≤ $15 Growth-tier comparison is exact and order-independent.
 *
 * Rates are config (Anthropic pricing, 2026-06). Haiku 4.5 ($1 in / $5 out per Mtok) is HIGH
 * confidence and the default triage model. The Sonnet row is MEDIUM confidence — the
 * `claude-sonnet-4-6` id string and absolute rates must be re-verified against docs.anthropic.com
 * before any Sonnet routing or the eval script's Sonnet row is trusted.
 */
export const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MTOK = 1_000_000;
const HALF = TOKENS_PER_MTOK / 2; // round-half-up offset for the single integer divide

export const MODEL_IDS = ['claude-haiku-4-5', 'claude-sonnet-4-6'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

interface ModelRate {
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cacheReadMicrosPerMtok: number; // = input × 0.10 (90% read discount, 5m TTL)
  readonly cacheWriteMicrosPerMtok: number; // = input × 1.25 (5m TTL write)
}

export const MODEL_PRICING: Readonly<Record<ModelId, ModelRate>> = Object.freeze({
  'claude-haiku-4-5': Object.freeze({
    inputMicrosPerMtok: 1_000_000,
    outputMicrosPerMtok: 5_000_000,
    cacheReadMicrosPerMtok: 100_000,
    cacheWriteMicrosPerMtok: 1_250_000,
  }),
  'claude-sonnet-4-6': Object.freeze({
    inputMicrosPerMtok: 3_000_000,
    outputMicrosPerMtok: 15_000_000,
    cacheReadMicrosPerMtok: 300_000,
    cacheWriteMicrosPerMtok: 3_750_000,
  }),
});

/** Token counts for one model call. `model` is the model we *requested* (priceable), not the
 * dated id the SDK echoes back — so pricing never fails on `claude-haiku-4-5-20260101`-style ids. */
export interface TokenUsage {
  readonly model: ModelId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export class CogsModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CogsModelError';
  }
}

const CHARS_PER_TOKEN = 4;

export const estimateTokens = (chars: number): number =>
  Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

/** Round-half-up integer divide of a non-negative numerator by the Mtok denominator — no float. */
const roundToMicros = (numerator: number): number =>
  Math.floor((numerator + HALF) / TOKENS_PER_MTOK);

/**
 * Exact integer micro-USD for one model call. All four token legs are summed in micros×Mtok
 * numerator space, batch-halved (floor) in that same space, then converted with exactly ONE
 * round-half-up — never per-leg, never a float divide. Unknown model fails closed (never metered
 * as free). Note: per-CALL totals are rounded once here; the *monthly* total is the integer sum of
 * these per-call results (associative, drift-free) — not a single global round.
 */
export const meterCost = (
  usage: TokenUsage,
  options: { readonly batch?: boolean } = {},
): number => {
  const rate = MODEL_PRICING[usage.model];
  if (rate === undefined) {
    throw new CogsModelError(`no pricing for model '${usage.model}' (Invariant 6: fail closed)`);
  }
  const legSum =
    usage.inputTokens * rate.inputMicrosPerMtok +
    usage.outputTokens * rate.outputMicrosPerMtok +
    usage.cacheReadTokens * rate.cacheReadMicrosPerMtok +
    usage.cacheWriteTokens * rate.cacheWriteMicrosPerMtok;
  // Fail closed: exact integer math only holds below 2^53; a usage magnitude that overflows it must
  // never silently lose precision and under-meter the budget.
  if (!Number.isSafeInteger(legSum)) {
    throw new CogsModelError(
      'usage magnitude exceeds safe-integer range (Invariant 6: fail closed)',
    );
  }
  const discounted = options.batch === true ? Math.floor(legSum / 2) : legSum;
  return roundToMicros(discounted);
};

/** A generous output allowance for the pre-call budget projection (actual accounting uses real usage). */
const PROJECTED_OUTPUT_TOKENS = 256;
/** Fixed allowance for the system prompt + request wrapper the changed spans don't account for, so the
 * projection stays conservative on the input axis by construction, not just via output headroom. */
const PROMPT_OVERHEAD_TOKENS = 200;

/** Conservative pre-call projection in micros for the budget gate: Haiku input (spans + prompt
 * overhead) + headroom output. */
export const estimateTriageCostMicros = (inputChars: number): number =>
  meterCost({
    model: 'claude-haiku-4-5',
    inputTokens: estimateTokens(inputChars) + PROMPT_OVERHEAD_TOKENS,
    outputTokens: PROJECTED_OUTPUT_TOKENS,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

/** Conservative per-section input/output allowances for the synthesis pre-spend projection. */
const SYNTHESIS_INPUT_TOKENS_PER_SECTION = 2_500;
const SYNTHESIS_OUTPUT_TOKENS_PER_SECTION = 1_200;

/**
 * Conservative pre-spend projection in micros for regenerating `sectionCount` sections via Sonnet.
 * Used by the synthesis budget gate to project the WHOLE affected set before any spend. Priced at the
 * SYNCHRONOUS rate (no batch discount) because synthesis currently uses the synchronous Messages API
 * — metering and billing must match. Note: the Sonnet rate is MEDIUM confidence (see MODEL_PRICING).
 */
export const estimateSynthesisCostMicros = (sectionCount: number): number =>
  sectionCount <= 0
    ? 0
    : meterCost({
        model: 'claude-sonnet-4-6',
        inputTokens: SYNTHESIS_INPUT_TOKENS_PER_SECTION * sectionCount,
        outputTokens: SYNTHESIS_OUTPUT_TOKENS_PER_SECTION * sectionCount,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });

/**
 * Per-tier monthly COGS cap in micro-USD (Invariant 6). Growth ($15) is the verified gate; starter
 * and team are generous soft-cap estimates — tune against measured COGS once synthesis spend lands.
 */
export const TIER_BUDGET_MICROS: Readonly<Record<PlanTier, number>> = Object.freeze({
  starter: 10_000_000, // $10 (estimate)
  growth: 15_000_000, // $15 (verified gate)
  team: 50_000_000, // $50 (estimate)
});

export const tierBudgetMicros = (tier: PlanTier): number => TIER_BUDGET_MICROS[tier];

export interface BudgetEvaluation {
  readonly allow: boolean;
  readonly capMicros: number;
  readonly spentMicros: number;
  readonly projectedMicros: number;
  readonly overageMicros: number;
}

/**
 * Soft-cap decision (pure, integer): may a workspace that has spent `spentMicros` this month afford
 * a call projected at `projectedMicros`? Fail-closed — if the projected total would exceed the cap,
 * the call is denied (stop-next-call). A soft cap, not a hard one: a single in-flight call may meter
 * slightly above the cap, but the next call is blocked.
 */
export const evaluateBudget = (
  tier: PlanTier,
  spentMicros: number,
  projectedMicros: number,
): BudgetEvaluation => {
  const capMicros = TIER_BUDGET_MICROS[tier];
  const projectedTotal = spentMicros + projectedMicros;
  return Object.freeze({
    allow: projectedTotal <= capMicros,
    capMicros,
    spentMicros,
    projectedMicros,
    overageMicros: Math.max(0, projectedTotal - capMicros),
  });
};

/** Lossless display of integer micros as a cents string (1¢ = 10_000 micros). */
export const formatMicrosAsCents = (micros: number): string => `${(micros / 10_000).toFixed(4)}¢`;

/** Display of integer micros as a USD string. */
export const formatMicrosAsUsd = (micros: number): string =>
  `$${(micros / MICROS_PER_USD).toFixed(6)}`;

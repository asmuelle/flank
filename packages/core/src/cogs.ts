/**
 * COGS meter (Invariant 6): cost is metered per account from M1, not estimated
 * after the fact. Rates are documented ballpark constants for a Haiku-class
 * triage model; live metering replaces estimates when real calls land (M2).
 */
export const HAIKU_INPUT_USD_PER_MTOK = 1.0;
const CHARS_PER_TOKEN = 4;

export const estimateTokens = (chars: number): number =>
  Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

/** Estimated triage cost in cents for a given prompt size (fractional cents preserved). */
export const estimateTriageCostCents = (inputChars: number): number =>
  (estimateTokens(inputChars) / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK * 100;

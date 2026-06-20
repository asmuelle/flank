import { describe, expect, it } from 'vitest';
import {
  CogsModelError,
  estimateSynthesisCostMicros,
  estimateTokens,
  estimateTriageCostMicros,
  evaluateBudget,
  formatMicrosAsCents,
  formatMicrosAsUsd,
  meterCost,
  tierBudgetMicros,
  type TokenUsage,
} from './cogs';

const haiku = (over: Partial<TokenUsage>): TokenUsage => ({
  model: 'claude-haiku-4-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe('estimateTokens', () => {
  it('estimates ~4 chars/token, rounding up, never negative', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(-10)).toBe(0);
  });
});

describe('meterCost (exact integer micro-USD)', () => {
  it('prices 1M Haiku input tokens at exactly $1.00 = 1_000_000 micros', () => {
    expect(meterCost(haiku({ inputTokens: 1_000_000 }))).toBe(1_000_000);
  });

  it('prices output at 5× input and sums legs with a single round', () => {
    // 100 in × 1 + 40 out × 5 = (100 + 200)M numerator → 300 micros.
    expect(meterCost(haiku({ inputTokens: 100, outputTokens: 40 }))).toBe(300);
  });

  it('prices cache reads at 0.1× and cache writes at 1.25× input', () => {
    expect(meterCost(haiku({ cacheReadTokens: 1_000_000 }))).toBe(100_000);
    expect(meterCost(haiku({ cacheWriteTokens: 1_000_000 }))).toBe(1_250_000);
  });

  it('halves the per-call total for the Batch API', () => {
    expect(meterCost(haiku({ inputTokens: 1_000_000 }), { batch: true })).toBe(500_000);
  });

  it('prices Sonnet at 3×/15× the Haiku in/out rates', () => {
    const usage: TokenUsage = {
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(meterCost(usage)).toBe(3_000_000);
  });

  it('fails closed on an unpriced model', () => {
    const bad = { ...haiku({ inputTokens: 1 }), model: 'gpt-9' as unknown as TokenUsage['model'] };
    expect(() => meterCost(bad)).toThrow(CogsModelError);
  });

  it('fails closed when a usage magnitude would overflow safe-integer math', () => {
    expect(() => meterCost(haiku({ outputTokens: 2_000_000_000 }))).toThrow(CogsModelError);
  });

  it('returns exact integers per call so monthly totals sum without drift', () => {
    // Each call rounds once to an exact integer micro; the month is plain integer addition.
    const calls = [
      meterCost(haiku({ inputTokens: 137, outputTokens: 33 })),
      meterCost(haiku({ inputTokens: 88, outputTokens: 51 })),
      meterCost(haiku({ inputTokens: 4011, outputTokens: 220 })),
    ];
    expect(calls).toEqual([302, 343, 5111]);
    expect(calls.every(Number.isInteger)).toBe(true);
    const forward = calls.reduce((a, b) => a + b, 0);
    const reverse = [...calls].reverse().reduce((a, b) => a + b, 0);
    expect(forward).toBe(5756);
    expect(reverse).toBe(5756);
  });
});

describe('estimateTriageCostMicros (pre-call budget projection)', () => {
  it('projects conservatively (input + output headroom) and stays a small positive integer', () => {
    const micros = estimateTriageCostMicros(500);
    expect(Number.isInteger(micros)).toBe(true);
    expect(micros).toBeGreaterThan(0);
    expect(micros).toBeLessThan(10_000); // « 1 cent
  });
});

describe('estimateSynthesisCostMicros (Sonnet Batch projection)', () => {
  it('is zero for no sections and grows with the section count', () => {
    expect(estimateSynthesisCostMicros(0)).toBe(0);
    const one = estimateSynthesisCostMicros(1);
    const three = estimateSynthesisCostMicros(3);
    expect(one).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(one);
    expect(Number.isInteger(three)).toBe(true);
  });
});

describe('evaluateBudget (soft cap, fail-closed)', () => {
  it('allows a call whose projected total lands exactly on the Growth cap', () => {
    const result = evaluateBudget('growth', tierBudgetMicros('growth') - 300, 300);
    expect(result.allow).toBe(true);
    expect(result.overageMicros).toBe(0);
  });

  it('denies a call whose projected total exceeds the cap, reporting the overage', () => {
    const result = evaluateBudget('growth', tierBudgetMicros('growth') - 200, 300);
    expect(result.allow).toBe(false);
    expect(result.overageMicros).toBe(100);
  });
});

describe('formatMicros formatters', () => {
  it('renders integer micros losslessly as cents', () => {
    expect(formatMicrosAsCents(10_000)).toBe('1.0000¢');
    expect(formatMicrosAsCents(300)).toBe('0.0300¢');
  });

  it('renders integer micros as USD', () => {
    expect(formatMicrosAsUsd(1_000_000)).toBe('$1.000000');
    expect(formatMicrosAsUsd(15_000_000)).toBe('$15.000000');
  });
});

import { describe, expect, it } from 'vitest';
import { estimateTokens, estimateTriageCostCents } from './cogs';

describe('COGS meter (Invariant 6)', () => {
  it('estimates tokens at ~4 chars per token, rounding up', () => {
    // Arrange & Act & Assert
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(-10)).toBe(0);
  });

  it('prices a million input tokens at the documented Haiku-class rate', () => {
    // Arrange
    const chars = 4_000_000; // ≈ 1M tokens

    // Act
    const cents = estimateTriageCostCents(chars);

    // Assert
    expect(cents).toBeCloseTo(100, 5);
  });

  it('keeps fixture-sized prompts well under a cent', () => {
    // Arrange & Act & Assert
    expect(estimateTriageCostCents(500)).toBeLessThan(1);
    expect(estimateTriageCostCents(500)).toBeGreaterThan(0);
  });
});

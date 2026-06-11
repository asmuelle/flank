import { describe, expect, it } from 'vitest';
import { contentHash } from './hash';

describe('contentHash', () => {
  it('returns the same hash for identical normalized text', () => {
    // Arrange
    const text = 'Analyst\n$59 per month';

    // Act
    const first = contentHash(text);
    const second = contentHash(text);

    // Assert
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different hash when a single character changes', () => {
    // Arrange
    const before = 'Analyst\n$59 per month';
    const after = 'Analyst\n$39 per month';

    // Act & Assert
    expect(contentHash(before)).not.toBe(contentHash(after));
  });

  it('is stable for unicode content', () => {
    // Arrange
    const text = 'Zürich café — naïve résumé 💼';

    // Act & Assert
    expect(contentHash(text)).toBe(contentHash(text));
    expect(contentHash(text)).not.toBe(contentHash(text.normalize('NFD')));
  });
});

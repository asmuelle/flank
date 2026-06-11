import { describe, expect, it } from 'vitest';
import { diffChangedSpans } from './diff';

describe('diffChangedSpans', () => {
  it('returns no spans for identical text', () => {
    // Arrange
    const text = 'line one\nline two\nline three';

    // Act
    const spans = diffChangedSpans(text, text);

    // Assert
    expect(spans).toEqual([]);
  });

  it('pins an added line with correct character offsets', () => {
    // Arrange
    const before = 'alpha\nbeta';
    const after = 'alpha\ninserted line\nbeta';

    // Act
    const spans = diffChangedSpans(before, after);

    // Assert
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('inserted line');
    expect(after.slice(spans[0].charStart, spans[0].charEnd)).toBe('inserted line');
  });

  it('pins a changed line as one span whose offsets slice back to its text', () => {
    // Arrange
    const before = 'Scout\n$29 per month\nAnalyst\n$59 per month\nCommand';
    const after = 'Scout\n$29 per month\nAnalyst\n$39 per month\nCommand';

    // Act
    const spans = diffChangedSpans(before, after);

    // Assert
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('$39 per month');
    expect(after.slice(spans[0].charStart, spans[0].charEnd)).toBe(spans[0].text);
  });

  it('merges adjacent changed lines into one span and keeps separate regions apart', () => {
    // Arrange
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB1\nB2\nc\nd\nE1';

    // Act
    const spans = diffChangedSpans(before, after);

    // Assert
    expect(spans.map((s) => s.text)).toEqual(['B1\nB2', 'E1']);
    for (const span of spans) {
      expect(after.slice(span.charStart, span.charEnd)).toBe(span.text);
    }
  });

  it('ignores blank-only changes', () => {
    // Arrange
    const before = 'alpha\nbeta';
    const after = 'alpha\n\nbeta';

    // Act
    const spans = diffChangedSpans(before, after);

    // Assert
    expect(spans).toEqual([]);
  });

  it('is deterministic: same input pair yields the same spans every run', () => {
    // Arrange
    const before = 'one\ntwo\nthree\nfour';
    const after = 'one\n2\nthree\n4\nfive';

    // Act
    const first = diffChangedSpans(before, after);
    const second = diffChangedSpans(before, after);

    // Assert
    expect(first).toEqual(second);
  });

  it('handles unicode content with correct offsets', () => {
    // Arrange
    const before = 'Zürich office\nBerlin office';
    const after = 'Zürich office\nMünchen office — naïve test 💼\nBerlin office';

    // Act
    const spans = diffChangedSpans(before, after);

    // Assert
    expect(spans).toHaveLength(1);
    expect(after.slice(spans[0].charStart, spans[0].charEnd)).toBe(spans[0].text);
  });
});

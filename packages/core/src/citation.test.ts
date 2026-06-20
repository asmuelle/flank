import { describe, expect, it } from 'vitest';
import {
  gatePublish,
  gateSectionPublish,
  pinClaims,
  verifyClaim,
  type SectionClaim,
} from './citation';
import { diffChangedSpans } from './diff';

const SNAPSHOT = 'Scout\n$29 per month\nAnalyst\n$39 per month\nCommand';

describe('pinClaims', () => {
  it('pins every changed span with quote, offsets, URL, and timestamp', () => {
    // Arrange
    const spans = diffChangedSpans('Analyst\n$59 per month', 'Analyst\n$39 per month');
    const capturedAt = new Date('2026-06-08T06:30:00Z');

    // Act
    const claims = pinClaims(spans, 'https://periscope.example/pricing', capturedAt);

    // Assert
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      quoteText: '$39 per month',
      sourceUrl: 'https://periscope.example/pricing',
      capturedAt,
    });
  });
});

describe('verifyClaim (adversarial fixtures per AGENTS.md)', () => {
  it('verifies an exact quote at the recorded offsets', () => {
    // Arrange
    const claim = { quoteText: '$39 per month', charStart: 28, charEnd: 41 };

    // Act & Assert
    expect(SNAPSHOT.slice(28, 41)).toBe('$39 per month');
    expect(verifyClaim(claim, SNAPSHOT)).toEqual({ ok: true });
  });

  it('rejects a truncated quote', () => {
    // Arrange
    const claim = { quoteText: '$39 per mon', charStart: 28, charEnd: 41 };

    // Act
    const check = verifyClaim(claim, SNAPSHOT);

    // Assert
    expect(check.ok).toBe(false);
  });

  it('rejects a moved span (right quote, wrong offsets)', () => {
    // Arrange
    const claim = { quoteText: '$39 per month', charStart: 6, charEnd: 19 };

    // Act
    const check = verifyClaim(claim, SNAPSHOT);

    // Assert
    expect(check.ok).toBe(false);
  });

  it('rejects offsets out of snapshot bounds', () => {
    // Arrange
    const claim = { quoteText: 'x', charStart: 0, charEnd: SNAPSHOT.length + 5 };

    // Act & Assert
    expect(verifyClaim(claim, SNAPSHOT).ok).toBe(false);
    expect(verifyClaim({ quoteText: 'x', charStart: -1, charEnd: 2 }, SNAPSHOT).ok).toBe(false);
  });

  it('rejects empty and inverted ranges', () => {
    // Arrange & Act & Assert
    expect(verifyClaim({ quoteText: '', charStart: 5, charEnd: 5 }, SNAPSHOT).ok).toBe(false);
    expect(verifyClaim({ quoteText: 'a', charStart: 9, charEnd: 3 }, SNAPSHOT).ok).toBe(false);
  });

  it('verifies unicode quotes only at exact offsets', () => {
    // Arrange
    const snapshot = 'Zürich — café ✓\nnext line';
    const quote = 'Zürich — café ✓';

    // Act & Assert
    expect(
      verifyClaim({ quoteText: quote, charStart: 0, charEnd: quote.length }, snapshot),
    ).toEqual({ ok: true });
    expect(
      verifyClaim({ quoteText: quote, charStart: 1, charEnd: quote.length + 1 }, snapshot).ok,
    ).toBe(false);
  });
});

describe('gatePublish (Invariant 1: fail closed)', () => {
  it('is publishable only when every claim verifies', () => {
    // Arrange
    const good = { quoteText: '$39 per month', charStart: 28, charEnd: 41 };
    const corrupted = { quoteText: '$99 per month', charStart: 28, charEnd: 41 };

    // Act
    const pass = gatePublish([good], SNAPSHOT);
    const fail = gatePublish([good, corrupted], SNAPSHOT);

    // Assert
    expect(pass.publishable).toBe(true);
    expect(fail.publishable).toBe(false);
    expect(fail.failures).toHaveLength(1);
    expect(fail.failures[0].index).toBe(1);
  });

  it('blocks publication when there are zero claims (never publish unverified)', () => {
    // Arrange & Act
    const gate = gatePublish([], SNAPSHOT);

    // Assert
    expect(gate.publishable).toBe(false);
  });
});

describe('gateSectionPublish (Invariant 1: each cited claim verified vs its own snapshot)', () => {
  const SNAP_A = 'Growth plan is now $39 per month.';
  const SNAP_B = 'Now hiring a VP of Sales.';
  const claim = (
    id: string,
    snapshotId: string,
    quoteText: string,
    charStart: number,
  ): SectionClaim => ({
    id,
    snapshotId,
    quoteText,
    charStart,
    charEnd: charStart + quoteText.length,
  });
  const texts = new Map([
    ['snap-a', SNAP_A],
    ['snap-b', SNAP_B],
  ]);

  it('publishes when every cited claim verifies against its own snapshot', () => {
    const claims = [
      claim('c1', 'snap-a', '$39 per month', SNAP_A.indexOf('$39 per month')),
      claim('c2', 'snap-b', 'VP of Sales', SNAP_B.indexOf('VP of Sales')),
    ];
    expect(gateSectionPublish(claims, texts).publishable).toBe(true);
  });

  it('blocks the whole section when a cited claim quote does not match its snapshot', () => {
    const claims = [claim('c1', 'snap-a', 'WRONG QUOTE!!', 0)];
    const gate = gateSectionPublish(claims, texts);
    expect(gate.publishable).toBe(false);
    expect(gate.failures).toHaveLength(1);
  });

  it('blocks when a cited claim’s snapshot is unavailable (missing or cross-tenant)', () => {
    const claims = [claim('c1', 'snap-missing', '$39 per month', 0)];
    const gate = gateSectionPublish(claims, texts);
    expect(gate.publishable).toBe(false);
    expect(gate.failures[0]?.reason).toContain('unavailable');
  });

  it('fails closed on zero claims (never publish an unsourced section)', () => {
    expect(gateSectionPublish([], texts).publishable).toBe(false);
  });
});

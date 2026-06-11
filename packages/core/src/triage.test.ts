import { describe, expect, it } from 'vitest';
import type { Span } from './entities';
import {
  TriageGateError,
  TriageResultSchema,
  assertTriageAllowed,
  classifyDeterministic,
} from './triage';

const span = (text: string): Span => ({ charStart: 0, charEnd: text.length, text });

describe('assertTriageAllowed (Invariant 2: deterministic diff before any LLM)', () => {
  it('throws when the content hash did not change', () => {
    // Arrange
    const hash = 'abc123';

    // Act & Assert
    expect(() => assertTriageAllowed(hash, hash, [span('x')])).toThrow(TriageGateError);
  });

  it('throws when there are no changed spans', () => {
    // Arrange & Act & Assert
    expect(() => assertTriageAllowed('old', 'new', [])).toThrow(TriageGateError);
  });

  it('allows triage on a baseline-free hash change with spans', () => {
    // Arrange & Act & Assert
    expect(() => assertTriageAllowed('old', 'new', [span('x')])).not.toThrow();
    expect(() => assertTriageAllowed(null, 'new', [span('x')])).not.toThrow();
  });
});

describe('classifyDeterministic (materiality rule engine)', () => {
  it('classifies a currency change on a pricing source as pricing_change with materiality 3', () => {
    // Arrange
    const request = { sourceType: 'pricing', changedSpans: [span('$39 per month')] } as const;

    // Act
    const result = classifyDeterministic(request);

    // Assert
    expect(result.triageClass).toBe('pricing_change');
    expect(result.materiality).toBe(3);
  });

  it('classifies a VP posting on a jobs source as leadership_hire', () => {
    // Arrange
    const request = {
      sourceType: 'jobs',
      changedSpans: [span('4012003 | VP of Sales, EMEA | London')],
    } as const;

    // Act & Assert
    expect(classifyDeterministic(request).triageClass).toBe('leadership_hire');
  });

  it('classifies non-leadership job changes as hiring_signal', () => {
    // Arrange
    const request = {
      sourceType: 'jobs',
      changedSpans: [span('4012004 | Senior Backend Engineer | Remote')],
    } as const;

    // Act & Assert
    expect(classifyDeterministic(request).triageClass).toBe('hiring_signal');
  });

  it('classifies launch language on a changelog as feature_launch', () => {
    // Arrange
    const request = {
      sourceType: 'changelog',
      changedSpans: [span('Introducing Battlecards AI — now available on every plan')],
    } as const;

    // Act & Assert
    expect(classifyDeterministic(request).triageClass).toBe('feature_launch');
  });

  it('classifies repositioning language', () => {
    // Arrange
    const request = {
      sourceType: 'blog',
      changedSpans: [span('We are rebranding: the platform for revenue intelligence')],
    } as const;

    // Act & Assert
    expect(classifyDeterministic(request).triageClass).toBe('repositioning');
  });

  it('falls through to noise with materiality 0', () => {
    // Arrange
    const request = {
      sourceType: 'changelog',
      changedSpans: [span('Fixed a typo in the footer')],
    } as const;

    // Act
    const result = classifyDeterministic(request);

    // Assert
    expect(result.triageClass).toBe('noise');
    expect(result.materiality).toBe(0);
  });

  it('is deterministic: same spans yield the same result object values', () => {
    // Arrange
    const request = {
      sourceType: 'pricing',
      changedSpans: [span('Analyst now $39/mo')],
    } as const;

    // Act & Assert
    expect(classifyDeterministic(request)).toEqual(classifyDeterministic(request));
  });
});

describe('TriageResultSchema (LLM output boundary validation)', () => {
  it('accepts a well-formed result', () => {
    // Arrange
    const candidate = { triageClass: 'feature_launch', materiality: 2, rationale: 'launch' };

    // Act & Assert
    expect(TriageResultSchema.parse(candidate)).toEqual(candidate);
  });

  it('rejects unknown classes and out-of-range materiality', () => {
    // Arrange & Act & Assert
    expect(() =>
      TriageResultSchema.parse({ triageClass: 'rumor', materiality: 1, rationale: 'x' }),
    ).toThrow();
    expect(() =>
      TriageResultSchema.parse({ triageClass: 'noise', materiality: 4, rationale: 'x' }),
    ).toThrow();
    expect(() =>
      TriageResultSchema.parse({ triageClass: 'noise', materiality: 0, rationale: '' }),
    ).toThrow();
  });
});

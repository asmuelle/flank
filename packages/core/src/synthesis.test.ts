import { describe, expect, it } from 'vitest';
import { SynthesisResultSchema } from './synthesis';

describe('SynthesisResultSchema (answer boundary, fail-closed)', () => {
  it('accepts regenerated content with at least one cited claim id', () => {
    const answer = { contentMd: '## Pricing\nGrowth is now $39/mo.', citedClaimIds: ['c1', 'c2'] };
    expect(SynthesisResultSchema.parse(answer)).toEqual(answer);
  });

  it('rejects empty content or zero citations', () => {
    expect(() => SynthesisResultSchema.parse({ contentMd: '', citedClaimIds: ['c1'] })).toThrow();
    expect(() => SynthesisResultSchema.parse({ contentMd: 'x', citedClaimIds: [] })).toThrow();
  });
});

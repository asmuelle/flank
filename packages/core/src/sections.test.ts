import { describe, expect, it } from 'vitest';
import { TRIAGE_CLASSES } from './entities';
import { AFFECTED_SECTIONS, affectedSectionKinds, unionAffectedKinds } from './sections';

describe('AFFECTED_SECTIONS mapping', () => {
  it('is exhaustive over every triage class', () => {
    for (const triageClass of TRIAGE_CLASSES) {
      expect(AFFECTED_SECTIONS[triageClass]).toBeDefined();
    }
  });

  it('maps a pricing change to the pricing dossier + counter battlecard', () => {
    const affected = affectedSectionKinds('pricing_change');
    expect(affected.dossier).toContain('pricing');
    expect(affected.battlecard).toContain('pricing_counter');
  });

  it('maps noise to nothing (dismissed deltas never synthesize)', () => {
    expect(affectedSectionKinds('noise')).toEqual({ dossier: [], battlecard: [] });
  });
});

describe('unionAffectedKinds', () => {
  it('de-duplicates kinds across multiple classes', () => {
    // pricing_change and feature_launch both touch dossier 'overview' and battlecard 'why_we_win'.
    const union = unionAffectedKinds(['pricing_change', 'feature_launch']);
    expect(union.dossier.filter((k) => k === 'overview')).toHaveLength(1);
    expect(union.battlecard.filter((k) => k === 'why_we_win')).toHaveLength(1);
    expect(union.dossier).toEqual(expect.arrayContaining(['pricing', 'product', 'overview']));
  });

  it('returns empty for no classes', () => {
    expect(unionAffectedKinds([])).toEqual({ dossier: [], battlecard: [] });
  });
});

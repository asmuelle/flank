import type { BattlecardSectionKind, DossierSectionKind } from './entities';
import type { TriageClass } from './entities';

/** Which dossier + battlecard section kinds a delta of each class can affect. */
export interface AffectedKinds {
  readonly dossier: readonly DossierSectionKind[];
  readonly battlecard: readonly BattlecardSectionKind[];
}

/**
 * Exhaustive map from triage class to the sections it can change. `Record<TriageClass, …>` makes a
 * missing class a COMPILE error — the basis of "only affected sections regenerate". `noise` maps to
 * nothing (dismissed deltas never reach synthesis anyway).
 */
export const AFFECTED_SECTIONS: Readonly<Record<TriageClass, AffectedKinds>> = Object.freeze({
  pricing_change: {
    dossier: ['pricing', 'overview'],
    battlecard: ['pricing_counter', 'why_we_win'],
  },
  feature_launch: { dossier: ['product', 'overview'], battlecard: ['why_we_win', 'landmines'] },
  repositioning: { dossier: ['gtm', 'overview'], battlecard: ['why_we_win', 'objections'] },
  leadership_hire: { dossier: ['team', 'overview'], battlecard: ['landmines'] },
  hiring_signal: { dossier: ['team'], battlecard: [] },
  noise: { dossier: [], battlecard: [] },
});

/** The section kinds affected by one triage class. */
export const affectedSectionKinds = (triageClass: TriageClass): AffectedKinds =>
  AFFECTED_SECTIONS[triageClass];

/** The de-duplicated union of section kinds affected across a set of triage classes. */
export const unionAffectedKinds = (classes: readonly TriageClass[]): AffectedKinds => {
  const dossier = new Set<DossierSectionKind>();
  const battlecard = new Set<BattlecardSectionKind>();
  for (const triageClass of classes) {
    for (const kind of AFFECTED_SECTIONS[triageClass].dossier) dossier.add(kind);
    for (const kind of AFFECTED_SECTIONS[triageClass].battlecard) battlecard.add(kind);
  }
  return Object.freeze({
    dossier: Object.freeze([...dossier]),
    battlecard: Object.freeze([...battlecard]),
  });
};

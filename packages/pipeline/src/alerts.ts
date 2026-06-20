import type { Claim, Competitor, Delta } from '@flank/core';

export interface AlertPayload {
  readonly deltaId: string;
  readonly competitorName: string;
  readonly whatChanged: string;
  readonly quote: string;
  readonly sourceUrl: string;
  readonly capturedAt: Date;
  readonly rationale: string;
}

/**
 * Compose delta alerts: what changed (quote + link + timestamp) and why it
 * matters. Only `published` deltas alert; a published pricing delta must
 * additionally carry a confirming snapshot (`confirmedBySnapshotId`), so a
 * pricing change that never passed the confirmation firewall can never reach a
 * channel — Invariant 3, enforced in depth (delta state machine + DB trigger + here).
 */
export const composeAlerts = (
  deltas: readonly Delta[],
  claimsByDelta: ReadonlyMap<string, readonly Claim[]>,
  competitor: Competitor,
): readonly AlertPayload[] =>
  Object.freeze(
    deltas
      .filter(
        (delta) =>
          delta.state === 'published' &&
          (delta.triageClass !== 'pricing_change' || delta.confirmedBySnapshotId !== null),
      )
      .map((delta) => {
        const claims = claimsByDelta.get(delta.id) ?? [];
        const first = claims[0];
        return Object.freeze({
          deltaId: delta.id,
          competitorName: competitor.name,
          whatChanged: `${delta.triageClass} (materiality ${delta.materiality}/3)`,
          quote: first?.quoteText ?? '',
          sourceUrl: first?.sourceUrl ?? '',
          capturedAt: delta.createdAt,
          rationale: delta.rationale,
        });
      }),
  );

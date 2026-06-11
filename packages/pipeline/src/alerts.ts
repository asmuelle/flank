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
 * matters. Only `published` deltas alert; pricing deltas additionally require
 * `confirmed` state (M2 flow), so an unconfirmed pricing delta can never reach
 * a channel — Invariant 3, enforced twice (state machine + here).
 */
export const composeAlerts = (
  deltas: readonly Delta[],
  claimsByDelta: ReadonlyMap<string, readonly Claim[]>,
  competitor: Competitor,
): readonly AlertPayload[] =>
  Object.freeze(
    deltas
      .filter((delta) => delta.state === 'published' && delta.triageClass !== 'pricing_change')
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

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

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rehydrate a stored alert payload (jsonb) back into an {@link AlertPayload}. `capturedAt` survives a
 * Postgres JSONB round-trip as an ISO string (and as a Date in the in-memory store), so it is coerced
 * back to a Date here — the renderers depend on it being a real Date.
 */
export const parseStoredAlertPayload = (raw: Readonly<Record<string, unknown>>): AlertPayload =>
  Object.freeze({
    deltaId: asString(raw.deltaId),
    competitorName: asString(raw.competitorName),
    whatChanged: asString(raw.whatChanged),
    quote: asString(raw.quote),
    sourceUrl: asString(raw.sourceUrl),
    capturedAt: new Date(raw.capturedAt as string | number | Date),
    rationale: asString(raw.rationale),
  });

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
          (delta.triageClass !== 'pricing_change' || delta.confirmedBySnapshotId !== null) &&
          // A published delta should always carry a verified claim (Invariant 1); fail safe and
          // never emit a contentless alert (empty quote / source) if one somehow has none.
          (claimsByDelta.get(delta.id)?.length ?? 0) > 0,
      )
      .map((delta) => {
        const first = (claimsByDelta.get(delta.id) ?? [])[0];
        return Object.freeze({
          deltaId: delta.id,
          competitorName: competitor.name,
          whatChanged: `${delta.triageClass} (materiality ${delta.materiality}/3)`,
          quote: first.quoteText,
          sourceUrl: first.sourceUrl,
          capturedAt: delta.createdAt,
          rationale: delta.rationale,
        });
      }),
  );

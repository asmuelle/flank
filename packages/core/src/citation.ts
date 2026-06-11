import type { Span } from './entities';

/** A claim before persistence: quote + offsets + URL + capture timestamp (Invariant 1). */
export interface ClaimDraft {
  readonly quoteText: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly sourceUrl: string;
  readonly capturedAt: Date;
}

export type ClaimCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface PublishGateResult {
  readonly publishable: boolean;
  readonly failures: readonly { readonly index: number; readonly reason: string }[];
}

/** Pin every changed span as a claim against the snapshot it was extracted from. */
export const pinClaims = (
  spans: readonly Span[],
  sourceUrl: string,
  capturedAt: Date,
): readonly ClaimDraft[] =>
  Object.freeze(
    spans.map((span) =>
      Object.freeze({
        quoteText: span.text,
        charStart: span.charStart,
        charEnd: span.charEnd,
        sourceUrl,
        capturedAt,
      }),
    ),
  );

/**
 * String-verify a claim at its recorded offsets against the stored snapshot text.
 * Exact match only — truncated quotes, moved spans, and off-by-one offsets all fail.
 */
export const verifyClaim = (
  claim: Pick<ClaimDraft, 'quoteText' | 'charStart' | 'charEnd'>,
  snapshotText: string,
): ClaimCheck => {
  if (!Number.isInteger(claim.charStart) || !Number.isInteger(claim.charEnd)) {
    return { ok: false, reason: 'offsets must be integers' };
  }
  if (claim.charStart < 0 || claim.charEnd > snapshotText.length) {
    return { ok: false, reason: 'offsets out of snapshot bounds' };
  }
  if (claim.charStart >= claim.charEnd) {
    return { ok: false, reason: 'empty or inverted offset range' };
  }
  const actual = snapshotText.slice(claim.charStart, claim.charEnd);
  if (actual !== claim.quoteText) {
    return { ok: false, reason: `quote mismatch at [${claim.charStart}, ${claim.charEnd})` };
  }
  return { ok: true };
};

/**
 * Publish gate, fail closed (Invariant 1): zero claims or any verification
 * failure blocks publication. Never publish unverified.
 */
export const gatePublish = (
  claims: readonly Pick<ClaimDraft, 'quoteText' | 'charStart' | 'charEnd'>[],
  snapshotText: string,
): PublishGateResult => {
  const failures = claims.flatMap((claim, index) => {
    const check = verifyClaim(claim, snapshotText);
    return check.ok ? [] : [Object.freeze({ index, reason: check.reason })];
  });
  return Object.freeze({
    publishable: claims.length > 0 && failures.length === 0,
    failures: Object.freeze(failures),
  });
};

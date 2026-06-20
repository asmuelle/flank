import { formatMicrosAsCents } from '@flank/core';
import type { CoverageView } from '../lib/views/sections';

/**
 * Coverage receipt (Invariant 7): silence must be visible. Reports what was
 * checked and what it cost, even when nothing material fired.
 */
export function CoverageReceipt({
  coverage,
  triageMode,
}: {
  readonly coverage: CoverageView;
  readonly triageMode?: string;
}) {
  const rows: readonly (readonly [string, string])[] = [
    ['Fetches', String(coverage.fetches)],
    ['Deltas found', String(coverage.deltasFound)],
    ['Material', String(coverage.materialDeltas)],
    ['Fetch failures', String(coverage.fetchFailures)],
    ['Model calls', String(coverage.llmCalls)],
    ['Metered cost', formatMicrosAsCents(coverage.llmCostMicros)],
  ];
  return (
    <aside className="receipt" aria-labelledby="receipt-heading">
      <h2 id="receipt-heading">Coverage receipt</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} className="receipt-row">
            <dt>{label}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      {triageMode !== undefined ? <p className="receipt-note mono">triage: {triageMode}</p> : null}
    </aside>
  );
}

import type { BattlecardSection, Claim, Competitor, DossierSection } from '@flank/core';
import type { LintFinding } from '@okf/core';

/** Everything the projector needs for one competitor, already workspace-scoped. */
export interface CompetitorExport {
  readonly competitor: Competitor;
  /** Full version chains (all versions) — the log renders from them; docs render the head only. */
  readonly dossierSections: readonly DossierSection[];
  readonly battlecardSections: readonly BattlecardSection[];
  /** Resolved claim rows for every claimId cited by any exported section head. */
  readonly claims: readonly Claim[];
}

export interface WorkspaceExportInput {
  readonly workspace: { readonly id: string; readonly name: string };
  /** App origin for `resource:` deep links, e.g. https://app.flank.example (no trailing slash). */
  readonly baseUrl: string;
  readonly competitors: readonly CompetitorExport[];
}

/**
 * The projection result. `files` is the deterministic bundle (path → content).
 * `findings` merges structural checks with the semantic UNVERIFIED_CITATION
 * gate; any `severity: 'error'` finding means the bundle MUST NOT ship
 * (projection-only rule — the lint check guards the gate itself).
 */
export interface WorkspaceBundle {
  readonly files: ReadonlyMap<string, string>;
  readonly findings: readonly LintFinding[];
}

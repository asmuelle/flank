import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TriageClass } from '@flank/core';
import {
  composeAlerts,
  loadFixtureBundleSync,
  runFixtureScenario,
  type AlertPayload,
  type ScenarioResult,
} from '@flank/pipeline';

export interface CitationView {
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly sourceUrl: string;
  readonly capturedAt: string;
  readonly verified: boolean;
}

export interface TimelineEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly sourceType: string;
  readonly sourceUrl: string;
  readonly triageClass: TriageClass;
  readonly materiality: number;
  readonly rationale: string;
  readonly state: string;
  readonly awaitingConfirmation: boolean;
  readonly citations: readonly CitationView[];
}

export interface CoverageView {
  readonly fetches: number;
  readonly deltasFound: number;
  readonly materialDeltas: number;
  readonly fetchFailures: number;
  readonly llmCalls: number;
  readonly llmCostMicros: number;
}

export interface BriefModel {
  readonly competitorName: string;
  readonly competitorDomain: string;
  readonly sourceCount: number;
  readonly entries: readonly TimelineEntryView[];
  readonly alerts: readonly AlertPayload[];
  readonly coverage: CoverageView;
  readonly triageMode: string;
}

/** Pure transform from the pipeline scenario result to the brief view model. */
export const toBriefModel = (scenario: ScenarioResult): BriefModel => {
  const sourceById = new Map(scenario.sources.map((source) => [source.id, source]));
  const entries = [...scenario.deltas]
    .map((delta): TimelineEntryView => {
      const source = sourceById.get(delta.sourceId);
      return Object.freeze({
        id: delta.id,
        occurredAt: delta.createdAt.toISOString(),
        sourceType: source?.type ?? 'unknown',
        sourceUrl: source?.url ?? '',
        triageClass: delta.triageClass,
        materiality: delta.materiality,
        rationale: delta.rationale,
        state: delta.state,
        awaitingConfirmation: delta.triageClass === 'pricing_change' && delta.state === 'pending',
        citations: Object.freeze(
          (scenario.claimsByDelta.get(delta.id) ?? []).map(
            (claim): CitationView =>
              Object.freeze({
                quote: claim.quoteText,
                charStart: claim.charStart,
                charEnd: claim.charEnd,
                sourceUrl: claim.sourceUrl,
                capturedAt: claim.capturedAt.toISOString(),
                verified: claim.verifiedAt !== null,
              }),
          ),
        ),
      });
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const coverage = scenario.coverageRuns.reduce<CoverageView>(
    (acc, run) => ({
      fetches: acc.fetches + run.sourcesChecked,
      deltasFound: acc.deltasFound + run.deltasFound,
      materialDeltas: acc.materialDeltas + run.materialDeltas,
      fetchFailures: acc.fetchFailures + run.fetchFailures,
      llmCalls: acc.llmCalls + run.llmCalls,
      llmCostMicros: acc.llmCostMicros + run.llmCostMicros,
    }),
    {
      fetches: 0,
      deltasFound: 0,
      materialDeltas: 0,
      fetchFailures: 0,
      llmCalls: 0,
      llmCostMicros: 0,
    },
  );

  return Object.freeze({
    competitorName: scenario.competitor.name,
    competitorDomain: scenario.competitor.primaryDomain,
    sourceCount: scenario.sources.length,
    entries: Object.freeze(entries),
    alerts: composeAlerts(scenario.deltas, scenario.claimsByDelta, scenario.competitor),
    coverage,
    triageMode: scenario.triageMode,
  });
};

/** Locate the checked-in fixtures from either the repo root or apps/web. */
export const resolveFixturesDir = (cwd: string): string => {
  const candidates = [
    join(cwd, 'packages', 'pipeline', 'fixtures'),
    join(cwd, '..', '..', 'packages', 'pipeline', 'fixtures'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`fixtures directory not found; looked in: ${candidates.join(', ')}`);
  }
  return found;
};

/**
 * Build the M1 brief: run the deterministic fixture pipeline (mock triage, no
 * network, no database, no API key) and shape it for the read-only timeline.
 */
export const loadBrief = async (): Promise<BriefModel> => {
  const bundle = loadFixtureBundleSync(resolveFixturesDir(process.cwd()));
  const scenario = await runFixtureScenario(bundle);
  return toBriefModel(scenario);
};

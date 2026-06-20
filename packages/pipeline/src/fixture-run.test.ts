import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeAlerts } from './alerts';
import { loadFixtureBundleSync } from './fixture-files';
import { runFixtureScenario, type ScenarioResult } from './fixture-run';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const runScenario = async (
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ScenarioResult> => runFixtureScenario(loadFixtureBundleSync(FIXTURES_DIR), env);

describe('M1 fixture scenario: one competitor, three sources, real diffs', () => {
  it('produces exactly one pricing_change delta and it stays pending (Invariant 3)', async () => {
    // Act
    const result = await runScenario();

    // Assert
    const pricingDeltas = result.deltas.filter((d) => d.triageClass === 'pricing_change');
    expect(pricingDeltas).toHaveLength(1);
    expect(pricingDeltas[0].state).toBe('pending');
    expect(pricingDeltas[0].materiality).toBe(3);
  });

  it('never alerts on an unconfirmed pricing delta (M1 accept: pending, not alerted)', async () => {
    const result = await runScenario();

    const alerts = composeAlerts(result.deltas, result.claimsByDelta, result.competitor);

    expect(alerts.some((a) => a.whatChanged.includes('pricing_change'))).toBe(false);
    const alertedDeltaIds = new Set(alerts.map((a) => a.deltaId));
    for (const delta of result.deltas.filter((d) => d.triageClass === 'pricing_change')) {
      expect(alertedDeltaIds.has(delta.id)).toBe(false);
    }
  });

  it('makes zero LLM calls on unchanged fetches (Invariant 2, M1 accept)', async () => {
    const result = await runScenario();

    expect(result.triageCallsOnUnchanged).toBe(0);
    // One triage call per changed source, none for baselines or quiet passes.
    expect(result.triageCalls).toBe(3);
    const quietOutcomes = result.outcomes.slice(6);
    expect(quietOutcomes.map((o) => o.kind)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('classifies the changelog launch and the VP job posting deterministically', async () => {
    const result = await runScenario();

    const byClass = new Map(result.deltas.map((d) => [d.triageClass, d]));
    expect(byClass.get('feature_launch')?.state).toBe('published');
    expect(byClass.get('leadership_hire')?.state).toBe('published');
    expect(result.deltas).toHaveLength(3);
  });

  it('pins every claim with quote + offsets + source URL + capture timestamp (Invariant 1)', async () => {
    const result = await runScenario();

    expect(result.deltas.length).toBeGreaterThan(0);
    for (const delta of result.deltas) {
      const claims = result.claimsByDelta.get(delta.id) ?? [];
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim.quoteText.length).toBeGreaterThan(0);
        expect(claim.charEnd).toBeGreaterThan(claim.charStart);
        expect(claim.sourceUrl).toMatch(/^https:\/\//);
        expect(claim.capturedAt).toBeInstanceOf(Date);
      }
    }
  });

  it('extracts the new price as the pricing claim, ignoring A/B script churn', async () => {
    const result = await runScenario();

    const pricing = result.deltas.find((d) => d.triageClass === 'pricing_change');
    expect(pricing).toBeDefined();
    const claims = result.claimsByDelta.get(pricing!.id) ?? [];
    expect(claims.map((c) => c.quoteText).join('\n')).toContain('$39 per month');
    // The window.__cfg experiment flip in <script> must never surface as evidence.
    expect(claims.map((c) => c.quoteText).join('\n')).not.toContain('variant-b');
  });

  it('records one coverage_run row per fetch, including quiet passes (Invariant 7)', async () => {
    const result = await runScenario();

    expect(result.coverageRuns).toHaveLength(9);
    const totals = result.coverageRuns.reduce(
      (acc, run) => ({
        sourcesChecked: acc.sourcesChecked + run.sourcesChecked,
        deltasFound: acc.deltasFound + run.deltasFound,
        llmCalls: acc.llmCalls + run.llmCalls,
      }),
      { sourcesChecked: 0, deltasFound: 0, llmCalls: 0 },
    );
    expect(totals).toEqual({ sourcesChecked: 9, deltasFound: 3, llmCalls: 3 });
    const quietRuns = result.coverageRuns.filter((run) => run.period === '2026-06-09');
    expect(quietRuns).toHaveLength(3);
    expect(quietRuns.every((run) => run.llmCalls === 0)).toBe(true);
  });

  it('meters COGS on every triage call (Invariant 6)', async () => {
    const result = await runScenario();

    const triageRuns = result.coverageRuns.filter((run) => run.llmCalls > 0);
    expect(triageRuns).toHaveLength(3);
    expect(triageRuns.every((run) => run.llmCostMicros > 0)).toBe(true);
  });

  it('uses the deterministic mock even when ANTHROPIC_API_KEY is present (no live calls in tests)', async () => {
    const withKey = await runScenario({ ANTHROPIC_API_KEY: 'test-placeholder-never-used' });
    const without = await runScenario();

    expect(withKey.triageMode).toContain('deterministic mock');
    expect(without.triageMode).toContain('deterministic mock');
    expect(withKey.deltas).toEqual(without.deltas);
  });

  it('is deterministic: two runs over the same fixtures produce identical deltas', async () => {
    const first = await runScenario();
    const second = await runScenario();

    expect(second.deltas).toEqual(first.deltas);
    expect([...second.claimsByDelta.entries()]).toEqual([...first.claimsByDelta.entries()]);
  });
});

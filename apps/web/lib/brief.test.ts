import { loadFixtureBundleSync, runFixtureScenario } from '@flank/pipeline';
import { describe, expect, it } from 'vitest';
import { loadBrief, resolveFixturesDir, toBriefModel } from './brief';

describe('toBriefModel', () => {
  const buildScenario = async () =>
    runFixtureScenario(loadFixtureBundleSync(resolveFixturesDir(process.cwd())));

  it('orders timeline entries newest first', async () => {
    // Arrange
    const scenario = await buildScenario();

    // Act
    const brief = toBriefModel(scenario);

    // Assert
    const times = brief.entries.map((entry) => entry.occurredAt);
    expect(times).toEqual([...times].sort((a, b) => b.localeCompare(a)));
    expect(brief.entries).toHaveLength(3);
  });

  it('flags the pending pricing delta as awaiting confirmation, never alerted', async () => {
    const scenario = await buildScenario();

    const brief = toBriefModel(scenario);

    const pricing = brief.entries.find((entry) => entry.triageClass === 'pricing_change');
    expect(pricing?.awaitingConfirmation).toBe(true);
    expect(pricing?.state).toBe('pending');
    expect(brief.alerts.some((alert) => alert.deltaId === pricing?.id)).toBe(false);
  });

  it('carries full provenance on every citation: quote, offsets, URL, timestamp', async () => {
    const scenario = await buildScenario();

    const brief = toBriefModel(scenario);

    for (const entry of brief.entries) {
      expect(entry.citations.length).toBeGreaterThan(0);
      for (const citation of entry.citations) {
        expect(citation.quote.length).toBeGreaterThan(0);
        expect(citation.charEnd).toBeGreaterThan(citation.charStart);
        expect(citation.sourceUrl).toMatch(/^https:\/\//);
        expect(citation.capturedAt).toMatch(/^2026-/);
      }
    }
  });

  it('aggregates coverage receipts across all nine fetches (Invariant 7)', async () => {
    const scenario = await buildScenario();

    const brief = toBriefModel(scenario);

    expect(brief.coverage.fetches).toBe(9);
    expect(brief.coverage.deltasFound).toBe(3);
    expect(brief.coverage.llmCalls).toBe(3);
    expect(brief.coverage.fetchFailures).toBe(0);
  });
});

describe('loadBrief', () => {
  it('builds the brief end-to-end with the deterministic mock (no key, no network)', async () => {
    const brief = await loadBrief();

    expect(brief.competitorName).toBe('Periscope Labs');
    expect(brief.sourceCount).toBe(3);
    expect(brief.triageMode).toContain('deterministic mock');
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFixtureBundleSync } from '../fixture-files';
import { AdapterError, normalizeForSource } from './index';
import { normalizeGreenhouse } from './greenhouse';
import { normalizePricingHtml } from './pricing';
import { normalizeRss } from './rss';

const fixtures = loadFixtureBundleSync(fileURLToPath(new URL('../../fixtures', import.meta.url)));

describe('normalizeRss', () => {
  it('normalizes the changelog fixture into one line per item, in document order', () => {
    // Arrange & Act
    const text = normalizeRss(fixtures.changelogV1);

    // Assert
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Faster dashboard loads');
    expect(lines[1]).toContain('CSV export for reports');
  });

  it('decodes CDATA descriptions', () => {
    // Arrange & Act
    const text = normalizeRss(fixtures.changelogV2);

    // Assert
    expect(text).toContain('Introducing Battlecards AI');
    expect(text).toContain('Auto-generated battlecards are now available on every plan');
    expect(text).not.toContain('CDATA');
  });

  it('is deterministic for the same document', () => {
    // Arrange & Act & Assert
    expect(normalizeRss(fixtures.changelogV1)).toBe(normalizeRss(fixtures.changelogV1));
  });

  it('throws AdapterError for non-RSS payloads', () => {
    // Arrange & Act & Assert
    expect(() => normalizeRss('<html><body>blocked</body></html>')).toThrow(AdapterError);
  });
});

describe('normalizeGreenhouse', () => {
  it('normalizes the job board fixture sorted by id, excluding timestamp churn', () => {
    // Arrange & Act
    const text = normalizeGreenhouse(fixtures.jobsV1);

    // Assert
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '4012001 | Senior Backend Engineer | Remote — EU | https://boards.greenhouse.io/periscopelabs/jobs/4012001',
    );
    expect(text).not.toContain('2026-05-20T10:00:00');
  });

  it('produces identical text regardless of payload job ordering', () => {
    // Arrange
    const parsed = JSON.parse(fixtures.jobsV1) as { jobs: unknown[] };
    const reversed = JSON.stringify({ ...parsed, jobs: [...parsed.jobs].reverse() });

    // Act & Assert
    expect(normalizeGreenhouse(reversed)).toBe(normalizeGreenhouse(fixtures.jobsV1));
  });

  it('throws AdapterError on invalid JSON', () => {
    // Arrange & Act & Assert
    expect(() => normalizeGreenhouse('{not json')).toThrow(AdapterError);
  });

  it('throws AdapterError when the payload fails schema validation', () => {
    // Arrange
    const bad = JSON.stringify({ jobs: [{ id: 'x', title: '' }] });

    // Act & Assert
    expect(() => normalizeGreenhouse(bad)).toThrow(AdapterError);
  });
});

describe('normalizePricingHtml', () => {
  it('extracts rendered text and strips scripts, styles, and tags', () => {
    // Arrange & Act
    const text = normalizePricingHtml(fixtures.pricingV1);

    // Assert
    expect(text).toContain('$59 per month');
    expect(text).toContain('SSO & API');
    expect(text).not.toContain('window.__cfg');
    expect(text).not.toContain('<');
  });

  it('ignores A/B-test config churn in script blocks (raw differs, normalized price-only delta)', () => {
    // Arrange
    const v1 = normalizePricingHtml(fixtures.pricingV1);
    const v2 = normalizePricingHtml(fixtures.pricingV2);

    // Assert: raw fixtures differ in the script experiment flag too,
    // but normalization reduces the change to the price line alone.
    expect(fixtures.pricingV1).toContain('control');
    expect(fixtures.pricingV2).toContain('variant-b');
    expect(v1.replace('$59 per month', '$39 per month')).toBe(v2);
  });

  it('throws AdapterError for non-HTML payloads', () => {
    // Arrange & Act & Assert
    expect(() => normalizePricingHtml('just plain text, no markup')).toThrow(AdapterError);
  });
});

describe('normalizeForSource registry (Invariant 4: legal-first source graph)', () => {
  it('routes changelog/jobs/pricing to their adapters', () => {
    // Arrange & Act & Assert
    expect(normalizeForSource('changelog', fixtures.changelogV1)).toContain('Faster dashboard');
    expect(normalizeForSource('jobs', fixtures.jobsV1)).toContain('Senior Backend Engineer');
    expect(normalizeForSource('pricing', fixtures.pricingV1)).toContain('$59 per month');
  });

  it('refuses review streams — license-only, never scraped', () => {
    // Arrange & Act & Assert
    expect(() => normalizeForSource('reviews', '{}')).toThrow(/license-only/);
  });
});

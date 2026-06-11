import { describe, expect, it } from 'vitest';
import { parseSourceConfig } from './entities';

describe('parseSourceConfig (boundary validation)', () => {
  const valid = {
    id: 'src-1',
    competitorId: 'comp-1',
    type: 'pricing',
    url: 'https://periscope.example/pricing',
    adapter: 'html',
    cadence: '0 6 * * *',
  };

  it('accepts a valid source and defaults legalStatus to open', () => {
    // Arrange & Act
    const source = parseSourceConfig(valid);

    // Assert
    expect(source.legalStatus).toBe('open');
    expect(Object.isFrozen(source)).toBe(true);
  });

  it('rejects unknown source types', () => {
    // Arrange & Act & Assert
    expect(() => parseSourceConfig({ ...valid, type: 'g2_reviews' })).toThrow();
  });

  it('rejects invalid URLs', () => {
    // Arrange & Act & Assert
    expect(() => parseSourceConfig({ ...valid, url: 'not a url' })).toThrow();
  });

  it('rejects unknown adapters', () => {
    // Arrange & Act & Assert
    expect(() => parseSourceConfig({ ...valid, adapter: 'scraper' })).toThrow();
  });
});

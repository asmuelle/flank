import { describe, expect, it } from 'vitest';
import { emitFrontmatter, parseConcept } from './frontmatter';
import { renderConcept } from './bundle';
import type { ConceptFrontmatter } from './concept';

describe('emitFrontmatter', () => {
  it('renders standard keys in fixed order regardless of object key order', () => {
    // Arrange — keys deliberately out of order.
    const frontmatter: ConceptFrontmatter = {
      timestamp: '2026-05-28T14:30:00Z',
      tags: ['sales', 'revenue'],
      type: 'BigQuery Table',
      title: 'Orders',
    };

    // Act
    const yaml = emitFrontmatter(frontmatter);

    // Assert
    expect(yaml).toBe(
      [
        'type: BigQuery Table',
        'title: Orders',
        'tags: [sales, revenue]',
        // Unquoted like the spec's own example; parseConcept always returns strings.
        'timestamp: 2026-05-28T14:30:00Z',
      ].join('\n'),
    );
  });

  it('renders extra keys after standard keys in sorted order', () => {
    // Arrange
    const frontmatter: ConceptFrontmatter = {
      type: 'Battlecard',
      extra: { workspace: 'acme', competitor: 'globex' },
    };

    // Act & Assert
    expect(emitFrontmatter(frontmatter)).toBe(
      ['type: Battlecard', 'competitor: globex', 'workspace: acme'].join('\n'),
    );
  });

  it('quotes values a YAML parser would read as non-strings or syntax', () => {
    // Arrange
    const frontmatter: ConceptFrontmatter = {
      type: 'Metric',
      title: 'true',
      description: 'ratio: definition pending',
      extra: { note: "O'Brien's draft", version: '42' },
    };

    // Act
    const yaml = emitFrontmatter(frontmatter);

    // Assert
    expect(yaml).toContain("title: 'true'");
    expect(yaml).toContain("description: 'ratio: definition pending'");
    expect(yaml).toContain("note: 'O''Brien''s draft'");
    expect(yaml).toContain("version: '42'");
  });
});

describe('parseConcept', () => {
  it('round-trips a rendered concept document', () => {
    // Arrange
    const doc = {
      path: 'tables/orders.md',
      frontmatter: {
        type: 'BigQuery Table',
        title: 'Orders',
        description: 'One row per completed customer order.',
        resource: 'https://example.com/orders',
        tags: ['sales', "o'brien"],
        timestamp: '2026-05-28T14:30:00Z',
        extra: { owner: 'data-eng' },
      },
      body: '# Schema\n\nJoined with [customers](customers.md).',
    };

    // Act
    const parsed = parseConcept(renderConcept(doc));

    // Assert
    expect(parsed.frontmatter).toEqual(doc.frontmatter);
    expect(parsed.body).toBe(doc.body);
  });

  it('rejects content without a frontmatter block', () => {
    // Act & Assert
    expect(() => parseConcept('# Just markdown\n')).toThrow(/frontmatter/);
  });
});

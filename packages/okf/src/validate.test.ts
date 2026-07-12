import { describe, expect, it } from 'vitest';
import { validateBundle } from './validate';
import type { ConceptDoc } from './concept';

const doc = (path: string, body: string, type = 'Note'): ConceptDoc => ({
  path,
  frontmatter: { type },
  body,
});

describe('validateBundle', () => {
  it('flags an empty bundle', () => {
    // Act
    const findings = validateBundle([]);

    // Assert
    expect(findings).toEqual([
      expect.objectContaining({ check: 'EMPTY_BUNDLE', severity: 'error' }),
    ]);
  });

  it('passes a well-formed linked bundle without findings', () => {
    // Arrange
    const bundle = [
      doc('index.md', 'See [orders](tables/orders.md).', 'Index'),
      doc('tables/orders.md', 'FK to [customers](customers.md).'),
      doc('tables/customers.md', 'Referenced by [orders](/tables/orders.md).'),
    ];

    // Act & Assert
    expect(validateBundle(bundle)).toEqual([]);
  });

  it('flags a missing type as an error', () => {
    // Act
    const findings = validateBundle([doc('index.md', '', '  ')]);

    // Assert
    expect(findings).toEqual([
      expect.objectContaining({ check: 'MISSING_TYPE', path: 'index.md' }),
    ]);
  });

  it('flags duplicate paths', () => {
    // Act
    const findings = validateBundle([doc('index.md', 'a'), doc('index.md', 'b')]);

    // Assert
    expect(findings).toContainEqual(
      expect.objectContaining({ check: 'DUPLICATE_PATH', path: 'index.md' }),
    );
  });

  it('flags links to missing targets and links escaping the bundle', () => {
    // Arrange
    const bundle = [
      doc('index.md', 'See [gone](tables/gone.md) and [out](../outside.md).', 'Index'),
    ];

    // Act
    const findings = validateBundle(bundle);

    // Assert
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: 'BROKEN_LINK',
        message: expect.stringContaining('gone.md'),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        check: 'BROKEN_LINK',
        message: expect.stringContaining('escapes'),
      }),
    );
  });

  it('flags unlinked concepts as orphans but never index.md or log.md', () => {
    // Arrange
    const bundle = [
      doc('index.md', 'nothing linked', 'Index'),
      doc('log.md', '', 'Log'),
      doc('tables/orders.md', 'no inbound links'),
    ];

    // Act
    const findings = validateBundle(bundle);

    // Assert
    expect(findings).toEqual([
      expect.objectContaining({ check: 'ORPHAN', severity: 'warning', path: 'tables/orders.md' }),
    ]);
  });
});

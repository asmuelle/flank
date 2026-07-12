import { describe, expect, it } from 'vitest';
import { extractInternalLinks, markdownLink, relativeLink, resolveLink, slugify } from './links';

describe('slugify', () => {
  it('lowercases and collapses non-alphanumeric runs', () => {
    expect(slugify('EU AI Act — Article 6(2)')).toBe('eu-ai-act-article-6-2');
  });

  it('strips diacritics', () => {
    expect(slugify('Zürich café résumé')).toBe('zurich-cafe-resume');
  });
});

describe('relativeLink', () => {
  it('links between siblings without a prefix', () => {
    expect(relativeLink('tables/orders.md', 'tables/customers.md')).toBe('customers.md');
  });

  it('links from the bundle root downward', () => {
    expect(relativeLink('index.md', 'tables/orders.md')).toBe('tables/orders.md');
  });

  it('links across directories via parent segments', () => {
    expect(relativeLink('tables/orders.md', 'metrics/wau.md')).toBe('../metrics/wau.md');
  });
});

describe('markdownLink', () => {
  it('renders a relative markdown link', () => {
    expect(markdownLink('Customers', 'tables/orders.md', 'tables/customers.md')).toBe(
      '[Customers](customers.md)',
    );
  });
});

describe('extractInternalLinks', () => {
  it('returns internal targets and skips external URLs and fragments', () => {
    // Arrange
    const body = [
      'Joined with [customers](customers.md) on `customer_id`.',
      'See [console](https://console.example.com/x) and [docs](mailto:a@b.c).',
      'Also [metric](../metrics/wau.md#definition).',
    ].join('\n');

    // Act & Assert
    expect(extractInternalLinks(body)).toEqual(['customers.md', '../metrics/wau.md']);
  });

  it('strips a long query and fragment without regex backtracking', () => {
    // Arrange
    const suffix = `?${'filter=value&'.repeat(10_000)}#definition`;

    // Act & Assert
    expect(extractInternalLinks(`[metric](../metrics/wau.md${suffix})`)).toEqual([
      '../metrics/wau.md',
    ]);
  });
});

describe('resolveLink', () => {
  it('resolves relative links against the linking file', () => {
    expect(resolveLink('tables/orders.md', '../metrics/wau.md')).toBe('metrics/wau.md');
  });

  it('resolves the spec root-absolute form', () => {
    expect(resolveLink('tables/orders.md', '/tables/customers.md')).toBe('tables/customers.md');
  });

  it('rejects links escaping the bundle root', () => {
    expect(() => resolveLink('index.md', '../../etc/passwd.md')).toThrow(/escapes/);
  });
});

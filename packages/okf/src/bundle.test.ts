import { describe, expect, it } from 'vitest';
import { buildBundle, renderConcept } from './bundle';
import { generateIndex } from './index-gen';
import { generateLog } from './log-gen';
import type { ConceptDoc } from './concept';

/** The OKF blog post's own example, as a golden fixture. */
const ordersDoc: ConceptDoc = {
  path: 'tables/orders.md',
  frontmatter: {
    type: 'BigQuery Table',
    title: 'Orders',
    description: 'One row per completed customer order.',
    resource: 'https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders',
    tags: ['sales', 'revenue'],
    timestamp: '2026-05-28T14:30:00Z',
  },
  body: [
    '# Schema',
    '',
    '| Column | Type | Description |',
    '|--------|------|-------------|',
    '| `order_id` | STRING | Globally unique order identifier. |',
    '| `customer_id` | STRING | FK to [customers](customers.md). |',
    '',
    '# Joins',
    '',
    'Joined with [customers](customers.md) on `customer_id`.',
  ].join('\n'),
};

describe('renderConcept', () => {
  it('renders the golden fixture byte-exactly', () => {
    // Act
    const content = renderConcept(ordersDoc);

    // Assert
    expect(content).toBe(
      [
        '---',
        'type: BigQuery Table',
        'title: Orders',
        'description: One row per completed customer order.',
        'resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders',
        'tags: [sales, revenue]',
        'timestamp: 2026-05-28T14:30:00Z',
        '---',
        '',
        '# Schema',
        '',
        '| Column | Type | Description |',
        '|--------|------|-------------|',
        '| `order_id` | STRING | Globally unique order identifier. |',
        '| `customer_id` | STRING | FK to [customers](customers.md). |',
        '',
        '# Joins',
        '',
        'Joined with [customers](customers.md) on `customer_id`.',
        '',
      ].join('\n'),
    );
  });

  it('renders a bodyless concept as frontmatter only', () => {
    // Arrange
    const doc: ConceptDoc = { path: 'a.md', frontmatter: { type: 'Stub' }, body: '  \n' };

    // Act & Assert
    expect(renderConcept(doc)).toBe('---\ntype: Stub\n---\n');
  });
});

describe('buildBundle', () => {
  const customersDoc: ConceptDoc = {
    path: 'tables/customers.md',
    frontmatter: { type: 'BigQuery Table', title: 'Customers' },
    body: 'See [orders](orders.md).',
  };

  it('is byte-deterministic and path-sorted regardless of input order', () => {
    // Arrange
    const index = generateIndex({
      title: 'Sales',
      entries: [
        { path: 'tables/orders.md', title: 'Orders' },
        { path: 'tables/customers.md', title: 'Customers' },
      ],
    });
    const log = generateLog([
      { timestamp: '2026-05-28T14:30:00Z', summary: 'Initial capture.', details: ['2 tables'] },
    ]);

    // Act — two builds, different input order.
    const first = buildBundle([ordersDoc, customersDoc, index, log]);
    const second = buildBundle([log, index, customersDoc, ordersDoc]);

    // Assert — identical keys in sorted order, identical bytes.
    expect([...first.keys()]).toEqual([
      'index.md',
      'log.md',
      'tables/customers.md',
      'tables/orders.md',
    ]);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('rejects duplicate paths', () => {
    // Act & Assert
    expect(() => buildBundle([ordersDoc, { ...ordersDoc, body: 'other' }])).toThrow(/duplicate/);
  });

  it('rejects absolute and non-markdown paths', () => {
    // Act & Assert
    expect(() =>
      buildBundle([{ path: '/etc/x.md', frontmatter: { type: 'T' }, body: '' }]),
    ).toThrow(/invalid bundle path/);
    expect(() =>
      buildBundle([{ path: 'tables/orders.txt', frontmatter: { type: 'T' }, body: '' }]),
    ).toThrow(/invalid bundle path/);
  });
});

describe('generateIndex', () => {
  it('groups entries by top-level directory with sorted sections', () => {
    // Act
    const index = generateIndex({
      title: 'Sales knowledge',
      description: 'Bundle entry point.',
      entries: [
        { path: 'tables/orders.md', title: 'Orders', description: 'One row per order.' },
        { path: 'metrics/wau.md', title: 'Weekly Active Users' },
        { path: 'tables/customers.md', title: 'Customers' },
      ],
    });

    // Assert
    expect(index.path).toBe('index.md');
    expect(index.frontmatter.type).toBe('Index');
    expect(index.body).toBe(
      [
        '## metrics',
        '',
        '- [Weekly Active Users](metrics/wau.md)',
        '',
        '## tables',
        '',
        '- [Customers](tables/customers.md)',
        '- [Orders](tables/orders.md) — One row per order.',
      ].join('\n'),
    );
  });
});

describe('generateLog', () => {
  it('renders entries in caller order without reordering (append-only)', () => {
    // Act
    const log = generateLog([
      { timestamp: '2026-05-01T00:00:00Z', summary: 'First run.' },
      { timestamp: '2026-05-08T00:00:00Z', summary: 'Second run.', details: ['1 page touched'] },
    ]);

    // Assert
    expect(log.body).toBe(
      [
        '## 2026-05-01T00:00:00Z',
        '',
        'First run.',
        '',
        '## 2026-05-08T00:00:00Z',
        '',
        'Second run.',
        '',
        '- 1 page touched',
      ].join('\n'),
    );
  });
});

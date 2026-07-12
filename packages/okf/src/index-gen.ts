import type { ConceptDoc } from './concept';
import { relativeLink } from './links';

/**
 * `index.md` generation — the bundle's progressive-disclosure entry point.
 * Entries are grouped by top-level directory and sorted by path, so the index
 * is deterministic regardless of input order.
 */

export interface IndexEntry {
  readonly path: string;
  readonly title: string;
  readonly description?: string;
}

export interface IndexOptions {
  readonly title: string;
  readonly description?: string;
  readonly entries: readonly IndexEntry[];
}

const topLevelGroup = (path: string): string => {
  const index = path.indexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};

const entryLine = (entry: IndexEntry): string => {
  const link = `[${entry.title}](${relativeLink('index.md', entry.path)})`;
  return entry.description === undefined ? `- ${link}` : `- ${link} — ${entry.description}`;
};

export const generateIndex = (options: IndexOptions): ConceptDoc => {
  const sorted = [...options.entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of sorted) {
    const group = topLevelGroup(entry.path);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }

  const sections: string[] = [];
  for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const lines = entries.map(entryLine).join('\n');
    sections.push(group === '' ? lines : `## ${group}\n\n${lines}`);
  }

  return {
    path: 'index.md',
    frontmatter: {
      type: 'Index',
      title: options.title,
      ...(options.description !== undefined && { description: options.description }),
    },
    body: sections.join('\n\n'),
  };
};

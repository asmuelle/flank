import type { ConceptDoc } from './concept';

/**
 * `log.md` generation — the bundle's append-only change history. Callers pass
 * entries in chronological order (oldest first); rendering never reorders,
 * so successive bundle versions only ever append lines (git-diff friendly).
 */

export interface LogEntry {
  /** ISO-8601 instant carried from source data (run/event tables). */
  readonly timestamp: string;
  readonly summary: string;
  /** Optional detail bullets, e.g. pages touched or event hashes. */
  readonly details?: readonly string[];
}

const renderEntry = (entry: LogEntry): string => {
  const heading = `## ${entry.timestamp}`;
  const details = (entry.details ?? []).map((detail) => `- ${detail}`).join('\n');
  return details === ''
    ? `${heading}\n\n${entry.summary}`
    : `${heading}\n\n${entry.summary}\n\n${details}`;
};

export const generateLog = (entries: readonly LogEntry[]): ConceptDoc => ({
  path: 'log.md',
  frontmatter: { type: 'Log', title: 'Change log' },
  body: entries.map(renderEntry).join('\n\n'),
});

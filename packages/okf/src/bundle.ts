import type { ConceptDoc } from './concept';
import { emitFrontmatter } from './frontmatter';

/**
 * Render a concept doc to its exact file content. Byte-deterministic: fixed
 * frontmatter key order, trimmed body, LF endings, single trailing newline.
 */
export const renderConcept = (doc: ConceptDoc): string => {
  const header = `---\n${emitFrontmatter(doc.frontmatter)}\n---\n`;
  const body = doc.body.trim();
  return body === '' ? header : `${header}\n${body}\n`;
};

const BUNDLE_PATH = /^[a-z0-9][a-z0-9/._-]*\.md$/;

/**
 * Build a bundle as an immutable path → content map, sorted by path so
 * iteration (and any archive built from it) is deterministic. Duplicate or
 * malformed paths are producer bugs and fail fast; content-level problems are
 * the validator's job.
 */
export const buildBundle = (docs: readonly ConceptDoc[]): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  for (const doc of [...docs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!BUNDLE_PATH.test(doc.path)) {
      throw new Error(`invalid bundle path (want relative kebab-case .md): ${doc.path}`);
    }
    if (files.has(doc.path)) {
      throw new Error(`duplicate bundle path: ${doc.path}`);
    }
    files.set(doc.path, renderConcept(doc));
  }
  return files;
};

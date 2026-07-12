import type { ConceptDoc } from './concept';
import { extractInternalLinks, resolveLink } from './links';

/**
 * Structural bundle validation. Check IDs follow the shared lint spec
 * (.scaffold/okf-lint-spec.md); semantic checks (UNVERIFIED_CITATION,
 * CONTRADICTION, STALE_EFFECTIVE_DATE, SOURCE_GONE) need app/domain context
 * and live in each app's pipeline, not here.
 */

export type LintCheck =
  'EMPTY_BUNDLE' | 'DUPLICATE_PATH' | 'MISSING_TYPE' | 'BROKEN_LINK' | 'ORPHAN';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  /**
   * Structural IDs come from {@link LintCheck}; apps may emit semantic IDs
   * (UNVERIFIED_CITATION, …) per the shared lint spec in the same shape.
   */
  readonly check: LintCheck | (string & {});
  readonly severity: LintSeverity;
  /** Bundle path the finding is anchored to ('' for bundle-level findings). */
  readonly path: string;
  readonly message: string;
}

/** Entry points are reachable by convention, so they are never orphans. */
const ENTRY_POINTS = new Set(['index.md', 'log.md']);

export const validateBundle = (docs: readonly ConceptDoc[]): LintFinding[] => {
  if (docs.length === 0) {
    return [
      {
        check: 'EMPTY_BUNDLE',
        severity: 'error',
        path: '',
        message: 'bundle contains no concept documents',
      },
    ];
  }

  const findings: LintFinding[] = [];
  const paths = new Set<string>();
  for (const doc of docs) {
    if (paths.has(doc.path)) {
      findings.push({
        check: 'DUPLICATE_PATH',
        severity: 'error',
        path: doc.path,
        message: `more than one concept renders to ${doc.path}`,
      });
    }
    paths.add(doc.path);
    if (doc.frontmatter.type.trim() === '') {
      findings.push({
        check: 'MISSING_TYPE',
        severity: 'error',
        path: doc.path,
        message: 'frontmatter is missing the mandatory type field',
      });
    }
  }

  const linkedTargets = new Set<string>();
  for (const doc of docs) {
    for (const href of extractInternalLinks(doc.body)) {
      let target: string;
      try {
        target = resolveLink(doc.path, href);
      } catch {
        findings.push({
          check: 'BROKEN_LINK',
          severity: 'error',
          path: doc.path,
          message: `link escapes the bundle root: ${href}`,
        });
        continue;
      }
      if (paths.has(target)) {
        linkedTargets.add(target);
      } else {
        findings.push({
          check: 'BROKEN_LINK',
          severity: 'error',
          path: doc.path,
          message: `link target does not exist in bundle: ${href}`,
        });
      }
    }
  }

  for (const doc of docs) {
    if (ENTRY_POINTS.has(doc.path)) continue;
    if (!linkedTargets.has(doc.path)) {
      findings.push({
        check: 'ORPHAN',
        severity: 'warning',
        path: doc.path,
        message: 'no other concept links to this document',
      });
    }
  }

  return findings;
};

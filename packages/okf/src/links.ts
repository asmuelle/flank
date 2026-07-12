/**
 * Bundle-internal linking. Concepts link to each other with normal markdown
 * links — that graph IS the OKF knowledge graph, so link construction and
 * resolution must be exact and deterministic.
 */

/** Stable, filesystem-safe slug for concept file names. */
export const slugify = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const dirname = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};

/** Normalize `.` / `..` segments in a bundle-relative POSIX path. */
const normalizeSegments = (path: string): string => {
  const output: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) {
        throw new Error(`link escapes the bundle root: ${path}`);
      }
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return output.join('/');
};

/**
 * Relative link target from one bundle file to another, e.g.
 * `tables/orders.md` → `metrics/wau.md` yields `../metrics/wau.md`.
 */
export const relativeLink = (fromPath: string, toPath: string): string => {
  const fromSegments = dirname(fromPath) === '' ? [] : dirname(fromPath).split('/');
  const toSegments = toPath.split('/');
  let common = 0;
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1;
  }
  const ups = fromSegments.length - common;
  return [...Array<string>(ups).fill('..'), ...toSegments.slice(common)].join('/');
};

/** Markdown link to another concept, relative to the linking file. */
export const markdownLink = (title: string, fromPath: string, toPath: string): string =>
  `[${title}](${relativeLink(fromPath, toPath)})`;

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Extract bundle-internal link targets from a markdown body. External URLs
 * (http:, mailto:, …) are skipped; fragments and queries are stripped.
 */
export const extractInternalLinks = (body: string): string[] => {
  const targets: string[] = [];
  for (const match of body.matchAll(/\]\(([^()\s]+)\)/g)) {
    const href = (match[1] ?? '').replace(/[#?].*$/, '');
    if (href === '' || EXTERNAL_SCHEME.test(href)) continue;
    targets.push(href);
  }
  return targets;
};

/**
 * Resolve a link found in `fromPath` to a normalized bundle-relative path.
 * Supports both relative links (`../tables/orders.md`) and the spec's
 * root-absolute form (`/tables/customers.md`).
 */
export const resolveLink = (fromPath: string, href: string): string => {
  if (href.startsWith('/')) return normalizeSegments(href.slice(1));
  const base = dirname(fromPath);
  return normalizeSegments(base === '' ? href : `${base}/${href}`);
};

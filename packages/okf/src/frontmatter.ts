import { FRONTMATTER_KEY_ORDER, type ConceptFrontmatter } from './concept';

/**
 * Deterministic emitter/parser for the small YAML subset OKF frontmatter
 * needs: string scalars and flat string arrays. Hand-rolled instead of a YAML
 * dependency so output bytes are fully under our control (key order, quoting)
 * and the package stays dependency-free.
 */

/**
 * Values that a YAML parser would read as a non-string (bool, null, number)
 * must be quoted so consumers always get strings back.
 */
const YAML_NON_STRING = /^(?:true|false|null|~|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i;

const needsQuoting = (value: string): boolean => {
  if (value === '') return true;
  if (YAML_NON_STRING.test(value)) return true;
  if (value !== value.trim()) return true;
  if (value.includes(': ') || value.endsWith(':')) return true;
  if (value.includes(' #') || value.includes('\n')) return true;
  // Leading characters that carry YAML syntax meaning.
  if (/^[-?[\]{}>|*&!%@`"'#,]/.test(value)) return true;
  return value.includes("'") || value.includes('"');
};

const quoteScalar = (value: string): string =>
  needsQuoting(value) ? `'${value.replaceAll("'", "''")}'` : value;

const unquoteScalar = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const emitArray = (values: readonly string[]): string =>
  `[${values.map(quoteScalar).join(', ')}]`;

/** Split an inline YAML array body on top-level commas (quote-aware). */
const splitInlineArray = (body: string): string[] => {
  const items: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "'") {
      // '' inside a quoted scalar is an escaped quote, not a boundary.
      if (inQuote && body[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      current += char;
    } else if (char === ',' && !inQuote) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') items.push(current);
  return items.map(unquoteScalar);
};

/**
 * Render frontmatter to YAML lines: standard keys in FRONTMATTER_KEY_ORDER,
 * then `extra` keys in sorted order. Deterministic by construction.
 */
export const emitFrontmatter = (frontmatter: ConceptFrontmatter): string => {
  const lines: string[] = [];
  for (const key of FRONTMATTER_KEY_ORDER) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    lines.push(
      Array.isArray(value)
        ? `${key}: ${emitArray(value)}`
        : `${key}: ${quoteScalar(value as string)}`,
    );
  }
  const extraEntries = Object.entries(frontmatter.extra ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  for (const [key, value] of extraEntries) {
    lines.push(`${key}: ${quoteScalar(value)}`);
  }
  return lines.join('\n');
};

export interface ParsedConcept {
  readonly frontmatter: ConceptFrontmatter;
  readonly body: string;
}

/**
 * Parse a rendered concept document back into frontmatter + body. Inverse of
 * the emitter for the subset it produces; used by consumers reading bundles
 * and by round-trip tests.
 */
export const parseConcept = (content: string): ParsedConcept => {
  if (!content.startsWith('---\n')) {
    throw new Error('concept document must start with a frontmatter block (---)');
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error('unterminated frontmatter block');
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + '\n---\n'.length).replace(/^\n/, '').replace(/\n$/, '');

  let type = '';
  const scalars: Record<string, string> = {};
  let tags: readonly string[] | undefined;
  for (const line of yamlBlock.split('\n')) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(': ');
    if (separator === -1) {
      throw new Error(`unparseable frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator);
    const rawValue = line.slice(separator + 2);
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      if (key !== 'tags') {
        throw new Error(`array values are only supported for tags, got: ${key}`);
      }
      tags = splitInlineArray(rawValue.slice(1, -1));
    } else if (key === 'type') {
      type = unquoteScalar(rawValue);
    } else {
      scalars[key] = unquoteScalar(rawValue);
    }
  }

  const standard = new Set<string>(FRONTMATTER_KEY_ORDER);
  const extraEntries = Object.entries(scalars).filter(([key]) => !standard.has(key));
  const frontmatter: ConceptFrontmatter = {
    type,
    ...(scalars.title !== undefined && { title: scalars.title }),
    ...(scalars.description !== undefined && { description: scalars.description }),
    ...(scalars.resource !== undefined && { resource: scalars.resource }),
    ...(tags !== undefined && { tags }),
    ...(scalars.timestamp !== undefined && { timestamp: scalars.timestamp }),
    ...(extraEntries.length > 0 && { extra: Object.fromEntries(extraEntries) }),
  };
  return { frontmatter, body };
};

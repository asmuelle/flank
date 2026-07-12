/**
 * OKF concept document model (spec v0.1). A bundle is a directory of markdown
 * concept docs; `type` is the only mandatory frontmatter field. Everything in
 * this package is a pure function over these types — writing to disk/S3/git is
 * the consuming app's job (producer/consumer separation).
 */

/**
 * Fixed rendering order for the standard frontmatter keys so identical input
 * always yields identical bytes (bundles must stay git-diffable).
 */
export const FRONTMATTER_KEY_ORDER = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'timestamp',
] as const;

export interface ConceptFrontmatter {
  /** The only mandatory OKF field, e.g. "Battlecard", "Postgres Table". */
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  /** Deep link back into the producing app or source system. */
  readonly resource?: string;
  readonly tags?: readonly string[];
  /**
   * ISO-8601 instant carried from source data. Never wall-clock at render
   * time — that would break byte-determinism.
   */
  readonly timestamp?: string;
  /**
   * Producer-defined fields beyond the standard set, rendered after the
   * standard keys in sorted key order. Values are always strings.
   */
  readonly extra?: Readonly<Record<string, string>>;
}

export interface ConceptDoc {
  /** Bundle-relative POSIX path, e.g. `tables/orders.md`. */
  readonly path: string;
  readonly frontmatter: ConceptFrontmatter;
  /** Markdown body without the frontmatter block. */
  readonly body: string;
}

import { createHash } from 'node:crypto';

/**
 * A bundle manifest: bundle-relative path → sha256 of its file content. The manifest is what a
 * delivery persists and what the next run diffs against — comparing hashes, never re-reading the
 * remote repo, so "what changed" is deterministic and offline-computable.
 */
export type BundleManifest = ReadonlyMap<string, string>;

const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/** Manifest of a rendered bundle (path → content). */
export const manifestOf = (files: ReadonlyMap<string, string>): BundleManifest => {
  const manifest = new Map<string, string>();
  for (const [path, content] of files) manifest.set(path, sha256(content));
  return manifest;
};

/** A plain object form for persistence (jsonb), path-sorted so stored manifests are stable. */
export const manifestToRecord = (manifest: BundleManifest): Readonly<Record<string, string>> =>
  Object.fromEntries([...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

/** Restore a manifest from its persisted record form. */
export const manifestFromRecord = (record: Readonly<Record<string, string>>): BundleManifest =>
  new Map(Object.entries(record));

export interface BundleDiff {
  /** Paths present only in `next`. */
  readonly added: readonly string[];
  /** Paths in both whose content hash changed. */
  readonly modified: readonly string[];
  /** Paths present only in `previous`. */
  readonly removed: readonly string[];
  /** Paths in both with an unchanged hash. */
  readonly unchanged: readonly string[];
}

/** True when the diff represents no change at all — the signal to skip a delivery. */
export const isEmptyDiff = (diff: BundleDiff): boolean =>
  diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;

/**
 * Diff two manifests into added/modified/removed/unchanged path lists (each sorted). This is the
 * "what changed since the last delivery" the Slack alert links to and the delivery record counts.
 */
export const diffManifests = (previous: BundleManifest, next: BundleManifest): BundleDiff => {
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const [path, hash] of next) {
    const before = previous.get(path);
    if (before === undefined) added.push(path);
    else if (before === hash) unchanged.push(path);
    else modified.push(path);
  }
  const removed: string[] = [];
  for (const path of previous.keys()) {
    if (!next.has(path)) removed.push(path);
  }
  const sort = (paths: string[]): string[] => paths.sort((a, b) => (a < b ? -1 : 1));
  return {
    added: sort(added),
    modified: sort(modified),
    removed: sort(removed),
    unchanged: sort(unchanged),
  };
};

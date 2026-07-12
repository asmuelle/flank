import type { BundleDiff } from './manifest';

/**
 * A customer-designated git destination for a workspace's OKF bundle. Operator-configured for M2
 * (self-serve UI config deferred); the sweep receives a list of these.
 */
export interface GitBundleTarget {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Only 'github' is implemented; the field keeps the port provider-neutral. */
  readonly provider: 'github';
  /** `owner/name`. */
  readonly repo: string;
  /** The branch the bundle commit lands on (created from `baseBranch` if absent). */
  readonly branch: string;
  /** The branch a pull request targets; when null, the commit is pushed without opening a PR. */
  readonly baseBranch: string | null;
  /** Directory the bundle is written under, e.g. `intel/acme` (no leading/trailing slash). */
  readonly subdir: string;
}

/** A request to publish one bundle: the files (already under `target.subdir`) plus the diff context. */
export interface BundlePublishRequest {
  readonly target: GitBundleTarget;
  /** Full current bundle as repo-relative path → content (paths already prefixed with subdir). */
  readonly files: ReadonlyMap<string, string>;
  /** Paths (repo-relative) to delete — the diff's removed set mapped under the subdir. */
  readonly deletions: readonly string[];
  readonly commitMessage: string;
  /** The bundle diff, for a publisher that wants to describe the change (e.g. PR body). */
  readonly diff: BundleDiff;
}

export type BundlePublishResult =
  | {
      readonly ok: true;
      readonly commitSha: string;
      readonly branchRef: string;
      readonly pullRequestUrl: string | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Port for pushing a bundle to a git host. Concrete impls (GitHub) live in the pipeline package,
 * mirroring the Notifier port/impl split; the pure delivery orchestration depends only on this.
 */
export interface BundlePublisher {
  publish(request: BundlePublishRequest): Promise<BundlePublishResult>;
}

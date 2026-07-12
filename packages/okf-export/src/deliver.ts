import type { LintFinding } from '@okf/core';
import {
  diffManifests,
  isEmptyDiff,
  manifestOf,
  type BundleDiff,
  type BundleManifest,
} from './manifest';
import type { BundlePublishRequest, GitBundleTarget } from './publisher';

export interface PlanDeliveryInput {
  readonly target: GitBundleTarget;
  /** The projected bundle (path → content) from {@link projectWorkspaceBundle}. */
  readonly files: ReadonlyMap<string, string>;
  /** Findings from the projection; any `error` severity blocks the delivery (projection-only rule). */
  readonly findings: readonly LintFinding[];
  /** Manifest of the last published delivery, or an empty manifest for a first delivery. */
  readonly previousManifest: BundleManifest;
}

/**
 * The delivery decision for one workspace, fully determined by the inputs (pure):
 *  - `blocked` — an error finding refused the bundle; nothing is pushed, a failed record is written.
 *  - `unchanged` — the bundle is byte-identical to the last delivery; nothing is pushed or recorded.
 *  - `publish` — the bundle changed; `request` is ready for the {@link BundlePublisher}.
 */
export type PlannedDelivery =
  | { readonly kind: 'blocked'; readonly blockingFindings: readonly LintFinding[] }
  | { readonly kind: 'unchanged'; readonly manifest: BundleManifest; readonly diff: BundleDiff }
  | {
      readonly kind: 'publish';
      readonly request: BundlePublishRequest;
      readonly manifest: BundleManifest;
      readonly diff: BundleDiff;
    };

const underSubdir = (subdir: string, path: string): string =>
  subdir === '' ? path : `${subdir}/${path}`;

const commitMessage = (target: GitBundleTarget, diff: BundleDiff): string =>
  `chore(okf): update ${target.workspaceName} competitive bundle ` +
  `(+${diff.added.length} ~${diff.modified.length} -${diff.removed.length})`;

/** Decide what to do with a projected bundle for one target. Pure — no I/O, deterministic. */
export const planDelivery = (input: PlanDeliveryInput): PlannedDelivery => {
  const blockingFindings = input.findings.filter((finding) => finding.severity === 'error');
  if (blockingFindings.length > 0) {
    return { kind: 'blocked', blockingFindings };
  }

  const manifest = manifestOf(input.files);
  const diff = diffManifests(input.previousManifest, manifest);
  if (isEmptyDiff(diff)) {
    return { kind: 'unchanged', manifest, diff };
  }

  const { subdir } = input.target;
  const files = new Map<string, string>();
  for (const [path, content] of input.files) files.set(underSubdir(subdir, path), content);
  const deletions = diff.removed.map((path) => underSubdir(subdir, path));

  return {
    kind: 'publish',
    manifest,
    diff,
    request: {
      target: input.target,
      files,
      deletions,
      commitMessage: commitMessage(input.target, diff),
      diff,
    },
  };
};

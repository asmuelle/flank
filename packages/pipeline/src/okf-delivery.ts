import type { BundleDelivery, FlankStore } from '@flank/core';
import {
  loadWorkspaceExport,
  manifestFromRecord,
  manifestToRecord,
  planDelivery,
  projectWorkspaceBundle,
  type BundlePublisher,
  type GitBundleTarget,
} from '@flank/okf-export';
import { liveBanBundlePublisher } from './github-publisher';

export interface OkfDeliveryDeps {
  readonly store: FlankStore;
  /** Defaults to {@link liveBanBundlePublisher} so a test that forgets to inject one fails loud. */
  readonly publisher?: BundlePublisher;
  readonly nextId: () => string;
}

export interface OkfDeliveryOptions {
  /** App origin for `resource:` deep links in the projected bundle. */
  readonly baseUrl: string;
}

export interface OkfDeliveryReport {
  readonly targetsConsidered: number;
  readonly published: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly failed: number;
  /** Targets that threw before a decision (load/project/store error) — never aborts the sweep. */
  readonly errors: number;
}

const blockedError = (findings: readonly { readonly message: string }[]): string =>
  `blocked by ${findings.length} error finding(s): ${findings
    .map((finding) => finding.message)
    .slice(0, 5)
    .join('; ')}`;

/**
 * One OKF delivery sweep: for each configured target, project the workspace's bundle, diff it
 * against the last published delivery, and push only when something changed. Enforces the
 * projection-only rule (an error finding blocks the push and records a failed attempt) and never
 * lets one target abort the others. Only `published`/`failed` attempts are recorded — an unchanged
 * bundle ships and records nothing.
 */
export const runOkfDelivery = async (
  deps: OkfDeliveryDeps,
  targets: readonly GitBundleTarget[],
  now: Date,
  options: OkfDeliveryOptions,
): Promise<OkfDeliveryReport> => {
  const publisher = deps.publisher ?? liveBanBundlePublisher;
  let published = 0;
  let unchanged = 0;
  let blocked = 0;
  let failed = 0;
  let errors = 0;

  const record = (delivery: BundleDelivery): Promise<BundleDelivery> =>
    deps.store.insertBundleDelivery(delivery);

  for (const target of targets) {
    try {
      const input = await loadWorkspaceExport(
        deps.store,
        { id: target.workspaceId, name: target.workspaceName },
        options.baseUrl,
      );
      const { files, findings } = projectWorkspaceBundle(input);

      const previous = await deps.store.latestPublishedBundleDelivery(target.workspaceId);
      const previousManifest =
        previous === null ? new Map<string, string>() : manifestFromRecord(previous.manifest);

      const plan = planDelivery({ target, files, findings, previousManifest });

      if (plan.kind === 'unchanged') {
        unchanged += 1;
        continue;
      }

      if (plan.kind === 'blocked') {
        await record(
          failedDelivery(deps.nextId(), target.workspaceId, now, blockedError(plan.blockingFindings)),
        );
        blocked += 1;
        continue;
      }

      const result = await publisher.publish(plan.request);
      if (result.ok) {
        await record({
          id: deps.nextId(),
          workspaceId: target.workspaceId,
          status: 'published',
          commitSha: result.commitSha,
          branchRef: result.branchRef,
          pullRequestUrl: result.pullRequestUrl,
          manifest: manifestToRecord(plan.manifest),
          filesAdded: plan.diff.added.length,
          filesModified: plan.diff.modified.length,
          filesRemoved: plan.diff.removed.length,
          error: null,
          createdAt: now,
        });
        published += 1;
      } else {
        await record(failedDelivery(deps.nextId(), target.workspaceId, now, result.error));
        failed += 1;
      }
    } catch {
      errors += 1;
    }
  }

  return Object.freeze({
    targetsConsidered: targets.length,
    published,
    unchanged,
    blocked,
    failed,
    errors,
  });
};

const failedDelivery = (
  id: string,
  workspaceId: string,
  now: Date,
  error: string,
): BundleDelivery =>
  Object.freeze({
    id,
    workspaceId,
    status: 'failed',
    commitSha: null,
    branchRef: null,
    pullRequestUrl: null,
    manifest: {},
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    error,
    createdAt: now,
  });

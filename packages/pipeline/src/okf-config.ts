import type { BundlePublisher, GitBundleTarget } from '@flank/okf-export';
import { z } from 'zod';
import { GitHubBundlePublisher, liveBanBundlePublisher } from './github-publisher';

/** Boundary validation for an operator-configured delivery target (M2 config via env JSON). */
const GitBundleTargetSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  provider: z.literal('github'),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be owner/name'),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).nullable().default(null),
  // Normalize away leading/trailing slashes so path-joining stays predictable.
  subdir: z
    .string()
    .default('')
    .transform((value) => value.replace(/^\/+|\/+$/g, '')),
});

/**
 * Parse the `FLANK_OKF_TARGETS` env var (a JSON array) into validated targets. Absent/blank → no
 * targets (the sweep no-ops). Malformed JSON or a bad target throws — fail closed, never deliver to
 * an unintended repo.
 */
export const parseOkfTargets = (raw: string | undefined): readonly GitBundleTarget[] => {
  if (raw === undefined || raw.trim() === '') return [];
  const parsed = z.array(GitBundleTargetSchema).parse(JSON.parse(raw));
  return Object.freeze(parsed.map((target) => Object.freeze(target)));
};

/**
 * Build the git publisher from env: a real {@link GitHubBundlePublisher} when
 * `FLANK_OKF_GITHUB_TOKEN` is set, else the live-ban publisher (which throws if ever called — safe
 * because with no token the operator also configures no targets, so the sweep never publishes).
 */
export const createOkfPublisher = (
  env: Readonly<Record<string, string | undefined>>,
): BundlePublisher => {
  const token = env.FLANK_OKF_GITHUB_TOKEN;
  return token !== undefined && token !== ''
    ? new GitHubBundlePublisher({ token })
    : liveBanBundlePublisher;
};

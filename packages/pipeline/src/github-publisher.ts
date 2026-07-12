import type { BundlePublishRequest, BundlePublishResult, BundlePublisher } from '@flank/okf-export';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_API_BASE = 'https://api.github.com';
const BLOB_MODE = '100644';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubPublisherOptions {
  /**
   * A token with contents:write (and pull-requests:write when opening PRs) on the customer repos —
   * a GitHub App installation token or PAT. One token serves every configured target, mirroring the
   * single-credential Notifier impls; per-target credentials can come later.
   */
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
  readonly timeoutMs?: number;
  readonly apiBase?: string;
}

/** Thrown by {@link liveBanBundlePublisher}: any push in a hermetic test is a breach. */
export class LivePublishBannedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivePublishBannedError';
  }
}

/** Default for unit tests: any publish throws instead of dialing out. Inject a fake to actually push. */
export const liveBanBundlePublisher: BundlePublisher = {
  async publish(): Promise<BundlePublishResult> {
    throw new LivePublishBannedError(
      'refusing a live git push: tests/CI are hermetic — inject a fake publisher',
    );
  },
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface GhResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Publishes an OKF bundle to a GitHub repo via the Git Data API: build a tree on top of the head
 * branch's current tree (unchanged files persist, deletions null out their blob), commit it, fast-
 * forward the branch ref, and open/reuse a PR when a base branch is configured. All network failures
 * are caught and returned as `{ ok: false }` so one target never aborts the delivery sweep.
 */
export class GitHubBundlePublisher implements BundlePublisher {
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly apiBase: string;

  constructor(private readonly options: GitHubPublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
  }

  async publish(request: BundlePublishRequest): Promise<BundlePublishResult> {
    const { target } = request;
    try {
      const baseBranchName = target.baseBranch ?? target.branch;
      const headSha = await this.resolveHeadSha(target.repo, target.branch, baseBranchName);
      const headTreeSha = await this.commitTreeSha(target.repo, headSha);

      const tree = [
        ...[...request.files.entries()].map(([path, content]) => ({
          path,
          mode: BLOB_MODE,
          type: 'blob' as const,
          content,
        })),
        // A null sha removes the path from the tree (a deletion).
        ...request.deletions.map((path) => ({
          path,
          mode: BLOB_MODE,
          type: 'blob' as const,
          sha: null,
        })),
      ];

      const newTree = await this.gh('POST', `/repos/${target.repo}/git/trees`, {
        base_tree: headTreeSha,
        tree,
      });
      const newTreeSha = asString(readField(newTree.body, 'sha'), 'git/trees.sha');

      const commit = await this.gh('POST', `/repos/${target.repo}/git/commits`, {
        message: request.commitMessage,
        tree: newTreeSha,
        parents: [headSha],
      });
      const commitSha = asString(readField(commit.body, 'sha'), 'git/commits.sha');

      await this.gh('PATCH', `/repos/${target.repo}/git/refs/heads/${target.branch}`, {
        sha: commitSha,
        force: false,
      });

      const pullRequestUrl =
        target.baseBranch !== null && target.baseBranch !== target.branch
          ? await this.ensurePullRequest(target.repo, target.branch, target.baseBranch, request)
          : null;

      return {
        ok: true,
        commitSha,
        branchRef: `refs/heads/${target.branch}`,
        pullRequestUrl,
      };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** Current tip of `branch`, creating it from `baseBranch` when it does not yet exist. */
  private async resolveHeadSha(repo: string, branch: string, baseBranch: string): Promise<string> {
    const existing = await this.gh(
      'GET',
      `/repos/${repo}/git/ref/heads/${branch}`,
      undefined,
      [404],
    );
    if (existing.status !== 404) {
      return asString(readField(existing.body, 'object', 'sha'), 'git/ref.object.sha');
    }
    // Branch absent — branch off the base branch's tip.
    const base = await this.gh('GET', `/repos/${repo}/git/ref/heads/${baseBranch}`);
    const baseSha = asString(readField(base.body, 'object', 'sha'), 'git/ref.object.sha');
    await this.gh('POST', `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
    return baseSha;
  }

  private async commitTreeSha(repo: string, commitSha: string): Promise<string> {
    const commit = await this.gh('GET', `/repos/${repo}/git/commits/${commitSha}`);
    return asString(readField(commit.body, 'tree', 'sha'), 'git/commits.tree.sha');
  }

  /** Open a PR head→base, or return the URL of the one already open for that head. */
  private async ensurePullRequest(
    repo: string,
    head: string,
    base: string,
    request: BundlePublishRequest,
  ): Promise<string | null> {
    const created = await this.gh(
      'POST',
      `/repos/${repo}/pulls`,
      {
        title: request.commitMessage,
        head,
        base,
        body: pullRequestBody(request),
      },
      [422], // 422 == a PR for this head already exists
    );
    if (created.status !== 422) {
      return asStringOrNull(readField(created.body, 'html_url'));
    }
    const owner = repo.split('/')[0];
    const existing = await this.gh(
      'GET',
      `/repos/${repo}/pulls?state=open&head=${owner}:${head}&base=${base}`,
    );
    return Array.isArray(existing.body) && existing.body.length > 0
      ? asStringOrNull(readField(existing.body[0], 'html_url'))
      : null;
  }

  private async gh(
    method: string,
    path: string,
    body?: unknown,
    allowStatuses: readonly number[] = [],
  ): Promise<GhResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text === '' ? null : JSON.parse(text);
      if (!response.ok && !allowStatuses.includes(response.status)) {
        throw new Error(`GitHub ${method} ${path} → ${response.status}: ${truncate(text)}`);
      }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }
}

const truncate = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const pullRequestBody = (request: BundlePublishRequest): string =>
  [
    `Automated OKF bundle update for **${request.target.workspaceName}**.`,
    '',
    `- ${request.diff.added.length} added`,
    `- ${request.diff.modified.length} modified`,
    `- ${request.diff.removed.length} removed`,
    '',
    'Generated from published, claim-verified dossiers and battlecards. See `log.md` for history.',
  ].join('\n');

/** Read a nested field from an unknown JSON body without asserting a shape up front. */
const readField = (body: unknown, ...path: readonly string[]): unknown => {
  let current = body;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`GitHub response missing ${label}`);
  }
  return value;
};

const asStringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

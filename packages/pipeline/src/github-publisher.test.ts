import type { BundlePublishRequest, GitBundleTarget } from '@flank/okf-export';
import { describe, expect, it } from 'vitest';
import {
  GitHubBundlePublisher,
  LivePublishBannedError,
  liveBanBundlePublisher,
} from './github-publisher';

const TARGET: GitBundleTarget = {
  workspaceId: 'ws-a',
  workspaceName: 'Acme',
  provider: 'github',
  repo: 'acme/intel',
  branch: 'flank-okf',
  baseBranch: 'main',
  subdir: 'intel/acme',
};

const request = (over: Partial<BundlePublishRequest> = {}): BundlePublishRequest => ({
  target: TARGET,
  files: new Map([['intel/acme/index.md', 'hello']]),
  deletions: ['intel/acme/competitors/gone/index.md'],
  commitMessage: 'chore(okf): update Acme competitive bundle (+1 ~0 -1)',
  diff: { added: ['index.md'], modified: [], removed: ['competitors/gone/index.md'], unchanged: [] },
  ...over,
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A scripted GitHub API: route on `METHOD /path` → [status, body]; records every call. */
const fakeGitHub = (routes: Record<string, [number, unknown]>) => {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    const path = url.replace('https://api.github.test', '');
    calls.push({
      method,
      path,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    const [status, body] = route;
    return new Response(body === null ? '' : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
};

const HAPPY_ROUTES: Record<string, [number, unknown]> = {
  'GET /repos/acme/intel/git/ref/heads/flank-okf': [200, { object: { sha: 'headsha' } }],
  'GET /repos/acme/intel/git/commits/headsha': [200, { tree: { sha: 'basetree' } }],
  'POST /repos/acme/intel/git/trees': [201, { sha: 'newtree' }],
  'POST /repos/acme/intel/git/commits': [201, { sha: 'newcommit' }],
  'PATCH /repos/acme/intel/git/refs/heads/flank-okf': [200, {}],
  'POST /repos/acme/intel/pulls': [201, { html_url: 'https://github.com/acme/intel/pull/7' }],
};

describe('GitHubBundlePublisher', () => {
  it('commits the bundle onto an existing branch and opens a PR', async () => {
    // Arrange
    const { fetchImpl, calls } = fakeGitHub(HAPPY_ROUTES);
    const publisher = new GitHubBundlePublisher({
      token: 't',
      fetchImpl,
      apiBase: 'https://api.github.test',
    });

    // Act
    const result = await publisher.publish(request());

    // Assert
    expect(result).toEqual({
      ok: true,
      commitSha: 'newcommit',
      branchRef: 'refs/heads/flank-okf',
      pullRequestUrl: 'https://github.com/acme/intel/pull/7',
    });
    // The tree is built on the branch's current tree, with content blobs and a null-sha deletion.
    const treeCall = calls.find((c) => c.path === '/repos/acme/intel/git/trees');
    const tree = (treeCall?.body as { base_tree: string; tree: unknown[] }) ?? { base_tree: '', tree: [] };
    expect(tree.base_tree).toBe('basetree');
    expect(tree.tree).toContainEqual({
      path: 'intel/acme/index.md',
      mode: '100644',
      type: 'blob',
      content: 'hello',
    });
    expect(tree.tree).toContainEqual({
      path: 'intel/acme/competitors/gone/index.md',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    // The new commit's parent is the prior head.
    const commitCall = calls.find((c) => c.path === '/repos/acme/intel/git/commits');
    expect((commitCall?.body as { parents: string[] }).parents).toEqual(['headsha']);
  });

  it('creates the head branch from the base branch when it is missing', async () => {
    // Arrange — branch ref 404s; base ref + create-ref are scripted.
    const { fetchImpl, calls } = fakeGitHub({
      ...HAPPY_ROUTES,
      'GET /repos/acme/intel/git/ref/heads/flank-okf': [404, { message: 'Not Found' }],
      'GET /repos/acme/intel/git/ref/heads/main': [200, { object: { sha: 'basesha' } }],
      'POST /repos/acme/intel/git/refs': [201, { ref: 'refs/heads/flank-okf' }],
      'GET /repos/acme/intel/git/commits/basesha': [200, { tree: { sha: 'basetree' } }],
    });
    const publisher = new GitHubBundlePublisher({
      token: 't',
      fetchImpl,
      apiBase: 'https://api.github.test',
    });

    // Act
    const result = await publisher.publish(request());

    // Assert — created the branch off basesha and committed with basesha as parent.
    expect(result.ok).toBe(true);
    const createRef = calls.find((c) => c.path === '/repos/acme/intel/git/refs');
    expect(createRef?.body).toEqual({ ref: 'refs/heads/flank-okf', sha: 'basesha' });
  });

  it('skips the PR when no base branch is configured', async () => {
    // Arrange
    const { fetchImpl, calls } = fakeGitHub(HAPPY_ROUTES);
    const publisher = new GitHubBundlePublisher({
      token: 't',
      fetchImpl,
      apiBase: 'https://api.github.test',
    });

    // Act
    const result = await publisher.publish(
      request({ target: { ...TARGET, baseBranch: null } }),
    );

    // Assert
    expect(result).toMatchObject({ ok: true, pullRequestUrl: null });
    expect(calls.some((c) => c.path === '/repos/acme/intel/pulls')).toBe(false);
  });

  it('returns ok:false with the status when the API errors, never throwing', async () => {
    // Arrange — the tree call 500s.
    const { fetchImpl } = fakeGitHub({
      ...HAPPY_ROUTES,
      'POST /repos/acme/intel/git/trees': [500, { message: 'boom' }],
    });
    const publisher = new GitHubBundlePublisher({
      token: 't',
      fetchImpl,
      apiBase: 'https://api.github.test',
    });

    // Act
    const result = await publisher.publish(request());

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('500');
  });
});

describe('liveBanBundlePublisher', () => {
  it('throws instead of dialing out', async () => {
    await expect(liveBanBundlePublisher.publish(request())).rejects.toBeInstanceOf(
      LivePublishBannedError,
    );
  });
});

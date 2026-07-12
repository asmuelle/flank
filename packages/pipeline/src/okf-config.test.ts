import { describe, expect, it } from 'vitest';
import { GitHubBundlePublisher, liveBanBundlePublisher } from './github-publisher';
import { createOkfPublisher, parseOkfTargets } from './okf-config';

describe('parseOkfTargets', () => {
  it('returns no targets for absent or blank config', () => {
    expect(parseOkfTargets(undefined)).toEqual([]);
    expect(parseOkfTargets('   ')).toEqual([]);
  });

  it('parses and normalizes a valid target array', () => {
    // Arrange
    const raw = JSON.stringify([
      {
        workspaceId: 'ws-a',
        workspaceName: 'Acme',
        provider: 'github',
        repo: 'acme/intel',
        branch: 'flank-okf',
        subdir: '/intel/acme/',
      },
    ]);

    // Act
    const targets = parseOkfTargets(raw);

    // Assert — baseBranch defaults to null, subdir slashes stripped.
    expect(targets).toEqual([
      {
        workspaceId: 'ws-a',
        workspaceName: 'Acme',
        provider: 'github',
        repo: 'acme/intel',
        branch: 'flank-okf',
        baseBranch: null,
        subdir: 'intel/acme',
      },
    ]);
  });

  it('throws on a malformed repo (fail closed, never deliver to an unintended repo)', () => {
    const raw = JSON.stringify([
      {
        workspaceId: 'ws-a',
        workspaceName: 'Acme',
        provider: 'github',
        repo: 'not-a-repo',
        branch: 'main',
      },
    ]);
    expect(() => parseOkfTargets(raw)).toThrow();
  });
});

describe('createOkfPublisher', () => {
  it('returns a real GitHub publisher when a token is set', () => {
    expect(createOkfPublisher({ FLANK_OKF_GITHUB_TOKEN: 'ghp_x' })).toBeInstanceOf(
      GitHubBundlePublisher,
    );
  });

  it('falls back to the live-ban publisher when no token is configured', () => {
    expect(createOkfPublisher({})).toBe(liveBanBundlePublisher);
  });
});

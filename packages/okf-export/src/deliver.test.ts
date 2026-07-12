import type { LintFinding } from '@okf/core';
import { describe, expect, it } from 'vitest';
import { planDelivery } from './deliver';
import { manifestOf } from './manifest';
import type { GitBundleTarget } from './publisher';

const TARGET: GitBundleTarget = {
  workspaceId: 'ws-a',
  workspaceName: 'Acme',
  provider: 'github',
  repo: 'acme/intel',
  branch: 'flank-okf',
  baseBranch: 'main',
  subdir: 'intel/acme',
};

const filesOf = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('planDelivery', () => {
  it('blocks when any finding is an error, pushing nothing', () => {
    // Arrange
    const findings: LintFinding[] = [
      { check: 'UNVERIFIED_CITATION', severity: 'error', path: 'a.md', message: 'nope' },
      { check: 'ORPHAN', severity: 'warning', path: 'b.md', message: 'meh' },
    ];

    // Act
    const plan = planDelivery({
      target: TARGET,
      files: filesOf({ 'index.md': 'x' }),
      findings,
      previousManifest: new Map(),
    });

    // Assert
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') {
      expect(plan.blockingFindings).toHaveLength(1);
      expect(plan.blockingFindings[0].check).toBe('UNVERIFIED_CITATION');
    }
  });

  it('reports unchanged when the bundle matches the previous manifest', () => {
    // Arrange
    const files = filesOf({ 'index.md': 'x', 'competitors/g/index.md': 'y' });

    // Act
    const plan = planDelivery({
      target: TARGET,
      files,
      findings: [],
      previousManifest: manifestOf(files),
    });

    // Assert
    expect(plan.kind).toBe('unchanged');
  });

  it('builds a subdir-prefixed publish request with deletions and a summary commit message', () => {
    // Arrange — previous had an extra file (now removed) and a changed one.
    const previous = manifestOf(
      filesOf({ 'index.md': 'old', 'competitors/gone/index.md': 'bye' }),
    );
    const files = filesOf({ 'index.md': 'new', 'competitors/globex/index.md': 'hi' });

    // Act
    const plan = planDelivery({ target: TARGET, files, findings: [], previousManifest: previous });

    // Assert
    expect(plan.kind).toBe('publish');
    if (plan.kind !== 'publish') return;
    // Every file path is prefixed with the target subdir.
    expect([...plan.request.files.keys()].sort()).toEqual([
      'intel/acme/competitors/globex/index.md',
      'intel/acme/index.md',
    ]);
    // Removed path is prefixed and queued for deletion.
    expect(plan.request.deletions).toEqual(['intel/acme/competitors/gone/index.md']);
    expect(plan.request.commitMessage).toBe(
      'chore(okf): update Acme competitive bundle (+1 ~1 -1)',
    );
    expect(plan.diff.added).toEqual(['competitors/globex/index.md']);
    expect(plan.diff.modified).toEqual(['index.md']);
    expect(plan.diff.removed).toEqual(['competitors/gone/index.md']);
  });

  it('does not prefix when the subdir is empty (repo root delivery)', () => {
    // Act
    const plan = planDelivery({
      target: { ...TARGET, subdir: '' },
      files: filesOf({ 'index.md': 'x' }),
      findings: [],
      previousManifest: new Map(),
    });

    // Assert
    expect(plan.kind).toBe('publish');
    if (plan.kind === 'publish') {
      expect([...plan.request.files.keys()]).toEqual(['index.md']);
    }
  });
});

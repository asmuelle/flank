import type { BattlecardSection, Claim, DossierSection } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { projectWorkspaceBundle } from './project';
import type { CompetitorExport, WorkspaceExportInput } from './types';

const AT_V1 = new Date('2026-06-01T06:00:00Z');
const AT_V2 = new Date('2026-06-08T06:00:00Z');
const VERIFIED_AT = new Date('2026-06-08T07:00:00Z');

const COMP = {
  id: 'comp-a',
  workspaceId: 'ws-a',
  name: 'Globex',
  primaryDomain: 'globex.com',
} as const;

const claim = (id: string, verified: boolean): Claim => ({
  id,
  deltaId: 'd-1',
  snapshotId: 'snap-1',
  quoteText: 'Analyst $59 per month',
  charStart: 0,
  charEnd: 21,
  sourceUrl: 'https://globex.com/pricing',
  capturedAt: AT_V2,
  verifiedAt: verified ? VERIFIED_AT : null,
});

const dossier = (
  id: string,
  version: number,
  over: Partial<DossierSection> = {},
): DossierSection => ({
  id,
  competitorId: COMP.id,
  kind: 'pricing',
  version,
  contentMd: `# Pricing v${version}\n\n- Analyst $59/mo`,
  claimIds: ['c-1'],
  model: 'claude-sonnet-4-6',
  batchId: 'batch-1',
  supersedesId: version > 1 ? `ds-${version - 1}` : null,
  createdAt: version > 1 ? AT_V2 : AT_V1,
  ...over,
});

const battlecard = (id: string, version: number): BattlecardSection => ({
  id,
  competitorId: COMP.id,
  kind: 'pricing_counter',
  version,
  contentMd: `# Counter v${version}`,
  claimIds: ['c-1'],
  supersedesId: null,
  createdAt: AT_V1,
  ...{},
});

const exportOf = (over: Partial<CompetitorExport> = {}): CompetitorExport => ({
  competitor: COMP,
  dossierSections: [dossier('ds-1', 1), dossier('ds-2', 2)],
  battlecardSections: [battlecard('bc-1', 1)],
  claims: [claim('c-1', true)],
  ...over,
});

const inputOf = (competitors: readonly CompetitorExport[]): WorkspaceExportInput => ({
  workspace: { id: 'ws-a', name: 'Acme' },
  baseUrl: 'https://app.flank.test',
  competitors,
});

describe('projectWorkspaceBundle', () => {
  it('renders the section head as a golden concept doc with verified sources only', () => {
    // Act
    const { files, findings } = projectWorkspaceBundle(inputOf([exportOf()]));

    // Assert — byte-exact head doc; v1 renders no doc of its own.
    expect(files.get('competitors/globex/dossier/pricing.md')).toBe(
      [
        '---',
        'type: Dossier Section',
        'title: Globex — Pricing',
        'resource: https://app.flank.test/authed/c/comp-a',
        'timestamp: 2026-06-08T06:00:00.000Z',
        'kind: pricing',
        'model: claude-sonnet-4-6',
        "version: '2'",
        '---',
        '',
        '# Pricing v2',
        '',
        '- Analyst $59/mo',
        '',
        '## Sources',
        '',
        '- "Analyst $59 per month" — [globex.com](https://globex.com/pricing), captured 2026-06-08T06:00:00.000Z, verified 2026-06-08T07:00:00.000Z',
        '',
        '[← Globex](../index.md)',
        '',
      ].join('\n'),
    );
    expect(findings).toEqual([]);
  });

  it('bundles exactly the expected files, path-sorted', () => {
    // Act
    const { files } = projectWorkspaceBundle(inputOf([exportOf()]));

    // Assert
    expect([...files.keys()]).toEqual([
      'competitors/globex/battlecard/pricing-counter.md',
      'competitors/globex/dossier/pricing.md',
      'competitors/globex/index.md',
      'index.md',
      'log.md',
    ]);
  });

  it('writes every section version into log.md in chronological order', () => {
    // Act
    const { files } = projectWorkspaceBundle(inputOf([exportOf()]));
    const log = files.get('log.md') ?? '';

    // Assert — v1, battlecard v1 (same instant, stable tie-break), then v2.
    const positions = [
      'Globex: battlecard/pricing_counter v1 published (first version).',
      'Globex: dossier/pricing v1 published (first version).',
      'Globex: dossier/pricing v2 published (supersedes v1).',
    ].map((line) => log.indexOf(line));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('is byte-deterministic under shuffled input order', () => {
    // Arrange — same rows, reversed array orders.
    const shuffled = exportOf({
      dossierSections: [dossier('ds-2', 2), dossier('ds-1', 1)],
    });

    // Act
    const first = projectWorkspaceBundle(inputOf([exportOf()]));
    const second = projectWorkspaceBundle(inputOf([shuffled]));

    // Assert
    expect([...first.files.entries()]).toEqual([...second.files.entries()]);
  });

  it('gates unverified and unresolvable citations out of the bundle as error findings', () => {
    // Arrange — head cites one unverified and one missing claim.
    const gated = exportOf({
      dossierSections: [dossier('ds-1', 1, { claimIds: ['c-unverified', 'c-gone'] })],
      battlecardSections: [],
      claims: [claim('c-unverified', false)],
    });

    // Act
    const { files, findings } = projectWorkspaceBundle(inputOf([gated]));

    // Assert — no Sources block rendered, both violations reported as errors.
    expect(files.get('competitors/globex/dossier/pricing.md')).not.toContain('## Sources');
    expect(findings).toEqual([
      expect.objectContaining({
        check: 'UNVERIFIED_CITATION',
        severity: 'error',
        path: 'competitors/globex/dossier/pricing.md',
        message: expect.stringContaining('c-unverified'),
      }),
      expect.objectContaining({
        check: 'UNVERIFIED_CITATION',
        severity: 'error',
        message: expect.stringContaining('c-gone'),
      }),
    ]);
  });

  it('keeps two same-named competitors apart with id-suffixed slugs', () => {
    // Arrange
    const twinA = exportOf();
    const twinB = exportOf({
      competitor: { ...COMP, id: 'comp-b', primaryDomain: 'other.example' },
      dossierSections: [dossier('ds-b', 1, { competitorId: 'comp-b' })],
      battlecardSections: [],
    });

    // Act
    const { files, findings } = projectWorkspaceBundle(inputOf([twinA, twinB]));

    // Assert
    expect(files.has('competitors/globex-comp-a/index.md')).toBe(true);
    expect(files.has('competitors/globex-comp-b/index.md')).toBe(true);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('produces a minimal valid bundle for an empty workspace', () => {
    // Act
    const { files, findings } = projectWorkspaceBundle(inputOf([]));

    // Assert
    expect([...files.keys()]).toEqual(['index.md', 'log.md']);
    expect(findings).toEqual([]);
  });
});

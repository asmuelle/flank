import type { BattlecardSection, Claim, Competitor, DossierSection } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceExport, type ExportReadStore } from './load';

const AT = new Date('2026-06-08T06:00:00Z');

const COMP: Competitor = {
  id: 'comp-a',
  workspaceId: 'ws-a',
  name: 'Globex',
  primaryDomain: 'globex.com',
};

const dossier: DossierSection = {
  id: 'ds-1',
  competitorId: COMP.id,
  kind: 'pricing',
  version: 1,
  contentMd: '# Pricing',
  claimIds: ['c-1', 'c-2'],
  model: null,
  batchId: null,
  supersedesId: null,
  createdAt: AT,
};

const battlecard: BattlecardSection = {
  id: 'bc-1',
  competitorId: COMP.id,
  kind: 'why_we_win',
  version: 1,
  contentMd: '# Why we win',
  claimIds: ['c-2', 'c-3'],
  supersedesId: null,
  createdAt: AT,
};

describe('loadWorkspaceExport', () => {
  it('loads competitors with their chains and resolves cited claim ids once, deduplicated', async () => {
    // Arrange
    const claimRequests: string[][] = [];
    const store: ExportReadStore = {
      listCompetitors: async () => [COMP],
      listDossierSections: async () => [dossier],
      listBattlecardSections: async () => [battlecard],
      getClaimsByIds: async (_workspaceId, claimIds) => {
        claimRequests.push([...claimIds]);
        return claimIds.map((id): Claim => ({
          id,
          deltaId: 'd-1',
          snapshotId: 'snap-1',
          quoteText: 'q',
          charStart: 0,
          charEnd: 1,
          sourceUrl: 'https://globex.com',
          capturedAt: AT,
          verifiedAt: AT,
        }));
      },
    };

    // Act
    const input = await loadWorkspaceExport(
      store,
      { id: 'ws-a', name: 'Acme' },
      'https://app.test',
    );

    // Assert
    expect(input.workspace.id).toBe('ws-a');
    expect(input.competitors).toHaveLength(1);
    expect(input.competitors[0].claims.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3']);
    // c-2 is cited by both sections but requested once.
    expect(claimRequests).toEqual([['c-1', 'c-2', 'c-3']]);
  });

  it('skips the claim lookup entirely when no section cites anything', async () => {
    // Arrange
    let claimCalls = 0;
    const store: ExportReadStore = {
      listCompetitors: async () => [COMP],
      listDossierSections: async () => [{ ...dossier, claimIds: [] }],
      listBattlecardSections: async () => [],
      getClaimsByIds: async () => {
        claimCalls += 1;
        return [];
      },
    };

    // Act
    const input = await loadWorkspaceExport(
      store,
      { id: 'ws-a', name: 'Acme' },
      'https://app.test',
    );

    // Assert
    expect(input.competitors[0].claims).toEqual([]);
    expect(claimCalls).toBe(0);
  });
});

import type { FlankStore } from '@flank/core';
import type { CompetitorExport, WorkspaceExportInput } from './types';

/** The four workspace-scoped reads the export needs — nothing else leaks in. */
export type ExportReadStore = Pick<
  FlankStore,
  'listCompetitors' | 'listDossierSections' | 'listBattlecardSections' | 'getClaimsByIds'
>;

/**
 * Load a workspace's export input through the store's request-safe reads
 * (workspace-scoped, fail-closed — Invariant 8 is the store's job, not ours).
 * Claims are resolved once per competitor across all of its section heads.
 */
export const loadWorkspaceExport = async (
  store: ExportReadStore,
  workspace: { readonly id: string; readonly name: string },
  baseUrl: string,
): Promise<WorkspaceExportInput> => {
  const competitors = await store.listCompetitors(workspace.id);
  const exports: CompetitorExport[] = [];
  for (const competitor of competitors) {
    const [dossierSections, battlecardSections] = await Promise.all([
      store.listDossierSections(workspace.id, competitor.id),
      store.listBattlecardSections(workspace.id, competitor.id),
    ]);
    const claimIds = [
      ...new Set([...dossierSections, ...battlecardSections].flatMap((s) => s.claimIds)),
    ];
    const claims = claimIds.length > 0 ? await store.getClaimsByIds(workspace.id, claimIds) : [];
    exports.push({ competitor, dossierSections, battlecardSections, claims });
  }
  return { workspace, baseUrl, competitors: exports };
};

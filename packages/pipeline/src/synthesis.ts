import {
  affectedSectionKinds,
  estimateSynthesisCostMicros,
  evaluateBudget,
  gateSectionPublish,
  meterCost,
  unionAffectedKinds,
  type BattlecardSectionKind,
  type CandidateClaim,
  type Claim,
  type Delta,
  type DossierSectionKind,
  type FlankStore,
  type ModelId,
  type PlanTier,
  type SynthesisClient,
} from '@flank/core';

const SYNTHESIS_MODEL: ModelId = 'claude-sonnet-4-6';

export interface SynthesisDeps {
  readonly store: FlankStore;
  readonly client: SynthesisClient;
  readonly nextId: () => string;
}

export interface SynthesisTarget {
  readonly workspaceId: string;
  readonly competitorId: string;
  readonly competitorName: string;
  readonly planTier: PlanTier;
}

export interface SynthesisReport {
  readonly competitorId: string;
  readonly deltasConsidered: number;
  readonly sectionsConsidered: number;
  readonly sectionsRegenerated: number;
  readonly sectionsBlocked: number;
  readonly costMicros: number;
  readonly skippedOverBudget: boolean;
}

interface PlannedSection {
  readonly surface: 'dossier' | 'battlecard';
  readonly kind: string;
  readonly contentMd: string;
  readonly claimIds: readonly string[];
  readonly passed: boolean;
}

const emptyReport = (competitorId: string, over: Partial<SynthesisReport> = {}): SynthesisReport =>
  Object.freeze({
    competitorId,
    deltasConsidered: 0,
    sectionsConsidered: 0,
    sectionsRegenerated: 0,
    sectionsBlocked: 0,
    costMicros: 0,
    skippedOverBudget: false,
    ...over,
  });

/**
 * Nightly synthesis for ONE competitor (DESIGN flow 3): collect confirmed material deltas, regenerate
 * ONLY the affected dossier/battlecard kinds, span-verify each cited claim against its own snapshot,
 * and publish the survivors as new append-only versions. The whole affected set is budget-gated
 * BEFORE any spend (Invariant 6); a section whose cited claims don't all verify is blocked, never
 * published unverified (Invariant 1). LLM calls happen outside the DB transaction; the version
 * publishes + coverage row commit atomically.
 */
export const runSynthesis = async (
  target: SynthesisTarget,
  deps: SynthesisDeps,
  now: Date,
): Promise<SynthesisReport> => {
  const { workspaceId, competitorId } = target;
  const period = now.toISOString().slice(0, 10);

  const deltas = await deps.store.listConfirmedMaterialDeltasForCompetitor(
    workspaceId,
    competitorId,
  );
  if (deltas.length === 0) return emptyReport(competitorId);

  const deltaById = new Map<string, Delta>(deltas.map((delta) => [delta.id, delta]));
  const claimsByDelta = new Map<string, readonly Claim[]>();
  await Promise.all(
    deltas.map(async (delta) => {
      claimsByDelta.set(delta.id, await deps.store.listClaimsForDelta(workspaceId, delta.id));
    }),
  );

  const affected = unionAffectedKinds(deltas.map((delta) => delta.triageClass));
  const sectionsConsidered = affected.dossier.length + affected.battlecard.length;

  // Budget gate (Invariant 6), whole affected set, before any spend. Read failure propagates closed.
  const spentMicros = await deps.store.monthToDateCostMicros(
    workspaceId,
    now.toISOString().slice(0, 7),
  );
  const budget = evaluateBudget(
    target.planTier,
    spentMicros,
    estimateSynthesisCostMicros(sectionsConsidered),
  );
  if (!budget.allow) {
    await deps.store.insertCoverageRun({
      id: deps.nextId(),
      workspaceId,
      period,
      sourcesChecked: 0,
      fetchFailures: 0,
      deltasFound: 0,
      materialDeltas: 0,
      llmCalls: 0,
      llmCostMicros: 0,
      createdAt: now,
    });
    return emptyReport(competitorId, {
      deltasConsidered: deltas.length,
      sectionsConsidered,
      skippedOverBudget: true,
    });
  }

  const claimsForKind = (surface: 'dossier' | 'battlecard', kind: string): readonly Claim[] => {
    const out: Claim[] = [];
    for (const delta of deltas) {
      const kinds = affectedSectionKinds(delta.triageClass)[surface] as readonly string[];
      if (kinds.includes(kind)) out.push(...(claimsByDelta.get(delta.id) ?? []));
    }
    return out;
  };

  const toCandidate = (claim: Claim): CandidateClaim => {
    const delta = deltaById.get(claim.deltaId);
    return {
      id: claim.id,
      quoteText: claim.quoteText,
      sourceUrl: claim.sourceUrl,
      triageClass: delta?.triageClass ?? 'noise',
      rationale: delta?.rationale ?? '',
    };
  };

  let costMicros = 0;
  let llmCalls = 0;
  const planned: PlannedSection[] = [];

  const synthesizeKind = async (surface: 'dossier' | 'battlecard', kind: string): Promise<void> => {
    const candidateClaims = claimsForKind(surface, kind);
    if (candidateClaims.length === 0) return; // nothing to cite — never call the model
    const previous =
      surface === 'dossier'
        ? await deps.store.latestDossierSection(
            workspaceId,
            competitorId,
            kind as DossierSectionKind,
          )
        : await deps.store.latestBattlecardSection(
            workspaceId,
            competitorId,
            kind as BattlecardSectionKind,
          );

    const result = await deps.client.synthesize({
      surface,
      kind,
      competitorName: target.competitorName,
      previousContentMd: previous?.contentMd ?? null,
      candidateClaims: candidateClaims.map(toCandidate),
    });
    llmCalls += 1;
    // Synchronous Messages API — no batch discount (metering must match billing). Missing usage is
    // charged the conservative one-section projection, never free (fail-closed on a no-usage client).
    costMicros += result.usage ? meterCost(result.usage) : estimateSynthesisCostMicros(1);

    // Intersect cited ids with the offered candidates — a hallucinated id is dropped, never cited.
    const candidateIds = new Set(candidateClaims.map((claim) => claim.id));
    const citedIds = [...new Set(result.citedClaimIds.filter((id) => candidateIds.has(id)))];

    // Section gate (Invariant 1): verify each surviving cited claim against ITS snapshot.
    const citedClaims = await deps.store.getClaimsByIds(workspaceId, citedIds);
    const snapshotTextById = new Map<string, string>();
    for (const snapshotId of new Set(citedClaims.map((claim) => claim.snapshotId))) {
      const snapshot = await deps.store.getSnapshot(workspaceId, snapshotId);
      if (snapshot !== null) snapshotTextById.set(snapshotId, snapshot.normalizedText);
    }
    const gate = gateSectionPublish(citedClaims, snapshotTextById);
    // Fail closed if any cited id didn't resolve to a row (partial resolution must not publish), and
    // persist exactly the gate-verified ids — never the pre-resolution citedIds list.
    const fullyResolved = citedClaims.length === citedIds.length;
    planned.push({
      surface,
      kind,
      contentMd: result.contentMd,
      claimIds: citedClaims.map((claim) => claim.id),
      passed: gate.publishable && fullyResolved,
    });
  };

  // Soft cap (Invariant 6): re-check running spend before each section so one nightly run cannot
  // run far past the cap (overshoot is bounded to the in-flight section).
  const sectionTargets: ReadonlyArray<readonly ['dossier' | 'battlecard', string]> = [
    ...affected.dossier.map((kind) => ['dossier', kind] as const),
    ...affected.battlecard.map((kind) => ['battlecard', kind] as const),
  ];
  for (const [surface, kind] of sectionTargets) {
    if (spentMicros + costMicros >= budget.capMicros) break;
    await synthesizeKind(surface, kind);
  }

  // Only-affected is guaranteed by construction (planned kinds come from `affected`); assert it.
  const affectedDossier = new Set<string>(affected.dossier);
  const affectedBattlecard = new Set<string>(affected.battlecard);
  for (const section of planned) {
    const ok =
      section.surface === 'dossier'
        ? affectedDossier.has(section.kind)
        : affectedBattlecard.has(section.kind);
    if (!ok)
      throw new Error(
        `synthesis regenerated an unaffected section: ${section.surface}/${section.kind}`,
      );
  }

  const batchId = deps.nextId();
  let regenerated = 0;
  let blocked = 0;
  await deps.store.withTransaction(async (tx) => {
    for (const section of planned) {
      if (!section.passed) {
        blocked += 1;
        continue;
      }
      if (section.surface === 'dossier') {
        const latest = await tx.latestDossierSection(
          workspaceId,
          competitorId,
          section.kind as DossierSectionKind,
        );
        await tx.insertDossierSection(workspaceId, {
          id: deps.nextId(),
          competitorId,
          kind: section.kind as DossierSectionKind,
          version: (latest?.version ?? 0) + 1,
          contentMd: section.contentMd,
          claimIds: section.claimIds,
          model: SYNTHESIS_MODEL,
          batchId,
          supersedesId: latest?.id ?? null,
          createdAt: now,
        });
      } else {
        const latest = await tx.latestBattlecardSection(
          workspaceId,
          competitorId,
          section.kind as BattlecardSectionKind,
        );
        await tx.insertBattlecardSection(workspaceId, {
          id: deps.nextId(),
          competitorId,
          kind: section.kind as BattlecardSectionKind,
          version: (latest?.version ?? 0) + 1,
          contentMd: section.contentMd,
          claimIds: section.claimIds,
          supersedesId: latest?.id ?? null,
          createdAt: now,
        });
      }
      regenerated += 1;
    }
    await tx.insertCoverageRun({
      id: deps.nextId(),
      workspaceId,
      period,
      sourcesChecked: 0,
      fetchFailures: 0,
      deltasFound: 0,
      materialDeltas: 0,
      llmCalls,
      llmCostMicros: costMicros,
      createdAt: now,
    });
  });

  return Object.freeze({
    competitorId,
    deltasConsidered: deltas.length,
    sectionsConsidered,
    sectionsRegenerated: regenerated,
    sectionsBlocked: blocked,
    costMicros,
    skippedOverBudget: false,
  });
};

export interface NightlySynthesisReport {
  readonly competitorsProcessed: number;
  readonly sectionsRegenerated: number;
  readonly sectionsBlocked: number;
  readonly skippedOverBudget: number;
  readonly costMicros: number;
  readonly errors: number;
}

/** The nightly worker: run {@link runSynthesis} for every competitor; one failure never aborts the run. */
export const runNightlySynthesis = async (
  deps: SynthesisDeps,
  now: Date,
): Promise<NightlySynthesisReport> => {
  const competitors = await deps.store.listCompetitorsForSynthesis();
  let sectionsRegenerated = 0;
  let sectionsBlocked = 0;
  let skippedOverBudget = 0;
  let costMicros = 0;
  let errors = 0;
  for (const { workspace, competitor } of competitors) {
    try {
      const report = await runSynthesis(
        {
          workspaceId: workspace.id,
          competitorId: competitor.id,
          competitorName: competitor.name,
          planTier: workspace.planTier,
        },
        deps,
        now,
      );
      sectionsRegenerated += report.sectionsRegenerated;
      sectionsBlocked += report.sectionsBlocked;
      costMicros += report.costMicros;
      if (report.skippedOverBudget) skippedOverBudget += 1;
    } catch {
      errors += 1;
    }
  }
  return Object.freeze({
    competitorsProcessed: competitors.length,
    sectionsRegenerated,
    sectionsBlocked,
    skippedOverBudget,
    costMicros,
    errors,
  });
};

import type {
  Alert,
  AlertChannelConfig,
  AppUser,
  BattlecardSection,
  Claim,
  Competitor,
  CoverageRun,
  Delta,
  DossierSection,
  Membership,
  Snapshot,
  Source,
  Workspace,
} from '@flank/core';
import type {
  alertChannelConfigs,
  alerts,
  appUsers,
  battlecardSections,
  claims,
  competitors,
  coverageRuns,
  deltas,
  dossierSections,
  memberships,
  snapshots,
  sources,
  workspaces,
} from './schema';

// Row → core-entity mappers. The schema carries a few columns the domain does not model yet
// (snapshot.s3Key, workspace.competitorLimit, …); the domain layer sees only the canonical shape.
// Shared by drizzle-store.ts and drizzle-alerts.ts (kept here so neither file exceeds its budget).

/** Guard money/count values read back from Postgres bigint/sum so an overflow fails loud. */
export const assertSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer: ${value}`);
  }
  return value;
};

export const toWorkspace = (row: typeof workspaces.$inferSelect): Workspace =>
  Object.freeze({ id: row.id, name: row.name, planTier: row.planTier });

export const toCompetitor = (row: typeof competitors.$inferSelect): Competitor =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    primaryDomain: row.primaryDomain,
  });

export const toSource = (row: typeof sources.$inferSelect): Source =>
  Object.freeze({
    id: row.id,
    competitorId: row.competitorId,
    type: row.type,
    url: row.url,
    adapter: row.adapter,
    cadence: row.cadence,
    legalStatus: row.legalStatus,
  });

export const toSnapshot = (row: typeof snapshots.$inferSelect): Snapshot =>
  Object.freeze({
    id: row.id,
    sourceId: row.sourceId,
    contentHash: row.contentHash,
    normalizedText: row.normalizedText,
    fetchedAt: row.fetchedAt,
    httpStatus: row.httpStatus,
    vantage: row.vantage,
  });

export const toDelta = (row: typeof deltas.$inferSelect): Delta =>
  Object.freeze({
    id: row.id,
    sourceId: row.sourceId,
    fromSnapshotId: row.fromSnapshotId,
    toSnapshotId: row.toSnapshotId,
    changedSpans: row.changedSpans,
    triageClass: row.triageClass,
    materiality: row.materiality,
    rationale: row.rationale,
    state: row.state,
    confirmedBySnapshotId: row.confirmedBySnapshotId,
    createdAt: row.createdAt,
  });

export const toClaim = (row: typeof claims.$inferSelect): Claim =>
  Object.freeze({
    id: row.id,
    deltaId: row.deltaId,
    snapshotId: row.snapshotId,
    quoteText: row.quoteText,
    charStart: row.charStart,
    charEnd: row.charEnd,
    sourceUrl: row.sourceUrl,
    capturedAt: row.capturedAt,
    verifiedAt: row.verifiedAt,
  });

export const toCoverageRun = (row: typeof coverageRuns.$inferSelect): CoverageRun =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    period: row.period,
    sourcesChecked: row.sourcesChecked,
    fetchFailures: row.fetchFailures,
    deltasFound: row.deltasFound,
    materialDeltas: row.materialDeltas,
    llmCalls: row.llmCalls,
    llmCostMicros: assertSafeInteger(row.llmCostMicros, 'coverage_run.llm_cost_micros'),
    createdAt: row.createdAt,
  });

export const toDossierSection = (row: typeof dossierSections.$inferSelect): DossierSection =>
  Object.freeze({
    id: row.id,
    competitorId: row.competitorId,
    kind: row.kind,
    version: row.version,
    contentMd: row.contentMd,
    claimIds: row.claimIds,
    model: row.model,
    batchId: row.batchId,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt,
  });

export const toBattlecardSection = (
  row: typeof battlecardSections.$inferSelect,
): BattlecardSection =>
  Object.freeze({
    id: row.id,
    competitorId: row.competitorId,
    kind: row.kind,
    version: row.version,
    contentMd: row.contentMd,
    claimIds: row.claimIds,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt,
  });

export const toAppUser = (row: typeof appUsers.$inferSelect): AppUser =>
  Object.freeze({ id: row.id, email: row.email, name: row.name, createdAt: row.createdAt });

export const toMembership = (row: typeof memberships.$inferSelect): Membership =>
  Object.freeze({
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    createdAt: row.createdAt,
  });

export const toAlertChannelConfig = (
  row: typeof alertChannelConfigs.$inferSelect,
): AlertChannelConfig =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    channel: row.channel as AlertChannelConfig['channel'],
    destination: row.destination,
    label: row.label,
    enabled: row.enabled,
    createdAt: row.createdAt,
  });

export const toAlert = (row: typeof alerts.$inferSelect): Alert =>
  Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    deltaId: row.deltaId,
    channel: row.channel as Alert['channel'],
    channelConfigId: row.channelConfigId,
    target: row.target,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attemptCount,
    providerRef: row.providerRef,
    lastError: row.lastError,
    enqueuedAt: row.enqueuedAt,
    lastAttemptAt: row.lastAttemptAt,
    deliveredAt: row.deliveredAt,
  });

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Postgres unique-violation (duplicate primary key) → append-only breach (Invariant 5). Drizzle
 * wraps the driver error, so the postgres-js `PostgresError` (carrying `code`) is reached via the
 * `cause` chain rather than the top-level error.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object') break;
    if (
      'code' in current &&
      (current as { readonly code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = 'cause' in current ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
};

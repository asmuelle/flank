import {
  DELTA_STATES,
  LEGAL_STATUSES,
  PLAN_TIERS,
  SOURCE_ADAPTERS,
  SOURCE_TYPES,
  TRIAGE_CLASSES,
  type Span,
} from '@flank/core';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// Enums mirror the canonical value sets in @flank/core — one source of truth.
export const planTierEnum = pgEnum('plan_tier', PLAN_TIERS);
export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES);
export const sourceAdapterEnum = pgEnum('source_adapter', SOURCE_ADAPTERS);
export const legalStatusEnum = pgEnum('legal_status', LEGAL_STATUSES);
export const triageClassEnum = pgEnum('triage_class', TRIAGE_CLASSES);
export const deltaStateEnum = pgEnum('delta_state', DELTA_STATES);
export const alertChannelEnum = pgEnum('alert_channel', ['slack', 'email', 'crm']);
export const alertStatusEnum = pgEnum('alert_status', ['queued', 'delivered', 'failed']);
export const sectionKindEnum = pgEnum('dossier_section_kind', [
  'overview',
  'pricing',
  'product',
  'gtm',
  'team',
]);
export const battlecardKindEnum = pgEnum('battlecard_section_kind', [
  'why_we_win',
  'landmines',
  'pricing_counter',
  'objections',
]);

export const workspaces = pgTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  planTier: planTierEnum('plan_tier').notNull().default('starter'),
  competitorLimit: integer('competitor_limit').notNull().default(5),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const competitors = pgTable('competitor', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text('name').notNull(),
  primaryDomain: text('primary_domain').notNull(),
  aliases: jsonb('aliases').$type<readonly string[]>().notNull().default([]),
  status: text('status', { enum: ['active', 'paused'] })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sources = pgTable('source', {
  id: text('id').primaryKey(),
  competitorId: text('competitor_id')
    .notNull()
    .references(() => competitors.id),
  type: sourceTypeEnum('type').notNull(),
  url: text('url_or_endpoint').notNull(),
  adapter: sourceAdapterEnum('adapter').notNull(),
  cadence: text('cadence').notNull(),
  legalStatus: legalStatusEnum('legal_status').notNull().default('open'),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
});

/** Append-only (Invariant 5): rows are inserted, never updated or deleted. */
export const snapshots = pgTable(
  'snapshot',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    // Denormalized tenant key (Invariant 8): isolation is a single WHERE, not a 3-hop join.
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    contentHash: text('content_hash').notNull(),
    s3Key: text('s3_key'),
    normalizedText: text('normalized_text').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    vantage: text('vantage'),
    httpStatus: integer('http_status').notNull(),
  },
  (table) => [index('snapshot_source_fetched_idx').on(table.sourceId, table.fetchedAt)],
);

/** Append-only (Invariant 5); only `state` advances via the delta state machine. */
export const deltas = pgTable('delta', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id),
  // Denormalized tenant key (Invariant 8): scoping reads without a source/competitor join.
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  fromSnapshotId: text('from_snapshot_id').references(() => snapshots.id),
  toSnapshotId: text('to_snapshot_id')
    .notNull()
    .references(() => snapshots.id),
  changedSpans: jsonb('changed_spans').$type<readonly Span[]>().notNull(),
  triageClass: triageClassEnum('triage_class').notNull(),
  materiality: integer('materiality').notNull(),
  rationale: text('rationale').notNull(),
  state: deltaStateEnum('state').notNull().default('pending'),
  confirmedBySnapshotId: text('confirmed_by_snapshot_id').references(() => snapshots.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** Quote + offsets + URL + timestamp: provenance unit (Invariant 1). Append-only. */
export const claims = pgTable('claim', {
  id: text('id').primaryKey(),
  deltaId: text('delta_id')
    .notNull()
    .references(() => deltas.id),
  // Denormalized tenant key (Invariant 8).
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  snapshotId: text('snapshot_id')
    .notNull()
    .references(() => snapshots.id),
  quoteText: text('quote_text').notNull(),
  charStart: integer('char_start').notNull(),
  charEnd: integer('char_end').notNull(),
  sourceUrl: text('source_url').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
});

/** Append-only version chain via supersedes_id (Invariant 5); one row per (competitor, kind, version). */
export const dossierSections = pgTable(
  'dossier_section',
  {
    id: text('id').primaryKey(),
    competitorId: text('competitor_id')
      .notNull()
      .references(() => competitors.id),
    kind: sectionKindEnum('kind').notNull(),
    version: integer('version').notNull(),
    contentMd: text('content_md').notNull(),
    claimIds: jsonb('claim_ids').$type<readonly string[]>().notNull().default([]),
    model: text('model'),
    batchId: text('batch_id'),
    supersedesId: text('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Structural guard against forked/duplicate versions in the chain (Invariant 5).
  (table) => [
    unique('dossier_section_competitor_kind_version_uq').on(
      table.competitorId,
      table.kind,
      table.version,
    ),
  ],
);

/** Append-only version chain via supersedes_id (Invariant 5); one row per (competitor, kind, version). */
export const battlecardSections = pgTable(
  'battlecard_section',
  {
    id: text('id').primaryKey(),
    competitorId: text('competitor_id')
      .notNull()
      .references(() => competitors.id),
    kind: battlecardKindEnum('kind').notNull(),
    version: integer('version').notNull(),
    contentMd: text('content_md').notNull(),
    claimIds: jsonb('claim_ids').$type<readonly string[]>().notNull().default([]),
    supersedesId: text('supersedes_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('battlecard_section_competitor_kind_version_uq').on(
      table.competitorId,
      table.kind,
      table.version,
    ),
  ],
);

export const alerts = pgTable('alert', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  deltaId: text('delta_id')
    .notNull()
    .references(() => deltas.id),
  channel: alertChannelEnum('channel').notNull(),
  payload: jsonb('payload').$type<Readonly<Record<string, unknown>>>().notNull(),
  status: alertStatusEnum('status').notNull().default('queued'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

/** One row per fetch attempt: silence stays visible (Invariant 7) and COGS metered (Invariant 6). */
export const coverageRuns = pgTable('coverage_run', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  period: text('period').notNull(),
  sourcesChecked: integer('sources_checked').notNull(),
  fetchFailures: integer('fetch_failures').notNull(),
  deltasFound: integer('deltas_found').notNull(),
  materialDeltas: integer('material_deltas').notNull(),
  llmCalls: integer('llm_calls').notNull(),
  // Exact integer micro-USD (USD × 1e6), never float — drift-free monthly summation (Invariant 6).
  llmCostMicros: bigint('llm_cost_micros', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/** Tables whose rows must never be UPDATEd or DELETEd (Invariant 5). */
export const APPEND_ONLY_TABLES = Object.freeze([
  snapshots,
  deltas,
  claims,
  dossierSections,
  battlecardSections,
] as const);

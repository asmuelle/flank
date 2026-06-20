/**
 * Idempotent demo seed for local development and the web smoke test. Applies migrations
 * (programmatic migrator, not the drizzle-kit CLI), TRUNCATEs every table, then writes one tenant's
 * worth of data through the real DrizzleFlankStore so the seed exercises the same invariants the app
 * does: a workspace + owner user + membership (the sign-in identity), a competitor with sources, an
 * append-only delta/claim history (including a pending pricing delta held for confirmation), two
 * versions of a dossier section (so the version-diff view has something to diff), and coverage runs.
 *
 *   just seed            # needs DATABASE_URL (see .env.example); `just db-up` first
 *
 * Re-runnable: the TRUNCATE makes every run produce the same state. Sign in at /auth/sign-in with
 * the email printed at the end.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromEnv } from '../src/client';
import { DrizzleFlankStore } from '../src/drizzle-store';

const SEED_EMAIL = 'founder@northwind.test';
const WS = { id: 'ws-demo', name: 'Northwind GTM', planTier: 'growth' as const };
const COMP = {
  id: 'comp-acme',
  workspaceId: WS.id,
  name: 'Acme Analytics',
  primaryDomain: 'acme.example',
};

const at = (iso: string): Date => new Date(iso);
const PRICING_URL = 'https://acme.example/pricing';
const BLOG_URL = 'https://acme.example/blog/series-b';

// Every table, child-before-parent order is handled by RESTART IDENTITY CASCADE.
const TABLES = [
  'workspace',
  'competitor',
  'source',
  'snapshot',
  'delta',
  'claim',
  'coverage_run',
  'dossier_section',
  'battlecard_section',
  'app_user',
  'membership',
];

const OVERVIEW_V1 = `Acme Analytics is a mid-market product-analytics vendor.

They sell a single self-serve plan and lean on a generous free tier to win bottoms-up adoption.

Primary wedge: fast time-to-first-dashboard.`;

const OVERVIEW_V2 = `Acme Analytics is a mid-market product-analytics vendor moving upmarket.

They now sell two plans — self-serve and a new sales-assisted Enterprise tier — and have pulled back the free tier from unlimited to a 30-day trial.

Primary wedge: fast time-to-first-dashboard, now paired with SSO and audit logs for enterprise buyers.`;

const main = async (): Promise<void> => {
  const handle = createDbFromEnv();
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
  await migrate(handle.db, { migrationsFolder });

  await handle.client.unsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(',')} RESTART IDENTITY CASCADE`,
  );

  const store = new DrizzleFlankStore(handle.db);

  // — Identity: the sign-in user + their owner membership —
  await store.seedWorkspace(WS);
  await store.seedUser({
    id: 'u-demo',
    email: SEED_EMAIL,
    name: 'Dana Founder',
    createdAt: at('2026-05-01T00:00:00Z'),
  });
  await store.seedMembership({
    id: 'mem-demo',
    userId: 'u-demo',
    workspaceId: WS.id,
    role: 'owner',
    createdAt: at('2026-05-01T00:00:00Z'),
  });

  // — Competitor + sources —
  await store.seedCompetitor(COMP);
  await store.seedSource({
    id: 'src-pricing',
    competitorId: COMP.id,
    type: 'pricing',
    url: PRICING_URL,
    adapter: 'html',
    cadence: '0 6 * * *',
    legalStatus: 'open',
  });
  await store.seedSource({
    id: 'src-blog',
    competitorId: COMP.id,
    type: 'blog',
    url: BLOG_URL,
    adapter: 'rss',
    cadence: '0 7 * * *',
    legalStatus: 'open',
  });

  // — Append-only history: snapshots → deltas → claims —
  await store.insertSnapshot(WS.id, {
    id: 'snap-blog',
    sourceId: 'src-blog',
    contentHash: 'h-blog-1',
    normalizedText: 'Acme raises $40M Series B to move upmarket and ship an Enterprise tier.',
    fetchedAt: at('2026-06-12T07:00:00Z'),
    httpStatus: 200,
    vantage: null,
  });
  await store.insertDelta(WS.id, {
    id: 'd-feature',
    sourceId: 'src-blog',
    fromSnapshotId: null,
    toSnapshotId: 'snap-blog',
    changedSpans: [],
    triageClass: 'feature_launch',
    materiality: 2,
    rationale: 'Acme announces an Enterprise tier (SSO, audit logs) alongside a $40M Series B.',
    state: 'published',
    confirmedBySnapshotId: null,
    createdAt: at('2026-06-12T07:01:00Z'),
  });
  await store.insertClaim(WS.id, {
    id: 'claim-feature',
    deltaId: 'd-feature',
    snapshotId: 'snap-blog',
    quoteText: 'Acme raises $40M Series B to move upmarket and ship an Enterprise tier.',
    charStart: 0,
    charEnd: 70,
    sourceUrl: BLOG_URL,
    capturedAt: at('2026-06-12T07:00:00Z'),
    verifiedAt: at('2026-06-12T07:00:30Z'),
  });

  // A pending pricing delta — the confirmation firewall keeps it OFF the alert path until re-fetch.
  await store.insertSnapshot(WS.id, {
    id: 'snap-pricing',
    sourceId: 'src-pricing',
    contentHash: 'h-pricing-1',
    normalizedText: 'Free tier is now a 30-day trial. Enterprise plan: contact sales.',
    fetchedAt: at('2026-06-13T06:00:00Z'),
    httpStatus: 200,
    vantage: null,
  });
  await store.insertDelta(WS.id, {
    id: 'd-pricing',
    sourceId: 'src-pricing',
    fromSnapshotId: null,
    toSnapshotId: 'snap-pricing',
    changedSpans: [],
    triageClass: 'pricing_change',
    materiality: 3,
    rationale:
      'Free tier pulled back from unlimited to a 30-day trial; new Enterprise "contact sales" plan.',
    state: 'pending',
    confirmedBySnapshotId: null,
    createdAt: at('2026-06-13T06:01:00Z'),
  });
  await store.insertClaim(WS.id, {
    id: 'claim-pricing',
    deltaId: 'd-pricing',
    snapshotId: 'snap-pricing',
    quoteText: 'Free tier is now a 30-day trial.',
    charStart: 0,
    charEnd: 32,
    sourceUrl: PRICING_URL,
    capturedAt: at('2026-06-13T06:00:00Z'),
    verifiedAt: at('2026-06-13T06:00:30Z'),
  });

  // — Dossier: two versions of the overview, so the diff view has a real before/after —
  await store.insertDossierSection(WS.id, {
    id: 'dossier-overview-v1',
    competitorId: COMP.id,
    kind: 'overview',
    version: 1,
    contentMd: OVERVIEW_V1,
    claimIds: [],
    model: 'claude-haiku-4-5',
    batchId: 'batch-2026-06-01',
    supersedesId: null,
    createdAt: at('2026-06-01T03:00:00Z'),
  });
  await store.insertDossierSection(WS.id, {
    id: 'dossier-overview-v2',
    competitorId: COMP.id,
    kind: 'overview',
    version: 2,
    contentMd: OVERVIEW_V2,
    claimIds: ['claim-feature', 'claim-pricing'],
    model: 'claude-haiku-4-5',
    batchId: 'batch-2026-06-14',
    supersedesId: 'dossier-overview-v1',
    createdAt: at('2026-06-14T03:00:00Z'),
  });
  await store.insertBattlecardSection(WS.id, {
    id: 'battlecard-why-v1',
    competitorId: COMP.id,
    kind: 'why_we_win',
    version: 1,
    contentMd: `We keep an unlimited free tier; Acme just capped theirs at 30 days.

Lead with total cost of ownership for teams that outgrow a trial.`,
    claimIds: ['claim-pricing'],
    supersedesId: null,
    createdAt: at('2026-06-14T03:05:00Z'),
  });

  // — Coverage runs: silence is visible even on a quiet day (Invariant 7) —
  await store.insertCoverageRun({
    id: 'run-2026-06-12',
    workspaceId: WS.id,
    period: '2026-06',
    sourcesChecked: 2,
    fetchFailures: 0,
    deltasFound: 1,
    materialDeltas: 1,
    llmCalls: 1,
    llmCostMicros: 1_840,
    createdAt: at('2026-06-12T07:05:00Z'),
  });
  await store.insertCoverageRun({
    id: 'run-2026-06-13',
    workspaceId: WS.id,
    period: '2026-06',
    sourcesChecked: 2,
    fetchFailures: 0,
    deltasFound: 1,
    materialDeltas: 1,
    llmCalls: 1,
    llmCostMicros: 2_110,
    createdAt: at('2026-06-13T06:05:00Z'),
  });

  await handle.close();
  process.stdout.write(`\nSeeded workspace "${WS.name}" with competitor "${COMP.name}".\n`);
  process.stdout.write(`Sign in at /auth/sign-in with: ${SEED_EMAIL}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

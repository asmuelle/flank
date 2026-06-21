# ROADMAP.md — Flank build sequence

> Derived from a code-grounded audit (9 dimensions, adversarially verified, then critiqued).
> Source of truth for milestone order is still [DESIGN.md](../DESIGN.md); this file sequences the
> concrete next steps and records the judgment calls behind the order.

## Progress (updated 2026-06-20)

The "Where we are" section below is the **original audit baseline**; this is the live status.
`just ci` is green (145 unit tests) plus a DB-backed integration suite (28 tests against
`pgvector:pg16`, run in CI).

**Done**

- ✅ **Persistence spine** — re-signed `FlankStore` contract (workspace-scoped writes, tx boundary,
  pricing firewall via `assertDeltaTransition`); `postgres-js` + env-validated `createDb`;
  `workspace_id` denormalized onto history tables; `DrizzleFlankStore` held to the shared
  `runFlankStoreContract` suite; DB-tier append-only triggers + delta transition guard;
  `UNIQUE(competitor,kind,version)` + `snapshot(source_id,fetched_at)` index. (Spine items #1–#4, #6, #7.)
- ✅ **Secure fetch layer** — `Fetcher` port; SSRF-guarded `HttpFetcher` (blocked-range + redirect
  re-validation), legal-source denylist (Invariant 4), `fetchAndIngest` wiring with real `httpStatus`.
  (Fetch track #1–#3.)
- ✅ **Pricing-confirmation re-fetch** — `confirmPricingDelta` closes Invariant 3 end-to-end
  (reproduce → `confirmed` with snapshot; flap → `dismissed`); `composeAlerts` now alerts confirmed
  pricing. (Fetch track #5.)
- ✅ **Cross-cutting** — coverage gate (global ≥ 80 + strict floors on citation/diff/net-policy);
  CI migration-apply + contract suite against the pgvector service.

**Deferred (intentional)** — RLS (#5 of the spine; post-first-customer), Firecrawl/Zyte + S3 (#6),
Lever/Ashby + source discovery (#7).

**Next** — **Inngest cron (fetch track #4)**: fan out due-by-cadence sources → `fetchAndIngest`,
drive pending pricing deltas → `confirmPricingDelta`, track source health (`lastFetchedAt`,
`consecutive_failures`). Open decision: serve the Inngest functions from a Next.js API route
(co-deployed) vs a standalone worker. After that: **Auth & tenancy origin**, then **M2**.

## Where we are (honest read)

The pure-TS domain core (`packages/core`) is genuinely strong: entities, content hashing,
span diffing, a **fail-closed citation verifier**, the triage schema, a COGS estimator, the
append-only store contract, and the delta state machine — all well-tested. The Drizzle schema is
complete and a baseline migration exists (`packages/db/drizzle/0000_polite_cable.sql`).

Everything **above** the pure-TS layer is mocked or in-memory:

- No DB client/driver and no `DrizzleFlankStore` — `packages/db/src/index.ts` only re-exports schema.
- No real HTTP fetch (adapters only normalize provided strings), no Firecrawl/Zyte, no Inngest cron.
- Triage is a deterministic mock; no real Haiku/Sonnet; no synthesis.
- No auth; tenant isolation lives only in `MemoryFlankStore`'s relation-walking.
- `apps/web` renders one page **from checked-in fixtures** ("no database, no API keys").

So M1 is _proven in a test tube, not in production_: the slice runs end-to-end against fixtures
but **cannot persist a row across two processes** — the precondition for every M2 trust feature
and the moat. M0 is done; `just ci` is green (92 tests).

## The ordering principle

The moat is the accumulating, span-verified **change timeline** plus workflow embedding. Sequence so
the differentiating M2 trust features and a real delivery surface arrive ASAP **without skipping the
persistence/fetch foundation they require**. Do not build Stripe before there is a product to pay for.

The single highest-leverage move is **not** "implement `DrizzleFlankStore`." The audit found three
contract-level bugs in `FlankStore` that would be copied 1:1 into the store shipped to paying
customers. Fix the _interface_ first, freeze it behind a shared contract-test suite, then the DB
store becomes a mechanical implementation of a tested spec.

## Keystone: re-sign the `FlankStore` contract

Three verified bugs, fixed in the one place they propagate from:

1. **No `workspaceId` on any write.** A caller holding another tenant's `deltaId` can advance its
   state or attach claims (Invariant 8 hole baked into the contract).
2. **`ALLOWED_DELTA_TRANSITIONS` has a `pending → published` edge.** Once a publisher exists, nothing
   structurally stops a pricing delta skipping confirmation (Invariant 3). ⚠️ This is `triageClass`-
   dependent, so it **cannot** be expressed in the static transition table alone — the store must
   load the delta and branch on its class (or thread `triageClass` into the guard).
3. **No section/alert methods exist** — M2 synthesis, the diff-two-versions UI, and M3 import are
   all unmodellable.

Split into two PRs (keystone stays small and invariant-critical):

- **PR-1 (this PR):** `workspaceId` on every write/lookup; tightened transitions (pricing reaches
  `published` only via `confirmed`); `confirmedBySnapshotId` + `vantage` added to the domain
  entities; a `withTransaction` unit-of-work; and **one shared `FlankStore` contract-test suite**
  that `MemoryFlankStore` must pass. Pure-TS, infra-free, reversible. No DB code.
- **PR-2:** section + alert methods — added **with their first real caller** (the section gate /
  delivery), since synthesis will likely reshape the section signature (`batch_id`, `model`,
  `supersedesId`). Adding unused methods to a "frozen" interface now invites a wrong signature.

## Tracks (sequenced)

### M1-hardening — Persistence spine _(the hard gate)_

| #   | Task                                                                                                                                                                                                                                                                                                                                      | Effort | Depends on   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| 1   | **PR-1: re-sign `FlankStore`** (workspace-scoped writes, tightened transitions, `withTransaction`, confirmation fields) + shared contract-test suite green against `MemoryFlankStore`                                                                                                                                                     | M      | —            |
| 2   | Add a wire driver (`postgres-js`) + a thin env-validated `createDb(databaseUrl)` factory in `packages/db`, exported alongside (not merged into) schema                                                                                                                                                                                    | S      | — (parallel) |
| 3   | Denormalize `workspace_id` onto `snapshot`/`delta`/`claim` (new migration) + a **backfill plan** — once append-only `REVOKE` lands you cannot retro-fix rows, so backfill ordering is load-bearing                                                                                                                                        | S      | PR-1         |
| 4   | Implement `DrizzleFlankStore` against the re-signed contract; `withTransaction` wraps the ingest write set atomically; every query filters by `workspace_id`                                                                                                                                                                              | L      | 2            |
| 5   | RLS as a **fast-follow** (FORCE ROW LEVEL SECURITY + per-tx `app.workspace_id` GUC) — keep adjacent to the store, not floating in an auth track. _Deferred past first paying customer; app-tier scoping + contract tests close Invariant 8 until then._                                                                                   | M      | 3, 4         |
| 6   | Append-only + Invariant-3 enforcement migration: `REVOKE UPDATE/DELETE` on history tables; `UPDATE` trigger permitting only legal delta transitions; guard `pricing_change → confirmed` requires `confirmed_by_snapshot_id NOT NULL`                                                                                                      | M      | 4            |
| 7   | `UNIQUE(competitor_id, kind, version)`, index on `snapshot(source_id, fetched_at)`, and **one** docker-compose-backed integration test that applies the migration and round-trips a full write set through `DrizzleFlankStore` via the shared contract suite — run locally **and** in CI against the already-provisioned pgvector service | M      | 6            |

### M1-hardening — Auth & tenancy origin

| #   | Task                                                                                                                                                                                                                                                                                                                    | Effort | Depends on       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- |
| 1   | `users` + `memberships` tables + a Next App Router auth/session layer resolving each request to an authorized `workspaceId`. **Done — identity delegated to FerrisKey (OIDC) via Auth.js v5; tenancy still re-derived from live `memberships` locally (Invariant 8). `app_user.external_subject` links the IdP `sub`.** | L      | store (#4 above) |
| 2   | Zod-parsed runtime env module validated at process start (`ANTHROPIC_API_KEY`, signing/API secrets) for app + worker entrypoints                                                                                                                                                                                        | S      | — (parallel)     |

### M1-hardening — Real fetch + schedule runtime

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                       | Effort | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 1   | Define a `Fetcher` port in core; direct-GET fetchers (RSS / Greenhouse-JSON / pricing-HTML) with timeout, courtesy UA, per-host ≤1 req/s; resolve the type-vs-adapter dispatch split; pass real `httpStatus` (not the hardcoded 200)                                                                                                                                                                                       | M      | store      |
| 2   | **SSRF-guarded fetch wrapper** under the port (block private/loopback/link-local/metadata ranges, resolve-then-pin, cap redirects) — lands **with** the first fetcher, not after; competitor URLs are tenant-supplied                                                                                                                                                                                                      | M      | fetch #1   |
| 3   | In-code **Invariant-4 allowlist/denylist** at the fetcher port (G2/Capterra prohibited), tested — not just a per-source `legalStatus` flag a buggy add could mis-set                                                                                                                                                                                                                                                       | S      | fetch #1   |
| 4   | Inngest + fan-out cron: query sources due by cadence → fetch → `ingestFetch` → stamp `lastFetchedAt`, increment/reset `consecutive_failures`, pause past threshold; **idempotency guard** (content-hash-keyed) on snapshot/delta insert so step retries don't duplicate history or crash on append-only                                                                                                                    | M      | fetch #1   |
| 5   | **Pricing-confirmation re-fetch** (Invariant 3 belongs **here**, not M2 — it structurally needs an independent second fetch): pending `pricing_change` schedules a second fetch (different time/vantage) → promote to `confirmed` with `confirmedBySnapshotId` if reproduced, else dismiss as flap (evidence retained). Update `composeAlerts` to alert on confirmed pricing instead of blanket-excluding `pricing_change` | M      | cron #4    |
| 6   | Firecrawl-then-Zyte fallback (only on 403/Cloudflare, budget-capped) + S3 raw-snapshot bytes. _Deferred — beachhead sources are legal-graph RSS/JSON; wait until a real source 403s._                                                                                                                                                                                                                                      | M      | fetch #1   |
| 7   | Lever/Ashby parsers + source-graph discovery. _Deferred — follows proven self-serve demand; concierge onboarding adds sources by hand._                                                                                                                                                                                                                                                                                    | M      | cron #4    |

### Cross-cutting — Real LLM + honest COGS

| #   | Task                                                                                                                                                                                                         | Effort | Depends on   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------ |
| 1   | Widen `TriageResult` to carry real token usage; build a **record/replay cassette harness** asserting zero live calls in `just ci`; live calls behind an opt-in eval script                                   | M      | — (parallel) |
| 2   | Add `@anthropic-ai/sdk` + `AnthropicTriageClient` behind the existing `TriageClient` interface (routed through `TriageResultSchema.parse`); factory returns it when `ANTHROPIC_API_KEY` is present           | S      | LLM #1       |
| 3   | Rewrite `cogs.ts` into a per-model pricing table (Haiku + Sonnet in/out, Batch discount, cache rates) metering from **actual** SDK usage tokens; store cost as integer micro-dollars, not float cents        | M      | LLM #2       |
| 4   | Per-tier COGS budget (Growth ≤ $15/mo) + monthly `coverage_run` aggregation + a soft-cap gate that pauses synthesis on overage; surface per-account COGS (a SQL query/script is enough — defer the admin UI) | M      | LLM #3       |

### Cross-cutting — Testing & CI gates _(land early)_

| #   | Task                                                                                                                                                                                                                                              | Effort | Depends on   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| 1   | Add a thresholds block to `vitest.config.ts` (global ≥ 80, higher floors for `citation.ts`/`diff.ts`) and make `just ci` run `vitest run --coverage` so the gate fails builds (today coverage is collected but **never enforced**)                | S      | — (parallel) |
| 2   | CI migration-apply + drift-check (`drizzle-kit migrate` + `generate --check`) and run the shared contract suite against the DB store using the already-provisioned pgvector service (today CI provisions Postgres but **nothing connects**)       | S      | store        |
| 3   | Replace the `e2e` hard-fail stub (`process.exit(1)`) with a Playwright scaffold (320/768/1024/1440 + reduced-motion; smoke: timeline renders, citation link resolves) wired as a CI job                                                           | M      | web refactor |
| 4   | **Operator observability** — structured logging + an operator error surface for async fetch/triage/batch failures and source pauses (Invariant 7 is customer-facing; the operator also needs to see failures of a nightly batch they can't watch) | S      | cron         |

### M2 — Trust layer _(the reason to pay)_

| #   | Task                                                                                                                                                                                                                                                                                              | Effort | Depends on                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- |
| 1   | Section-level citation gate: run synthesized section `claim_ids` through `verifyClaim`/`gatePublish` against stored snapshot text before publishing a new `supersedesId` version (establishes the version-chain write path **before** any LLM cost)                                               | M      | PR-1 (+ PR-2 section methods) |
| 2   | `SonnetBatchClient` interface + checked-in batch-response replay fixtures + a golden assertion that synthesis regenerates **only** affected sections                                                                                                                                              | M      | LLM #1                        |
| 3   | Nightly Sonnet Batch synthesis: collect confirmed material deltas per competitor → Batch requests with prompt caching over the stable dossier → regenerate only sections whose `claim_ids` intersect new deltas → section gate → publish verified sections as new versions (`model` + `batch_id`) | L      | M2 #1, #2                     |
| 4   | Refactor the web brief into a **store-reading Server Component** (fed by `DrizzleFlankStore` rows by `workspaceId`, not `runFixtureScenario`) + app shell (workspace-scoped nav, dossier index, competitor/timeline/dossier/battlecard tabs); drop the M1 fixture chrome                          | M      | auth                          |
| 5   | Dossier/battlecard **version-diff view** (select two versions via `supersedes_id`, inline diff reusing the `Citation` component) + per-delta raw-vs-revised source diff in the timeline                                                                                                           | L      | M2 #4                         |
| 6   | Load Source Serif 4 / Inter / JetBrains Mono via `next/font` (`font-display: swap`) wired to the existing `--font` CSS variables (today they degrade to system fonts)                                                                                                                             | S      | — (parallel)                  |

### M2 — Delivery surfaces _(silence must be visible)_

| #   | Task                                                                                                                                                                                                                                                                                                                                                 | Effort | Depends on           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| 1   | Wire `composeAlerts` into ingest's post-publish path: persist each payload as a queued `alert` per channel **inside** the coverage transaction, gated by a dedupe lookup; refuse to emit an alert for a published delta with no verified claim (closes the empty-quote hole); validate `alert.payload` with a Zod schema derived from `AlertPayload` | S      | PR-2 (alert methods) |
| 2   | **Resend email digest** as the first delivery surface (no OAuth): batch queued alerts + the latest `coverage_run` receipt into one HTML email per workspace per period; transition `alert.status` on send; reuse the `CoverageReceipt` view model                                                                                                    | M      | delivery #1          |
| 3   | Slack Bolt delivery adapter (one Block Kit message per published delta) sharing the dedupe/status machinery; single bot token first                                                                                                                                                                                                                  | M      | delivery #2          |
| 4   | Extend `AlertPayload` with `battlecardSectionRef` (the "how to respond" leg); add `HUBSPOT_*`/`SFDC_*` to `.env.example`. CRM sidebar itself deferred to M3                                                                                                                                                                                          | S      | synthesis            |

### M3 — Monetization _(last; do not invert the dependency order)_

| #   | Task                                                                                                                                                                                                                              | Effort | Depends on            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------- |
| 1   | Pure-core `TIER_LIMITS` map (starter 5 / growth 15 / team 40) + `countCompetitors` + a `seedCompetitor` guard with overage flagging; tie limit-sizing to measured `coverage_run.llmCostCents`                                     | S      | COGS #4               |
| 2   | Section provenance (`native` \| `imported`) + a Klue/Crayon CSV import seeding battlecard/dossier sections as `imported` version-0 entries (seeds the moat history for the churned-Klue beachhead)                                | M      | M2 #1                 |
| 3   | One Stripe Payment Link / annual invoice per tier + a webhook writing `stripeCustomerId`/`planTier`/`competitorLimit`, paired with concierge onboarding; **skip self-serve signup** until a design partner validates the timeline | M      | auth                  |
| 4   | Monthly state-of-field synthesis + quiet-month receipts tied to the digest spine (anti-churn, DESIGN Risk #4)                                                                                                                     | M      | M2 synthesis + digest |
| 5   | Multi-workspace Slack OAuth install flow + CRM deal-context sidebar. _Last mile — a single bot token + reserved CRM env vars suffice until paid demand is proven._                                                                | L      | delivery #3           |

## Top risks to manage

| Risk                                                                                                                                                                              | Mitigation                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DrizzleFlankStore` written before the contract is corrected, copying the three bugs into the paid store                                                                          | Make contract re-signing the mandated first PR (no DB code); freeze behind the shared contract-test suite                                                                                                 |
| Append-only + tenant isolation (Inv. 5 & 8) ship enforced only in app code — one raw `UPDATE`/forgotten `WHERE` destroys/leaks the moat                                           | `REVOKE`/trigger append-only migration + (fast-follow) RLS as hard gates before the store is exposed; direct-SQL rejection + cross-tenant assertions in the integration suite                             |
| Pricing confirmation (Inv. 3) deferred into a fixture-only M2 — but it's impossible without the real fetch+schedule runtime; false pricing alerts burn the exact buyers we target | Build confirmation **on the fetch track**; tighten the state machine; test both confirm and flap-dismiss paths                                                                                            |
| Real LLM/Batch added without a replay seam → live calls in CI + dishonest input-only COGS → Inv. 6 unenforceable                                                                  | Land the cassette harness + per-model token COGS table **with** the real client; soft-cap synthesis spend before any paying account                                                                       |
| Scope creep to M3 (Stripe/OAuth/self-serve) before M2 exists → a billable but valueless shell                                                                                     | Hard-sequence M3 behind M2; earliest monetization is a Payment Link + concierge for a design partner                                                                                                      |
| Prompt injection via fetched competitor pages manipulating triage/synthesis                                                                                                       | Span-verification (Inv. 1) bounds the blast radius; treat synthesis rationale (not span-verified, buyer-facing) as untrusted and review before publish; add content-side handling when the real LLM lands |
| A bad-but-verified synthesis batch publishes into append-only history with no undo                                                                                                | Add a **supersede-with-correction** path (the version chain supports it structurally); a concierge design partner will need it                                                                            |

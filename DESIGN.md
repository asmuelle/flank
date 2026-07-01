# DESIGN.md — Flank Architecture & Product Design

## Thesis

Scheduled one-shot research (ChatGPT Tasks, Perplexity Spaces) regenerates today's snapshot;
it cannot tell you what changed since last Tuesday, with proof. Flank owns exactly that gap:
versioned cross-run diffing with span-pinned provenance, delivered where sales teams already
work, at a price that captures the churned Klue/Crayon pool repricing CI right now. The moat
is not the dossier — it is the accumulating, irreproducible change timeline plus workflow
embedding, so every design decision below biases toward history integrity and trust.

## Architecture

### Pipeline shape: source → diff → triage → synthesis → surface

```
[Source graph per competitor]
  pricing pages · changelogs · docs · job-board JSON · status pages · blogs/RSS · app stores
        │  (adaptive cadence: daily pricing/changelog, weekly jobs/reviews)
        ▼
[Fetch layer]            deterministic code
  RSS/JSON/sitemap first → Firecrawl/Zyte only for blocked pages → S3 raw snapshot
        ▼
[Diff layer]             deterministic code
  normalize → SimHash/content-hash → unchanged? STOP (no LLM, no cost)
  changed? → extract changed spans with offsets
        ▼
[Triage]                 cheap model (Claude Haiku class)
  classify delta: pricing_change | feature_launch | repositioning | leadership_hire |
  hiring_signal | noise · materiality score · pricing deltas → confirmation queue
        ▼
[Synthesis]              frontier model (Claude Sonnet class), nightly Batch API (50% off)
  prompt-cached stable dossier context + only the material deltas →
  regenerate ONLY affected dossier/battlecard sections → span-verify every claim → publish
        ▼
[Surface]
  web app (dossier library, timeline, battlecards) · Slack alerts · email digest ·
  CRM sidebar + deal-context alerts (Team tier)
```

**Cost discipline ladder (enforced as code, see AGENTS.md Invariant 2 & 6):**

1. Deterministic code handles fetching, hashing, span extraction, scheduling, citation
   verification — zero model cost, the bulk of all runs end here.
2. Haiku-class triage sees only changed spans (+ tight context window), ~5M tok/account/mo.
3. Sonnet-class synthesis runs once nightly per affected competitor via Batch API with prompt
   caching on the stable dossier; regenerates only sections referencing changed claims.
4. Per-account COGS metered in-product; Growth-tier target ≤ $15/mo (README's $8 assumed free
   crawling — treat $15–30 as the honest band and optimize down).

### Monorepo layout (pnpm workspace)

| Package             | Contents                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`          | Next.js 15 App Router, TypeScript strict. Dossier library, change timeline, battlecard editor/viewer, source-graph settings, billing.                                     |
| `packages/core`     | Pure TS, no I/O: entity types, span diff algorithms, materiality rule engine, citation verifier (exact-quote + offset string match), COGS meter. The most-tested package. |
| `packages/pipeline` | Inngest functions: per-source fetch crons, diff jobs, triage calls, pricing-confirmation re-fetch, nightly synthesis batch, Slack/Resend delivery, coverage accounting.   |
| `packages/db`       | Drizzle ORM schema, migrations, pgvector setup, append-only guards.                                                                                                       |

### Scheduling choice: Inngest (over Temporal)

Inngest is the call: TypeScript-native step functions co-deployed with the Next.js app,
built-in cron + event triggers, retries, concurrency keys, and a local dev server — no
separate cluster to operate, which matters for a 1–2 person team shipping M1. Per-competitor
standing workflows map to Inngest functions keyed by `sourceId` with per-source cron cadence.
Revisit Temporal only if we need long-lived (>7 day) workflow state or migrate off serverless.

## Data Model Sketch

All history tables are **append-only** (Invariant 5). Workspace-scoped throughout (Invariant 8).

| Entity                 | Key fields                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **workspace**          | id, name, plan_tier (starter/growth/team), competitor_limit, stripe_customer_id, created_at                                                                                                                                          |
| **competitor**         | id, workspace_id, name, primary_domain, aliases[], status (active/paused), created_at                                                                                                                                                |
| **source**             | id, competitor_id, type (pricing/changelog/docs/jobs/reviews/status/blog/appstore), url_or_endpoint, adapter (rss/json/firecrawl/zyte), cadence (cron), legal_status (open/licensed/blocked), last_fetched_at, consecutive_failures  |
| **snapshot**           | id, source_id, content_hash, s3_key (raw), normalized_text, fetched_at, vantage (region/context), http_status — append-only                                                                                                          |
| **delta**              | id, source_id, from_snapshot_id, to_snapshot_id, changed_spans (jsonb: offsets + text), triage_class, materiality (0–3), state (pending/confirmed/dismissed/published), confirmed_by_snapshot_id (pricing), created_at — append-only |
| **claim**              | id, delta_id, snapshot_id, quote_text, char_start, char_end, source_url, captured_at, verified_at (null = unpublishable)                                                                                                             |
| **dossier_section**    | id, competitor_id, kind (overview/pricing/product/gtm/team), version, content_md, claim_ids[], model + batch_id, supersedes_id — append-only versions                                                                                |
| **battlecard_section** | id, competitor_id, kind (why_we_win/landmines/pricing_counter/objections), version, content_md, claim_ids[], supersedes_id — append-only versions                                                                                    |
| **alert**              | id, workspace_id, delta_id, channel (slack/email/crm), payload, status (queued/delivered/failed), delivered_at                                                                                                                       |
| **coverage_run**       | id, workspace_id, period, sources_checked, fetch_failures, deltas_found, material_deltas, llm_cost_cents — feeds digest receipts and COGS metering                                                                                   |
| **app_user**           | id, email, name, external_subject (FerrisKey OIDC `sub`, nullable — linked on first login), created_at — global identity, not workspace-scoped                                                                                       |
| **membership**         | id, user_id, workspace_id, role (owner/member), created_at — the ONLY thing that confers tenancy (Invariant 8); mutable                                                                                                              |

pgvector lives on `snapshot.normalized_text` embeddings (changed-span similarity, "have we
seen this repositioning before") — an enhancement, not on the M1 critical path.

### Authentication & tenancy origin

Identity is delegated to **FerrisKey** (self-hosted, Keycloak-alternative IAM) over OIDC; the web
app is a relying party via **Auth.js v5** (`apps/web/auth.ts`). FerrisKey answers _who_ the user is;
it never carries _tenancy_. On each sign-in the verified identity is mapped to exactly one local
`app_user` (`linkOrCreateUserBySubject`, keyed by the immutable `sub`, email-backfilled for seed
rows), and that local id is pinned on the session. Every authed request then re-derives its
`workspaceId` + role from **live** `membership` rows (`resolveActiveWorkspace` → pure
`resolveWorkspace`), so a revoked grant takes effect immediately and a user with zero memberships is
fail-closed to the "no workspace" screen — Invariant 8 holds without trusting anything in the token.

## Key Flows

### 1. Ingest & diff (per source, on cadence)

1. Inngest cron fires for a `source`; adapter fetches (RSS/JSON direct; Firecrawl/Zyte only if `legal_status` permits and direct fetch is blocked).
2. Raw payload → S3; normalized text + content hash computed.
3. Hash equals previous snapshot's → record fetch in coverage accounting, **stop** (no LLM).
4. Hash differs → persist new `snapshot`, compute changed spans with character offsets, create `delta(state=pending)`.
5. Haiku triage classifies the changed spans → triage_class + materiality. `noise` → delta closed, still counted in coverage.

### 2. Pricing confirmation (the false-positive firewall)

1. Triage classifies a delta as `pricing_change` → delta stays `pending`; **no alert fires**.
2. Pipeline schedules a confirmation re-fetch: clean context (no cookies) and, when configured, a second vantage/region.
3. Confirmation snapshot reproduces the change → `state=confirmed`, `confirmed_by_snapshot_id` set → proceeds to synthesis/alerting.
4. Not reproduced → delta marked `dismissed` with both snapshots retained as evidence; nothing published.

### 3. Nightly synthesis (frontier pass)

1. Nightly Inngest job collects confirmed material deltas per competitor since the last pass.
2. Builds Batch API requests: prompt-cached stable dossier context + only the new deltas/claims; requests regeneration of **only sections whose claim_ids intersect the deltas**.
3. Each regenerated section's claims run through the citation verifier: quote text string-matched at the recorded offsets against the stored snapshot. Any failure → section publish blocked, flagged for repair (fail closed, Invariant 1).
4. Verified sections published as new versions (`supersedes_id` chain); change timeline entries created; affected battlecard sections regenerated the same way.

### 4. Delta to Slack (and deal context)

1. Published material delta → alert composed: what changed (quote + link + timestamp), why it matters (triage rationale), how to respond (battlecard pointer).
2. Delivered to the workspace's Slack channel; email digest batches the rest daily/weekly per settings.
3. Team tier: CRM poll/webhook detects a tracked competitor attached to an open opportunity → deal-context alert into the deal's channel/sidebar with the freshest battlecard section.

### 5. Onboarding & quiet-month receipts

1. New competitor: domain entered → source-graph discovery (sitemap, RSS autodiscovery, job-board token probe, changelog heuristics) proposes sources; user confirms.
2. Initial fetch pass builds snapshot baseline; first dossier generated as the onboarding "wow" — with Klue/Crayon export import to seed history where available (M3 migration path).
3. Monthly, regardless of delta volume: state-of-the-field synthesis ships — "checked N sources, M deltas, nothing material; here's the QoQ trendline" — making silence legible instead of churn-inducing (Invariant 7).

## Product & Visual Design Direction

**Intelligence-briefing editorial** — the product should read like a well-run intel desk's
morning brief, not a SaaS dashboard. Light paper surface (warm off-white, `oklch(97% 0.005 90)`),
near-black ink text, and a disciplined signal system: one radar-blue accent for interactive
elements, with delta semantics carried by color (red = pricing/threat, amber = repositioning,
green = opportunity) used _only_ on deltas, never decoratively. Typography pairing: a serif
display face (Source Serif 4) for dossier headlines and battlecard titles — gravitas, print-brief
feel — over Inter for UI, with JetBrains Mono reserved for provenance metadata (hashes, URLs,
timestamps, offsets) so evidence is visually distinct from synthesis. The change timeline is
the hero surface: a dense, newspaper-margin-annotated vertical with quote-card citations that
expand to the verified span. Hierarchy through scale and weight, not boxes; no card-grid filler.

## Milestones

### M0 — Bootstrap (make `just ci` green)

Scaffold the pnpm workspace exactly as laid out above: root `package.json` with `dev/test/e2e/
lint/format/typecheck/build/migrate` scripts, the four packages with placeholder entry points,
TS strict configs, ESLint + Prettier, Vitest + Playwright configs, `docker-compose.yml`
(pgvector/pgvector:pg16), Drizzle config, `.env.example`.
**Accept:** `just ci` passes locally and in GitHub Actions on a fresh clone; `just db-up && just migrate` creates an empty schema.

### M1 — Thin vertical slice (one competitor, three sources, real diffs)

One workspace, one competitor, three source types end-to-end: (a) a changelog RSS feed,
(b) a Greenhouse public-JSON job board, (c) one pricing page via direct fetch. Cron fetch →
snapshot → hash diff → Haiku triage → delta rows, and a web UI showing the competitor's change
timeline with raw quote + URL + timestamp per delta. No synthesis yet; mocked-LLM test fixtures.
**Accept:** seeding a real competitor produces snapshots on schedule; editing the fixture
pricing page produces exactly one `pricing_change` delta in `pending` (not alerted); unchanged
fetches produce zero LLM calls (asserted by test); timeline renders with citations; coverage_run rows populate.

### M2 — Trust layer (the reason to pay)

Citation verifier gating publish (Invariant 1), pricing confirmation flow (Invariant 2 firewall),
nightly Sonnet Batch synthesis regenerating only affected dossier sections, append-only version
chains visible in the UI (diff any two dossier versions), coverage receipts in a digest email.
**Accept:** a corrupted claim fixture blocks publish and surfaces a repair task; an A/B-style
flapping pricing fixture is dismissed, never alerted; nightly batch touches only affected
sections (asserted on batch request contents); digest shows "checked N sources" on a zero-delta week.

### M3 — Monetization wiring

Stripe with annual-prepay emphasis (2 months free) per tier limits ($79/5, $199/15, $449/40,
+$10 per extra competitor); Slack app distribution; Klue/Crayon battlecard import (CSV/export
parsing) seeding dossier history; concierge-onboarding order flow ($500–1K one-time);
competitor-limit and COGS-budget enforcement per workspace.
**Accept:** self-serve signup → paid Growth workspace → competitor limits enforced; import of a
sample Klue export produces seeded battlecards with provenance marked `imported`; per-account
COGS visible in an internal admin view.

## Risks & Mitigations (top 5, from the adversarial review)

| #   | Risk                                                                                                                                                                          | Mitigation                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Platform substitution** — ChatGPT Tasks / Perplexity scheduled research covers the "regenerate a dossier" job; cross-run diffing is "a 1–2 sprint feature" for them         | Make the timeline + span-verified provenance the hero from M1, not the dossier; embed in Slack rituals and CRM deal records (M2/M3) so switching means leaving workflows, not just a document; accumulate history they cannot backfill                                   |
| 2   | **Data access shrinkage** — Cloudflare blocks AI crawlers by default; G2/Capterra legally off-limits                                                                          | Legal-first source graph (RSS/JSON/sitemaps cover most signal); Firecrawl/Zyte budgeted per account as fallback only; degraded sources surfaced honestly in coverage receipts instead of silently missing (turns a weakness into a trust feature)                        |
| 3   | **False pricing alerts** — A/B-tested, geo-personalized pricing pages make false deltas the default failure mode, and one bad alert repeated in a live deal kills credibility | Pricing confirmation protocol (Flow 2): no single-fetch pricing alert ever; clean-context + multi-vantage re-fetch; dismissed flaps retained as evidence; invariant-level tests                                                                                          |
| 4   | **Quiet-month churn** — a silent $199 Slack channel is the first cut in the month-6 tool audit                                                                                | Annual prepay pushed hard (2 months free) matching how ex-Klue buyers budget; monthly state-of-the-field synthesis + per-digest coverage receipts demonstrate negative-space value; never inflate alert volume to fake liveliness                                        |
| 5   | **COGS underestimate** — pitched $8/account assumes free crawling; honest band is $15–30 with unblockers                                                                      | COGS metered per account from M1 (`coverage_run.llm_cost_cents` + crawl spend); hash-gate enforcement keeps LLM spend proportional to actual change; Batch + prompt caching mandatory for synthesis; tier source-count limits sized against measured, not assumed, costs |

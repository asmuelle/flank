# AGENTS.md — Operating Manual for AI Agents

## Project Snapshot

**Flank** is a living competitor radar for B2B SaaS: standing agents maintain versioned,
citation-pinned dossiers and self-refreshing battlecards per rival, pushing only material
deltas (what changed, why it matters, how to respond) at 1/50th–1/100th of a Klue contract.

- **Who pays:** founders and PMMs at seed-to-Series-B SaaS ($79–449/mo self-serve tiers);
  beachhead is churned/orphaned Klue and Crayon accounts re-pricing CI after Klue's 40% staff cut.
- **Status:** Tier 2 (pipeline). Strong unit economics; must out-execute ChatGPT/Perplexity
  scheduled-research features on the one structurally unowned axis: versioned cross-run
  diffing with span-pinned provenance.
- **Current state:** documentation + harness scaffold. No application code yet. M0 = bootstrap.

## Read First

1. `README.md` — research dossier: market evidence, adversarial review, unit economics. Binding context.
2. `DESIGN.md` — architecture, data model, key flows, milestones M0–M3. Build in that order.
3. `TOOLS.md` — every command, external API, env var, and local service.

## Commands (single source of truth)

Agents MUST use `just` recipes, never raw `pnpm`/`docker` invocations. Recipes fail with
guidance until the workspace is bootstrapped (M0).

| Recipe                        | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `just`                        | List all recipes                                           |
| `just setup`                  | corepack enable + pnpm install                             |
| `just dev`                    | Run the dev servers (web + workers)                        |
| `just db-up` / `just db-down` | Start/stop local Postgres (pgvector) via docker compose    |
| `just migrate`                | Apply Drizzle migrations                                   |
| `just test`                   | Vitest unit/integration tests                              |
| `just e2e`                    | Playwright end-to-end tests                                |
| `just lint` / `just format`   | ESLint / Prettier                                          |
| `just typecheck`              | tsc --noEmit across the workspace                          |
| `just build`                  | Production build of all packages                           |
| `just ci`                     | lint + typecheck + test + build (what GitHub Actions runs) |

## Architecture Summary

A pnpm-workspace monorepo implementing a source → diff → triage → synthesis → surface
pipeline: per-competitor source graphs (pricing pages, changelogs, docs, job-board JSON,
review streams, status pages) are fetched on adaptive cadence, content-hash diffed so LLMs
only ever see changed spans, triaged for materiality by Haiku-class models, and synthesized
nightly by a frontier batch pass that regenerates only affected dossier/battlecard sections —
every claim span-pinned (quote + URL + timestamp) and string-verified before publish.

| Module              | Responsibility                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/web`          | Next.js 15 App Router, TS strict — dossier library, change timeline, battlecards, settings                           |
| `packages/core`     | Pure TS domain logic: entities, span diffing, materiality rules, citation verification. No I/O.                      |
| `packages/pipeline` | Inngest functions: source fetchers, hash diffing, Haiku triage, nightly Sonnet batch synthesis, Slack/email delivery |
| `packages/db`       | Drizzle ORM schema + migrations, Postgres + pgvector                                                                 |

## Coding Standards

- TypeScript strict mode everywhere; no `any` without a written justification comment.
- Files < 800 lines, functions < 50 lines. Extract modules early.
- Immutability by default: return new objects, never mutate inputs. Append-only tables stay append-only.
- Explicit error handling at every boundary (fetchers, LLM calls, webhooks, DB). Never swallow
  errors; fetch failures are first-class data (they feed coverage receipts).
- Validate all external data at the boundary with Zod schemas (crawled HTML, job-board JSON,
  LLM output, webhook payloads). Never trust fetched content.
- No hardcoded secrets — env vars only, validated at startup. See TOOLS.md for the full table.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## Testing Policy

- TDD: write the failing test first (RED → GREEN → REFACTOR). Target 80%+ coverage. AAA pattern.
- What matters MOST for this product, in priority order:
  1. **Citation verification** (`packages/core`): exact-quote/offset checks against stored
     snapshots — property tests and adversarial fixtures (truncated quotes, unicode, moved spans).
  2. **Diff/triage determinism** (`packages/core`, `packages/pipeline`): same input pair →
     same changed spans, same hash. Golden-file fixtures of real pricing/changelog HTML.
  3. **Pipeline integration**: fetch → snapshot → delta → triage against a local Postgres,
     with mocked LLM responses (record/replay fixtures, never live calls in tests).
  4. **E2E (Playwright)**: dossier timeline renders, citation links resolve, alert settings persist.
- LLM calls are always mocked in unit/integration tests. Cost-bearing live calls only behind
  an explicit opt-in eval script.

## PRODUCT INVARIANTS (non-negotiable, each must be enforced by code + tests)

1. **No claim without a verified span.** Every published statement in a dossier or battlecard
   carries quote text + character offsets + source URL + capture timestamp, string-verified
   against the stored snapshot at publish time. Verification failure blocks publish — fail
   closed, never publish unverified.
2. **Deterministic diff before any LLM.** An LLM call on source content is only permitted when
   the content hash changed; the prompt contains only changed spans plus minimal context.
   A code path that sends unchanged content to a model is a bug.
3. **Pricing deltas require confirmation.** Pricing pages are A/B-tested and geo-personalized;
   a false "competitor cut pricing 20%" alert is a credibility-ending event. Never alert on a
   single fetch: require re-fetch confirmation from a clean context (and/or second vantage)
   before a pricing delta can leave `pending` state.
4. **Legal-first source graph.** Greenhouse/Lever/Ashby public JSON, RSS, sitemaps, changelogs,
   status pages, app-store feeds are fair game. G2/Capterra scraping is prohibited (ToS) —
   license or skip. Respect robots/blocks; a blocked source degrades coverage visibly, it does
   not trigger evasion beyond the sanctioned unblocker budget.
5. **History is append-only.** Snapshots, deltas, dossier versions, and battlecard versions are
   never updated or deleted (tenant offboarding/export aside). The versioned time series IS the
   moat; destructive migrations on these tables must be rejected in review.
6. **Cost discipline is enforced, not aspirational.** Haiku-class triage on changed spans only;
   frontier model only in the nightly Batch API pass (50% off) with prompt caching, regenerating
   only affected sections. Per-account COGS is metered and surfaced; Growth-tier target ≤ $15/mo.
7. **Silence must be visible.** Every digest reports coverage ("checked N sources, M deltas,
   K failures") even when nothing material fired; a monthly state-of-the-field synthesis ships
   regardless. Never pad quiet periods with non-material alerts — that recreates Google Alerts.
8. **Tenant isolation.** All queries are workspace-scoped; competitive intel of one customer can
   never leak into another's dossiers, prompts, or alerts. Cross-tenant access is a CRITICAL bug.

## Definition of Done

- [ ] Tests written first, passing, coverage ≥ 80% on touched code
- [ ] `just ci` green locally
- [ ] No invariant above weakened; new code paths that touch publish/alert flows have invariant tests
- [ ] External inputs Zod-validated; errors handled explicitly at boundaries
- [ ] No secrets in code or fixtures; new env vars documented in TOOLS.md
- [ ] DESIGN.md updated if architecture or data model changed
- [ ] Conventional commit message

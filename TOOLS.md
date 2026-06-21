# TOOLS.md — Commands, APIs, Env Vars, Services

## just Recipes

| Recipe                     | What it does                                             | When to run                                         |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `just`                     | Lists all recipes                                        | Orientation                                         |
| `just setup`               | `corepack enable` + `pnpm install`                       | First clone; after lockfile changes                 |
| `just dev`                 | `pnpm dev` — Next.js web + Inngest dev server/workers    | Daily development                                   |
| `just db-up`               | `docker compose up -d postgres` (pgvector/pgvector:pg16) | Before `just migrate`, `just dev`, `just test`      |
| `just db-down`             | Stops the local Postgres container                       | Cleanup                                             |
| `just ferriskey-up`        | FerrisKey IAM stack (API :3333, console :5555, db :5434) | Before signing in locally                           |
| `just ferriskey-down`      | Stops the FerrisKey IAM stack                            | Cleanup                                             |
| `just ferriskey-bootstrap` | Realm + client + demo user; prints `FERRISKEY_*` env     | Once after `ferriskey-up`                           |
| `just migrate`             | Applies Drizzle migrations to `DATABASE_URL`             | After schema changes; after `db-up` on fresh volume |
| `just test`                | `pnpm test` — Vitest across packages                     | TDD loop; before commit                             |
| `just e2e`                 | `pnpm e2e` — Playwright suite                            | Before merging UI/flow changes                      |
| `just lint`                | `pnpm lint` — ESLint workspace-wide                      | Before commit                                       |
| `just format`              | `pnpm format` — Prettier write                           | When the hook didn't catch a file                   |
| `just typecheck`           | `pnpm typecheck` — `tsc --noEmit`                        | Before commit                                       |
| `just build`               | `pnpm build` — production build all packages             | Verifying release readiness                         |
| `just ci`                  | lint + typecheck + test + build                          | Mirror of GitHub Actions; run before pushing        |

All recipes exit with a helpful message until the pnpm workspace exists (M0 in DESIGN.md).

## External Data Sources & APIs

| Source / API          | Endpoint / feed                                           | Auth env var                                 | Cost / limits                                                     | Notes                                                |
| --------------------- | --------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| Greenhouse job boards | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs` | none (public JSON)                           | Free; be courteous (≤1 req/s)                                     | Hiring signals; legal, no scraping needed            |
| Lever postings        | `https://api.lever.co/v0/postings/{company}?mode=json`    | none (public JSON)                           | Free                                                              | Hiring signals                                       |
| Ashby job boards      | `https://api.ashbyhq.com/posting-api/job-board/{name}`    | none (public JSON)                           | Free                                                              | Hiring signals                                       |
| RSS/Atom + sitemaps   | per-competitor changelogs, blogs, status pages            | none                                         | Free                                                              | Preferred fetch path — always try before crawling    |
| Firecrawl             | change-tracking crawl API                                 | `FIRECRAWL_API_KEY`                          | Usage-priced; budget per account                                  | Cloudflare-protected pricing/docs pages              |
| Zyte (or Bright Data) | unblocker proxy                                           | `ZYTE_API_KEY`                               | $6–15/mo per Growth account budget                                | Fallback only; respect Invariant 4 (AGENTS.md)       |
| Exa                   | websets / monitors / search                               | `EXA_API_KEY`                                | $3–8/mo per account budget                                        | New-page and news discovery                          |
| Anthropic             | Messages + Batch API                                      | `ANTHROPIC_API_KEY`                          | Haiku triage; Sonnet nightly via Batch (50% off) + prompt caching | The only LLM provider; see DESIGN.md cost ladder     |
| Slack                 | Bolt app (events + Web API)                               | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`    | Free tier fine                                                    | Delta alerts + digest; Growth tier and up            |
| Resend                | transactional email                                       | `RESEND_API_KEY`                             | Free tier to 3k/mo                                                | Email digests (Starter tier touchpoint)              |
| Stripe                | billing                                                   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | n/a                                                               | M3; annual-prepay emphasis                           |
| HubSpot/Salesforce    | CRM sidebar + opportunity feed                            | `HUBSPOT_*` / `SFDC_*` (M3)                  | n/a                                                               | Team tier; deal-context alerts                       |
| G2 / Capterra         | —                                                         | —                                            | License only                                                      | **Never scraped.** Skip until licensed (Invariant 4) |

## Required Env Vars

| Var                                                                    | Purpose                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`                                                         | Postgres + pgvector connection string                |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` | Raw HTML snapshot storage (S3-compatible)            |
| `ANTHROPIC_API_KEY`                                                    | Triage + synthesis models                            |
| `FIRECRAWL_API_KEY`, `ZYTE_API_KEY`, `EXA_API_KEY`                     | Crawl / unblock / discovery                          |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                             | Scheduling/orchestration (see DESIGN.md choice note) |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`                              | Slack app delivery                                   |
| `RESEND_API_KEY`                                                       | Email digests                                        |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                           | Billing (M3)                                         |
| `AUTH_SECRET`                                                          | Auth.js (NextAuth v5) session/JWT key                |
| `FERRISKEY_ISSUER`, `FERRISKEY_REALM`                                  | FerrisKey OIDC issuer base + realm (discovery)       |
| `FERRISKEY_CLIENT_ID`, `FERRISKEY_CLIENT_SECRET`                       | Confidential OIDC client for the web app             |
| `FERRISKEY_ADMIN_USERNAME/PASSWORD/EMAIL`                              | Local FerrisKey console + bootstrap (dev: admin)     |

No values in the repo, ever. `packages/core` exposes a startup validator that fails fast when
a required var for the running surface is missing. Keep a `.env.example` with names only.

## Authentication (FerrisKey OIDC)

Identity is owned by **FerrisKey** (self-hosted Keycloak-alternative IAM); the web app is an OIDC
relying party via **Auth.js v5**. Tenancy is NOT in the token — every request re-derives workspace

- role from the local `memberships` table (Invariant 8). First-time logins are JIT-provisioned into
  `app_user` and linked by the IdP `sub` (`linkOrCreateUserBySubject`); a user with no membership is
  fail-closed to the "no workspace" screen. Local setup:

```
just ferriskey-up           # API :3333, console :5555, its own Postgres :5434
just ferriskey-bootstrap    # realm `flank` + client `flank-web` + demo user; prints FERRISKEY_* env
# paste FERRISKEY_CLIENT_SECRET into .env, then:
just db-up && just migrate && just seed && just dev
```

Console: http://localhost:5555 (default `admin`/`admin`) is the source of truth if the bootstrap
script drifts from a future FerrisKey API.

## Local Services

- **Postgres 16 + pgvector** via `docker compose` (`pgvector/pgvector:pg16`), port 5432,
  started with `just db-up`. Used by dev, Vitest integration tests, and Drizzle migrations.
- **FerrisKey IAM** via `docker compose --profile auth` (`just ferriskey-up`): API `:3333`,
  console `:5555`, dedicated Postgres `:5434`. The OIDC identity provider for sign-in.
- **Inngest dev server** runs as part of `just dev` for local function execution/cron simulation.
- S3 is mocked or pointed at a local MinIO container if snapshot tests need it (add to compose when M1 lands).

## CI Overview (.github/workflows/ci.yml)

- Triggers on `push` and `pull_request`; single job on `ubuntu-latest`.
- Steps: checkout → `extractions/setup-just@v3` → Node 22 + corepack → **bootstrap guard**:
  if `package.json` is absent the job logs a notice and skips install/build, so the docs-only
  scaffold stays green. Once bootstrapped: `pnpm install --frozen-lockfile` → `just ci`.
- A `pgvector/pgvector:pg16` service container is wired up with `DATABASE_URL` for integration
  tests; it idles harmlessly while the repo is docs-only.

## AI Harness Notes (.claude/settings.json)

- **PostToolUse hooks:** Prettier runs on every written/edited `.ts/.tsx/.js/.jsx/.json/.css/.md`
  file; ESLint `--fix` runs on `.ts/.tsx`. Both no-op until `package.json` exists.
- **Stop hook:** `tsc --noEmit` runs at session end (last 20 lines shown) once bootstrapped —
  do not end a session with type errors.
- **Permissions:** `just`, `pnpm`, `node`, `npx vitest`, `npx playwright`, `docker compose`,
  and read-only git are pre-allowed.
- **Most useful subagents here:**
  - `tdd-guide` — before any new feature (citation verifier, diff engine, triage rules).
  - `code-reviewer` — immediately after changes; pay special attention to invariant erosion.
  - `security-reviewer` — anything touching webhooks (Slack/Stripe), tenant scoping,
    crawled-content handling, or CRM data.

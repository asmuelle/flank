# Flank — living competitor radar. Run `just` to list recipes.
# All recipes guard against the not-yet-bootstrapped state (no package.json, see DESIGN.md M0).

# Load the local .env (gitignored) into every recipe's environment. Nothing else auto-loads it:
# next dev runs in apps/web/ and the tsx scripts don't import dotenv, so without this DATABASE_URL
# (and the other vars in .env.example) never reach the running surface. Falls back silently if absent.
set dotenv-load := true

# List available recipes
default:
    @just --list

# Internal: fail helpfully if the pnpm workspace has not been bootstrapped yet
_bootstrapped:
    @if [ ! -f package.json ]; then \
        echo "flank is not bootstrapped: no package.json found."; \
        echo "This is a docs-only scaffold. Build the pnpm workspace per DESIGN.md milestone M0,"; \
        echo "then run 'just setup'."; \
        exit 1; \
    fi

# Enable corepack and install workspace dependencies
setup: _bootstrapped
    corepack enable
    pnpm install

# Run the Next.js dev server (serves the Inngest functions at /api/inngest)
dev: _bootstrapped
    pnpm dev

# Run the Inngest dev server against the local app (run alongside `just dev`)
inngest-dev: _bootstrapped
    npx inngest-cli@latest dev -u http://localhost:3000/api/inngest

# Start local Postgres (pgvector) via docker compose
db-up:
    @if [ ! -f docker-compose.yml ] && [ ! -f compose.yaml ]; then \
        echo "No docker compose file yet — created in milestone M0 (see DESIGN.md)."; \
        exit 1; \
    fi
    docker compose up -d postgres

# Stop local Postgres
db-down:
    @if [ ! -f docker-compose.yml ] && [ ! -f compose.yaml ]; then \
        echo "No docker compose file yet — nothing to stop."; \
        exit 1; \
    fi
    docker compose down

# Start the FerrisKey IAM stack (API :3333, console :5555, its own Postgres :5434) — the OIDC IdP
ferriskey-up:
    docker compose --profile auth up -d ferriskey ferriskey-console

# Stop the FerrisKey IAM stack (leaves the app Postgres running)
ferriskey-down:
    docker compose --profile auth down

# Provision FerrisKey for Flank: realm + confidential client + redirect URIs + demo user.
# Prints the FERRISKEY_* env values to paste into .env. Re-runnable.
ferriskey-bootstrap:
    pnpm ferriskey:bootstrap

# Apply Drizzle migrations to DATABASE_URL
migrate: _bootstrapped
    pnpm migrate

# Reset + seed one demo tenant (idempotent; needs DATABASE_URL). Prints the sign-in email.
seed: _bootstrapped
    pnpm seed

# Run unit/integration tests (Vitest)
test: _bootstrapped
    pnpm test

# Run tests with the coverage gate (enforces vitest.config.ts thresholds; used by CI)
coverage: _bootstrapped
    pnpm test:coverage

# Run DB-backed integration tests (needs DATABASE_URL; specs skip cleanly without it)
test-integration: _bootstrapped
    pnpm test:integration

# Opt-in live triage eval (needs ANTHROPIC_API_KEY; NEVER part of `just ci`). `--record` writes a cassette.
eval-triage *ARGS: _bootstrapped
    pnpm eval:triage {{ARGS}}

# Run end-to-end tests (Playwright)
e2e: _bootstrapped
    pnpm e2e

# Lint the workspace (ESLint)
lint: _bootstrapped
    pnpm lint

# Format the workspace (Prettier)
format: _bootstrapped
    pnpm format

# verify formatting (prettier --check); CI gate
format-check: _bootstrapped
    pnpm run format:check

# audit dependencies for high+ severity advisories; CI gate
audit: _bootstrapped
    pnpm audit --audit-level=high

# Type-check the workspace (tsc --noEmit)
typecheck: _bootstrapped
    pnpm typecheck

# Production build of all packages
build: _bootstrapped
    pnpm build

# Full CI suite: lint + format-check + typecheck + coverage-gated test + build + audit (mirrors GitHub Actions)
ci: lint format-check typecheck coverage build audit

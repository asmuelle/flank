# Flank — living competitor radar. Run `just` to list recipes.
# All recipes guard against the not-yet-bootstrapped state (no package.json, see DESIGN.md M0).

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

# Apply Drizzle migrations to DATABASE_URL
migrate: _bootstrapped
    pnpm migrate

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

# Type-check the workspace (tsc --noEmit)
typecheck: _bootstrapped
    pnpm typecheck

# Production build of all packages
build: _bootstrapped
    pnpm build

# Full CI suite: lint + typecheck + coverage-gated test + build (mirrors GitHub Actions)
ci: lint typecheck coverage build

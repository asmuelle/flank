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

# Run dev servers (Next.js web + Inngest dev/workers)
dev: _bootstrapped
    pnpm dev

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

# Full CI suite: lint + typecheck + test + build (mirrors GitHub Actions)
ci: lint typecheck test build

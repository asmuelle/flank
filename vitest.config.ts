import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    // Integration tests own real I/O and run via vitest.integration.config.ts, not this unit suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/web/lib/**/*.ts'],
      // The drizzle-*.ts files (store, alert store, row mappers) are exercised by the DB-backed
      // integration suite, not the unit run, so they would otherwise report 0% and drag the gate
      // down — they are covered, just elsewhere (the shared FlankStore contract runs against Postgres).
      // session.ts / store.ts are thin server-only Next wiring (cookies/redirect/react cache, DB pool)
      // that imports `server-only` (throws under plain Node/vitest); their pure logic lives in the
      // covered resolver.ts / secret.ts / session-crypto.ts seams instead.
      exclude: [
        '**/*.test.ts',
        '**/*.integration.test.ts',
        '**/packages/db/src/drizzle-store.ts',
        '**/packages/db/src/drizzle-alerts.ts',
        '**/packages/db/src/drizzle-mappers.ts',
        '**/apps/web/lib/auth/session.ts',
        '**/apps/web/lib/store.ts',
      ],
      thresholds: {
        // Global floor (aggregate across all included files) — the gate that fails `just ci`.
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // Higher per-file floors for the most invariant-critical pure logic: citation
        // verification (Invariant 1) and diff determinism (Invariant 2) must not silently regress.
        '**/packages/core/src/citation.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 95,
        },
        '**/packages/core/src/diff.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 95,
        },
        // SSRF / legal-source policy — the security boundary for the fetch layer.
        '**/packages/core/src/net-policy.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 95,
        },
        // The money meter — exact COGS math must not silently regress (Invariant 6).
        '**/packages/core/src/cogs.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
});

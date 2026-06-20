import { defineConfig } from 'vitest/config';

// DB-backed integration tests. These own real I/O (Postgres via DATABASE_URL) and are run by a
// dedicated `just test-integration` step, separate from the coverage-gated unit suite. Individual
// specs skip themselves when DATABASE_URL is unset, so this is safe to run anywhere.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.integration.test.ts'],
    environment: 'node',
  },
});

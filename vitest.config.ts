import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/web/lib/**/*.ts'],
      exclude: ['**/*.test.ts'],
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
      },
    },
  },
});

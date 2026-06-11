import { defineConfig } from 'drizzle-kit';

// Validated at startup (AGENTS.md): drizzle-kit commands fail fast without a
// target database. Typecheck and tests never load this file (M1: no Postgres).
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error(
    'DATABASE_URL is not set. Run `just db-up` and export DATABASE_URL (see .env.example / TOOLS.md).',
  );
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
});

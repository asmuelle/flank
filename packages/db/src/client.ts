import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import * as schema from './schema';

/** A postgres connection string, validated at the boundary (AGENTS.md: never trust external config). */
const DatabaseUrlSchema = z
  .string()
  .min(1, 'DATABASE_URL must not be empty')
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  });

export type FlankSchema = typeof schema;
export type FlankDatabase = PostgresJsDatabase<FlankSchema>;

/** A live database handle: the Drizzle query interface, the underlying client, and a graceful close. */
export interface DbHandle {
  readonly db: FlankDatabase;
  readonly client: Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Max pool connections (default 10). */
  readonly max?: number;
}

/**
 * Build a Drizzle database handle bound to the full Flank schema. Validates the connection string
 * (fail fast — never connect to a malformed URL) and constructs the pool lazily: no socket opens
 * until the first query, so this is safe to call at module init and in tests without a live DB.
 *
 * Exported alongside (not merged into) the schema so schema-only importers stay I/O-free.
 */
export const createDb = (databaseUrl: string, options: CreateDbOptions = {}): DbHandle => {
  const url = DatabaseUrlSchema.parse(databaseUrl);
  // Suppress postgres-js's default NOTICE logging (e.g. TRUNCATE ... CASCADE) — these are not
  // actionable in app context and only clutter logs.
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: () => client.end(),
  };
};

/**
 * Resolve {@link createDb} from the environment, validating DATABASE_URL is present at startup
 * (AGENTS.md). Workers and the web app should call this once and share the returned handle.
 */
export const createDbFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: CreateDbOptions = {},
): DbHandle => {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is not set. Run `just db-up` and export DATABASE_URL (see .env.example / TOOLS.md).',
    );
  }
  return createDb(databaseUrl, options);
};

import 'server-only';
import { createDbFromEnv, DrizzleFlankStore } from '@flank/db';

// One DB-backed store per server process, built lazily. Deferred so neither the Postgres pool nor
// DATABASE_URL validation runs at build time — only on the first request/cron that needs it.
let cached: DrizzleFlankStore | undefined;

export const getStore = (): DrizzleFlankStore => {
  if (cached === undefined) {
    cached = new DrizzleFlankStore(createDbFromEnv().db);
  }
  return cached;
};

import 'server-only';

import { createRequire } from 'node:module';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import type { Db } from './types';

let cached: { db: PostgresJsDatabase<typeof schema>; sql: postgres.Sql } | null = null;
let override: Db | null = null;

/** Tests inject a pglite-backed instance; the app never calls this. */
export function setDbForTests(db: Db | null): void {
  override = db;
}

function sandboxDb(url: string): Db {
  // Lazy so Railway never loads @electric-sql/pglite. Local `dev:helper` only.
  const require = createRequire(__filename);
  return (require('./pglite') as typeof import('./pglite')).openPglite(url);
}

export function db(): Db {
  if (override) return override;
  if (cached) return cached.db;
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not configured.');
  if (url.startsWith('pglite:')) return sandboxDb(url);
  // Supabase's pooler (transaction mode) does not support prepared statements.
  const sql = postgres(url, {
    prepare: false,
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    idle_timeout: 30,
    connect_timeout: 15,
  });
  cached = { db: drizzle(sql, { schema }), sql };
  return cached.db;
}

export { schema };

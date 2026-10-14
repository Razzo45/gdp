import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema';
import type { Db } from './types';

const PREFIX = 'pglite:';

/** `pglite:./tmp/gdp-helper` → file-backed Postgres. Same schema as Railway. */
export function pgliteDataDir(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null;
  return url.slice(PREFIX.length).trim() || './tmp/gdp-helper';
}

const boot = globalThis as typeof globalThis & { __gdpPglite?: { dir: string; db: Db } };

export function openPglite(url: string): Db {
  const dir = pgliteDataDir(url);
  if (!dir) throw new Error('DATABASE_URL is not a pglite: path.');
  if (boot.__gdpPglite?.dir === dir) return boot.__gdpPglite.db;
  const db = drizzle(new PGlite(dir), { schema }) as unknown as Db;
  boot.__gdpPglite = { dir, db };
  return db;
}

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows } from '@/db/rows';
import type { Db } from '@/db/types';
import { withSharedAdmission } from '@/lib/ai/sharedAdmission';
import { testDb } from './helpers/db';

let handle: Awaited<ReturnType<typeof testDb>>;
let database: Db;

beforeAll(async () => {
  process.env['AUTH_MODE'] = 'local';
  process.env['DATABASE_URL'] ??= 'postgres://gdp:gdp@127.0.0.1/gdp';
  handle = await testDb();
  database = handle.db;
});
afterAll(async () => handle.close());

async function acquire(token: string, maxActive = 1): Promise<boolean> {
  const [row] = rows<{ ok: unknown }>(
    await database.execute(sql`
      select app.acquire_gemini_admission(
        ${token}::uuid, 'inference', 'background', 90, ${maxActive}, ${maxActive}, 0
      ) as ok
    `),
  );
  return row?.ok === true || row?.ok === 't';
}

describe('shared Gemini admission', () => {
  it('caps active leases across callers, then frees the slot', async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(await acquire(first, 1)).toBe(true);
    expect(await acquire(second, 1)).toBe(false);
    await database.execute(sql`select app.release_gemini_admission(${first}::uuid)`);
    expect(await acquire(second, 1)).toBe(true);
    await database.execute(sql`select app.release_gemini_admission(${second}::uuid)`);
  });

  it('runs the work while holding a shared lease', async () => {
    const seen: string[] = [];
    await withSharedAdmission({ lane: 'inference', requestClass: 'interactive' }, async () => {
      seen.push('ok');
    });
    expect(seen).toEqual(['ok']);
  });
});

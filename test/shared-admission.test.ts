import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows } from '@/db/rows';
import type { Db } from '@/db/types';
import { sharedAdmissionFailure, withSharedAdmission } from '@/lib/ai/sharedAdmission';
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

async function acquire(token: string, maxActive = 1, requestClass: 'interactive' | 'background' | 'idle' = 'background'): Promise<boolean> {
  const [row] = rows<{ ok: unknown }>(
    await database.execute(sql`
      select app.acquire_gemini_admission(
        ${token}::uuid, 'inference', ${requestClass}, 90, ${maxActive}, ${maxActive}, 0
      ) as ok
    `),
  );
  return row?.ok === true || row?.ok === 't';
}

const release = (token: string) => database.execute(sql`select app.release_gemini_admission(${token}::uuid)`);

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

  it('admits idle work when nothing else needs the slots', async () => {
    const idle = crypto.randomUUID();
    expect(await acquire(idle, 4, 'idle')).toBe(true);
    await release(idle);
  });

  it('never lets a waiting idle call hold up background work that arrives after it', async () => {
    const running = crypto.randomUUID();
    const idle = crypto.randomUUID();
    const later = crypto.randomUUID();
    expect(await acquire(running, 2)).toBe(true);
    expect(await acquire(idle, 2, 'idle')).toBe(false);
    expect(await acquire(later, 2)).toBe(true);
    await Promise.all([release(running), release(idle), release(later)]);
  });

  it('refuses idle work while background work is waiting, even with free slots', async () => {
    const holders = [crypto.randomUUID(), crypto.randomUUID()];
    const waiting = crypto.randomUUID();
    const idle = crypto.randomUUID();
    for (const token of holders) expect(await acquire(token, 2)).toBe(true);
    expect(await acquire(waiting, 2)).toBe(false);
    await release(holders[0]!);
    await release(holders[1]!);
    expect(await acquire(idle, 4, 'idle')).toBe(false);
    expect(await acquire(waiting, 2)).toBe(true);
    await Promise.all([release(waiting), release(idle)]);
  });

  it('caps idle work at half the ceiling', async () => {
    const tokens = Array.from({ length: 4 }, () => crypto.randomUUID());
    const admitted = [];
    for (const token of tokens) admitted.push(await acquire(token, 8, 'idle'));
    expect(admitted).toEqual([true, true, true, true]);
    const fifth = crypto.randomUUID();
    expect(await acquire(fifth, 8, 'idle')).toBe(false);
    await Promise.all([...tokens, fifth].map(release));
  });

  it('reads the database error from the cause the query wrapper hides it in', () => {
    const wrapped = (message: string) => new Error('Failed query: select app.acquire_gemini_admission(...)', { cause: new Error(message) });
    expect(sharedAdmissionFailure(wrapped('invalid Gemini request class'))).toBe('idle_unsupported');
    expect(sharedAdmissionFailure(wrapped('function app.acquire_gemini_admission does not exist'))).toBe('missing');
    expect(sharedAdmissionFailure(wrapped('connection reset'))).toBeNull();
  });

  it('runs the work while holding a shared lease', async () => {
    const seen: string[] = [];
    await withSharedAdmission({ lane: 'inference', requestClass: 'interactive' }, async () => {
      seen.push('ok');
    });
    expect(seen).toEqual(['ok']);
  });
});

import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rows } from '@/db/rows';
import { env } from '@/lib/env';
import type { RequestClass } from './admission';

type SharedLane = 'inference' | 'files';

let disabled = false;

function sharedLane(lane: string): SharedLane {
  return lane === 'files' ? 'files' : 'inference';
}

function truthy(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

async function call<T>(statement: ReturnType<typeof sql>): Promise<T | undefined> {
  if (disabled) return undefined;
  try {
    const [row] = rows<T>(await db().execute(statement));
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|undefined function/i.test(message)) {
      disabled = true;
      console.warn('[gemini-admission] shared leases unavailable; staying process-local.');
    }
    return undefined;
  }
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Cross-instance lease on DATABASE_URL. Local AdaptiveAdmission still owns
 * AIMD. This is the ceiling + 429 cooldown other replicas must see.
 */
export async function withSharedAdmission<T>(
  options: { lane: string; requestClass: RequestClass; signal?: AbortSignal },
  operation: () => Promise<T>,
): Promise<T> {
  if (disabled) return operation();
  const lane = sharedLane(options.lane);
  const e = env();
  const maxActive = lane === 'files' ? e.GEMINI_FILES_CONCURRENCY : e.GEMINI_CONCURRENCY;
  const maxBackground = lane === 'files' ? maxActive : Math.max(1, maxActive - 1);
  const leaseSeconds = lane === 'files' ? 180 : 75;
  const token = crypto.randomUUID();
  let held = false;
  try {
    while (!held) {
      options.signal?.throwIfAborted();
      const row = await call<{ ok: unknown }>(sql`
        select app.acquire_gemini_admission(
          ${token}::uuid,
          ${lane},
          ${options.requestClass},
          ${leaseSeconds},
          ${maxActive},
          ${maxBackground},
          0
        ) as ok
      `);
      if (disabled) return operation();
      held = truthy(row?.ok);
      if (!held) await wait(400, options.signal);
    }
    return await operation();
  } finally {
    if (held) {
      await call(sql`select app.release_gemini_admission(${token}::uuid)`);
    }
  }
}

export async function throttleSharedAdmission(lane: string, cooldownMs: number): Promise<void> {
  await call(sql`select app.throttle_gemini_admission(${sharedLane(lane)}, ${Math.max(1_000, Math.floor(cooldownMs))})`);
}

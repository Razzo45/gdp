import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rows } from '@/db/rows';
import { env } from '@/lib/env';
import type { RequestClass } from './admission';

type SharedLane = 'inference' | 'files';

let disabled = false;
/** Set when the database predates 0012 and rejects the idle class. */
let idleUnsupported = false;

function sharedLane(lane: string): SharedLane {
  return lane === 'files' ? 'files' : 'inference';
}

function truthy(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

/** The query wrapper puts the database message in `cause`, not in `message`. */
export function sharedAdmissionFailure(error: unknown): 'missing' | 'idle_unsupported' | null {
  const messages: string[] = [];
  for (let current: unknown = error; current && messages.length < 5; current = current instanceof Error ? current.cause : undefined) {
    messages.push(current instanceof Error ? current.message : String(current));
  }
  const text = messages.join('\n');
  if (/invalid Gemini request class/i.test(text)) return 'idle_unsupported';
  if (/does not exist|undefined function/i.test(text)) return 'missing';
  return null;
}

async function call<T>(statement: ReturnType<typeof sql>): Promise<T | undefined> {
  if (disabled) return undefined;
  try {
    const [row] = rows<T>(await db().execute(statement));
    return row;
  } catch (error) {
    const failure = sharedAdmissionFailure(error);
    if (failure === 'missing') {
      disabled = true;
      console.warn('[gemini-admission] shared leases unavailable; staying process-local.');
    } else if (failure === 'idle_unsupported') {
      idleUnsupported = true;
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
  options: { lane: string; requestClass: RequestClass; signal?: AbortSignal; maxActive?: number; intervalMs?: number },
  operation: () => Promise<T>,
): Promise<T> {
  if (disabled) return operation();
  const lane = sharedLane(options.lane);
  const e = env();
  const ceiling = lane === 'files' ? e.GEMINI_FILES_CONCURRENCY : e.GEMINI_CONCURRENCY;
  const maxActive = Math.max(1, Math.min(ceiling, options.maxActive ?? ceiling));
  const maxBackground = lane === 'files' ? maxActive : Math.max(1, maxActive - 1);
  const intervalMs = Math.max(0, options.intervalMs ?? 0);
  const leaseSeconds = 180;
  const token = crypto.randomUUID();
  let held = false;
  try {
    while (!held) {
      options.signal?.throwIfAborted();
      const requestClass = options.requestClass === 'idle' && idleUnsupported ? 'background' : options.requestClass;
      const row = await call<{ ok: unknown }>(sql`
        select app.acquire_gemini_admission(
          ${token}::uuid,
          ${lane},
          ${requestClass},
          ${leaseSeconds},
          ${maxActive},
          ${maxBackground},
          ${intervalMs}
        ) as ok
      `);
      if (disabled) return operation();
      held = truthy(row?.ok);
      if (!held) await wait(requestClass === 'idle' ? 1_500 : 400, options.signal);
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

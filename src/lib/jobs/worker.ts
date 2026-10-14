import 'server-only';

import { JOB_KINDS, type Job } from '@/db/schema';
import { isStatementLane } from '@/domain/jobs';
import { withModelContext } from '@/lib/ai/context';
import { HANDLERS, isRetryable, LeaseLost, type JobContext } from './handlers';
import { reapGeminiFiles } from '@/lib/ai/reaper';
import { claimNext, complete, expireOverdue, fail, heartbeat, HEARTBEAT_MS } from './queue';

/**
 * In-process worker. Polls for runnable jobs, runs up to `concurrency` at
 * once, heartbeats each lease, and never throws out of the loop. On Replit
 * this runs inside the web process (see `instrumentation.ts`); it can also
 * run standalone via `npm run worker` on a second machine — the SKIP LOCKED
 * claim makes both safe together.
 */

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startWorker(options: WorkerOptions = {}): WorkerHandle {
  const concurrency = options.concurrency ?? 2;
  const pollMs = options.pollMs ?? 2_000;
  const log = options.log ?? ((message, detail) => console.log(`[worker] ${message}`, detail ?? ''));
  let stopping = false;
  const running = new Set<Promise<void>>();
  let wake: (() => void) | null = null;

  const runOne = async (job: Job, leaseToken: string) => {
    let lost = false;
    // Losing the lease (cancelled, or taken by another worker) aborts every
    // in-flight and queued model call for this job immediately.
    const abort = new AbortController();
    const markLost = () => {
      lost = true;
      abort.abort(new LeaseLost());
    };
    const tick: JobContext['tick'] = async (progress, checkpoint) => {
      const ok = await heartbeat(job.id, leaseToken, { progress, checkpoint });
      if (!ok) {
        markLost();
        throw new LeaseLost();
      }
    };
    const pulse = setInterval(() => {
      heartbeat(job.id, leaseToken).then((ok) => {
        if (!ok) markLost();
      }).catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      log('start', { id: job.id, kind: job.kind, attempt: job.attempts });
      const result = await withModelContext(
        {
          ownerId: `task:${job.submissionId}`,
          requestClass:
            job.kind === 'rubric_helper'
              ? 'idle'
              : job.kind === 'golden_autorate' && isStatementLane(job.payload)
                ? 'interactive'
                : 'background',
          signal: abort.signal,
        },
        () => HANDLERS[job.kind]({ job, leaseToken, tick, signal: abort.signal }),
      );
      if (lost) throw new LeaseLost();
      await complete(job.id, leaseToken, result);
      log('done', { id: job.id, kind: job.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LeaseLost || lost) {
        log('lease lost', { id: job.id });
        return;
      }
      log('failed', { id: job.id, kind: job.kind, error: message, retry: isRetryable(error) });
      await fail(job.id, leaseToken, message, isRetryable(error)).catch(() => undefined);
    } finally {
      clearInterval(pulse);
    }
  };

  const loop = (async () => {
    let sweep = 0;
    while (!stopping) {
      try {
        if (sweep++ % 30 === 0) {
          await expireOverdue();
          await reapGeminiFiles().catch((error) => log('reaper', { error: error instanceof Error ? error.message : String(error) }));
        }
        while (running.size < concurrency && !stopping) {
          const claimed = await claimNext(JOB_KINDS);
          if (!claimed) break;
          const promise = runOne(claimed.job, claimed.leaseToken).finally(() => running.delete(promise));
          running.add(promise);
        }
      } catch (error) {
        log('poll error', { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pollMs);
      });
      wake = null;
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await loop;
      await Promise.allSettled([...running]);
    },
  };
}

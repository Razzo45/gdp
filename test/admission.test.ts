import { describe, expect, it } from 'vitest';
import { AdaptiveAdmission, PACE_AFTER_429_MS, sharedAdmissionLimits } from '@/lib/ai/admission';

/** Deterministic clock + timers so cooldowns can be tested without waiting. */
function harness(config: Partial<ConstructorParameters<typeof AdaptiveAdmission>[0]> = {}) {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const admission = new AdaptiveAdmission({
    ...config,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= now) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  return { admission, advance, clock: () => now };
}

/** A controllable in-flight operation. */
function gate() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { done, release: () => release() };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AdaptiveAdmission', () => {
  it('bounds concurrency at the target and admits queued work on release', async () => {
    const { admission } = harness({ initial: 2, floor: 1, ceiling: 4 });
    const g1 = gate();
    const g2 = gate();
    const g3 = gate();
    const order: string[] = [];
    const run = (name: string, g: ReturnType<typeof gate>) =>
      admission.use(async () => {
        order.push(`start ${name}`);
        await g.done;
      }, { lane: 'm', requestClass: 'interactive', ownerId: name });
    const p1 = run('a', g1);
    const p2 = run('b', g2);
    const p3 = run('c', g3);
    await flush();
    expect(order).toEqual(['start a', 'start b']);
    expect(admission.snapshot().queued).toBe(1);
    g1.release();
    await flush();
    expect(order).toEqual(['start a', 'start b', 'start c']);
    g2.release();
    g3.release();
    await Promise.all([p1, p2, p3]);
    expect(admission.snapshot().active).toBe(0);
  });

  it('round-robins across owners so one job cannot starve another', async () => {
    const { admission } = harness({ initial: 1, floor: 1, ceiling: 1, ownerCeiling: 5 });
    const started: string[] = [];
    const gates: ReturnType<typeof gate>[] = [];
    const run = (owner: string) => {
      const g = gate();
      gates.push(g);
      return admission.use(async () => {
        started.push(owner);
        await g.done;
      }, { lane: 'm', requestClass: 'background', ownerId: owner });
    };
    const all = [run('A'), run('A'), run('A'), run('B'), run('C')];
    await flush();
    for (let i = 0; i < 5; i += 1) {
      gates[i]!.release();
      await flush();
    }
    await Promise.all(all);
    expect(started).toEqual(['A', 'B', 'C', 'A', 'A']);
  });

  it('admits ten owners across a tight target without dropping any', async () => {
    const { admission } = harness({ initial: 4, floor: 1, ceiling: 4, ownerCeiling: 4 });
    const started: string[] = [];
    const hold = gate();
    const jobs = Array.from({ length: 10 }, (_, i) =>
      admission.use(async () => {
        started.push(`u${i}`);
        await hold.done;
      }, { lane: 'm', requestClass: 'background', ownerId: `task:u${i}` }),
    );
    await flush();
    expect(started).toHaveLength(4);
    expect(new Set(started).size).toBe(4);
    expect(admission.snapshot().queued).toBe(6);
    hold.release();
    await Promise.all(jobs);
    expect(new Set(started).size).toBe(10);
  });

  it('hands freed slots to the other owner once a second job is waiting', async () => {
    const { admission } = harness({ initial: 8, floor: 1, ceiling: 8, ownerCeiling: 8 });
    const started: string[] = [];
    const gatesA = Array.from({ length: 16 }, () => gate());
    const aJobs = gatesA.map((g) =>
      admission.use(async () => {
        started.push('A');
        await g.done;
      }, { lane: 'm', requestClass: 'background', ownerId: 'task:video' }),
    );
    await flush();
    expect(started).toHaveLength(8);
    const holdB = gate();
    const bJobs = Array.from({ length: 4 }, () =>
      admission.use(async () => {
        started.push('B');
        await holdB.done;
      }, { lane: 'm', requestClass: 'background', ownerId: 'task:cards' }),
    );
    await flush();
    expect(started.filter((owner) => owner === 'B')).toHaveLength(0);
    for (let i = 0; i < 4; i += 1) {
      gatesA[i]!.release();
      await flush();
    }
    expect(started.filter((owner) => owner === 'A')).toHaveLength(8);
    expect(started.filter((owner) => owner === 'B')).toHaveLength(4);
    for (const g of gatesA) g.release();
    holdB.release();
    await Promise.all([...aJobs, ...bJobs]);
  });

  it('lets a single owner fill the whole target when nobody is on the UI', async () => {
    const { admission } = harness({ initial: 8, floor: 2, ceiling: 8, ownerCeiling: 8 });
    const g = gate();
    const started: string[] = [];
    const jobs = Array.from({ length: 8 }, (_, i) =>
      admission.use(async () => {
        started.push(`j${i}`);
        await g.done;
      }, { lane: 'm', requestClass: 'background', ownerId: 'job' }),
    );
    await flush();
    expect(started).toHaveLength(8);
    expect(admission.snapshot().queued).toBe(0);
    g.release();
    await Promise.all(jobs);
  });

  it('reserves a slot only once an interactive waiter is actually queued', async () => {
    const { admission } = harness({ initial: 3, floor: 1, ceiling: 3, ownerCeiling: 10 });
    const started: string[] = [];
    const hold = gate();
    const bg = (n: string) =>
      admission.use(async () => {
        started.push(n);
        await hold.done;
      }, { lane: 'm', requestClass: 'background', ownerId: 'job' });
    const first = [bg('b1'), bg('b2')];
    await flush();
    expect(started).toEqual(['b1', 'b2']);
    const ui = admission.use(async () => {
      started.push('ui');
      await hold.done;
    }, { lane: 'm', requestClass: 'interactive', ownerId: 'person' });
    const extra = bg('b3');
    await flush();
    expect(started).toEqual(['b1', 'b2', 'ui']);
    hold.release();
    await Promise.all([...first, extra, ui]);
  });

  it('halves the target once per 429 wave, opens a cooldown and restores slowly', async () => {
    const { admission, advance } = harness({ initial: 8, floor: 2, ceiling: 8, increaseAfter: 3 });
    const wait = admission.onThrottle('m', 30_000, 2_000);
    expect(wait).toBe(30_000);
    expect(admission.snapshot().target).toBe(4);
    // A second 429 inside the same wave does not halve again.
    admission.onThrottle('m', null, 2_000);
    expect(admission.snapshot().target).toBe(4);
    expect(admission.snapshot().cooldownMsRemaining).toBe(30_000);
    // Nothing is admitted during the cooldown.
    let ran = false;
    const p = admission.use(async () => {
      ran = true;
    }, { lane: 'm', requestClass: 'interactive' });
    await flush();
    expect(ran).toBe(false);
    advance(30_010);
    await p;
    expect(ran).toBe(true);
    // Successes after the cooldown raise the target one step per `increaseAfter`.
    for (let i = 0; i < 3; i += 1) admission.onSuccess('m', 500);
    expect(admission.snapshot().target).toBe(5);
    // Still at 5 after one more success (needs three).
    admission.onSuccess('m', 500);
    expect(admission.snapshot().target).toBe(5);
  });

  it('steps the target down after three consecutive failures, never below the floor', () => {
    const { admission } = harness({ initial: 3, floor: 2, ceiling: 8 });
    admission.onFailure('m', 'server');
    admission.onFailure('m', 'timeout');
    expect(admission.snapshot().target).toBe(3);
    admission.onFailure('m', 'server');
    expect(admission.snapshot().target).toBe(2);
    for (let i = 0; i < 6; i += 1) admission.onFailure('m', 'server');
    expect(admission.snapshot().target).toBe(2);
  });

  it('rejects queued work when its signal aborts and frees the queue', async () => {
    const { admission } = harness({ initial: 1, floor: 1, ceiling: 1 });
    const g = gate();
    const first = admission.use(() => g.done, { lane: 'm', requestClass: 'interactive', ownerId: 'x' });
    const ac = new AbortController();
    const waiting = admission.use(async () => 'never', { lane: 'm', requestClass: 'interactive', ownerId: 'y', signal: ac.signal });
    await flush();
    expect(admission.snapshot().queued).toBe(1);
    ac.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    expect(admission.snapshot().queued).toBe(0);
    g.release();
    await first;
  });

  it('holds idle helper pings behind interactive and background work', async () => {
    const { admission } = harness({ initial: 1, floor: 1, ceiling: 1, agingMs: 20, idleAgingMs: 10_000 });
    const started: string[] = [];
    const bgHold = gate();
    const uiHold = gate();
    const idleHold = gate();
    const run = (name: string, requestClass: 'interactive' | 'background' | 'idle', hold: ReturnType<typeof gate>) =>
      admission.use(async () => {
        started.push(name);
        await hold.done;
      }, { lane: 'm', requestClass, ownerId: name });
    const first = run('bg', 'background', bgHold);
    const idle = run('idle', 'idle', idleHold);
    await flush();
    expect(started).toEqual(['bg']);
    const ui = run('ui', 'interactive', uiHold);
    bgHold.release();
    await first;
    await flush();
    expect(started).toEqual(['bg', 'ui']);
    uiHold.release();
    await ui;
    await flush();
    expect(started).toEqual(['bg', 'ui', 'idle']);
    idleHold.release();
    await idle;
  });

  it('keeps the files lane independent from inference', async () => {
    const { admission } = harness({ initial: 1, floor: 1, ceiling: 1, ownerCeiling: 4, filesCeiling: 2 });
    const g = gate();
    const inf = admission.use(() => g.done, { lane: 'm', requestClass: 'background', ownerId: 'j' });
    let fileRan = false;
    const f = admission.use(async () => {
      fileRan = true;
    }, { lane: 'files', requestClass: 'background', ownerId: 'j' });
    await f;
    expect(fileRan).toBe(true);
    expect(admission.snapshot().filesActive).toBe(0);
    g.release();
    await inf;
  });

  it('hands the shared gate the reduced AIMD target and paces after a 429', () => {
    const { admission } = harness({ initial: 32, floor: 16, ceiling: 96, filesCeiling: 8 });
    expect(admission.limitsFor('gemini-3-flash').maxActive).toBe(32);
    expect(admission.limitsFor('gemini-3-flash').intervalMs).toBe(0);
    expect(admission.limitsFor('files').maxActive).toBe(8);
    admission.onThrottle('gemini-3-flash', 8_000, 2_000);
    const after = admission.limitsFor('gemini-3-flash');
    expect(after.maxActive).toBe(16);
    expect(after.intervalMs).toBe(PACE_AFTER_429_MS);
    expect(sharedAdmissionLimits({
      lane: 'gemini-3-flash',
      target: 16,
      filesTarget: 8,
      recent429s: 2,
      cooldownMsRemaining: 0,
    })).toEqual({ maxActive: 16, intervalMs: PACE_AFTER_429_MS });
  });
});

/**
 * Adaptive admission control for model calls (process-wide).
 *
 * Why this exists: generation fans out dozens of calls. A fixed semaphore
 * either wastes Tier 3 quota or 429s; naive retries make the storm worse.
 * The job queue is FIFO — usually one heavy owner — so that owner may take
 * the full target. AIMD and Retry-After are what protect the key.
 *
 *   target        AIMD concurrency. Halved on a 429 (once per cooldown wave),
 *                 −1 after three consecutive timeouts/5xx, +1 after
 *                 `increaseAfter` healthy successes while latency is flat.
 *                 Bounded by [floor, ceiling].
 *   cooldown      After a 429 no inference call starts until the provider's
 *                 Retry-After (or a capped backoff) has elapsed.
 *   lanes         One target per model; lanes never exceed the shared target.
 *                 Files API traffic is a separate lane with its own budget.
 *   owners        Round-robin across owners; FIFO inside an owner. One
 *                 owner may fill the target. When a second owner is
 *                 waiting, each is capped at ceil(target / owners) so a
 *                 huge-video job cannot keep the lane.
 *   interactive   A slot is reserved for a waiting interactive request so a
 *                 button never sits behind a batch. If nobody is waiting on
 *                 the UI, background fills every slot.
 *
 * Pure in-memory and dependency free so it is unit-testable with fake time.
 */

export type RequestClass = 'interactive' | 'background' | 'idle';

export interface AdmissionOptions {
  /** Model name for inference, or 'files' for the Files API. */
  lane: string;
  requestClass: RequestClass;
  /** Fairness key: job id, submission id or user id. */
  ownerId?: string;
  signal?: AbortSignal;
}

export interface AdmissionConfig {
  floor: number;
  ceiling: number;
  initial: number;
  ownerCeiling: number;
  filesCeiling: number;
  agingMs: number;
  /** How long an idle helper ping waits before it can age past other idle work. */
  idleAgingMs: number;
  /** Successes required for +1. */
  increaseAfter: number;
  maxCooldownMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiter {
  lane: string;
  requestClass: RequestClass;
  owner: string;
  enqueuedAt: number;
  sequence: number;
  signal?: AbortSignal;
  enter: () => void;
}

export interface LaneTelemetry {
  active: number;
  queued: number;
  oldestQueueWaitMs: number;
  success: number;
  throttled: number;
  timeout: number;
  serverError: number;
  increases: number;
  reductions: number;
  cooldowns: number;
  requestLatencyAvgMs: number;
  queueLatencyAvgMs: number;
}

export interface AdmissionSnapshot {
  target: number;
  floor: number;
  ceiling: number;
  active: number;
  activeBackground: number;
  queued: number;
  cooldownMsRemaining: number;
  filesActive: number;
  filesQueued: number;
  owners: { owner: string; active: number; queued: number }[];
  lanes: Record<string, LaneTelemetry>;
  recent429s: number;
}

const FILES = 'files';

/** While a 429 cooldown is live, space new leases. After it lifts, overlap again. */
export const PACE_AFTER_429_MS = 2_000;

export function sharedAdmissionLimits(input: {
  lane: string;
  target: number;
  filesTarget: number;
  recent429s: number;
  cooldownMsRemaining: number;
}): { maxActive: number; intervalMs: number } {
  const files = input.lane === FILES;
  return {
    maxActive: Math.max(1, files ? input.filesTarget : input.target),
    intervalMs: input.cooldownMsRemaining > 0 ? PACE_AFTER_429_MS : 0,
  };
}

export class AdaptiveAdmission {
  private readonly cfg: Required<Omit<AdmissionConfig, 'now' | 'setTimer' | 'clearTimer'>>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private target: number;
  private active = 0;
  private activeBackground = 0;
  private readonly activeByLane = new Map<string, number>();
  private readonly activeByOwner = new Map<string, number>();
  private readonly laneTargets = new Map<string, number>();
  private readonly laneSuccesses = new Map<string, number>();
  private readonly laneFailures = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  private readonly ownerRing: string[] = [];
  private ownerCursor: string | null = null;
  private sequence = 0;
  private healthySuccesses = 0;
  private failureStreak = 0;
  private readonly latency: number[] = [];
  private cooldownUntil = 0;
  private filesCooldownUntil = 0;
  private cooldownTimer: unknown = undefined;
  private readonly telemetry = new Map<string, LaneTelemetry & { requestSamples: number[]; queueSamples: number[] }>();
  private readonly throttleTimes: number[] = [];

  constructor(config: Partial<AdmissionConfig> = {}) {
    const floor = clamp(config.floor ?? 16, 1, 256);
    const ceiling = clamp(config.ceiling ?? 96, floor, 256);
    this.cfg = {
      floor,
      ceiling,
      // Start at the ceiling. Warming from 32 wasted the first enhance wave.
      initial: clamp(config.initial ?? ceiling, floor, ceiling),
      ownerCeiling: clamp(config.ownerCeiling ?? ceiling, 1, 256),
      filesCeiling: clamp(config.filesCeiling ?? 8, 1, 32),
      agingMs: Math.max(0, config.agingMs ?? 5_000),
      idleAgingMs: Math.max(0, config.idleAgingMs ?? 60_000),
      increaseAfter: Math.max(1, config.increaseAfter ?? 4),
      maxCooldownMs: Math.max(1_000, config.maxCooldownMs ?? 90_000),
    };
    this.now = config.now ?? (() => Date.now());
    this.setTimer = config.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = config.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.target = this.cfg.initial;
  }

  /** Runs `operation` once a slot is admitted; the slot is held until it settles. */
  async use<T>(operation: () => Promise<T>, options: AdmissionOptions): Promise<T> {
    await this.acquire(options);
    const started = this.now();
    try {
      return await operation();
    } finally {
      this.release(options, this.now() - started);
    }
  }

  /* ─────────────────────────────────────────── feedback ── */

  onSuccess(lane: string, latencyMs: number): void {
    if (lane === FILES) {
      this.laneFailures.set(lane, 0);
      const n = (this.laneSuccesses.get(lane) ?? 0) + 1;
      if (n >= this.cfg.increaseAfter && this.now() >= this.filesCooldownUntil) {
        this.laneSuccesses.set(lane, 0);
        this.laneTargets.set(lane, Math.min(this.cfg.filesCeiling, this.laneTarget(lane) + 1));
        this.record(lane, 'increase');
        this.drain();
      } else this.laneSuccesses.set(lane, n);
      this.record(lane, 'success');
      return;
    }
    this.latency.push(latencyMs);
    if (this.latency.length > 20) this.latency.shift();
    this.laneFailures.set(lane, 0);
    this.failureStreak = 0;
    this.record(lane, 'success');
    if (this.now() < this.cooldownUntil || this.latencyIsRising()) return;
    const laneHealthy = (this.laneSuccesses.get(lane) ?? 0) + 1;
    this.laneSuccesses.set(lane, laneHealthy);
    this.healthySuccesses += 1;
    if (this.healthySuccesses >= this.cfg.increaseAfter) {
      this.healthySuccesses = 0;
      if (this.target < this.cfg.ceiling) {
        this.target += 1;
        this.record(lane, 'increase');
      }
    }
    if (laneHealthy >= this.cfg.increaseAfter) {
      this.laneSuccesses.set(lane, 0);
      this.laneTargets.set(lane, Math.min(this.target, this.laneTarget(lane) + 1));
    }
    this.drain();
  }

  /** A 429. Returns how long the caller should wait before retrying. */
  onThrottle(lane: string, providerDelayMs: number | null, fallbackDelayMs: number): number {
    const now = this.now();
    this.throttleTimes.push(now);
    while (this.throttleTimes.length && now - this.throttleTimes[0]! > 5 * 60_000) this.throttleTimes.shift();
    this.laneSuccesses.set(lane, 0);
    this.laneFailures.set(lane, 0);
    const isFiles = lane === FILES;
    const current = isFiles ? this.filesCooldownUntil : this.cooldownUntil;
    if (current <= now) {
      // First 429 of a wave: halve. Later 429s inside the same wave only extend it.
      if (isFiles) this.laneTargets.set(lane, Math.max(1, Math.floor(this.laneTarget(lane) / 2)));
      else {
        this.healthySuccesses = 0;
        this.failureStreak = 0;
        this.target = Math.max(this.cfg.floor, Math.floor(this.target / 2));
        for (const [l, t] of this.laneTargets) if (l !== FILES) this.laneTargets.set(l, Math.min(t, this.target));
      }
      this.record(lane, 'reduction');
    }
    const base = providerDelayMs && providerDelayMs > 0 ? providerDelayMs : fallbackDelayMs;
    const delay = Math.min(this.cfg.maxCooldownMs, Math.max(250, base));
    const until = Math.max(current, now + delay);
    if (isFiles) this.filesCooldownUntil = until;
    else this.cooldownUntil = until;
    this.armCooldownTimer(until - now);
    this.record(lane, 'throttle');
    this.record(lane, 'cooldown');
    return Math.max(0, until - now);
  }

  onFailure(lane: string, kind: 'timeout' | 'server'): void {
    this.laneSuccesses.set(lane, 0);
    this.record(lane, kind);
    const failures = (this.laneFailures.get(lane) ?? 0) + 1;
    this.laneFailures.set(lane, failures);
    if (lane !== FILES) {
      this.healthySuccesses = 0;
      this.failureStreak += 1;
    }
    if (failures < 3 && (lane === FILES || this.failureStreak < 3)) return;
    this.laneFailures.set(lane, 0);
    if (lane === FILES) {
      this.laneTargets.set(lane, Math.max(1, this.laneTarget(lane) - 1));
    } else {
      this.failureStreak = 0;
      this.target = Math.max(this.cfg.floor, this.target - 1);
      for (const [l, t] of this.laneTargets) if (l !== FILES) this.laneTargets.set(l, Math.min(t, this.target));
    }
    this.record(lane, 'reduction');
    this.drain();
  }

  snapshot(): AdmissionSnapshot {
    const now = this.now();
    const lanes: Record<string, LaneTelemetry> = {};
    for (const [key, value] of this.telemetry) {
      const queued = this.waiting.filter((w) => w.lane === key);
      const { requestSamples, queueSamples, ...rest } = value;
      lanes[key] = {
        ...rest,
        active: this.activeByLane.get(key) ?? 0,
        queued: queued.length,
        oldestQueueWaitMs: queued.length ? Math.max(...queued.map((w) => now - w.enqueuedAt)) : 0,
        requestLatencyAvgMs: avg(requestSamples),
        queueLatencyAvgMs: avg(queueSamples),
      };
    }
    const owners = new Map<string, { active: number; queued: number }>();
    for (const [owner, active] of this.activeByOwner) if (active > 0) owners.set(owner, { active, queued: 0 });
    for (const w of this.waiting) {
      const o = owners.get(w.owner) ?? { active: 0, queued: 0 };
      o.queued += 1;
      owners.set(w.owner, o);
    }
    return {
      target: this.target,
      floor: this.cfg.floor,
      ceiling: this.cfg.ceiling,
      active: this.active,
      activeBackground: this.activeBackground,
      queued: this.waiting.filter((w) => w.lane !== FILES).length,
      cooldownMsRemaining: Math.max(0, this.cooldownUntil - now),
      filesActive: this.activeByLane.get(FILES) ?? 0,
      filesQueued: this.waiting.filter((w) => w.lane === FILES).length,
      owners: [...owners.entries()].map(([owner, v]) => ({ owner, ...v })),
      lanes,
      recent429s: this.throttleTimes.filter((t) => now - t <= 5 * 60_000).length,
    };
  }

  /** Cap and spacing the shared Postgres gate should use for this process. */
  limitsFor(lane: string): { maxActive: number; intervalMs: number } {
    const snap = this.snapshot();
    return sharedAdmissionLimits({
      lane,
      target: snap.target,
      filesTarget: this.laneTarget(FILES),
      recent429s: snap.recent429s,
      cooldownMsRemaining: lane === FILES ? Math.max(0, this.filesCooldownUntil - this.now()) : snap.cooldownMsRemaining,
    });
  }

  /* ─────────────────────────────────────────── internals ── */

  private laneTarget(lane: string): number {
    const existing = this.laneTargets.get(lane);
    if (existing !== undefined) return existing;
    const value = lane === FILES ? this.cfg.filesCeiling : this.target;
    this.laneTargets.set(lane, value);
    return value;
  }

  private ownerLimit(): number {
    const owners = new Set<string>([...this.activeByOwner.keys(), ...this.waiting.map((w) => w.owner)]);
    if (owners.size <= 1) return this.cfg.ownerCeiling;
    return Math.max(1, Math.min(this.cfg.ownerCeiling, Math.ceil(this.target / owners.size)));
  }

  private canEnter(lane: string, requestClass: RequestClass, owner: string): boolean {
    const now = this.now();
    if (lane !== FILES && (this.activeByOwner.get(owner) ?? 0) >= this.ownerLimit()) return false;
    const laneActive = this.activeByLane.get(lane) ?? 0;
    if (lane === FILES) return laneActive < this.laneTarget(lane) && now >= this.filesCooldownUntil;
    if (now < this.cooldownUntil) return false;
    if (this.active >= this.target || laneActive >= this.laneTarget(lane)) return false;
    const higherWaiting = this.waiting.some((w) => w.requestClass !== 'idle' && w.lane !== FILES);
    if (requestClass === 'idle') {
      if (higherWaiting) return false;
      // Idle never takes the reserved interactive slot.
      if (this.target > 1 && this.active >= this.target - 1) return false;
    }
    // Reserve a slot only when a creator is actually waiting on a button.
    if (requestClass === 'background' && this.target > 1 && this.activeBackground >= this.target - 1) {
      const interactiveWaiting = this.waiting.some((w) => w.requestClass === 'interactive' && w.lane !== FILES);
      if (interactiveWaiting) return false;
    }
    return true;
  }

  private acquire(options: AdmissionOptions): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const owner = options.ownerId ?? 'anonymous';
    if (this.waiting.length === 0 && this.canEnter(options.lane, options.requestClass, owner)) {
      this.enter(options.lane, options.requestClass, owner);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        lane: options.lane,
        requestClass: options.requestClass,
        owner,
        enqueuedAt: this.now(),
        sequence: this.sequence++,
        signal: options.signal,
        enter: () => {
          options.signal?.removeEventListener('abort', cancel);
          this.enter(options.lane, options.requestClass, owner);
          resolve();
        },
      };
      const cancel = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(options.signal?.reason ?? new Error('Cancelled while waiting for a model slot.'));
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      this.waiting.push(waiter);
      if (!this.ownerRing.includes(owner)) this.ownerRing.push(owner);
      this.record(options.lane, 'queued');
      this.drain();
    });
  }

  private enter(lane: string, requestClass: RequestClass, owner: string): void {
    this.ownerCursor = owner;
    if (!this.ownerRing.includes(owner)) this.ownerRing.push(owner);
    this.activeByLane.set(lane, (this.activeByLane.get(lane) ?? 0) + 1);
    this.activeByOwner.set(owner, (this.activeByOwner.get(owner) ?? 0) + 1);
    if (lane !== FILES) {
      this.active += 1;
      if (requestClass === 'background') this.activeBackground += 1;
    }
  }

  private release(options: AdmissionOptions, latencyMs: number): void {
    const owner = options.ownerId ?? 'anonymous';
    this.activeByLane.set(options.lane, Math.max(0, (this.activeByLane.get(options.lane) ?? 1) - 1));
    const ownerActive = Math.max(0, (this.activeByOwner.get(owner) ?? 1) - 1);
    if (ownerActive === 0) this.activeByOwner.delete(owner);
    else this.activeByOwner.set(owner, ownerActive);
    if (options.lane !== FILES) {
      this.active = Math.max(0, this.active - 1);
      if (options.requestClass === 'background') this.activeBackground = Math.max(0, this.activeBackground - 1);
    }
    this.record(options.lane, 'latency', latencyMs);
    this.drain();
  }

  private drain(): void {
    const now = this.now();
    while (this.waiting.length > 0) {
      const eligible = this.waiting.filter((w) => !w.signal?.aborted && this.canEnter(w.lane, w.requestClass, w.owner));
      if (eligible.length === 0) return;
      const interactive = eligible.filter((w) => w.requestClass === 'interactive');
      const aged = eligible.filter((w) => w.requestClass === 'background' && now - w.enqueuedAt >= this.cfg.agingMs);
      const higher = eligible.filter((w) => w.requestClass !== 'idle');
      const agedIdle = eligible.filter((w) => w.requestClass === 'idle' && now - w.enqueuedAt >= this.cfg.idleAgingMs);
      // Interactive first; then aged background; then any non-idle; idle last.
      const pool = interactive.length ? interactive : aged.length ? aged : higher.length ? higher : agedIdle.length ? agedIdle : eligible;
      const owners = new Set(pool.map((w) => w.owner));
      for (const o of owners) if (!this.ownerRing.includes(o)) this.ownerRing.push(o);
      const start = this.ownerCursor === null ? 0 : (this.ownerRing.indexOf(this.ownerCursor) + 1) % this.ownerRing.length;
      let chosenOwner: string | undefined;
      for (let offset = 0; offset < this.ownerRing.length; offset += 1) {
        const candidate = this.ownerRing[(start + offset) % this.ownerRing.length]!;
        if (owners.has(candidate)) {
          chosenOwner = candidate;
          break;
        }
      }
      const selected = pool.filter((w) => w.owner === chosenOwner).sort((a, b) => a.sequence - b.sequence)[0];
      if (!selected) return;
      this.waiting.splice(this.waiting.indexOf(selected), 1);
      this.record(selected.lane, 'admitted', now - selected.enqueuedAt);
      selected.enter();
    }
    // Forget owners with nothing active or queued so the ring stays small.
    for (let i = this.ownerRing.length - 1; i >= 0; i -= 1) {
      const o = this.ownerRing[i]!;
      if (!this.activeByOwner.has(o) && !this.waiting.some((w) => w.owner === o)) this.ownerRing.splice(i, 1);
    }
  }

  private armCooldownTimer(ms: number): void {
    if (this.cooldownTimer !== undefined) this.clearTimer(this.cooldownTimer);
    this.cooldownTimer = this.setTimer(() => {
      this.cooldownTimer = undefined;
      this.drain();
    }, Math.max(1, ms) + 5);
  }

  private latencyIsRising(): boolean {
    if (this.latency.length < 6) return false;
    const recent = avg(this.latency.slice(-3));
    const baseline = avg(this.latency.slice(0, -3));
    return recent > baseline * 1.5 && recent - baseline >= 250;
  }

  private record(lane: string, event: string, value = 0): void {
    const item = this.telemetry.get(lane) ?? {
      active: 0, queued: 0, oldestQueueWaitMs: 0, success: 0, throttled: 0, timeout: 0, serverError: 0,
      increases: 0, reductions: 0, cooldowns: 0, requestLatencyAvgMs: 0, queueLatencyAvgMs: 0,
      requestSamples: [], queueSamples: [],
    };
    if (event === 'success') item.success += 1;
    if (event === 'throttle') item.throttled += 1;
    if (event === 'timeout') item.timeout += 1;
    if (event === 'server') item.serverError += 1;
    if (event === 'increase') item.increases += 1;
    if (event === 'reduction') item.reductions += 1;
    if (event === 'cooldown') item.cooldowns += 1;
    if (event === 'latency') push(item.requestSamples, value);
    if (event === 'admitted') push(item.queueSamples, value);
    this.telemetry.set(lane, item);
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo);
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const push = (xs: number[], v: number) => {
  xs.push(v);
  if (xs.length > 20) xs.shift();
};

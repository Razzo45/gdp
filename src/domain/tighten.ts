import { isSoftSeat } from './discrimination';
import { looksCheated } from './helper';
import { lintStatement, nearDuplicate } from './lint';
import { countFamilies, familyOfTag, familyQuotas, quotaSpread, tagsForStyle, type Family, type TagStyle } from './rubric';

/**
 * "Get under 50%": swap seats the AI output passes for grounded locks it fails.
 * Every lock cites a line that exists in the brief, acceptance criteria or an
 * input, and is kept only when the grader says golden Yes and AI No on every pass.
 */

/** Below the 50% gate so a single flip between passes does not break it. */
export const TIGHTEN_TARGET_PERCENT = 46;
export const TIGHTEN_ROUNDS = 3;

export interface TightenSeat {
  id: string;
  statement: string;
  tag: string;
  family: Family;
  golden: boolean | null;
  /** One verdict per Stability pass. */
  ai: (boolean | null)[];
  /** Checks something the brief explicitly asks for; only retired when the golden fails it. */
  core?: boolean;
}

export type RetireReason = 'false_on_golden' | 'duplicate' | 'flips' | 'passes_both';

export interface RetireSlot {
  seat: TightenSeat;
  reason: RetireReason;
}

export interface LockDraft {
  statement: string;
  tag: string;
  /** Where the cited line lives: "Brief", "Acceptance criteria", or an input's name or role. */
  sourceLabel: string;
  /** A line from that source. Must exist in the task text. */
  quote: string;
  /** Verbatim restates the line; interpretation reads what the line requires. */
  basis: 'verbatim' | 'interpretation';
  rationale: string;
}

export interface VerifiedLock extends LockDraft {
  id: string;
  golden: boolean | null;
  ai: (boolean | null)[];
  goldenEvidence: string;
  aiEvidence: string[];
}

export interface TightenSwap {
  seatId: string;
  seatStatement: string;
  seatTag: string;
  seatFamily: Family;
  reason: RetireReason;
  /** AI Yes verdicts removed per pass when this swap is applied. */
  delta: number[];
  lock: VerifiedLock;
}

export interface TightenResult {
  target: number;
  total: number;
  /** AI Yes count per pass before any swap. */
  beforeYes: number[];
  before: number[];
  projected: number[];
  reached: boolean;
  /** Seats still to flip on the worst pass after every swap. */
  shortBy: number;
  quotaReady: boolean;
  swaps: TightenSwap[];
  rejected: { id: string; statement: string; why: string }[];
}

/** What the job stores. Swaps are only offered against the rubric revision they were verified on. */
export interface TightenReport extends TightenResult {
  rubricRevision: number;
  rounds: number;
  /** Drafts stopped before grading, with the reasons a reviewer would give. */
  guarded: { statement: string; reasons: string[] }[];
  /** A later round failed; the swaps are what earlier rounds verified. */
  stoppedEarly?: string | null;
  /** Seats kept because they check what the brief explicitly asks for. */
  core?: string[];
}

export function tightenReportOf(raw: unknown): TightenReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.swaps) || !Array.isArray(value.before) || !Array.isArray(value.projected) || typeof value.rubricRevision !== 'number') return null;
  return value as unknown as TightenReport;
}

/** Note stored on an applied seat so a reviewer can check where the wording came from. */
export function lockNote(lock: Pick<LockDraft, 'sourceLabel' | 'quote' | 'basis' | 'rationale'>): string {
  const note = `${lock.basis === 'verbatim' ? 'Source' : 'Interprets'} (${lock.sourceLabel}): "${lock.quote}". ${lock.rationale}`;
  return note.length > 600 ? `${note.slice(0, 597)}...` : note;
}

function passCount(seats: readonly TightenSeat[]): number {
  return Math.max(0, ...seats.map((seat) => seat.ai.length));
}

function yesOf(seat: TightenSeat, pass: number): number {
  return seat.ai[pass] === true ? 1 : 0;
}

function percents(yes: number[], total: number): number[] {
  return yes.map((count) => (total === 0 ? 0 : Math.round((count / total) * 100)));
}

function maxYes(total: number, target: number): number {
  return Math.floor((total * target) / 100);
}

export function tightenNeed(seats: readonly TightenSeat[], target = TIGHTEN_TARGET_PERCENT): { scores: number[]; flips: number } {
  const passes = passCount(seats);
  const yes = Array.from({ length: passes }, (_, pass) => seats.reduce((sum, seat) => sum + yesOf(seat, pass), 0));
  const ceiling = maxYes(seats.length, target);
  return { scores: percents(yes, seats.length), flips: Math.max(0, ...yes.map((count) => count - ceiling)) };
}

function aiYesSomewhere(seat: TightenSeat): boolean {
  return seat.ai.some((value) => value === true);
}

function flips(seat: TightenSeat): boolean {
  const graded = seat.ai.filter((value) => value !== null);
  return new Set(graded).size > 1;
}

/** Retire order. Seats the AI already fails are discriminators and are never offered. */
export function retireSlots(seats: readonly TightenSeat[]): RetireSlot[] {
  const slots: RetireSlot[] = [];
  const taken = new Set<string>();
  const push = (seat: TightenSeat, reason: RetireReason) => {
    if (taken.has(seat.id)) return;
    taken.add(seat.id);
    slots.push({ seat, reason });
  };
  for (const seat of seats) if (seat.golden === false) push(seat, 'false_on_golden');
  for (const [index, seat] of seats.entries()) {
    for (const other of seats.slice(index + 1)) {
      if (taken.has(seat.id) || taken.has(other.id) || !nearDuplicate(seat.statement, other.statement)) continue;
      const retiree = [other, seat].find((row) => !row.core && aiYesSomewhere(row));
      if (retiree) push(retiree, 'duplicate');
    }
  }
  const rest = seats.filter((seat) => !taken.has(seat.id) && !seat.core && aiYesSomewhere(seat));
  const rank = (seat: TightenSeat) => (seat.family === 'format' ? 4 : 0) + (flips(seat) ? 0 : 2) + (isSoftSeat({ statement: seat.statement }) ? 0 : 1);
  for (const seat of rest.toSorted((a, b) => rank(a) - rank(b))) push(seat, flips(seat) ? 'flips' : 'passes_both');
  return slots;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, '')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

const PAGE_REF = /\b(pages?|slides?|spreads?|frames?|screens?)\s+\d+/i;
const QUOTED = /"([^"]{2,})"|\u201c([^\u201d]{2,})\u201d/g;
const NUMBERS = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|\d+(?:[.:]\d+)?/gi;

export function guardLock(draft: LockDraft, ctx: { sources: string; kept: readonly string[]; style: TagStyle }): string[] {
  const reasons: string[] = [];
  const source = normalise(ctx.sources);
  const raw = ctx.sources.toLowerCase();
  if (!tagsForStyle(ctx.style).includes(draft.tag as never)) reasons.push(`The tag "${draft.tag}" is not one of this rubric's tags.`);
  const segments = draft.quote.split(/\.{3}|\u2026/).map(normalise).filter((segment) => segment.split(' ').length >= 3);
  if (segments.length === 0 || segments.some((segment) => !source.includes(segment))) {
    reasons.push('The cited source line is not in the brief, acceptance criteria or inputs.');
  }
  for (const match of draft.statement.matchAll(QUOTED)) {
    const quoted = normalise(match[1] ?? match[2] ?? '');
    if (quoted && !source.includes(quoted)) reasons.push(`The quoted wording "${match[1] ?? match[2]}" is not in the task.`);
  }
  for (const match of draft.statement.matchAll(NUMBERS)) {
    if (!raw.includes(match[0].toLowerCase())) reasons.push(`${match[0]} does not appear in the task.`);
  }
  if (PAGE_REF.test(draft.statement)) reasons.push('Names a page or slide number; a correct file could put it elsewhere.');
  if (looksCheated(draft.statement, { prompt: ctx.sources, inputRoles: [] })) reasons.push('Names the golden or AI file, or a file name.');
  const lint = lintStatement({ statement: draft.statement, tag: draft.tag });
  if (lint.overall === 'fail') reasons.push(...lint.reasons);
  if (ctx.kept.some((statement) => nearDuplicate(statement, draft.statement))) reasons.push('Near duplicate of a seat already in the rubric.');
  return reasons;
}

function locksVerified(lock: VerifiedLock): string | null {
  if (lock.golden !== true) return 'The golden file does not pass it.';
  if (lock.ai.length === 0 || lock.ai.some((value) => value !== false)) return 'The AI output passes it on at least one pass.';
  return null;
}

export function packTighten(input: { seats: readonly TightenSeat[]; locks: readonly VerifiedLock[]; style: TagStyle; target?: number }): TightenResult {
  const target = input.target ?? TIGHTEN_TARGET_PERCENT;
  const total = input.seats.length;
  const passes = passCount(input.seats);
  const yes = Array.from({ length: passes }, (_, pass) => input.seats.reduce((sum, seat) => sum + yesOf(seat, pass), 0));
  const beforeYes = [...yes];
  const before = percents(yes, total);
  const ceiling = maxYes(total, target);
  const rejected: TightenResult['rejected'] = [];
  const keepers: VerifiedLock[] = [];
  for (const lock of input.locks) {
    const why = locksVerified(lock);
    if (why) rejected.push({ id: lock.id, statement: lock.statement, why });
    else keepers.push(lock);
  }

  const open = retireSlots(input.seats);
  const families = new Map(input.seats.map((seat) => [seat.id, seat.family]));
  const swaps: TightenSwap[] = [];
  const reached = () => yes.every((count) => count <= ceiling);
  const quotas = familyQuotas(total);
  const quotaOkWith = (seatId: string, family: Family) => {
    const next = new Map(families);
    next.set(seatId, family);
    return quotaSpread(countFamilies([...next.values()].map((value) => ({ family: value }))), quotas).ready;
  };

  for (const lock of keepers) {
    const usable = reached() ? open.filter((slot) => slot.reason === 'false_on_golden') : open;
    if (usable.length === 0) break;
    const family = familyOfTag(lock.tag);
    const pick = usable.find((slot) => slot.seat.family === family) ?? usable.find((slot) => quotaOkWith(slot.seat.id, family));
    const index = pick ? open.indexOf(pick) : -1;
    if (index < 0) continue;
    const [slot] = open.splice(index, 1);
    const seat = slot!.seat;
    families.set(seat.id, family);
    const delta = Array.from({ length: passes }, (_, pass) => yesOf(seat, pass) - (lock.ai[pass] === true ? 1 : 0));
    delta.forEach((value, pass) => {
      yes[pass]! -= value;
    });
    swaps.push({ seatId: seat.id, seatStatement: seat.statement, seatTag: seat.tag, seatFamily: seat.family, reason: slot!.reason, delta, lock });
  }

  return {
    target,
    total,
    beforeYes,
    before,
    projected: percents(yes, total),
    reached: reached(),
    shortBy: Math.max(0, ...yes.map((count) => count - ceiling)),
    quotaReady: quotaSpread(countFamilies([...families.values()].map((value) => ({ family: value }))), quotas).ready,
    swaps,
    rejected,
  };
}

/** AI score per pass if only the ticked swaps are applied. */
export function projectPicked(report: Pick<TightenResult, 'total' | 'beforeYes' | 'swaps'>, picked: ReadonlySet<string>): number[] {
  const yes = [...report.beforeYes];
  for (const swap of report.swaps) {
    if (!picked.has(swap.seatId)) continue;
    swap.delta.forEach((value, pass) => {
      yes[pass]! -= value;
    });
  }
  return percents(yes, report.total);
}

/** Save payload for the ticked swaps. A seat edited since the helper looked is skipped, not overwritten. */
export function swapUpserts(
  swaps: readonly TightenSwap[],
  picked: ReadonlySet<string>,
  current: readonly { id: string; statement: string }[],
): { upserts: { id: string; tag: string; statement: string; notes: string; scope: 'output'; inputFileIds: string[]; outputFile: null }[]; stale: string[] } {
  const byId = new Map(current.map((row) => [row.id, row.statement]));
  const upserts: ReturnType<typeof swapUpserts>['upserts'] = [];
  const stale: string[] = [];
  for (const swap of swaps) {
    if (!picked.has(swap.seatId)) continue;
    if (byId.get(swap.seatId) !== swap.seatStatement) {
      stale.push(swap.seatId);
      continue;
    }
    upserts.push({ id: swap.seatId, tag: swap.lock.tag, statement: swap.lock.statement, notes: lockNote(swap.lock), scope: 'output', inputFileIds: [], outputFile: null });
  }
  return { upserts, stale };
}

const COMPOUND_REASON = 'Checks two separate things; one could pass while the other fails.';
const FITTED_REASON = 'Describes a flaw in this AI output, not a requirement the task states.';

/**
 * Applies the pre-grading review. Drafts linked by "same" form one group; a group that touches an existing seat
 * is dropped, otherwise its first draft is kept. Ids the review invented are ignored.
 */
export function screenDrafts<T extends LockDraft & { id: string }>(
  drafts: readonly T[],
  review: { compound: readonly string[]; same: readonly { id: string; as: string }[]; fitted?: readonly string[] },
  existing: ReadonlySet<string>,
): { keep: T[]; dropped: { statement: string; reasons: string[] }[] } {
  const early = new Map<string, string>([
    ...(review.fitted ?? []).map((id) => [id, FITTED_REASON] as const),
    ...review.compound.map((id) => [id, COMPOUND_REASON] as const),
  ]);
  const live = drafts.filter((row) => !early.has(row.id));
  const known = new Set([...live.map((row) => row.id), ...existing]);
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const top = root(up);
    parent.set(id, top);
    return top;
  };
  for (const pair of review.same) {
    if (!known.has(pair.id) || !known.has(pair.as) || pair.id === pair.as) continue;
    parent.set(root(pair.id), root(pair.as));
  }
  const seatGroups = new Set([...existing].map(root));
  const claimed = new Set<string>();
  const keep: T[] = [];
  const reasons = new Map<string, string>();
  for (const row of drafts) {
    if (early.has(row.id)) {
      reasons.set(row.id, early.get(row.id)!);
      continue;
    }
    const group = root(row.id);
    if (seatGroups.has(group)) reasons.set(row.id, 'Checks the same requirement as a seat already in the rubric.');
    else if (claimed.has(group)) reasons.set(row.id, 'Checks the same requirement as another lock.');
    else {
      claimed.add(group);
      keep.push(row);
    }
  }
  return { keep, dropped: drafts.filter((row) => reasons.has(row.id)).map((row) => ({ statement: row.statement, reasons: [reasons.get(row.id)!] })) };
}

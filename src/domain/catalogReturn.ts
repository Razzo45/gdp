import { catalogLaneReopensSubmitted } from './catalogInbound';
import { classifyCatalogListState, type CatalogListState } from './catalogListState';

/**
 * Catalog sent a submitted task back. Sync applies that onto Platform
 * returned; Accept/dismiss remain for leftover pending queue rows.
 */

export type CatalogReturnOutcome = 'pending' | 'dismissed' | 'applied';

export interface CatalogReturnDetail {
  statusId: string;
  statusName: string | null;
  trigger: string | null;
  note: string | null;
  [key: string]: unknown;
}

export interface CatalogReturnRecord extends CatalogReturnDetail {
  outcome: CatalogReturnOutcome;
}

export interface PendingCatalogReturn {
  id: string;
  catalogSubmissionId: string;
  title: string;
  heroDeliverable: string;
  stage: string;
  statusId: string | null;
  catalogReturn: CatalogReturnRecord;
}

export function localIsSubmitted(input: { stage: string; handoffStatus: string | null }): boolean {
  return input.stage === 'done' || input.handoffStatus === 'client_visible';
}

/** Last person on the rubric seat. Team-pool assigns are skipped so a return can restore them. */
export function lastRubricHolder(input: {
  currentId: string | null;
  events: readonly { action: string; actorId: string | null; detail: unknown; createdAt?: string }[];
}): string | null {
  if (input.currentId?.trim()) return input.currentId;
  const events = input.events.toSorted((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  for (const event of events) {
    if (event.action === 'rubric_assigned') {
      const userId = asText(object(event.detail)['userId']);
      if (userId) return userId;
      continue;
    }
    if (event.action === 'rubric_claimed' && event.actorId) return event.actorId;
    if (event.action === 'rubric_released') {
      const previous = asText(object(event.detail)['previousHolder']);
      if (previous) return previous;
    }
  }
  return null;
}

/** Catalog why-text on Platform returned — shown on the task, not only the board list. */
export function platformReturnNote(input: { handoffStatus: string | null; note: string | null | undefined }): { message: string } | null {
  if (input.handoffStatus !== 'bounced') return null;
  const message = input.note?.trim() ?? '';
  return message ? { message } : null;
}

/** True when this sync should write (or replace) a pending PM queue item. */
export function shouldEnqueueCatalogReturn(input: {
  stage: string;
  handoffStatus: string | null;
  catalogLane: CatalogListState;
  catalogStatusId: string | null;
  existing: CatalogReturnRecord | null;
  /** Catalog status we last stored. Required when the lane is only inbound pickup. */
  previousStatusId?: string | null;
}): boolean {
  if (!catalogLaneReopensSubmitted(input.catalogLane)) return false;
  const statusId = input.catalogStatusId?.trim() ?? '';
  if (!statusId) return false;
  if (input.existing?.statusId === statusId && (input.existing.outcome === 'pending' || input.existing.outcome === 'dismissed' || input.existing.outcome === 'applied')) {
    return false;
  }
  if (input.catalogLane === 'platform_return') return true;
  const previous = input.previousStatusId?.trim() ?? '';
  return Boolean(previous && previous !== statusId);
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const NOTE_KEYS = ['note', 'comment', 'message', 'revisionNote', 'lastNote'] as const;

function noteOf(entry: Record<string, unknown>): string | null {
  for (const key of NOTE_KEYS) {
    const direct = asText(entry[key]);
    if (direct) return direct;
    const nested = object(entry[key]);
    const text = asText(nested['text']) ?? asText(nested['value']) ?? asText(nested['comment']) ?? asText(nested['note']);
    if (text) return text;
  }
  const notes = entry['notes'];
  if (Array.isArray(notes)) {
    for (const item of notes) {
      const text = asText(item) ?? asText(object(item)['text']) ?? asText(object(item)['value']);
      if (text) return text;
    }
  }
  return null;
}

/** Why-text from a Catalog GET or webhook body. Ignores `{ isRequired }` schema objects. */
export function catalogNoteFromPayload(value: unknown): string | null {
  const raw = object(value);
  return noteOf(raw) ?? noteOf(object(raw['workflowState'])) ?? noteOf(object(raw['payload'])) ?? noteOf(object(raw['submission']));
}

function triggerOf(entry: Record<string, unknown>): string | null {
  return asText(entry['trigger']) ?? asText(entry['action']) ?? asText(entry['displayName']);
}

export function parseCatalogReturn(value: unknown): CatalogReturnRecord | null {
  const row = object(value);
  const statusId = asText(row['statusId']);
  const outcome = row['outcome'] === 'pending' || row['outcome'] === 'dismissed' || row['outcome'] === 'applied' ? row['outcome'] : null;
  if (!statusId || !outcome) return null;
  return {
    statusId,
    statusName: asText(row['statusName']),
    trigger: asText(row['trigger']),
    note: asText(row['note']),
    outcome,
  };
}

/** Classify the synced Catalog payload and describe the latest return move. */
export function catalogReturnFromSync(input: {
  statusId: string | null;
  source: { submission?: unknown; project?: unknown };
  watched: { workStatusId: string; handoffStatusId: string; project?: unknown } | null;
}): { lane: CatalogListState; detail: CatalogReturnDetail } {
  const raw = object(input.source.submission);
  const project = object(input.watched?.project ?? input.source.project);
  const workflow = object(project['workflow']);
  const statuses = workflow['statuses'] ?? [];
  const transitions = workflow['transitions'] ?? [];
  const transitionLog = raw['transitionLog'] ?? raw['transitions'];
  const lane = classifyCatalogListState({
    statusId: input.statusId,
    workStatusId: input.watched?.workStatusId,
    handoffStatusId: input.watched?.handoffStatusId,
    statuses,
    transitions,
    transitionLog,
  });
  const statusName =
    (Array.isArray(statuses) ? statuses : [])
      .map(object)
      .find((row) => asText(row['statusId']) === input.statusId?.trim())?.['name'] ?? null;
  const latest = (Array.isArray(transitionLog) ? transitionLog : [])
    .map(object)
    .filter((entry) => asText(entry['toStatus']) === input.statusId?.trim() || asText(entry['to']) === input.statusId?.trim())
    .at(-1);
  return {
    lane,
    detail: {
      statusId: input.statusId?.trim() ?? '',
      statusName: asText(statusName),
      trigger: latest ? triggerOf(latest) : null,
      note: (latest ? noteOf(latest) : null) ?? catalogNoteFromPayload(raw),
    },
  };
}

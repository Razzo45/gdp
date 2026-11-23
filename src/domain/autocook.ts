import type { ModelTag } from '@/domain/modelTag';

/** Only this operator sees Cook and may call Autocook from GDP. */
export const AUTOCOOK_OPERATOR_EMAIL = 'george@wirestock.io';

export function canAutocookEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === AUTOCOOK_OPERATOR_EMAIL;
}

/** Autocook brain for the task model tag. Gemini 3.8 cooks on Argon. */
export function brainFromModelTag(tag: ModelTag | string | null | undefined): 'argon' | 'carbon' {
  return tag === 'carbon' ? 'carbon' : 'argon';
}

/** Operator paste shape: labeled Catalog fields joined with blank lines. */
export function cookPromptFromFields(fields: readonly { label: string; text: string }[]): string {
  return fields
    .map((field) => {
      const label = field.label.trim();
      const text = field.text.trim();
      if (!text) return '';
      return label ? `${label}:\n${text}` : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

const FINISHED_COOK = new Set(['exported', 'failed', 'rejected']);

export interface OperatorCookRow {
  id: string;
  sessionId: string;
  status: string;
  line: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  /** Start, land, or fail — not Autocook's open/heartbeat `updated_at`. */
  activityAt: string;
  prompt: string;
  brain: 'Argon' | 'Carbon';
  active: boolean;
}

/** GDP events that mean the cook actually moved, not that someone opened the task. */
export const COOK_ACTIVITY_ACTIONS = ['autocook_ingested', 'autocook_closed'] as const;

export interface CookActivityEvent {
  runId: string;
  action: string;
  createdAt: string;
}

const COOK_ACTIVITY_ACTION_SET = new Set<string>(COOK_ACTIVITY_ACTIONS);

/** Finished cooks stamp land/fail. Live cooks keep created time so opening a task cannot reshuffle them. */
export function applyCookActivity(cooks: OperatorCookRow[], events: readonly CookActivityEvent[]): OperatorCookRow[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (!COOK_ACTIVITY_ACTION_SET.has(event.action)) continue;
    const runId = event.runId.trim();
    const at = event.createdAt.trim();
    if (!runId || !at) continue;
    const have = latest.get(runId);
    if (!have || at > have) latest.set(runId, at);
  }
  return cooks.map((cook) => ({
    ...cook,
    activityAt: cook.active ? cook.createdAt : (latest.get(cook.id) ?? cook.createdAt),
  }));
}

function cookBrainLabel(model: string | null | undefined): 'Argon' | 'Carbon' {
  const value = (model ?? '').trim().toLowerCase();
  return value === 'carbon' || value === 'gemini-4-carbon' ? 'Carbon' : 'Argon';
}

/** Short label for the panel. The live line stays under it. */
export function cookPhase(status: string, line: string): string {
  const live = line.trim();
  const lower = live.toLowerCase();
  if (status === 'exported') return 'Done';
  if (status === 'failed' || status === 'rejected') return 'Failed';
  if (status === 'stitching') return 'Stitching';
  if (/fetching the task files/i.test(lower)) return 'Fetching files';
  if (/reading the task/i.test(lower)) return 'Planning';
  if (/queued for deliverables/i.test(lower)) return 'Waiting in queue';
  if (/writing the deliverables/i.test(lower)) return 'Writing files';
  if (/\btool\s+(\w+)/i.test(live)) {
    const tool = live.match(/\btool\s+(\w+)/i)?.[1] ?? 'tool';
    return `Tool · ${tool}`;
  }
  if (/writing\s+/i.test(lower)) return 'Writing a file';
  if (status === 'queued') return 'Queued';
  if (status === 'generating') return 'Working';
  return status || 'Working';
}

/** Active cooks keep a fixed order. Finished cooks stay newest first. */
export function sortOperatorCooks(cooks: OperatorCookRow[]): OperatorCookRow[] {
  const active = cooks
    .filter((row) => row.active)
    .sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt);
      if (byCreated) return byCreated;
      return a.id.localeCompare(b.id);
    });
  const finished = cooks
    .filter((row) => !row.active)
    .sort((a, b) => {
      const byActivity = b.activityAt.localeCompare(a.activityAt);
      if (byActivity) return byActivity;
      return b.id.localeCompare(a.id);
    })
    .slice(0, 20);
  return [...active, ...finished];
}

/** True when the panel would look the same. Autocook heartbeat `updated_at` is ignored. */
export function cookListUnchanged(prev: readonly OperatorCookRow[], next: readonly OperatorCookRow[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.line !== b.line ||
      a.phase !== b.phase ||
      a.active !== b.active ||
      a.activityAt !== b.activityAt ||
      a.brain !== b.brain ||
      a.sessionId !== b.sessionId
    ) {
      return false;
    }
  }
  return true;
}

/** One row for the operator's cook list. Drops anything that is not a run id. */
export function operatorCookFromRun(run: {
  id?: string;
  session_id?: string;
  status?: string;
  error?: string | null;
  initial_prompt?: string | null;
  created_at?: string;
  updated_at?: string;
  script_model?: string | null;
  live?: { text?: string } | null;
}): OperatorCookRow | null {
  const id = run.id?.trim() ?? '';
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(id)) return null;
  const status = run.status?.trim() || 'unknown';
  const line = run.live?.text?.trim() || run.error?.trim() || status;
  const updatedAt = run.updated_at?.trim() || '';
  const createdAt = run.created_at?.trim() || updatedAt;
  const active = !FINISHED_COOK.has(status);
  return {
    id,
    sessionId: run.session_id?.trim() || '',
    status,
    line,
    phase: cookPhase(status, line),
    createdAt,
    updatedAt,
    activityAt: createdAt,
    prompt: (run.initial_prompt ?? '').replace(/\s+/g, ' ').trim(),
    brain: cookBrainLabel(run.script_model),
    active,
  };
}

function cookFileName(name: string): string {
  return name.replace(/[\\/]/g, '_').trim().slice(0, 200);
}

/** Names Autocook already wrote onto the task for this run. */
export function landedCookFiles(detail: Record<string, unknown> | undefined): string[] {
  const files = detail?.['files'];
  if (!Array.isArray(files)) return [];
  return files.flatMap((name) => (typeof name === 'string' && cookFileName(name) ? [cookFileName(name)] : []));
}

/**
 * One copy of each deliverable name.
 * A new run replaces the task's AI outputs. The same run only adds names the first
 * pass never landed, and drops extra copies. Files the operator later removed stay gone.
 */
export function ingestFilePlan(
  existing: { id: string; name: string }[],
  wanted: string[],
  sameRun: boolean,
  previouslyLanded: readonly string[] = [],
): { removeIds: string[]; add: string[] } {
  const wantedNames = wanted.map(cookFileName).filter(Boolean);
  if (!sameRun) return { removeIds: existing.map((file) => file.id), add: wantedNames };
  const byName = new Map<string, string[]>();
  for (const file of existing) {
    const ids = byName.get(file.name) ?? [];
    ids.push(file.id);
    byName.set(file.name, ids);
  }
  const removeIds: string[] = [];
  const wantedSet = new Set(wantedNames);
  for (const [name, ids] of byName) {
    if (!wantedSet.has(name)) continue;
    removeIds.push(...ids.slice(1));
  }
  const landed = new Set(previouslyLanded.map(cookFileName).filter(Boolean));
  return { removeIds, add: wantedNames.filter((name) => !byName.has(name) && !landed.has(name)) };
}

/** Autocook deliverable abs paths → `/api/media?path=` relative form. */
export function mediaPathFromAbs(abs: string): string {
  const normalized = abs.replaceAll('\\', '/');
  const at = normalized.toLowerCase().lastIndexOf('/runs/');
  if (at >= 0) return normalized.slice(at + 1);
  if (normalized.startsWith('runs/')) return normalized;
  return normalized.replace(/^\/+/, '');
}

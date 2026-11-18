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
  prompt: string;
  brain: 'Argon' | 'Carbon';
  active: boolean;
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
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated) return byUpdated;
      return b.id.localeCompare(a.id);
    })
    .slice(0, 20);
  return [...active, ...finished];
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
  return {
    id,
    sessionId: run.session_id?.trim() || '',
    status,
    line,
    phase: cookPhase(status, line),
    createdAt: run.created_at?.trim() || updatedAt,
    updatedAt,
    prompt: (run.initial_prompt ?? '').replace(/\s+/g, ' ').trim(),
    brain: cookBrainLabel(run.script_model),
    active: !FINISHED_COOK.has(status),
  };
}

/**
 * One copy of each deliverable name.
 * A new run replaces the task's AI outputs. The same run only adds what is missing
 * and drops extra copies of those names, so a second upload cannot append duplicates
 * or wipe a file the first pass already stored.
 */
export function ingestFilePlan(
  existing: { id: string; name: string }[],
  wanted: string[],
  sameRun: boolean,
): { removeIds: string[]; add: string[] } {
  const wantedNames = wanted.map((name) => name.replace(/[\\/]/g, '_').trim().slice(0, 200)).filter(Boolean);
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
  return { removeIds, add: wantedNames.filter((name) => !byName.has(name)) };
}

/** Autocook deliverable abs paths → `/api/media?path=` relative form. */
export function mediaPathFromAbs(abs: string): string {
  const normalized = abs.replaceAll('\\', '/');
  const at = normalized.toLowerCase().lastIndexOf('/runs/');
  if (at >= 0) return normalized.slice(at + 1);
  if (normalized.startsWith('runs/')) return normalized;
  return normalized.replace(/^\/+/, '');
}

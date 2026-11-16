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
  updatedAt: string;
  prompt: string;
  brain: 'Argon' | 'Carbon';
  active: boolean;
}

function cookBrainLabel(model: string | null | undefined): 'Argon' | 'Carbon' {
  const value = (model ?? '').trim().toLowerCase();
  return value === 'carbon' || value === 'gemini-4-carbon' ? 'Carbon' : 'Argon';
}

/** One row for the operator's cook list. Drops anything that is not a run id. */
export function operatorCookFromRun(run: {
  id?: string;
  session_id?: string;
  status?: string;
  error?: string | null;
  initial_prompt?: string | null;
  updated_at?: string;
  script_model?: string | null;
  live?: { text?: string } | null;
}): OperatorCookRow | null {
  const id = run.id?.trim() ?? '';
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(id)) return null;
  const status = run.status?.trim() || 'unknown';
  const line = run.live?.text?.trim() || run.error?.trim() || status;
  return {
    id,
    sessionId: run.session_id?.trim() || '',
    status,
    line,
    updatedAt: run.updated_at?.trim() || '',
    prompt: (run.initial_prompt ?? '').replace(/\s+/g, ' ').trim(),
    brain: cookBrainLabel(run.script_model),
    active: !FINISHED_COOK.has(status),
  };
}

/** Autocook deliverable abs paths → `/api/media?path=` relative form. */
export function mediaPathFromAbs(abs: string): string {
  const normalized = abs.replaceAll('\\', '/');
  const at = normalized.toLowerCase().lastIndexOf('/runs/');
  if (at >= 0) return normalized.slice(at + 1);
  if (normalized.startsWith('runs/')) return normalized;
  return normalized.replace(/^\/+/, '');
}

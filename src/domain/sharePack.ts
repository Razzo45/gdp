export interface ShareFile {
  id: string;
  name: string;
  mime: string;
  kind: 'input' | 'golden' | 'ai';
  role?: string | null;
}

export interface SharePack {
  submissionId: string;
  title: string;
  task: string;
  fields: { key: string; label: string; text: string }[];
  inputs: ShareFile[];
  golden: ShareFile[];
  aiOutputs: ShareFile[];
  performance: { goldenOutput: string | null; aiOutputHumanEval: string | null; stabilityScores: string | null };
  rubric: { id: string; statement: string; tag: string }[];
}

export function shareFileHref(submissionId: string, fileId: string, token: string): string {
  return `/api/s/${encodeURIComponent(submissionId)}/files/${encodeURIComponent(fileId)}?t=${encodeURIComponent(token)}`;
}

const TASK_VALUE_KEYS = ['task', 'prompt', 'instruction', 'description'] as const;
const TASK_FIELD_KEY = /^(task|prompt|instruction|description)$/i;
const HIDDEN_SHARE_FIELD = /^(task|prompt|instruction|description|expert\s*review|preview(?:\s*image)?|notes)$/i;
const HIDDEN_BRIEF_FIELD = /^(expert\s*(qa|review)|preview(?:\s*image)?)$/i;
const REVIEWER_NOTE_PREFIX = /^(?:\*{2,}\s*)?Expert Reviewer Note:[\s\S]*?(?:\*{2,}\s*)?(?:\r?\n)+/i;

function withoutReviewerNote(text: string): string {
  const stripped = text.replace(REVIEWER_NOTE_PREFIX, '').trim();
  return stripped || text;
}

/** Catalog hides `task` on Ready-for-expert / Independent review; the share page still has to print the brief. */
export function shareTaskText(
  source: { values?: Record<string, unknown>; fields?: { key: string; text: string }[] } | null,
  fallback: string,
): string {
  const values = source?.values ?? {};
  for (const key of TASK_VALUE_KEYS) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) return withoutReviewerNote(value.trim());
  }
  const fromFields = source?.fields?.find((field) => TASK_FIELD_KEY.test(field.key) && field.text.trim());
  return withoutReviewerNote(fromFields?.text.trim() || fallback);
}

function fieldToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function hiddenBy(pattern: RegExp, field: { key: string; label: string }): boolean {
  return pattern.test(fieldToken(field.key)) || pattern.test(fieldToken(field.label));
}

/** Catalog leftover the expert page should not show: review Q&A, preview, notes. */
export function shareVisibleFields<T extends { key: string; label: string }>(fields: T[]): T[] {
  return fields.filter((field) => !hiddenBy(HIDDEN_SHARE_FIELD, field));
}

const ACCEPTANCE_SHARE_FIELDS = [
  { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
  { key: 'creatorAcceptanceCriteria', label: 'Additional acceptance criteria' },
] as const;

/**
 * Expert statuses on GDP Eval and GDP Eval Combined hide one or both criteria
 * from the field list. The View task page still shows whatever text was stored.
 */
export function shareFields(
  fields: { key: string; label: string; text: string }[],
  values: Record<string, unknown> | null | undefined,
): { key: string; label: string; text: string }[] {
  const visible = shareVisibleFields(fields);
  const seen = new Set(visible.map((field) => field.key));
  const missing = ACCEPTANCE_SHARE_FIELDS.flatMap((field) => {
    if (seen.has(field.key)) return [];
    const text = typeof values?.[field.key] === 'string' ? values[field.key].trim() : '';
    if (!text) return [];
    return [{ key: field.key, label: field.label, text }];
  });
  return [...missing, ...visible];
}

/** Task brief: drop Catalog expert Q&A and the preview image; keep the brief itself. */
export function briefVisibleFields<T extends { key: string; label: string }>(fields: T[]): T[] {
  return fields.filter((field) => !hiddenBy(HIDDEN_BRIEF_FIELD, field));
}

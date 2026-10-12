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

const HIDDEN_SHARE_FIELD = /^(expert\s*review|acceptance\s*criteria|preview(?:\s*image)?|notes)$/i;
const HIDDEN_BRIEF_FIELD = /^(expert\s*(qa|review)|preview(?:\s*image)?)$/i;

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

/** Catalog leftover the expert page should not show: review Q&A, acceptance list, preview, notes. */
export function shareVisibleFields<T extends { key: string; label: string }>(fields: T[]): T[] {
  return fields.filter((field) => !hiddenBy(HIDDEN_SHARE_FIELD, field));
}

/** Task brief: drop Catalog expert Q&A and the preview image; keep the brief itself. */
export function briefVisibleFields<T extends { key: string; label: string }>(fields: T[]): T[] {
  return fields.filter((field) => !hiddenBy(HIDDEN_BRIEF_FIELD, field));
}

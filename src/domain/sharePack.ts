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

function fieldToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Catalog leftover the expert page should not show: review Q&A, acceptance list, preview, notes. */
export function shareVisibleFields<T extends { key: string; label: string }>(fields: T[]): T[] {
  return fields.filter((field) => !HIDDEN_SHARE_FIELD.test(fieldToken(field.key)) && !HIDDEN_SHARE_FIELD.test(fieldToken(field.label)));
}

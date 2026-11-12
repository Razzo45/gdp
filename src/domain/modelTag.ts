export const MODEL_TAGS = ['argon', 'carbon', 'gemini_38'] as const;

export type ModelTag = (typeof MODEL_TAGS)[number];

export const MODEL_TAG_LABEL: Record<ModelTag, string> = {
  argon: 'Argon',
  carbon: 'Carbon',
  gemini_38: 'Gemini 3.8',
};

export function isModelTag(value: unknown): value is ModelTag {
  return typeof value === 'string' && (MODEL_TAGS as readonly string[]).includes(value);
}

export function isActiveModelTag(tag: ModelTag): boolean {
  return tag !== 'gemini_38';
}

/** Argon/Carbon are active development; Gemini 3.8 is filterable but out of ops metrics. */
export function isActiveModelWork(row: { modelTag: ModelTag | string | null | undefined }): boolean {
  return isModelTag(row.modelTag) ? isActiveModelTag(row.modelTag) : false;
}

/** Prefer Argon/Carbon on the first non-empty acceptance line; otherwise Gemini 3.8. */
export function inferModelTag(acceptanceText: string): ModelTag {
  const firstLine =
    acceptanceText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  const normalized = firstLine.replace(/^[\s*#\-–—•]*(?:\d+[.)]\s*)?/, '').trim();

  if (/\bargon\b/i.test(normalized)) return 'argon';
  if (/\bcarbon\b/i.test(normalized)) return 'carbon';
  return 'gemini_38';
}

export function modelTagFromValues(values: Record<string, unknown> | null | undefined): ModelTag {
  const main = typeof values?.acceptanceCriteria === 'string' ? values.acceptanceCriteria : '';
  const creator =
    typeof values?.creatorAcceptanceCriteria === 'string' ? values.creatorAcceptanceCriteria : '';
  const text = main.trim().length > 0 ? main : creator;
  return inferModelTag(text);
}

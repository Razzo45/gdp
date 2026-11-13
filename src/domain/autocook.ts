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

/** Autocook deliverable abs paths → `/api/media?path=` relative form. */
export function mediaPathFromAbs(abs: string): string {
  const normalized = abs.replaceAll('\\', '/');
  const at = normalized.toLowerCase().lastIndexOf('/runs/');
  if (at >= 0) return normalized.slice(at + 1);
  if (normalized.startsWith('runs/')) return normalized;
  return normalized.replace(/^\/+/, '');
}

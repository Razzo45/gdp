/** Import wrote this when a legacy row was tagged human but had no observation. */
const PLACEHOLDER_HUMAN_NOTE = /^imported human override\.?$/i;

/** A human golden row only outranks AI when it carries a real observation. */
export function isLiveHumanNote(note: string | null | undefined): boolean {
  const text = (note ?? '').trim();
  return text.length >= 5 && !PLACEHOLDER_HUMAN_NOTE.test(text);
}

/**
 * Saved rubric_answers are the Golden autorate snapshot. Seats tagged human
 * with no live note still import as autorate so empty-on-live verdicts are not dropped.
 */
export function isImportableAutorateSource(source: string | null | undefined): boolean {
  return /autorate|ai|golden|human/i.test(String(source ?? 'autorate_golden'));
}

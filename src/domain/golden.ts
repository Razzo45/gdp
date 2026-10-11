/** Import wrote this when a legacy row was tagged human but had no observation. */
const PLACEHOLDER_HUMAN_NOTE = /^imported human override\.?$/i;

/** A human golden row only outranks AI when it carries a real observation. */
export function isLiveHumanNote(note: string | null | undefined): boolean {
  const text = (note ?? '').trim();
  return text.length >= 5 && !PLACEHOLDER_HUMAN_NOTE.test(text);
}

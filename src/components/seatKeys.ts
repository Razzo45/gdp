/** Y/N on a focused seat — same muscle memory as legacy review. */

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function gradeFromKey(event: { key: string; target: EventTarget | null }): boolean | null {
  if (isTypingTarget(event.target)) return null;
  const key = event.key.toLowerCase();
  if (key === 'y') return true;
  if (key === 'n') return false;
  return null;
}

export function focusNextSeat(from: HTMLElement): void {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-seat-row]')];
  const index = rows.indexOf(from);
  (rows[index + 1] ?? rows[0])?.focus();
}

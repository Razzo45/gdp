/** Autosave vs an explicit click (paste, bank keep/add). */
export type RubricSaveSource = 'autosave' | 'action';

/** One in-flight PUT. A second keystroke queues instead of racing the same revision. */
export function beginRubricSave(sending: boolean): 'send' | 'queue' {
  return sending ? 'queue' : 'send';
}

/** After the in-flight PUT settles, send the queued keystrokes or go idle. */
export function afterRubricSave(queued: boolean): 'idle' | 'send' {
  return queued ? 'send' : 'idle';
}

/** Autosave 409 is our own overlap or a pulse. An explicit action still tells the user. */
export function quietRubricConflict(source: RubricSaveSource): boolean {
  return source === 'autosave';
}

/** Drop ids this PUT already sent. Later keystrokes on other seats stay dirty. */
export function leftoverDirty(current: ReadonlySet<string>, savedIds: readonly string[]): Set<string> {
  const next = new Set(current);
  for (const id of savedIds) next.delete(id);
  return next;
}

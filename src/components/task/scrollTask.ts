/** Marks a column that owns in-panel scrolling (brief sidebar or main panels). */
export const TASK_SCROLL_ATTR = 'data-task-scroll';

type ScrollBox = {
  scrollTop: number;
  scrollTo: (options: ScrollToOptions) => void;
  getBoundingClientRect: () => { top: number };
};

/**
 * Scroll only the nearest task column to `id` — not the window / app shell.
 * Falls back to element.scrollIntoView when no marked scroller exists.
 */
export function scrollTaskPanel(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const found = el.closest(`[${TASK_SCROLL_ATTR}]`);
  const scroller = found as ScrollBox | null;
  if (!scroller || typeof scroller.scrollTo !== 'function' || typeof scroller.getBoundingClientRect !== 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (scroller.scrollTop || 0) - 12;
  scroller.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
}

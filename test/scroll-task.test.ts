import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollTaskPanel, TASK_SCROLL_ATTR } from '@/components/task/scrollTask';

describe('scrollTaskPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('no-ops when the target is missing', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    expect(() => scrollTaskPanel('missing')).not.toThrow();
  });

  it('scrolls only the marked task column', () => {
    const scrollTo = vi.fn();
    const scroller = {
      scrollTop: 40,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const target = {
      getBoundingClientRect: () => ({ top: 400 }),
      closest: (selector: string) => (selector === `[${TASK_SCROLL_ATTR}]` ? scroller : null),
      scrollIntoView: vi.fn(),
    };
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'golden' ? target : null) });

    scrollTaskPanel('golden');

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 328, behavior: 'smooth' });
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it('falls back to element.scrollIntoView without a marked scroller', () => {
    const intoView = vi.fn();
    const target = {
      closest: () => null,
      scrollIntoView: intoView,
    };
    vi.stubGlobal('document', { getElementById: () => target });

    scrollTaskPanel('stability');
    expect(intoView).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'start' });
  });
});

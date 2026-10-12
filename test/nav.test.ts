import { describe, expect, it } from 'vitest';
import { NAV_COLLAPSE_KEY, navCollapseValue, readNavCollapsed } from '@/domain/nav';

describe('nav collapse', () => {
  it('reads a stored rail as collapsed only when the token is collapsed', () => {
    expect(NAV_COLLAPSE_KEY).toBe('gdp.nav:v1');
    expect(readNavCollapsed(null)).toBe(false);
    expect(readNavCollapsed('open')).toBe(false);
    expect(readNavCollapsed('collapsed')).toBe(true);
    expect(navCollapseValue(true)).toBe('collapsed');
    expect(navCollapseValue(false)).toBe('open');
  });
});

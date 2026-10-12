/** Desktop rail preference. Versioned so a later shape does not collide. */
export const NAV_COLLAPSE_KEY = 'gdp.nav:v1';

export function readNavCollapsed(stored: string | null): boolean {
  return stored === 'collapsed';
}

export function navCollapseValue(collapsed: boolean): 'collapsed' | 'open' {
  return collapsed ? 'collapsed' : 'open';
}

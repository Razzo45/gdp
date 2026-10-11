import { describe, expect, it } from 'vitest';
import { shortCatalogId, shortTaskDescriptor } from '@/components/format';

describe('task labels', () => {
  it('uses the first 8 of the catalog id', () => {
    expect(shortCatalogId('60dcd5ce-e117-c385-8a10-9e6d1c58dae0')).toBe('60dcd5ce');
    expect(shortCatalogId('')).toBe('—');
    expect(shortCatalogId(null)).toBe('—');
  });

  it('keeps a short one-line descriptor', () => {
    expect(shortTaskDescriptor('Deliverable: One editable 22-slide deck.')).toBe('Deliverable: One editable 22-slide deck.');
    const clipped = shortTaskDescriptor('  I am a VFX artist and I have been tasked with creating a high-fidelity meteor-impact shot for a film.  ');
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(72);
    expect(clipped.startsWith('I am a VFX artist')).toBe(true);
    expect(shortTaskDescriptor('')).toBe('');
  });
});

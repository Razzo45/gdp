import { describe, expect, it } from 'vitest';
import { shortCatalogId, shortTaskDescriptor } from '@/components/format';

describe('task labels', () => {
  it('uses the first 8 of the catalog id', () => {
    expect(shortCatalogId('60dcd5ce-e117-c385-8a10-9e6d1c58dae0')).toBe('60dcd5ce');
    expect(shortCatalogId('')).toBe('—');
    expect(shortCatalogId(null)).toBe('—');
  });

  it('keeps a short one-line descriptor', () => {
    expect(shortTaskDescriptor('Deliverable: One editable 22-slide deck.')).toBe('One editable 22-slide deck');
    expect(shortTaskDescriptor('  I am a VFX artist and I have been tasked with creating a high-fidelity meteor-impact shot for a film.  ')).toBe(
      'High-fidelity meteor-impact shot for a film',
    );
    expect(
      shortTaskDescriptor(
        "I am an Instructional Coordinator at Groundwork Coffee Academy, and I've been tasked with producing an internal training video that gives our instructors a clear overview.",
      ),
    ).toBe('Internal training video for Groundwork Coffee Academy');
    expect(shortTaskDescriptor('I am a graphic designer and I need help creating a presentation that includes charts.')).toBe('Presentation');
    expect(shortTaskDescriptor('Make a deck for regional leadership.')).toBe('Deck for regional leadership');
    expect(shortTaskDescriptor('Q3 regional deck')).toBe('Q3 regional deck');
    expect(shortTaskDescriptor('')).toBe('');
  });
});

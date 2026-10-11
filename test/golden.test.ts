import { describe, expect, it } from 'vitest';
import { isLiveHumanNote } from '@/domain/golden';

describe('isLiveHumanNote', () => {
  it('rejects empty and import stubs', () => {
    expect(isLiveHumanNote('')).toBe(false);
    expect(isLiveHumanNote('ok')).toBe(false);
    expect(isLiveHumanNote('Imported human override.')).toBe(false);
    expect(isLiveHumanNote('imported human override')).toBe(false);
  });

  it('accepts a real observation', () => {
    expect(isLiveHumanNote('Checked by hand on slide 1.')).toBe(true);
  });
});

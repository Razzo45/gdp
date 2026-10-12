import { describe, expect, it } from 'vitest';
import { isImportableAutorateSource, isLiveHumanNote } from '@/domain/golden';

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

describe('isImportableAutorateSource', () => {
  it('keeps autorate and human-tagged seats from the saved snapshot', () => {
    expect(isImportableAutorateSource(undefined)).toBe(true);
    expect(isImportableAutorateSource('autorate_golden')).toBe(true);
    expect(isImportableAutorateSource('human')).toBe(true);
    expect(isImportableAutorateSource('calibration')).toBe(false);
  });
});

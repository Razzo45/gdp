import { describe, expect, it } from 'vitest';
import { mediaResolutionFor } from '@/lib/ai/gemini';
import { AUTORATE_THINKING_BUDGET, AUTORATER_SYSTEM, INVENTORY_UNAVAILABLE, inventoryPromptBlock } from '@/lib/engines/autorater';

describe('autorater policy', () => {
  it('grades the statement only — no Yes/No preference, no Golden score target', () => {
    expect(AUTORATER_SYSTEM).toMatch(/no preference for Yes or No/i);
    expect(AUTORATER_SYSTEM).toMatch(/Grade the statement as written/i);
    expect(AUTORATER_SYSTEM).not.toMatch(/100%/);
    expect(AUTORATER_SYSTEM).not.toMatch(/optional is\s+absent/i);
    expect(AUTORATE_THINKING_BUDGET).not.toBe(0);
  });

  it('does not treat an unverified or close-enough claim as Yes', () => {
    expect(AUTORATER_SYSTEM).toMatch(/unverified|cannot verify/i);
    expect(AUTORATER_SYSTEM).toMatch(/close-enough|probable Yes is a No|paraphrase is a No/i);
    expect(AUTORATER_SYSTEM).toMatch(/letterbox|pillarbox/i);
    expect(AUTORATER_SYSTEM).toMatch(/container|metadata/i);
    expect(AUTORATER_SYSTEM).toMatch(/file size/i);
    expect(AUTORATER_SYSTEM).not.toMatch(/not a worst-case guess/i);
  });

  it('keeps seat ids in the JSON id field, not in the evidence sentence', () => {
    expect(AUTORATER_SYSTEM).not.toMatch(/Refer to seats as Seat 8 in evidence/i);
    expect(AUTORATER_SYSTEM).toMatch(/Put the seat id only in "id"/i);
    expect(AUTORATER_SYSTEM).toMatch(/do not write Seat 8/i);
  });

  it('does not treat a failed inventory as a clean file', () => {
    expect(inventoryPromptBlock([])).toBeNull();
    expect(inventoryPromptBlock(['logo is stretched'])).toMatch(/logo is stretched/);
    expect(inventoryPromptBlock([INVENTORY_UNAVAILABLE])).toMatch(/unavailable/i);
    expect(inventoryPromptBlock([INVENTORY_UNAVAILABLE])).toMatch(/do not treat/i);
  });
});

describe('grade media resolution', () => {
  it('sends video, audio and PDF at medium so the model can inspect them', () => {
    expect(mediaResolutionFor('video/mp4')).toBe('medium');
    expect(mediaResolutionFor('audio/mpeg')).toBe('medium');
    expect(mediaResolutionFor('application/pdf')).toBe('medium');
    expect(mediaResolutionFor('image/png')).toBe('medium');
  });
});

import { describe, expect, it } from 'vitest';
import { mediaResolutionFor } from '@/lib/ai/gemini';
import { AUTORATE_THINKING_LEVEL, AUTORATER_SYSTEM, INVENTORY_UNAVAILABLE, inventoryPromptBlock, inventoryRelevantTo, statementsBlock } from '@/lib/engines/autorater';

describe('autorater policy', () => {
  it('grades the statement only — no Yes/No preference, no Golden score target', () => {
    expect(AUTORATER_SYSTEM).toMatch(/no preference for Yes or No/i);
    expect(AUTORATER_SYSTEM).toMatch(/Grade the statement as written/i);
    expect(AUTORATER_SYSTEM).not.toMatch(/100%/);
    expect(AUTORATER_SYSTEM).not.toMatch(/optional is\s+absent/i);
    expect(AUTORATE_THINKING_LEVEL).toBe('LOW');
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

  it('does not treat JPEG slide stills as the deliverable being a JPEG instead of a PPTX', () => {
    expect(AUTORATER_SYSTEM).toMatch(/slide still/i);
    expect(AUTORATER_SYSTEM).toMatch(/FILE FACTS/i);
    expect(AUTORATER_SYSTEM).toMatch(/not (change|the) (the )?file kind|still a (PPTX|PowerPoint)|do not answer .*(JPEG|jpeg).*(PPTX|pptx)/i);
  });

  it('treats FILE FACTS picture skew as authoritative over LibreOffice stills', () => {
    expect(AUTORATER_SYSTEM).toMatch(/stretch|squash/i);
    expect(AUTORATER_SYSTEM).toMatch(/Pictures/i);
    expect(AUTORATER_SYSTEM).toMatch(/stills may crop instead of stretch/i);
  });

  it('grades each seat as if it travelled alone even when several share a call', () => {
    expect(AUTORATER_SYSTEM).toMatch(/as if it were (the only statement|sent alone)/i);
    expect(AUTORATER_SYSTEM).toMatch(/shared files\s+are not shared verdicts/i);
    const together = statementsBlock([
      { id: 'a', seat: 1, tag: 'Content - Semantics', statement: 'The home page lists opening hours.', scope: 'output', inputFileIds: [], outputFile: null },
      { id: 'b', seat: 2, tag: 'Content - Semantics', statement: 'The about page names the bakery.', scope: 'output', inputFileIds: [], outputFile: null },
    ]);
    expect(together).toMatch(/\[s001\]/);
    expect(together).toMatch(/\[s002\]/);
    expect(together).toMatch(/ISOLATE EACH STATEMENT|as if it were sent alone/i);
    expect(together).toMatch(/not (reuse|evidence for another)|neighbouring/i);
  });

  it('does not treat a failed inventory as a clean file', () => {
    expect(inventoryPromptBlock([])).toBeNull();
    expect(inventoryPromptBlock(['logo is stretched'])).toMatch(/logo is stretched/);
    expect(inventoryPromptBlock(['logo is stretched'])).toMatch(/optional hints, not verdicts/i);
    expect(inventoryPromptBlock([INVENTORY_UNAVAILABLE])).toMatch(/unavailable/i);
    expect(inventoryPromptBlock([INVENTORY_UNAVAILABLE])).toMatch(/do not treat/i);
  });

  it('does not treat the defect inventory as a universal finding', () => {
    expect(AUTORATER_SYSTEM).toMatch(/hint list, not a finding/i);
    expect(AUTORATER_SYSTEM).toMatch(/unrelated defect/i);
    expect(inventoryPromptBlock(['logo is stretched'])).toMatch(/this statement is about that defect/i);
  });

  it('keeps only inventory rows that could falsify the statement', () => {
    const bar = 'Floating section bar navigation buttons overlap and collide into an unreadable tangle on mobile viewport (390px wide screenshot).';
    const photo = 'Hero background and closing panel image fail to load authentic branding board photography.';
    const pdf = {
      id: 'a',
      tag: 'Format/File',
      statement: 'Each of the Rajdhani and Poppins fonts is embedded in the delivered Complete Directory PDF.',
      scope: 'output' as const,
      inputFileIds: [],
      outputFile: null,
    };
    const nav = {
      id: 'b',
      tag: 'Craft - Composition',
      statement: 'At 375px wide, the navigation menu of the delivered website is collapsed behind a menu toggle that opens it as a drawer.',
      scope: 'output' as const,
      inputFileIds: [],
      outputFile: null,
    };
    expect(inventoryRelevantTo([pdf], [bar, photo])).toEqual([]);
    expect(inventoryRelevantTo([nav], [bar, photo])).toEqual([bar]);
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

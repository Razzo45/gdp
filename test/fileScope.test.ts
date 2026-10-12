import { describe, expect, it } from 'vitest';
import {
  ALL_OUTPUTS,
  applyInferredScope,
  inferFileScope,
  isDefaultScope,
  observationKey,
  resolveGradeFiles,
  statementNamesFile,
} from '@/domain/fileScope';
import { describeNamedFiles } from '@/domain/fileLanguage';

const deck = { id: 'out-1', name: 'q3-regional-deck.pptx' };
const notes = { id: 'out-2', name: 'speaker-notes.pdf' };
const guide = { id: 'in-1', name: 'brand-guide.pdf' };
const brief = { id: 'in-2', name: 'arvella-brief.docx' };

describe('describeNamedFiles', () => {
  it('replaces name.extension with a role descriptor', () => {
    expect(describeNamedFiles('The q3-regional-deck.pptx uses a 16:9 page size.')).toBe(
      'The delivered presentation uses a 16:9 page size.',
    );
    expect(describeNamedFiles('hero_final.mp4 is free of burned-in captions.')).toBe(
      'The delivered video is free of burned-in captions.',
    );
    expect(describeNamedFiles('Colours follow brand-guide.pdf.')).toBe('Colours follow the delivered PDF.');
    expect(describeNamedFiles('The title slide names the review.')).toBe('The title slide names the review.');
  });
});

describe('statementNamesFile', () => {
  it('matches a full filename, not a generic "file 1" label', () => {
    expect(statementNamesFile('The q3-regional-deck.pptx title names the review.', deck)).toBe(true);
    expect(statementNamesFile('The deck title names the review.', deck)).toBe(false);
    expect(statementNamesFile('The input file 1 is attached.', { id: 'x', name: 'Input file 1' })).toBe(false);
  });

  it('matches a long basename so "brand-guide" finds brand-guide.pdf', () => {
    expect(statementNamesFile('Colours follow the brand-guide.', guide)).toBe(true);
  });
});

describe('inferFileScope', () => {
  it('pins the named deliverable and required input', () => {
    expect(inferFileScope('The q3-regional-deck.pptx footer matches brand-guide.pdf.', [guide, brief], [deck, notes])).toEqual({
      scope: 'inputs',
      outputFile: 'q3-regional-deck.pptx',
      inputFileIds: ['in-1'],
    });
  });

  it('stays output-only when no input is implied, and does not pin the sole deliverable', () => {
    expect(inferFileScope('The title slide names the Q3 review.', [guide], [deck])).toEqual({
      scope: 'output',
      outputFile: null,
      inputFileIds: [],
    });
  });

  it('attaches the workbook when figures must match it', () => {
    const sheet = { id: 'in-3', name: 'q3-sales-by-region.xlsx' };
    expect(inferFileScope('Revenue figures match the workbook.', [sheet, brief], [deck])).toEqual({
      scope: 'inputs',
      outputFile: null,
      inputFileIds: ['in-3'],
    });
  });

  it('attaches the brief when a policy threshold is claimed', () => {
    expect(inferFileScope("The escalation policy states a refund threshold of €200.", [brief], [deck])).toEqual({
      scope: 'inputs',
      outputFile: null,
      inputFileIds: ['in-2'],
    });
  });

  it('does not guess when two deliverables and no name', () => {
    expect(inferFileScope('The title slide names the Q3 review.', [guide], [deck, notes])).toEqual({
      scope: 'output',
      outputFile: null,
      inputFileIds: [],
    });
  });
});

describe('applyInferredScope', () => {
  it('leaves a curator all-outputs choice alone', () => {
    const seat = { statement: 'The q3-regional-deck.pptx title is present.', scope: 'output' as const, outputFile: ALL_OUTPUTS, inputFileIds: [] };
    expect(applyInferredScope(seat, [guide], [deck, notes]).outputFile).toBe(ALL_OUTPUTS);
  });

  it('fills a default seat from the statement', () => {
    const seat = { statement: 'Colours follow brand-guide.pdf.', scope: 'output' as const, outputFile: null, inputFileIds: [] };
    expect(applyInferredScope(seat, [guide], [deck])).toMatchObject({ scope: 'inputs', inputFileIds: ['in-1'] });
  });
});

describe('resolveGradeFiles', () => {
  it('sends only the considered deliverable and the required input when the statement names it', () => {
    const resolved = resolveGradeFiles(
      { scope: 'inputs', outputFile: deck.name, inputFileIds: [guide.id], statement: 'The q3-regional-deck.pptx footer matches brand-guide.pdf.' },
      [deck, notes],
      [guide, brief],
    );
    expect(resolved).toMatchObject({ ok: true, allOutputs: false });
    if (resolved.ok) {
      expect(resolved.outputs.map((f) => f.id)).toEqual(['out-1']);
      expect(resolved.inputs.map((f) => f.id)).toEqual(['in-1']);
      expect(observationKey(resolved)).toBe('o:out-1#i:in-1');
    }
  });

  it('honours an explicit pin and treats a stale pin as the current set', () => {
    const pinned = resolveGradeFiles({ scope: 'output', outputFile: deck.name, inputFileIds: [] }, [deck, notes], []);
    expect(pinned).toMatchObject({ ok: true, allOutputs: false });
    if (pinned.ok) expect(pinned.outputs.map((f) => f.id)).toEqual(['out-1']);

    const stale = resolveGradeFiles({ scope: 'output', outputFile: 'missing.pptx', inputFileIds: [] }, [deck, notes], []);
    expect(stale).toMatchObject({ ok: true, allOutputs: true });
    if (stale.ok) expect(stale.outputs.map((f) => f.id)).toEqual(['out-1', 'out-2']);
  });

  it('grades the whole current set when the seat is unset', () => {
    const cards = [
      { id: 'c1', name: 'card-1.png' },
      { id: 'c2', name: 'card-2.png' },
      { id: 'c3', name: 'card-3.png' },
      { id: 'c4', name: 'card-4.png' },
    ];
    const unset = resolveGradeFiles({ scope: 'output', outputFile: null, inputFileIds: [] }, cards, []);
    expect(unset).toMatchObject({ ok: true, allOutputs: true });
    if (unset.ok) expect(unset.outputs.map((f) => f.id)).toEqual(['c1', 'c2', 'c3', 'c4']);

    const named = resolveGradeFiles({ scope: 'output', outputFile: null, inputFileIds: [], statement: 'card-2.png is 1200px wide.' }, cards, []);
    expect(named).toMatchObject({ ok: true, allOutputs: false });
    if (named.ok) expect(named.outputs.map((f) => f.id)).toEqual(['c2']);
  });

  it('treats * as every current deliverable', () => {
    const resolved = resolveGradeFiles({ scope: 'output', outputFile: ALL_OUTPUTS, inputFileIds: [] }, [deck, notes], []);
    expect(resolved).toMatchObject({ ok: true, allOutputs: true });
    if (resolved.ok) expect(resolved.outputs).toHaveLength(2);
  });

  it('never attaches inputs on an output-only seat', () => {
    const resolved = resolveGradeFiles({ scope: 'output', outputFile: deck.name, inputFileIds: [guide.id] }, [deck], [guide]);
    expect(resolved.ok).toBe(false);
  });
});

describe('isDefaultScope', () => {
  it('is only the unset factory row', () => {
    expect(isDefaultScope({ scope: 'output', outputFile: null, inputFileIds: [] })).toBe(true);
    expect(isDefaultScope({ scope: 'output', outputFile: ALL_OUTPUTS, inputFileIds: [] })).toBe(false);
  });
});

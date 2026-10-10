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

const deck = { id: 'out-1', name: 'q3-regional-deck.pptx' };
const notes = { id: 'out-2', name: 'speaker-notes.pdf' };
const guide = { id: 'in-1', name: 'brand-guide.pdf' };
const brief = { id: 'in-2', name: 'arvella-brief.docx' };

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

  it('stays output-only when no input is named, and uses the sole deliverable', () => {
    expect(inferFileScope('The title slide names the Q3 review.', [guide], [deck])).toEqual({
      scope: 'output',
      outputFile: 'q3-regional-deck.pptx',
      inputFileIds: [],
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

  it('follows a replaced or newly uploaded file instead of a stale pin', () => {
    const stale = resolveGradeFiles({ scope: 'output', outputFile: 'missing.pptx', inputFileIds: [] }, [deck, notes], []);
    expect(stale).toMatchObject({ ok: true, allOutputs: false });
    if (stale.ok) expect(stale.outputs.map((f) => f.id)).toEqual(['out-2']);

    const newerWins = resolveGradeFiles({ scope: 'output', outputFile: deck.name, inputFileIds: [] }, [deck, notes], []);
    expect(newerWins).toMatchObject({ ok: true });
    if (newerWins.ok) expect(newerWins.outputs.map((f) => f.id)).toEqual(['out-2']);
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

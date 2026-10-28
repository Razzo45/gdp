import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

const calls = vi.hoisted(() => [] as { parts: unknown[] }[]);
const gradeGate = vi.hoisted(() => ({ delay: 0, inflight: 0, max: 0 }));

vi.mock('@/lib/ai/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini')>()),
  generateJson: async (input: { parts: unknown[] }) => {
    calls.push(input);
    gradeGate.inflight += 1;
    gradeGate.max = Math.max(gradeGate.max, gradeGate.inflight);
    if (gradeGate.delay) await new Promise((resolve) => setTimeout(resolve, gradeGate.delay));
    gradeGate.inflight -= 1;
    const ids = [...String(input.parts.at(-1)).matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!);
    return { value: { verdicts: ids.map((id) => ({ id, answer: 'Yes', evidence: 'ok' })) }, model: 'm', usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 0 };
  },
}));

import { ACCEPTANCE } from '@/domain/fileScope';
import { gradeStatements } from '@/lib/engines/autorater';

const deck = { id: 'out-1', name: 'deck.pdf', parts: ['CONSIDERED OUTPUT: deck.pdf'], delivery: 'native' as const, sha256: 'x', bytes: 1 };
const criteria = 'ACCEPTANCE CRITERIA:\nEvery slide has a title.\n\nADDITIONAL ACCEPTANCE CRITERIA:\nLogo bottom right.';

describe('gradeStatements with acceptance criteria', () => {
  it('attaches the criteria only to statements that link them', async () => {
    calls.length = 0;
    const result = await gradeStatements({
      statements: [
        { id: 'a', seat: 1, tag: 'Content - Semantics', statement: 'Every slide carries a title as required.', scope: 'inputs', inputFileIds: [ACCEPTANCE], outputFile: null },
        { id: 'b', seat: 2, tag: 'Visual - Layout', statement: 'The cover photo fills the slide.', scope: 'output', inputFileIds: [], outputFile: null },
      ],
      outputs: [deck],
      inputs: [],
      taskContext: 'Task: Deck',
      acceptanceCriteria: criteria,
      defectInventory: [],
    });

    expect(result.errors).toEqual({});
    const textOf = (call: { parts: unknown[] }) => call.parts.filter((p): p is string => typeof p === 'string').join('\n');
    const linked = calls.find((call) => textOf(call).includes('[s001]'))!;
    const plain = calls.find((call) => textOf(call).includes('[s002]'))!;
    expect(textOf(linked)).toContain('ADDITIONAL ACCEPTANCE CRITERIA:\nLogo bottom right.');
    expect(textOf(plain)).not.toContain('ACCEPTANCE CRITERIA');
  });

  it('grades archive batches one at a time so a zip cannot fan out full-site prompts', async () => {
    calls.length = 0;
    gradeGate.delay = 30;
    gradeGate.inflight = 0;
    gradeGate.max = 0;
    await gradeStatements({
      statements: [
        { id: 'a', seat: 1, tag: 'Content - Semantics', statement: 'The home page lists opening hours.', scope: 'output', inputFileIds: [], outputFile: null },
        { id: 'b', seat: 2, tag: 'Content - Semantics', statement: 'The about page names the bakery.', scope: 'output', inputFileIds: [], outputFile: null },
      ],
      outputs: [deck],
      inputs: [],
      taskContext: 'Task: Site',
      defectInventory: [],
      batchSize: 1,
      serialBatches: true,
    });

    expect(gradeGate.max).toBe(1);
  });
});

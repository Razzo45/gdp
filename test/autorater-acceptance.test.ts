import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

const calls = vi.hoisted(() => [] as { parts: unknown[] }[]);

vi.mock('@/lib/ai/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini')>()),
  generateJson: async (input: { parts: unknown[] }) => {
    calls.push(input);
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
});

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

const calls = vi.hoisted(() => [] as { thinkingBudget?: number; maxOutputTokens?: number }[]);

vi.mock('@/lib/ai/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini')>()),
  generateJson: async (input: { parts: unknown[]; thinkingBudget?: number; maxOutputTokens?: number }) => {
    calls.push({ thinkingBudget: input.thinkingBudget, maxOutputTokens: input.maxOutputTokens });
    const ids = [...String(input.parts.at(-1)).matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!);
    const empty = { value: { verdicts: [] }, model: 'm', usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 0 };
    if (calls.length === 1 || (input.maxOutputTokens ?? 0) < 8192) return empty;
    return {
      value: { verdicts: ids.map((id) => ({ id, answer: 'No', evidence: 'The screenshot does not show that state.' })) },
      model: 'm',
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
    };
  },
}));

import { gradeStatements } from '@/lib/engines/autorater';

const html = { id: 'out-1', name: 'index.html', parts: ['CONSIDERED OUTPUT: index.html'], delivery: 'native' as const, sha256: 'x', bytes: 1 };

describe('gradeStatements retry ping', () => {
  it('fits a Yes or No on the existing solo retry when the first ping is empty', async () => {
    calls.length = 0;
    const result = await gradeStatements({
      statements: [{ id: 'a', seat: 5, tag: 'Visual - Layout', statement: 'Hovering the filter chip highlights it.', scope: 'output', inputFileIds: [], outputFile: null }],
      outputs: [html],
      inputs: [],
      taskContext: 'Task: Site',
      defectInventory: [],
      batchSize: 1,
    });

    expect(result.errors).toEqual({});
    expect(result.answers).toEqual({ a: false });
    expect(result.evidence.a).toMatch(/screenshot/i);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.maxOutputTokens).toBeGreaterThanOrEqual(8192);
    expect(calls[1]?.thinkingBudget).toBe(calls[0]?.thinkingBudget);
  });
});

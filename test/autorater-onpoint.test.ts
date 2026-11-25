import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

const calls = vi.hoisted(() => [] as { parts: string }[]);

vi.mock('@/lib/ai/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini')>()),
  generateJson: async (input: { parts: unknown[] }) => {
    const parts = input.parts.map(String).join('\n');
    calls.push({ parts });
    const ids = [...String(input.parts.at(-1)).matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]!);
    const offPoint = ids.map((id) => ({ id, answer: 'Yes' as const, evidence: 'The app.js RESOURCES array contains 26 objects.' }));
    const onPoint = ids.map((id) => ({
      id,
      answer: 'No' as const,
      evidence: 'Relative paths link the HTML, CSS and JS with no server, setup step or CDN.',
    }));
    const ping = calls.filter((call) => call.parts.includes('Double-clicking')).length;
    return {
      value: { verdicts: ping === 1 ? offPoint : onPoint },
      model: 'm',
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
    };
  },
}));

import { gradeStatements } from '@/lib/engines/autorater';

const zip = { id: 'out-1', name: 'index.zip', parts: ['CONSIDERED OUTPUT: index.zip'], delivery: 'archive' as const, sha256: 'x', bytes: 1 };
const html = { id: 'out-2', name: 'index.html', parts: ['CONSIDERED OUTPUT: index.html'], delivery: 'native' as const, sha256: 'y', bytes: 1 };

const offline = {
  id: 'a',
  seat: 1,
  tag: 'Format/File',
  statement: 'Double-clicking the main HTML page of the delivered website opens the full site with no server, setup step or internet connection.',
  scope: 'output' as const,
  inputFileIds: [] as string[],
  outputFile: null,
};

describe('gradeStatements on-point evidence', () => {
  it('repeats the statement before and after the files', async () => {
    calls.length = 0;
    await gradeStatements({
      statements: [offline],
      outputs: [html],
      inputs: [],
      taskContext: 'Task: Site',
      defectInventory: [],
      batchSize: 1,
    });
    const blob = calls[0]!.parts;
    const first = blob.slice(0, blob.indexOf('TASK CONTEXT'));
    expect(blob).toMatch(/STATEMENTS TO GRADE/);
    expect(first).toMatch(/STATEMENTS TO GRADE/);
    expect(blob.lastIndexOf('STATEMENTS TO GRADE')).toBeGreaterThan(blob.indexOf('STATEMENTS TO GRADE'));
  });

  it('does not keep an off-point archive first ping — the solo retry must grade the statement', async () => {
    calls.length = 0;
    const result = await gradeStatements({
      statements: [offline],
      outputs: [zip],
      inputs: [],
      taskContext: 'Task: Site',
      defectInventory: [],
      batchSize: 1,
    });
    expect(result.errors).toEqual({});
    expect(result.answers).toEqual({ a: false });
    expect(result.evidence.a).toMatch(/relative paths|no server/i);
    expect(result.evidence.a).not.toMatch(/RESOURCES/);
    expect(calls.length).toBe(2);
  });

  it('keeps a native first ping even when evidence is a recited file fact', async () => {
    calls.length = 0;
    const result = await gradeStatements({
      statements: [offline],
      outputs: [html],
      inputs: [],
      taskContext: 'Task: Site',
      defectInventory: [],
      batchSize: 1,
    });
    expect(result.errors).toEqual({});
    expect(calls.length).toBe(1);
    expect(result.evidence.a).toMatch(/RESOURCES/);
  });
});

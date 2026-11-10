import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
});

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

vi.mock('@/lib/ai/htmlShots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/htmlShots')>();
  return {
    ...actual,
    screenshotHtml: async () => [
      { view: 'desktop' as const, mime: 'image/jpeg' as const, bytes: jpeg },
      { view: 'mobile' as const, mime: 'image/jpeg' as const, bytes: jpeg },
    ],
  };
});

function thenable(result: unknown = []) {
  const query: Record<string, unknown> = {};
  const next = () => query;
  query.select = next;
  query.from = next;
  query.where = next;
  query.insert = next;
  query.values = next;
  query.onConflictDoUpdate = next;
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

vi.mock('@/db/client', () => ({
  db: () => thenable([]),
}));

vi.mock('@/lib/storage', () => ({
  putObject: async () => undefined,
  getObject: async () => null,
}));

import { prepareFile } from '@/lib/ai/media';

describe('prepareFile HTML visual-first judge note', () => {
  it('tells the rater a screenshot cannot be overridden by source', async () => {
    const html = '<!DOCTYPE html><html><body><canvas id="webgl"></canvas></body></html>';
    const prepared = await prepareFile(
      { id: 'h', name: 'scene.html', mime: 'text/html', bytes: new TextEncoder().encode(html) },
      'CONSIDERED OUTPUT',
    );
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('\n');
    const media = prepared.parts.filter((part) => typeof part !== 'string');

    expect(text).toMatch(/screenshots first/i);
    expect(text).toMatch(/Yes only if it is visible in a screenshot/i);
    expect(text).toMatch(/cannot turn a missing or broken visual into a Yes/i);
    expect(text).not.toMatch(/check the source for them/i);
    expect(text).not.toMatch(/judge text and structure from the source/i);
    expect(media.some((part) => 'mime' in part && part.mime === 'image/jpeg')).toBe(true);
  });
});

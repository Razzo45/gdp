import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
}));

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

vi.mock('@google/genai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@google/genai')>();
  return {
    ...real,
    GoogleGenAI: class {
      files = files;
    },
  };
});

import { eq } from 'drizzle-orm';
import { geminiFiles, geminiFileUses } from '@/db/schema';
import { GeminiError, mediaPart } from '@/lib/ai/gemini';
import { makeSubmission, testDb } from './helpers/db';

const GIB = 1024 ** 3;
const video = { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'video/mp4', sha256: 'sha-video', name: 'clip.mp4', label: 'clip' };
const active = (name: string) => ({ name, uri: `https://gemini/${name}`, state: 'ACTIVE' });
const listing = (sizes: number[]) => (async function* () {
  for (const [i, size] of sizes.entries()) yield { name: `files/x${i}`, sizeBytes: String(size) };
})();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('Files API staging never leaves an untracked copy behind', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;

  beforeEach(async () => {
    ctx = await testDb();
    for (const fn of Object.values(files)) fn.mockReset();
    files.delete.mockResolvedValue({});
  });
  afterEach(async () => ctx.close());

  it('deletes the remote file when it forgets a failed cached handle', async () => {
    await ctx.db.insert(geminiFiles).values({ sha256: video.sha256, uri: 'https://gemini/files/old', mime: video.mime, size: 4, expiresAt: inHours(40) });
    files.get.mockResolvedValue({ name: 'files/old', state: 'FAILED' });
    files.upload.mockResolvedValue(active('files/new'));

    const part = await mediaPart(video);

    expect(part.data).toBe('https://gemini/files/new');
    expect(files.delete).toHaveBeenCalledWith({ name: 'files/old' });
  });

  it('deletes its own upload when Gemini never makes it ACTIVE', async () => {
    files.upload.mockResolvedValue({ name: 'files/bad', state: 'FAILED' });

    await expect(mediaPart(video)).rejects.toBeInstanceOf(GeminiError);
    expect(files.delete).toHaveBeenCalledWith({ name: 'files/bad' });
  });

  it('keeps the live handle another process recorded first and deletes its duplicate', async () => {
    files.upload.mockImplementation(async () => {
      await ctx.db.insert(geminiFiles).values({ sha256: video.sha256, uri: 'https://gemini/files/winner', mime: video.mime, size: 4, expiresAt: inHours(40) });
      return active('files/loser');
    });

    const part = await mediaPart(video);

    expect(part.data).toBe('https://gemini/files/winner');
    expect(files.delete).toHaveBeenCalledWith({ name: 'files/loser' });
    const rows = await ctx.db.select().from(geminiFiles).where(eq(geminiFiles.sha256, video.sha256));
    expect(rows.map((row) => row.uri)).toEqual(['https://gemini/files/winner']);
  });
});

describe('Files API storage full', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;

  beforeEach(async () => {
    ctx = await testDb();
    for (const fn of Object.values(files)) fn.mockReset();
    files.delete.mockResolvedValue({});
  });
  afterEach(async () => ctx.close());

  it('reports storage full, not a rate limit, after culling finished tasks', async () => {
    const done = await makeSubmission(ctx.db, { stage: 'done' });
    await ctx.db.insert(geminiFiles).values({ sha256: 'sha-done', uri: 'https://gemini/files/done', mime: video.mime, size: GIB, expiresAt: inHours(40) });
    await ctx.db.insert(geminiFileUses).values({ sha256: 'sha-done', submissionId: done.id });
    files.upload.mockRejectedValue(Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), { status: 429 }));
    files.list.mockImplementation(async () => listing([10 * GIB, 10 * GIB]));

    const failure = await mediaPart(video).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GeminiError);
    expect((failure as GeminiError).kind).toBe('storage_full');
    expect((failure as GeminiError).message).toMatch(/storage is full/i);
    expect(files.delete).toHaveBeenCalledWith({ name: 'files/done' });
    expect(files.upload).toHaveBeenCalledTimes(2);
  });

  it('reads a storage quota message as storage full without measuring', async () => {
    files.upload.mockRejectedValue(Object.assign(new Error('RESOURCE_EXHAUSTED: File storage quota exceeded for project.'), { status: 429 }));

    const failure = await mediaPart(video).catch((error: unknown) => error);

    expect((failure as GeminiError).kind).toBe('storage_full');
  });
});

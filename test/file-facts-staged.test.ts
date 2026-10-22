import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveUri = vi.fn<(digest: string) => Promise<string | null>>();
const readObject = vi.fn<(path: string) => Promise<Uint8Array | null>>();

vi.mock('@/lib/ai/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini')>()),
  lookupActiveFileUri: (digest: string) => liveUri(digest),
  rememberGeminiUse: async () => undefined,
}));
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  getObject: (path: string) => readObject(path),
}));

import { aiOutputFiles } from '@/db/schema';
import { sha256 } from '@/domain/fingerprint';
import { prepareAiOutputs } from '@/lib/services/files';
import { makeSubmission, testDb } from './helpers/db';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const factsOf = (parts: unknown[]) => parts.filter((part): part is string => typeof part === 'string').join('\n');

describe('FILE FACTS on a re-run that reuses a staged Files API URI', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  const bytes = png(3840, 2160);

  beforeEach(async () => {
    ctx = await testDb();
    liveUri.mockReset();
    readObject.mockReset();
    readObject.mockResolvedValue(bytes);
  });
  afterEach(async () => ctx.close());

  async function seedOutput() {
    const submission = await makeSubmission(ctx.db);
    await ctx.db.insert(aiOutputFiles).values({ submissionId: submission.id, name: 'frame.png', mime: 'image/png', size: bytes.byteLength, sha256: sha256(bytes), storagePath: 'ai/frame.png' });
    return submission.id;
  }

  it('keeps the measured facts the first run sent', async () => {
    const id = await seedOutput();
    liveUri.mockResolvedValue(null);
    const first = await prepareAiOutputs(ctx.db, id, 'CONSIDERED OUTPUT');
    expect(factsOf(first.files[0]!.parts)).toMatch(/Dimensions: 3840 x 2160/);

    liveUri.mockResolvedValue('files/abc');
    readObject.mockClear();
    const rerun = await prepareAiOutputs(ctx.db, id, 'CONSIDERED OUTPUT');
    expect(readObject).not.toHaveBeenCalled();
    expect(rerun.files[0]!.parts).toContainEqual(expect.objectContaining({ kind: 'uri', data: 'files/abc' }));
    expect(factsOf(rerun.files[0]!.parts)).toMatch(/Dimensions: 3840 x 2160/);
  });

  it('re-measures from the bytes when a live URI has no stored facts', async () => {
    const id = await seedOutput();
    liveUri.mockResolvedValue('files/abc');
    const rerun = await prepareAiOutputs(ctx.db, id, 'CONSIDERED OUTPUT');
    expect(readObject).toHaveBeenCalledOnce();
    expect(factsOf(rerun.files[0]!.parts)).toMatch(/Dimensions: 3840 x 2160/);
  });
});

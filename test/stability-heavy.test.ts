import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gradeGate = vi.hoisted(() => ({ inflight: 0, max: 0 }));
const stagedParts = vi.hoisted(() => ({ calls: [] as { name: string; stage?: boolean; mime: string }[] }));

vi.hoisted(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
  process.env['AUTH_MODE'] = 'local';
});

vi.mock('@/lib/ai/gemini', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/gemini')>();
  return {
    ...real,
    mediaPart: async (input: { mime: string; sha256: string; name: string; label: string; stage?: boolean }) => {
      stagedParts.calls.push({ name: input.name, stage: input.stage, mime: input.mime });
      return { kind: 'uri' as const, mime: input.mime, data: `files/${input.sha256}`, label: input.label };
    },
  };
});

vi.mock('@/lib/engines/autorater', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/engines/autorater')>();
  return {
    ...real,
    inventoriesForObservations: async () => ({}),
    gradeStatements: async (input: { statements: { id: string }[] }) => {
      gradeGate.inflight += 1;
      gradeGate.max = Math.max(gradeGate.max, gradeGate.inflight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      gradeGate.inflight -= 1;
      const answers = Object.fromEntries(input.statements.map((statement) => [statement.id, true]));
      return {
        answers,
        evidence: {},
        errors: {},
        model: 'test',
        usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 1 },
        defectInventory: [],
        inventoryByKey: {},
      };
    },
  };
});

vi.mock('@/lib/services/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/services/files')>();
  return {
    ...real,
    prepareAiOutputs: async () => ({
      files: [
        {
          id: 'ai-zip',
          name: 'maison-ai-output.zip',
          parts: ['ARCHIVE', { kind: 'uri' as const, mime: 'text/html', data: 'files/index', label: 'index.html' }],
          delivery: 'archive' as const,
          sha256: 'zip-sha',
          bytes: 100_899_604,
        },
      ],
      fingerprint: 'fp',
    }),
    listAiOutputs: async () => [{ sha256: 'zip-sha' }],
    prepareCatalogFiles: async () => ({ files: [], fingerprint: '' }),
  };
});

import JSZip from 'jszip';
import { jobs, rubrics, rubricStatements } from '@/db/schema';
import { ARCHIVE_STAGE_BYTES, isArchiveFile, isHeavyMedia, stabilityGradeCalls, stabilityGradesInParallel } from '@/domain/jobs';
import { inspectSendParts } from '@/lib/ai/gemini';
import { prepareFile } from '@/lib/ai/media';
import { runStability } from '@/lib/jobs/handlers';
import { makeSubmission, makeUser, testDb } from './helpers/db';

const B290_ZIP = { mime: 'application/x-zip-compressed', name: 'maison-ai-output.zip', size: 100_899_604 };

async function fatSiteZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('index.html', '<!DOCTYPE html><html><body><h1>Maison</h1></body></html>');
  zip.file('app.js', 'document.body.dataset.ready = "1";');
  const pad = new Uint8Array(ARCHIVE_STAGE_BYTES);
  for (let i = 0; i < pad.byteLength; i += 65536) {
    pad.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, pad.byteLength - i))), i);
  }
  zip.file('assets/pad.bin', pad);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
}

describe('b290-sized zip Stability', () => {
  it('classifies the live maison zip as an archive job, not a 1 GB video', () => {
    expect(isArchiveFile(B290_ZIP)).toBe(true);
    expect(isHeavyMedia(B290_ZIP)).toBe(false);
    expect(stabilityGradesInParallel({ archive: true })).toBe(false);
    expect(stabilityGradeCalls(50, { archive: true })).toBe(150);
    expect(B290_ZIP.size).toBeGreaterThan(ARCHIVE_STAGE_BYTES);
  });

  it('stages HTML from a fat site zip instead of inlining it in the grade body', async () => {
    stagedParts.calls = [];
    const bytes = await fatSiteZip();
    expect(bytes.byteLength).toBeGreaterThanOrEqual(ARCHIVE_STAGE_BYTES);
    const prepared = await prepareFile({ id: 'z', name: 'maison-ai-output.zip', mime: 'application/zip', bytes }, 'CONSIDERED OUTPUT');
    const media = prepared.parts.filter((part): part is { kind: 'uri' | 'inline'; mime: string; data: string; label: string } => typeof part !== 'string');
    const inspect = inspectSendParts(prepared.parts);
    expect(prepared.delivery).toBe('archive');
    expect(inspect.inline).toBe(0);
    expect(inspect.uris).toBeGreaterThan(0);
    expect(media.every((part) => part.kind === 'uri')).toBe(true);
    expect(stagedParts.calls.some((call) => call.name.includes('index.html') && call.stage === true)).toBe(true);
  });
});

describe('heavy Stability does not overlap grade passes', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;

  beforeEach(async () => {
    ctx = await testDb();
    gradeGate.inflight = 0;
    gradeGate.max = 0;
  });
  afterEach(async () => ctx.close());

  async function seedJob(heavy: boolean) {
    const creator = await makeUser(ctx.db, 'c-heavy@example.com', ['rubric_creator']);
    const submission = await makeSubmission(ctx.db);
    const [rubric] = await ctx.db.insert(rubrics).values({ submissionId: submission.id, version: 1, createdBy: creator.id }).returning();
    await ctx.db.insert(rubricStatements).values({
      rubricId: rubric!.id,
      position: 1,
      family: 'format',
      tag: 'Format/File',
      statement: 'The deliverable is a zip of the site.',
    });
    const [job] = await ctx.db
      .insert(jobs)
      .values({
        kind: 'stability_run',
        submissionId: submission.id,
        rubricId: rubric!.id,
        requestId: crypto.randomUUID(),
        payload: { groupId: crypto.randomUUID(), ...(heavy ? { archive: true } : {}) },
        status: 'running',
        createdBy: creator.id,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .returning();
    return job!;
  }

  it('runs the three heavy passes one at a time', async () => {
    const job = await seedJob(true);
    const result = await runStability({
      job,
      leaseToken: 'lease',
      tick: async () => undefined,
      signal: new AbortController().signal,
    });
    expect(gradeGate.max).toBe(1);
    expect(result.scores).toHaveLength(3);
  });

  it('still overlaps the three light passes, so the detector can see a crash-shaped run', async () => {
    const job = await seedJob(false);
    await runStability({
      job,
      leaseToken: 'lease',
      tick: async () => undefined,
      signal: new AbortController().signal,
    });
    expect(gradeGate.max).toBeGreaterThan(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rubrics, rubricStatements } from '@/db/schema';
import { viewTaskToken } from '@/domain/viewTask';
import type { Db } from '@/db/types';
import { ServiceError } from '@/lib/services/errors';
import { sharePack } from '@/lib/services/share';
import { makeSubmission, testDb } from './helpers/db';

const SECRET = 'local-dev-secret-change-me';

let handle: Awaited<ReturnType<typeof testDb>>;
let db: Db;

beforeAll(async () => {
  process.env['AUTH_MODE'] = 'local';
  process.env['AUTH_LOCAL_SECRET'] = SECRET;
  process.env['DATABASE_URL'] ??= 'postgres://gdp:gdp@127.0.0.1/gdp';
  handle = await testDb();
  db = handle.db;
});
afterAll(async () => handle.close());

describe('share pack', () => {
  it('refuses a missing or wrong token with the same 404', async () => {
    const row = await makeSubmission(db);
    const token = viewTaskToken(SECRET, row.id);
    await expect(sharePack(row.id, null)).rejects.toMatchObject({ status: 404 });
    await expect(sharePack(row.id, '0'.repeat(32))).rejects.toMatchObject({ status: 404 });
    await expect(sharePack(crypto.randomUUID(), token)).rejects.toBeInstanceOf(ServiceError);
  });

  it('returns the read-only pack for a valid link', async () => {
    const row = await makeSubmission(db, {
      title: 'Avenue briefing',
      source: {
        submission: {
          projectSubmissionId: 'cat-share',
          submission: { prompt: 'Make a deck for regional leadership.' },
          files: [],
        },
        project: null,
      },
    });
    const [rubric] = await db.insert(rubrics).values({ submissionId: row.id, version: 1, isCurrent: true }).returning();
    await db.insert(rubricStatements).values({
      rubricId: rubric!.id,
      position: 0,
      family: 'format',
      tag: 'Format/File',
      statement: 'The delivered video is 16:9.',
    });
    const pack = await sharePack(row.id, viewTaskToken(SECRET, row.id));
    expect(pack.title).toMatch(/deck for regional leadership/);
    expect(pack.task).toMatch(/deck for regional leadership/);
    expect(pack.rubric).toEqual([{ id: 's001', statement: 'The delivered video is 16:9.', tag: 'Format/File' }]);
  });
});

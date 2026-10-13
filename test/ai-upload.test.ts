import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@/domain/fingerprint';
import type { Db } from '@/db/types';
import type { Actor } from '@/lib/auth/permissions';
import { beginAiOutput, finishAiOutput, listAiOutputs } from '@/lib/services/files';
import { submissionView } from '@/lib/services/view';
import { ServiceError } from '@/lib/services/errors';
import { claimSeat } from '@/lib/services/submissions';
import { putObject } from '@/lib/storage';
import { makeSubmission, makeUser, testDb } from './helpers/db';

let handle: Awaited<ReturnType<typeof testDb>>;
let db: Db;
let creator: Actor;
let admin: Actor;

beforeAll(async () => {
  process.env['AUTH_MODE'] = 'local';
  process.env['DATABASE_URL'] ??= 'postgres://gdp:gdp@127.0.0.1/gdp';
  process.env['STORAGE_DRIVER'] = 'local';
  handle = await testDb();
  db = handle.db;
  creator = await makeUser(db, 'upload@example.com', ['rubric_creator']);
  admin = await makeUser(db, 'admin-upload@example.com', ['admin']);
});
afterAll(async () => handle.close());

describe('signed AI output upload', () => {
  it('lets an admin attach AI output while the rubric seat is empty', async () => {
    const submission = await makeSubmission(db);
    expect(submission.rubricAssigneeId).toBeNull();
    const view = await submissionView(admin, submission.id);
    expect(view.can.changeAiOutputs).toBe(true);
    const ticket = await beginAiOutput(admin, submission.id, { name: 'ai.pdf', mime: 'application/pdf', size: 4 });
    expect(ticket.path.startsWith(`ai-outputs/${submission.id}/`)).toBe(true);
  });

  it('records a file after the object lands, and refuses a missing object', async () => {
    const submission = await makeSubmission(db);
    await claimSeat(creator, submission.id, 'rubric');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const ticket = await beginAiOutput(creator, submission.id, { name: 'ai.mp4', mime: 'video/mp4', size: bytes.byteLength });
    expect(ticket.path.startsWith(`ai-outputs/${submission.id}/`)).toBe(true);
    expect(ticket.uploadUrl).toContain('local-storage');

    await expect(
      finishAiOutput(creator, submission.id, { ...ticket, name: 'ai.mp4', mime: 'video/mp4', size: bytes.byteLength }),
    ).rejects.toMatchObject({ status: 502 });

    await putObject(ticket.path, bytes, 'video/mp4');
    const row = await finishAiOutput(creator, submission.id, { ...ticket, name: 'ai.mp4', mime: 'video/mp4', size: bytes.byteLength });
    expect(row.sha256).toBe(sha256(bytes));
    expect(row.size).toBe(5);
    expect((await listAiOutputs(db, submission.id)).map((f) => f.id)).toEqual([row.id]);
  });

  it('rejects a ticket that does not match the file', async () => {
    const submission = await makeSubmission(db);
    await claimSeat(creator, submission.id, 'rubric');
    const ticket = await beginAiOutput(creator, submission.id, { name: 'ai.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 12 });
    await expect(
      finishAiOutput(creator, submission.id, { ...ticket, name: 'other.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 12 }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await listAiOutputs(db, submission.id)).toEqual([]);
  });
});

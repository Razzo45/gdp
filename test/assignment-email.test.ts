import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/types';
import type { Actor } from '@/lib/auth/permissions';
import { makeUser, testDb } from './helpers/db';

const send = vi.fn();
vi.mock('@/lib/mail/ses', () => ({
  sesConfigured: () => Boolean(process.env['SES_FROM_EMAIL']),
  sendSesTemplatedEmail: (...args: unknown[]) => send(...args),
}));

import { sendAssignmentEmail } from '@/lib/mail/assignment';

let handle: Awaited<ReturnType<typeof testDb>>;
let db: Db;
let creator: Actor;

beforeAll(async () => {
  handle = await testDb();
  db = handle.db;
  creator = await makeUser(db, 'assigned@example.test', ['rubric_creator']);
});
afterAll(async () => handle.close());
afterEach(() => {
  vi.clearAllMocks();
  delete process.env['SES_FROM_EMAIL'];
  delete process.env['PUBLIC_APP_URL'];
});

describe('assignment email', () => {
  beforeEach(() => {
    process.env['PUBLIC_APP_URL'] = 'https://gdp.example';
    process.env['SES_FROM_EMAIL'] = 'Wirestock <noreply@wirestock.io>';
    send.mockResolvedValue(undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('sends the live template contract', async () => {
    expect(await sendAssignmentEmail('task-id', creator.id)).toBe('accepted');
    expect(send).toHaveBeenCalledExactlyOnceWith({
      recipient: 'assigned@example.test',
      templateName: 'submission_assigned',
      templateData: {
        firstName: 'assigned',
        submissionUrl: 'https://gdp.example/submissions/task-id',
        updateProfileUrl: 'https://gdp.example/settings',
        unsubscribeUrl: 'https://gdp.example/settings',
      },
    });
  });

  it('skips when SES is not configured', async () => {
    delete process.env['SES_FROM_EMAIL'];
    expect(await sendAssignmentEmail('task-id', creator.id)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send without https PUBLIC_APP_URL', async () => {
    process.env['PUBLIC_APP_URL'] = 'http://localhost:3000';
    expect(await sendAssignmentEmail('task-id', creator.id)).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
});

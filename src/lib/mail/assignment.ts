import 'server-only';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles } from '@/db/schema';
import { sendSesTemplatedEmail, sesConfigured } from './ses';

/**
 * After a seat is assigned. Failure never rolls the assignment back.
 * Same SES template name and data contract as live (`submission_assigned`).
 */
export async function sendAssignmentEmail(submissionId: string, assigneeId: string): Promise<'accepted' | 'skipped' | 'failed'> {
  let stage: 'configuration' | 'recipient' | 'ses' = 'configuration';
  try {
    if (!sesConfigured()) return 'skipped';
    const base = (process.env['PUBLIC_APP_URL'] ?? '').trim();
    if (!base || !/^https:\/\//i.test(base)) throw new Error('A public HTTPS app URL is required.');

    stage = 'recipient';
    const profile = (await db().select().from(profiles).where(eq(profiles.id, assigneeId)).limit(1))[0];
    if (!profile?.isActive || !profile.email.trim()) throw new Error('Assignment recipient unavailable.');

    stage = 'ses';
    const origin = base.replace(/\/$/, '');
    await sendSesTemplatedEmail({
      recipient: profile.email.trim(),
      templateName: process.env['SES_ASSIGNMENT_TEMPLATE']?.trim() || 'submission_assigned',
      templateData: {
        firstName: profile.displayName?.trim() || 'there',
        submissionUrl: `${origin}/submissions/${encodeURIComponent(submissionId)}`,
        updateProfileUrl: process.env['SES_PROFILE_URL']?.trim() || `${origin}/settings`,
        unsubscribeUrl: process.env['SES_UNSUBSCRIBE_URL']?.trim() || `${origin}/settings`,
      },
    });
    console.info('[assignment-email]', { outcome: 'provider_accepted', stage });
    return 'accepted';
  } catch {
    console.warn('[assignment-email]', { outcome: 'failed', stage });
    return 'failed';
  }
}

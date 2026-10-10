import { z } from 'zod';
import { db } from '@/db/client';
import { RUBRIC_TAGS } from '@/domain/rubric';
import { route } from '@/lib/api';
import { assertGeminiConfigured } from '@/lib/ai/gemini';
import { holdsRubricSeat } from '@/lib/auth/permissions';
import { rewriteStatement } from '@/lib/engines/rewrite';
import { forbidden, ServiceError } from '@/lib/services/errors';
import { getVisibleSubmission, readSource } from '@/lib/services/submissions';

/**
 * Polish / Harden / Fix-lint for one seat. Synchronous and interactive: the
 * creator is waiting, so this call takes the reserved slot. Nothing is saved;
 * the editor applies the proposal through the normal autosave.
 */
const Body = z.object({
  statement: z.string().trim().min(1).max(600),
  tag: z.enum(RUBRIC_TAGS),
  mode: z.enum(['polish', 'harden', 'lint']),
  lintReasons: z.array(z.string().max(300)).max(10).default([]),
});

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  try {
    assertGeminiConfigured();
  } catch (error) {
    throw new ServiceError(503, error instanceof Error ? error.message : 'The writing model is not configured on this server (GEMINI_API_KEY).');
  }
  const submission = await getVisibleSubmission(db(), actor, params['id']!);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  const source = readSource(submission);
  const taskContext = source ? source.fields.map((f) => `${f.label}: ${f.text}`).join('\n') : submission.title;
  const result = await rewriteStatement({ ...body, taskContext });
  return { proposal: result.proposal, rationale: result.rationale, lint: result.lint, changed: result.changed };
});

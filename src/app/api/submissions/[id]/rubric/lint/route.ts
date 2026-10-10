import { z } from 'zod';
import { db } from '@/db/client';
import { route } from '@/lib/api';
import { assertGeminiConfigured } from '@/lib/ai/gemini';
import { holdsRubricSeat } from '@/lib/auth/permissions';
import { aiLint } from '@/lib/engines/rubricFactory';
import { forbidden, ServiceError } from '@/lib/services/errors';
import { currentRubric, persistLint, statementsOf } from '@/lib/services/rubric';
import { getVisibleSubmission, readSource } from '@/lib/services/submissions';

/**
 * "Check wording": runs the 8-attribute LLM lint on the given statements
 * (default: every statement that has not been AI-linted at its current
 * wording) and stores the verdicts. Synchronous; at most 60 statements
 * (4 chunks) per call so the request stays interactive.
 */
const Body = z.object({ statementIds: z.array(z.string().uuid()).max(200).optional(), scope: z.enum(['all', 'unchecked']).default('unchecked') });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  try {
    assertGeminiConfigured();
  } catch (error) {
    throw new ServiceError(503, error instanceof Error ? error.message : 'The lint model is not configured on this server (GEMINI_API_KEY).');
  }
  const database = db();
  const submission = await getVisibleSubmission(database, actor, params['id']!);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  const rubric = await currentRubric(database, submission.id);
  if (!rubric) return { checked: 0, results: {} };
  const all = await statementsOf(database, rubric.id);
  let targets = body.statementIds ? all.filter((s) => body.statementIds!.includes(s.id)) : all;
  if (!body.statementIds && body.scope === 'unchecked') targets = targets.filter((s) => (s.lint as { source?: string } | null)?.source !== 'ai');
  targets = targets.slice(0, 60);
  if (targets.length === 0) return { checked: 0, results: {} };

  const source = readSource(submission);
  const taskContext = source ? source.fields.map((f) => `${f.label}: ${f.text}`).join('\n') : submission.title;
  const linted = await aiLint({ taskContext, statements: targets.map((s) => ({ id: s.id, statement: s.statement, tag: s.tag })) });
  const toPersist: Record<string, { lint: (typeof linted.results)[string]; statement: string }> = {};
  for (const s of targets) if (linted.results[s.id]) toPersist[s.id] = { lint: linted.results[s.id]!, statement: s.statement };
  const written = await persistLint(actor, submission.id, toPersist);
  return { checked: written, requested: targets.length, results: linted.results, failures: Object.values(linted.results).filter((r) => r.overall === 'fail').length };
});

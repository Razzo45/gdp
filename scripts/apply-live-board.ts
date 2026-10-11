import './railway-target';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissions, type HandoffStatus, type ReviewStatus, type Stage } from '@/db/schema';
import { workStateOf } from '@/domain/workState';

/**
 * Retags Railway stages to the live GDP board the operator confirmed.
 * Never writes live Catalog / Supabase.
 *
 *   npx railway run --service Postgres -- npx tsx --conditions=react-server scripts/apply-live-board.ts
 *   npx railway run --service Postgres -- npx tsx --conditions=react-server scripts/apply-live-board.ts --apply
 */

const PREPARING = ['60dcd5ca', '80ba20f0', 'ba0e8353', '93a8a4cc', '54fd7011', 'c616faf6', '8a0c38c4', '1aca51c9', 'e062bda1'];
const IN_REVIEW = ['27f6a0de', '5752d2eb', '28bb831c'];
const REVIEW_RETURNED = ['7f1b0b44'];
const SUBMITTED = ['01c420db', '227841fd', '4929aa3e', '4e0409d0', '4e2f906b', '54d0b3ff', '868afbd1', '87a77f60', '966ebd18', 'a002e716', 'af1c7423', 'bf7722e4', 'dd823796'];

type Next = { stage: Stage; reviewStatus: ReviewStatus | null; handoffStatus: HandoffStatus | null };

function nextOf(catalogId: string): Next {
  const prefix = catalogId.slice(0, 8);
  if (SUBMITTED.includes(prefix)) return { stage: 'done', reviewStatus: 'approved', handoffStatus: 'client_visible' };
  if (IN_REVIEW.includes(prefix)) return { stage: 'review', reviewStatus: 'pending', handoffStatus: null };
  if (REVIEW_RETURNED.includes(prefix)) return { stage: 'rubric', reviewStatus: 'changes_requested', handoffStatus: null };
  if (PREPARING.includes(prefix)) return { stage: 'rubric', reviewStatus: null, handoffStatus: null };
  return { stage: 'parked', reviewStatus: null, handoffStatus: null };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const database = db();
  const rows = await database.select().from(submissions);
  const board: Record<string, number> = {};
  let changed = 0;
  for (const row of rows) {
    const next = nextOf(row.catalogSubmissionId);
    const preview = { ...row, ...next };
    const label = workStateOf(preview);
    board[label] = (board[label] ?? 0) + 1;
    const same = row.stage === next.stage && row.reviewStatus === next.reviewStatus && row.handoffStatus === next.handoffStatus;
    if (same) continue;
    changed += 1;
    console.log(`${row.catalogSubmissionId.slice(0, 8)} ${row.title.slice(0, 40) || '(no title)'}  ${workStateOf(row)} → ${label}`);
    if (!apply) continue;
    await database
      .update(submissions)
      .set({ stage: next.stage, reviewStatus: next.reviewStatus, handoffStatus: next.handoffStatus })
      .where(eq(submissions.id, row.id));
  }
  console.log(`${apply ? 'Wrote' : 'Would update'} ${changed} / ${rows.length}`);
  console.log('Board', board);
  if (!apply) console.log('Re-run with --apply to write Railway only.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

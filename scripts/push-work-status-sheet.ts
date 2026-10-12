import './env';
import { db } from '@/db/client';
import { submissions } from '@/db/schema';
import { workStateOf } from '@/domain/workState';
import { env } from '@/lib/env';
import { writeWorkStatusSheetMany } from '@/lib/sheets/workStatus';

/**
 * First populate of Status Rubrics after cutover.
 *
 *   npx tsx --conditions=react-server scripts/push-work-status-sheet.ts
 *   npx tsx --conditions=react-server scripts/push-work-status-sheet.ts --apply
 *
 * Requires SHEETS_SYNC=1 and GOOGLE_SHEETS_CREDENTIALS. Never appends rows.
 */

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (env().SHEETS_SYNC !== '1') {
    throw new Error('SHEETS_SYNC must be 1. Leave it off until users are on this platform.');
  }
  const rows = await db()
    .select({
      catalogSubmissionId: submissions.catalogSubmissionId,
      stage: submissions.stage,
      rubricAssigneeId: submissions.rubricAssigneeId,
      reviewStatus: submissions.reviewStatus,
      handoffStatus: submissions.handoffStatus,
    })
    .from(submissions);
  const items = rows.map((row) => ({ catalogSubmissionId: row.catalogSubmissionId, state: workStateOf(row) }));
  console.log(`GDP tasks ${items.length}${apply ? '' : ' (dry-run)'}`);
  if (!apply) {
    console.log('Re-run with --apply after cutover to write Status Rubrics on rows that already have a Task ID.');
    return;
  }
  const result = await writeWorkStatusSheetMany(items);
  console.log(`updated=${result.updated} skipped=${result.skipped} (no Task ID on the sheet)`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

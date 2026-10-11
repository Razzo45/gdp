import './env';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { rubrics, submissions } from '@/db/schema';
import { factoryStatementsFromLegacy, latestLegacyRun, seedsFromLegacy } from '@/domain/legacyImport';
import { installFactoryVersion } from '@/lib/services/rubric';

const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

function load(name: string): Record<string, unknown>[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(parsed) ? parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const database = db();
  const neon = await database.select().from(submissions);
  const current = await database.select().from(rubrics).where(eq(rubrics.isCurrent, true));
  const currentBySub = new Map(current.map((row) => [row.submissionId, row]));
  const live = load('public.wirestock_submissions.json');
  const runs = load('public.wirestock_rubric_runs.json');
  const runsByInternal = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) {
    const id = str(run, 'submission_id');
    const list = runsByInternal.get(id) ?? [];
    list.push(run);
    runsByInternal.set(id, list);
  }
  const catalogToInternal = new Map(live.map((row) => [str(row, 'submission_id'), str(row, 'id')]));

  let bind = 0;
  let installed = 0;
  for (const sub of neon) {
    let rubric = currentBySub.get(sub.id);
    if (!rubric) {
      const internal = catalogToInternal.get(sub.catalogSubmissionId);
      const latest = internal ? latestLegacyRun(runsByInternal.get(internal) ?? []) : null;
      const statements = latest ? factoryStatementsFromLegacy(latest['rows']) : [];
      if (apply && statements.length) {
        rubric = await installFactoryVersion(database, sub.id, null, {
          seeds: latest ? seedsFromLegacy(latest) : [],
          statements,
          generation: { provenance: 'legacy-snapshot', catalogId: sub.catalogSubmissionId, statements: statements.length, recovered: true },
        });
        currentBySub.set(sub.id, rubric);
        installed += 1;
        console.log(`installed rubric ${rubric.id} on ${sub.catalogSubmissionId.slice(0, 8)} (${statements.length} seats)`);
      } else if (statements.length) {
        installed += 1;
        console.log(`would install ${statements.length} seats on ${sub.catalogSubmissionId.slice(0, 8)}`);
      }
    }
    if (!rubric) continue;
    const needsBind =
      sub.reviewRubricId !== rubric.id &&
      (sub.stage === 'review' || sub.reviewStatus === 'pending' || sub.reviewStatus === 'approved' || sub.reviewStatus === 'changes_requested');
    if (!needsBind) continue;
    bind += 1;
    console.log(`bind reviewRubricId ${sub.catalogSubmissionId.slice(0, 8)} ${sub.reviewRubricId ?? 'null'} → ${rubric.id} (${sub.stage}/${sub.reviewStatus})`);
    if (apply) {
      await database.update(submissions).set({ reviewRubricId: rubric.id }).where(and(eq(submissions.id, sub.id)));
    }
  }

  console.log(`${apply ? 'Wrote' : 'Would write'} recoveredRubrics=${installed} reviewBinds=${bind}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

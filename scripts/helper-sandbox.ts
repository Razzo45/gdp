import './helper-sandbox-env';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { migrate } from '@/db/migrate';
import {
  aiOutputFiles,
  goldenRatings,
  jobs,
  profiles,
  rubricStatements,
  rubrics,
  stabilityPasses,
  submissions,
  userRoles,
  type Family,
} from '@/db/schema';
import { statementHash } from '@/domain/fingerprint';
import { packHelperResult, type HelperDraft, type HelperSeatInput } from '@/domain/helper';
import { seatedRubricInputs } from '../test/helpers/db';

const CATALOG_ID = 'helper-sandbox';
const ANA = { id: '11111111-1111-4111-8111-111111111111', email: 'ana@gdp.local', name: 'Ana (creator)' };
const PROMPT =
  'Deliver a 16:9 staff deck about the new access card. The spoken narration states that Westbridge is introducing a new employee access card.';

function familyOf(tag: string): Family {
  if (tag.startsWith('Format')) return 'format';
  if (tag.startsWith('Content')) return 'content';
  return 'visual';
}

async function seed(): Promise<string> {
  const database = db();
  await migrate(database);

  await database.insert(profiles).values({ id: ANA.id, email: ANA.email, displayName: ANA.name, isActive: true }).onConflictDoUpdate({
    target: profiles.id,
    set: { email: ANA.email, displayName: ANA.name, isActive: true },
  });
  await database.delete(userRoles).where(eq(userRoles.userId, ANA.id));
  await database.insert(userRoles).values({ userId: ANA.id, role: 'rubric_creator' });

  const existing = await database.select({ id: submissions.id }).from(submissions);
  for (const row of existing) {
    await database.delete(submissions).where(eq(submissions.id, row.id));
  }

  const source = {
    submission: {
      projectId: 'sandbox',
      projectSubmissionId: CATALOG_ID,
      submission: { prompt: PROMPT },
      files: [],
    },
    project: { projectId: 'sandbox', name: 'Helper sandbox' },
  };
  const [task] = await database
    .insert(submissions)
    .values({
      catalogSubmissionId: CATALOG_ID,
      projectId: 'sandbox',
      title: 'Westbridge access-card deck',
      source,
      sourceFingerprint: 'helper-sandbox',
      stage: 'rubric',
      rubricAssigneeId: ANA.id,
      rubricClaimedAt: new Date().toISOString(),
      lastClaimedAt: new Date().toISOString(),
    })
    .returning();
  if (!task) throw new Error('Could not create the sandbox task.');

  const [rubric] = await database.insert(rubrics).values({ submissionId: task.id, version: 1, isCurrent: true, createdBy: ANA.id }).returning();
  if (!rubric) throw new Error('Could not create the sandbox rubric.');

  const upserts = seatedRubricInputs();
  upserts[0] = { ...upserts[0]!, statement: 'The delivered presentation uses a 16:9 page size.' };
  upserts[5] = { ...upserts[5]!, tag: 'Content - Exact', statement: 'The title names the client.' };
  upserts[6] = { ...upserts[6]!, statement: 'The deck names the rollout date in the opening.' };
  upserts[20] = {
    ...upserts[20]!,
    statement:
      'Every text box, chart, shape, and image across all slides in the delivered presentation is positioned entirely within the 16:9 slide canvas boundaries.',
  };
  upserts[21] = { ...upserts[21]!, statement: 'The logo sits inside the title-safe margin on every slide.' };

  const seated = await database
    .insert(rubricStatements)
    .values(
      upserts.map((row, position) => ({
        rubricId: rubric.id,
        position,
        family: familyOf(row.tag),
        tag: row.tag,
        statement: row.statement,
        notes: '',
        scope: 'output' as const,
        inputFileIds: [],
        outputFile: null,
        origin: 'manual' as const,
        updatedBy: ANA.id,
      })),
    )
    .returning();

  const byStatement = new Map(seated.map((row) => [row.statement, row]));
  const title = byStatement.get('The title names the client.')!;
  const date = byStatement.get('The deck names the rollout date in the opening.')!;
  const canvas = byStatement.get(upserts[20]!.statement)!;
  const logo = byStatement.get('The logo sits inside the title-safe margin on every slide.')!;

  await database.insert(goldenRatings).values(
    seated.map((row) => {
      const fail = row.id === logo.id;
      return {
        rubricId: rubric.id,
        statementId: row.id,
        source: 'ai' as const,
        verdict: !fail,
        evidence: fail ? 'The logo sits off the slide on the title.' : 'Present on the Golden deck.',
        basis: { statementHash: statementHash(row) },
        model: 'sandbox',
      };
    }),
  );

  const groupId = crypto.randomUUID();
  const passes = [1, 2, 3].map((passIndex) => {
    const answers: Record<string, boolean | null> = {};
    const evidence: Record<string, string> = {};
    for (const row of seated) {
      if (row.id === logo.id) answers[row.id] = false;
      else if (row.id === date.id) answers[row.id] = passIndex !== 2;
      else answers[row.id] = true;
      evidence[row.id] = answers[row.id] ? 'Held on this pass.' : 'Missed on this pass.';
    }
    return { rubricId: rubric.id, groupId, passIndex, answers, evidence, errors: {}, scorePercent: 90, model: 'sandbox', basis: {} };
  });
  await database.insert(stabilityPasses).values(passes);

  await database.insert(aiOutputFiles).values({
    submissionId: task.id,
    name: 'westbridge-ai.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 2048,
    sha256: 'helper-sandbox-ai',
    storagePath: `sandbox/${task.id}/westbridge-ai.pptx`,
    uploadedBy: ANA.id,
  });

  const seats: HelperSeatInput[] = seated.map((row) => ({
    id: row.id,
    statement: row.statement,
    tag: row.tag,
    family: row.family,
    golden: row.id === logo.id ? false : true,
    goldenEvidence: row.id === logo.id ? 'The logo sits off the slide on the title.' : undefined,
    stability: passes.map((pass) => pass.answers[row.id] ?? null),
  }));
  const drafts: HelperDraft[] = [
    {
      seatId: logo.id,
      statement: 'The title-slide wordmark stays inside the title-safe area.',
      tag: 'Visual - Layout',
      grounding: 'craft:slides-title-safe',
      golden: true,
      ai: false,
      evidence: 'The brief requires a 16:9 staff deck.',
    },
    {
      statement: 'The spoken narration states that Westbridge is introducing a new employee access card.',
      tag: 'Content - Semantics',
      grounding: 'prompt',
      golden: true,
      ai: false,
      evidence: 'Named in the task prompt.',
    },
  ];
  const packed = packHelperResult({ seats, prompt: PROMPT, inputRoles: ['brand guidelines'], drafts });
  await database.insert(jobs).values({
    kind: 'rubric_helper',
    submissionId: task.id,
    rubricId: rubric.id,
    requestId: crypto.randomUUID(),
    payload: {},
    status: 'succeeded',
    result: packed,
    finishedAt: new Date().toISOString(),
    createdBy: ANA.id,
  });

  void title;
  void canvas;
  return task.id;
}

function sourceDatabaseUrl(): string {
  const url = process.env['GDP_SOURCE_DATABASE_URL'] ?? '';
  if (!url) throw new Error('No Railway/Neon DATABASE_URL in .env.local to copy from.');
  if (/supabase\.(co|com)/i.test(url)) throw new Error('Refusing to read live Supabase. Copy from Railway/Neon only.');
  return url;
}

async function copyFromSource(prefix?: string): Promise<string> {
  const postgres = (await import('postgres')).default;
  const sql = postgres(sourceDatabaseUrl(), { prepare: false, max: 1, connect_timeout: 20 });
  try {
    const like = prefix ? `${prefix}%` : '%';
    const candidates = await sql<{
      id: string;
      catalog: string;
      title: string;
      stage: string;
      seats: number;
      golden: number;
      golden_no: number;
      passes: number;
      ai_files: number;
      last_score: number | null;
    }[]>`
      select s.id, s.catalog_submission_id::text as catalog, s.title, s.stage,
             count(distinct st.id)::int as seats,
             count(distinct g.id) filter (where g.verdict is not null)::int as golden,
             count(distinct g.id) filter (where g.verdict = false)::int as golden_no,
             count(distinct p.id)::int as passes,
             count(distinct a.id)::int as ai_files,
             (
               select p2.score_percent
               from app.stability_passes p2
               where p2.rubric_id = r.id
               order by p2.created_at desc
               limit 1
             ) as last_score
      from app.submissions s
      join app.rubrics r on r.submission_id = s.id and r.is_current
      left join app.rubric_statements st on st.rubric_id = r.id
      left join app.golden_ratings g on g.rubric_id = r.id
      left join app.stability_passes p on p.rubric_id = r.id
      left join app.ai_output_files a on a.submission_id = s.id and a.removed_at is null
      where s.catalog_submission_id::text like ${like}
      group by s.id, r.id
      having count(distinct st.id) >= 10
         and count(distinct g.id) filter (where g.verdict is not null) >= 1
         and count(distinct p.id) >= 3
         and count(distinct a.id) >= 1
      order by (count(distinct g.id) filter (where g.verdict = false)) desc,
               coalesce((
                 select p2.score_percent from app.stability_passes p2
                 where p2.rubric_id = r.id order by p2.created_at desc limit 1
               ), 0) desc
      limit 8
    `;
    if (candidates.length === 0) throw new Error(prefix ? `No helper-ready task matching ${prefix}.` : 'No helper-ready task on Railway/Neon (need rubric + Golden + AI pack grade + AI file).');
    const picked = candidates[0]!;
    const [task] = await sql<Record<string, unknown>[]>`select * from app.submissions where id = ${picked.id}`;
    if (!task) throw new Error('Task vanished while copying.');
    const [rubric] = await sql<Record<string, unknown>[]>`select * from app.rubrics where submission_id = ${picked.id} and is_current`;
    if (!rubric) throw new Error('No current rubric on that task.');
    const statements = await sql<Record<string, unknown>[]>`select * from app.rubric_statements where rubric_id = ${rubric.id} order by position`;
    const golden = await sql<Record<string, unknown>[]>`select * from app.golden_ratings where rubric_id = ${rubric.id}`;
    const [latestPass] = await sql<{ group_id: string }[]>`
      select group_id from app.stability_passes where rubric_id = ${rubric.id} order by created_at desc limit 1
    `;
    const passes = latestPass
      ? await sql<Record<string, unknown>[]>`select * from app.stability_passes where group_id = ${latestPass.group_id} order by pass_index`
      : [];
    const files = await sql<Record<string, unknown>[]>`
      select * from app.ai_output_files where submission_id = ${picked.id} and removed_at is null
    `;

    const database = db();
    await migrate(database);
    await database.insert(profiles).values({ id: ANA.id, email: ANA.email, displayName: ANA.name, isActive: true }).onConflictDoUpdate({
      target: profiles.id,
      set: { email: ANA.email, displayName: ANA.name, isActive: true },
    });
    await database.delete(userRoles).where(eq(userRoles.userId, ANA.id));
    await database.insert(userRoles).values({ userId: ANA.id, role: 'rubric_creator' });
    for (const row of await database.select({ id: submissions.id }).from(submissions)) {
      await database.delete(submissions).where(eq(submissions.id, row.id));
    }

    await database.insert(submissions).values({
      id: String(task.id),
      catalogSubmissionId: String(task.catalog_submission_id),
      projectId: String(task.project_id),
      statusId: task.status_id ? String(task.status_id) : null,
      title: String(task.title ?? picked.title),
      source: (task.source ?? {}) as Record<string, unknown>,
      sourceFingerprint: String(task.source_fingerprint ?? `copy:${picked.catalog}`),
      stage: 'rubric',
      rubricAssigneeId: ANA.id,
      rubricClaimedAt: new Date().toISOString(),
      lastClaimedAt: new Date().toISOString(),
      reviewerId: null,
      reviewStatus: null,
      handoffStatus: null,
    });
    await database.insert(rubrics).values({
      id: String(rubric.id),
      submissionId: String(task.id),
      version: Number(rubric.version ?? 1),
      revision: Number(rubric.revision ?? 0),
      seeds: (rubric.seeds as string[]) ?? [],
      generation: (rubric.generation as Record<string, unknown>) ?? {},
      isCurrent: true,
      createdBy: ANA.id,
    });
    if (statements.length) {
      await database.insert(rubricStatements).values(
        statements.map((row) => ({
          id: String(row.id),
          rubricId: String(rubric.id),
          position: Number(row.position),
          family: row.family as 'format' | 'content' | 'visual',
          tag: String(row.tag),
          statement: String(row.statement),
          notes: String(row.notes ?? ''),
          scope: (row.scope === 'inputs' ? 'inputs' : 'output') as 'output' | 'inputs',
          inputFileIds: (row.input_file_ids as string[]) ?? [],
          outputFile: row.output_file ? String(row.output_file) : null,
          claimKey: row.claim_key ? String(row.claim_key) : null,
          origin: (['factory', 'bank', 'manual', 'import'].includes(String(row.origin)) ? row.origin : 'manual') as 'factory' | 'bank' | 'manual' | 'import',
          lint: (row.lint as Record<string, unknown>) ?? null,
          updatedBy: ANA.id,
        })),
      );
    }
    if (golden.length) {
      await database.insert(goldenRatings).values(
        golden.map((row) => ({
          id: String(row.id),
          rubricId: String(rubric.id),
          statementId: String(row.statement_id),
          jobId: null,
          source: row.source === 'human' ? 'human' : 'ai',
          verdict: typeof row.verdict === 'boolean' ? row.verdict : null,
          evidence: String(row.evidence ?? ''),
          error: row.error ? String(row.error) : null,
          reason: row.reason ? String(row.reason) : null,
          model: row.model ? String(row.model) : null,
          basis: (row.basis as Record<string, unknown>) ?? {},
          createdBy: ANA.id,
        })),
      );
    }
    if (passes.length) {
      await database.insert(stabilityPasses).values(
        passes.map((row) => ({
          id: String(row.id),
          rubricId: String(rubric.id),
          groupId: String(row.group_id),
          jobId: null,
          passIndex: Number(row.pass_index),
          answers: (row.answers as Record<string, boolean | null>) ?? {},
          evidence: (row.evidence as Record<string, string>) ?? {},
          errors: (row.errors as Record<string, string>) ?? {},
          scorePercent: row.score_percent == null ? null : Number(row.score_percent),
          model: row.model ? String(row.model) : null,
          basis: (row.basis as Record<string, unknown>) ?? {},
        })),
      );
    }
    if (files.length) {
      await database.insert(aiOutputFiles).values(
        files.map((row) => ({
          id: String(row.id),
          submissionId: String(task.id),
          name: String(row.name),
          mime: String(row.mime ?? 'application/octet-stream'),
          size: Number(row.size ?? 1),
          sha256: String(row.sha256 ?? `copy:${row.id}`),
          storagePath: String(row.storage_path ?? `sandbox/${task.id}/${row.name}`),
          uploadedBy: ANA.id,
        })),
      );
    }

    console.log('Copied a read-only snapshot into the helper sandbox (not writing Railway).');
    console.log(
      `${picked.title} · ${picked.catalog.slice(0, 8)} · ${picked.seats} seats · Golden Nos ${picked.golden_no}/${picked.golden} · AI pack ${picked.passes} passes${picked.last_score != null ? ` @ ${Math.round(picked.last_score)}%` : ''} · ${picked.ai_files} AI file(s)`,
    );
    if (candidates.length > 1) {
      console.log(
        'Other helper-ready copies:',
        candidates
          .slice(1)
          .map((row) => `${row.catalog.slice(0, 8)} (${row.golden_no} Golden Nos)`)
          .join(', '),
      );
    }
    return String(task.id);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function serve(): void {
  const child = spawn('npx', ['next', 'dev', '--port', '3000'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env },
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const serveOnly = process.argv.includes('--serve-only');
  const fromAt = process.argv.indexOf('--from');
  const prefix = fromAt >= 0 && process.argv[fromAt + 1] && !process.argv[fromAt + 1]!.startsWith('--') ? process.argv[fromAt + 1] : undefined;
  if (!serveOnly) {
    const id = fromAt >= 0 ? await copyFromSource(prefix) : await seed();
    console.log(`http://localhost:3000/submissions/${id}`);
  }
  console.log('Helper sandbox is a writable PGlite file outside the repo (not Railway).');
  console.log(`Sign in as ${ANA.email} / gdp-dev`);
  if (serveOnly || process.argv.includes('--serve')) serve();
  else process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

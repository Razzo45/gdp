import postgres from 'postgres';

/**
 * Railway-only: keep the latest run and the two before it.
 * Rubric versions, golden autorates, calibrations, stability groups,
 * review decisions, finished jobs. Never writes to Neon or Supabase.
 *
 *   npx railway run --service Postgres -- npx tsx scripts/prune-railway-history.ts --apply
 */

const KEEP = 3;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid)';
  }
}

function railwayUrl(): string {
  const host = process.env['PGHOST_PUBLIC']?.trim();
  const port = process.env['PGPORT_PUBLIC']?.trim();
  const user = process.env['PGUSER']?.trim();
  const password = process.env['PGPASSWORD'] ?? '';
  const database = process.env['PGDATABASE']?.trim() || 'railway';
  if (!host || !port || !user) throw new Error('Run via `railway run --service Postgres`.');
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
  if (/supabase\.(co|com)|neon\.tech/i.test(hostOf(url))) throw new Error(`Refusing unexpected host ${hostOf(url)}`);
  if (!/rlwy\.net|railway\.(internal|app)/i.test(hostOf(url))) throw new Error(`Not Railway (${hostOf(url)})`);
  return url;
}

async function count(sql: postgres.Sql, table: string): Promise<number> {
  const rows = await sql.unsafe(`select count(*)::int as n from app.${table}`);
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sql = postgres(railwayUrl(), { max: 1, prepare: false, ssl: 'require', connection: { application_name: 'gdp-prune-runs' } });
  try {
    const before = {
      rubrics: await count(sql, 'rubrics'),
      statements: await count(sql, 'rubric_statements'),
      goldens: await count(sql, 'golden_ratings'),
      calibrations: await count(sql, 'calibrations'),
      passes: await count(sql, 'stability_passes'),
      acceptances: await count(sql, 'stability_acceptances'),
      flips: await count(sql, 'stability_flip_notes'),
      feedback: await count(sql, 'review_feedback'),
      jobs: await count(sql, 'jobs'),
      submissions: await count(sql, 'submissions'),
    };
    console.log(`Railway ${hostOf(railwayUrl())} keep=${KEEP}${apply ? '' : ' (dry-run)'}`);
    console.log('before', before);

    const plan = await sql.begin(async (tx) => {
      const droppedSubs = await tx`
        with historical as (
          select id, row_number() over (order by coalesce(pushed_at, last_seen_at, created_at) desc) as rn
          from app.submissions
          where stage in ('done', 'handoff', 'parked')
        ),
        keep as (
          select id from app.submissions where stage in ('rubric', 'review', 'stability')
          union all
          select id from historical where rn <= ${KEEP}
        )
        delete from app.submissions s
        where not exists (select 1 from keep k where k.id = s.id)
        returning s.id
      `;

      const droppedRubrics = await tx`
        with ranked as (
          select id, row_number() over (partition by submission_id order by version desc) as rn
          from app.rubrics
        )
        delete from app.rubrics r
        using ranked
        where r.id = ranked.id and ranked.rn > ${KEEP}
        returning r.id
      `;

      const droppedGoldAi = await tx`
        with ranked_jobs as (
          select rubric_id, coalesce(job_id, id) as run_id, max(created_at) as seen
          from app.golden_ratings
          where source = 'ai'
          group by rubric_id, coalesce(job_id, id)
        ),
        numbered as (
          select rubric_id, run_id, dense_rank() over (partition by rubric_id order by seen desc) as rn
          from ranked_jobs
        )
        delete from app.golden_ratings g
        using numbered n
        where g.source = 'ai' and g.rubric_id = n.rubric_id and coalesce(g.job_id, g.id) = n.run_id and n.rn > ${KEEP}
        returning g.id
      `;

      const droppedGoldHuman = await tx`
        with numbered as (
          select id, row_number() over (partition by rubric_id, statement_id order by created_at desc) as rn
          from app.golden_ratings
          where source = 'human'
        )
        delete from app.golden_ratings g
        using numbered n
        where g.id = n.id and n.rn > ${KEEP}
        returning g.id
      `;

      const droppedCals = await tx`
        with numbered as (
          select id, row_number() over (partition by rubric_id order by created_at desc) as rn
          from app.calibrations
        )
        delete from app.calibrations c
        using numbered n
        where c.id = n.id and n.rn > ${KEEP}
        returning c.id
      `;

      const oldGroups = await tx`
        with ranked as (
          select rubric_id, group_id, max(created_at) as seen
          from app.stability_passes
          group by rubric_id, group_id
        ),
        numbered as (
          select rubric_id, group_id, dense_rank() over (partition by rubric_id order by seen desc) as rn
          from ranked
        )
        select group_id from numbered where rn > ${KEEP}
      `;
      const groupIds = oldGroups.map((row) => row.group_id);
      let droppedFlips = 0;
      let droppedAccept = 0;
      let droppedPasses = 0;
      if (groupIds.length) {
        droppedFlips = (await tx`delete from app.stability_flip_notes where group_id in ${tx(groupIds)} returning id`).length;
        droppedAccept = (await tx`delete from app.stability_acceptances where group_id in ${tx(groupIds)} returning id`).length;
        droppedPasses = (await tx`delete from app.stability_passes where group_id in ${tx(groupIds)} returning id`).length;
      }

      const droppedFeedback = await tx`
        with numbered as (
          select id, row_number() over (partition by submission_id order by created_at desc) as rn
          from app.review_feedback
        )
        delete from app.review_feedback f
        using numbered n
        where f.id = n.id and n.rn > ${KEEP}
        returning f.id
      `;

      const droppedJobs = await tx`
        with numbered as (
          select id, row_number() over (partition by submission_id, kind order by coalesce(finished_at, created_at) desc) as rn
          from app.jobs
          where status in ('succeeded', 'failed', 'cancelled')
        )
        delete from app.jobs j
        using numbered n
        where j.id = n.id and n.rn > ${KEEP}
        returning j.id
      `;

      const summary = {
        submissions: droppedSubs.length,
        rubrics: droppedRubrics.length,
        goldAi: droppedGoldAi.length,
        goldHuman: droppedGoldHuman.length,
        calibrations: droppedCals.length,
        stabilityGroups: groupIds.length,
        flips: droppedFlips,
        acceptances: droppedAccept,
        passes: droppedPasses,
        feedback: droppedFeedback.length,
        jobs: droppedJobs.length,
      };
      if (!apply) {
        throw Object.assign(new Error('dry-run'), { dryRun: true, summary });
      }
      return summary;
    });

    console.log('dropped', plan);
    console.log('after', {
      rubrics: await count(sql, 'rubrics'),
      statements: await count(sql, 'rubric_statements'),
      goldens: await count(sql, 'golden_ratings'),
      calibrations: await count(sql, 'calibrations'),
      passes: await count(sql, 'stability_passes'),
      acceptances: await count(sql, 'stability_acceptances'),
      flips: await count(sql, 'stability_flip_notes'),
      feedback: await count(sql, 'review_feedback'),
      jobs: await count(sql, 'jobs'),
      submissions: await count(sql, 'submissions'),
    });
  } catch (error) {
    if (error instanceof Error && 'dryRun' in error) {
      console.log('would drop', 'summary' in error ? (error as { summary: unknown }).summary : error);
      console.log('Re-run with --apply to keep latest + 2 previous runs.');
      return;
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

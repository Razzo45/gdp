import './env';
import { signLocalSession } from '../src/lib/auth/local';

/**
 * Fire Golden and/or Stability on a few live tasks at once, through the
 * production HTTP API (real worker, real Gemini). Overwrites those tasks'
 * scores. Does not touch live Supabase.
 *
 * Discover candidates (Railway Postgres):
 *   npx @railway/cli run --service Postgres -- npx tsx scripts/load-autorate.ts --discover
 *
 * Run as the gdp service so AUTH_LOCAL_SECRET is present:
 *   npx @railway/cli run --service gdp -- npx tsx scripts/load-autorate.ts --ids <uuid-or-catalog> --mint --user-id <admin-uuid> --email <admin@...>
 *
 * Or sign in with a password:
 *   npx tsx scripts/load-autorate.ts --ids <id> --email you@... --password ...
 *
 * --kinds golden,stability (default both). Starts every selected kind on
 * every id at the same moment. When AUTH_LOCAL_SECRET is set, each POST
 * uses that task's rubric assignee cookie if they have one.
 */

const DEFAULT_BASE = 'https://gdp-production-83d5.up.railway.app';
const KINDS = ['golden', 'stability'] as const;
type Kind = (typeof KINDS)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseKinds(raw: string | undefined): Kind[] {
  const wanted = (raw ?? 'golden,stability')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const kinds = KINDS.filter((k) => wanted.includes(k));
  if (!kinds.length) throw new Error('Use --kinds golden and/or stability.');
  return kinds;
}

function parseIds(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('Pass --ids as comma-separated GDP uuids or Catalog prefixes.');
  return [...new Set(ids)];
}

async function discover(): Promise<void> {
  await import('./railway-target');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Run --discover via `npx @railway/cli run --service Postgres`.');
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  try {
    const admins = await sql<{ id: string; email: string }[]>`
      select p.id, p.email
      from app.profiles p
      join app.user_roles r on r.user_id = p.id
      where r.role = 'admin' and p.is_active
      order by p.email
    `;
    const rows = await sql<
      {
        id: string;
        catalog: string;
        title: string;
        stage: string;
        assignee: string | null;
        seats: number;
        ai: number;
      }[]
    >`
      select
        s.id,
        s.catalog_submission_id as catalog,
        left(s.title, 80) as title,
        s.stage,
        coalesce(p.email, '') as assignee,
        (
          select count(*)::int
          from app.rubric_statements st
          join app.rubrics rub on rub.id = st.rubric_id
          where rub.submission_id = s.id and rub.is_current
        ) as seats,
        (
          select count(*)::int
          from app.ai_output_files a
          where a.submission_id = s.id and a.removed_at is null
        ) as ai
      from app.submissions s
      left join app.profiles p on p.id = s.rubric_assignee_id
      where s.stage in ('rubric', 'review', 'stability', 'handoff')
      order by s.last_seen_at desc
      limit 24
    `;
    console.log('admins');
    for (const row of admins) console.log(`  ${row.id}  ${row.email}`);
    console.log('tasks  (prefer seats>0; add stability only when ai>0)');
    for (const row of rows) {
      console.log(`  ${row.id}  ${row.catalog.slice(0, 8)}  ${row.stage}  seats=${row.seats}  ai=${row.ai}  ${row.assignee || 'unassigned'}  ${row.title}`);
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

function makeApi(base: string, cookie: string): Api {
  return (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        cookie,
        ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
}

async function signIn(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`signin ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ') || (res.headers.get('set-cookie')?.split(';')[0] ?? '');
  if (!cookie) throw new Error('signin returned no cookie');
  return cookie;
}

async function mintCookie(user: { id: string; email: string }): Promise<string> {
  const secret = process.env['AUTH_LOCAL_SECRET'];
  if (!secret) throw new Error('AUTH_LOCAL_SECRET is missing. Run via `npx @railway/cli run --service gdp -- ... --mint`.');
  return `gdp_session=${await signLocalSession(user, secret)}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text || res.statusText };
  }
}

function catalogPrefix(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

type ListRow = { id: string; catalogSubmissionId?: string; title?: string };
type View = {
  submission: { id: string; catalogSubmissionId: string; title: string; stage: string; rubricAssigneeId: string | null };
  people: Record<string, { name: string; email: string }>;
  rubric: { statements: unknown[] } | null;
  aiOutputs: unknown[];
  golden?: { gate?: { percent?: number | null; ok?: boolean } } | null;
  stability?: { gate?: { scores?: number[] | null; complete?: boolean } } | null;
  jobs: { id: string; kind: string; status: string; error?: string | null }[];
};

async function resolveId(admin: Api, token: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return token;
  const listed = (await readJson(await admin('/api/submissions'))) as { submissions?: ListRow[] };
  const needle = token.replace(/-/g, '').toLowerCase();
  const match = (listed.submissions ?? []).find((row) => (row.catalogSubmissionId ?? '').replace(/-/g, '').toLowerCase().startsWith(needle) || row.id.replace(/-/g, '').toLowerCase().startsWith(needle));
  if (!match) throw new Error(`No visible task matches ${token}.`);
  return match.id;
}

async function waitJob(admin: Api, jobId: string, label: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const res = await admin(`/api/jobs/${jobId}`);
    const job = await readJson(res);
    const status = String(job.status ?? '');
    const progress = job.progress as { note?: string; done?: number; total?: number } | undefined;
    const elapsed = Math.round((Date.now() - started) / 1000);
    const frac = progress?.total ? `${progress.done ?? 0}/${progress.total}` : '';
    console.log(`${label}  ${status}  ${elapsed}s  ${frac}  ${progress?.note ?? ''}`.trim());
    if (status === 'succeeded') return job;
    if (status === 'failed' || status === 'cancelled') throw new Error(`${label} ${status}: ${job.error ?? ''}`);
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out after ${elapsed}s`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function run(): Promise<void> {
  const base = (arg('base') ?? process.env['PUBLIC_APP_URL'] ?? DEFAULT_BASE).replace(/\/$/, '');
  const kinds = parseKinds(arg('kinds'));
  const tokens = parseIds(arg('ids'));
  const email = (arg('email') ?? process.env['LOAD_AUTORATE_EMAIL'] ?? '').trim().toLowerCase();
  const password = arg('password') ?? process.env['LOAD_AUTORATE_PASSWORD'] ?? process.env['AUTH_LOCAL_PASSWORD'] ?? '';
  const userId = arg('user-id') ?? process.env['LOAD_AUTORATE_USER_ID'] ?? '';
  const mint = hasFlag('mint') || Boolean(process.env['AUTH_LOCAL_SECRET'] && userId && email);

  if (!email) throw new Error('Pass --email (admin) so we can see every task.');
  const adminCookie = mint ? await mintCookie({ id: userId, email }) : await signIn(base, email, password);
  const admin = makeApi(base, adminCookie);
  const probe = await admin('/api/submissions');
  if (!probe.ok) throw new Error(`auth failed ${probe.status} ${await probe.text()}`);

  const ids = [];
  for (const token of tokens) ids.push(await resolveId(admin, token));

  const secret = process.env['AUTH_LOCAL_SECRET'];
  const started: { label: string; jobId: string }[] = [];

  const launches = ids.flatMap((id) =>
    kinds.map(async (kind) => {
      const view = (await readJson(await admin(`/api/submissions/${id}`))) as View;
      const catalog = catalogPrefix(view.submission.catalogSubmissionId);
      const seats = view.rubric?.statements.length ?? 0;
      const ai = view.aiOutputs?.length ?? 0;
      if (kind === 'golden' && seats === 0) {
        console.log(`${catalog} skip golden — no statements`);
        return;
      }
      if (kind === 'stability' && (seats === 0 || ai === 0)) {
        console.log(`${catalog} skip stability — seats=${seats} ai=${ai}`);
        return;
      }
      const active = (view.jobs ?? []).filter((j) => j.kind === (kind === 'golden' ? 'golden_autorate' : 'stability_run') && (j.status === 'queued' || j.status === 'running'));
      for (const job of active) {
        const cancel = await admin(`/api/jobs/${job.id}`, { method: 'DELETE' });
        console.log(`${catalog} cancel ${job.kind} ${cancel.status}`);
      }
      const actorId = view.submission.rubricAssigneeId;
      const actor = actorId && view.people[actorId]?.email && secret ? { id: actorId, email: view.people[actorId]!.email } : { id: userId || actorId || '', email };
      const cookie = secret && actor.id ? await mintCookie(actor) : adminCookie;
      const path = kind === 'golden' ? `/api/submissions/${id}/golden` : `/api/submissions/${id}/stability`;
      const bodyOf = async (cookieToUse: string) => {
        const res = await makeApi(base, cookieToUse)(path, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) });
        return { res, body: await readJson(res) };
      };
      let used = actor.email;
      let { res, body } = await bodyOf(cookie);
      if (!res.ok && cookie !== adminCookie) {
        console.log(`${catalog} ${kind} as ${actor.email} ${res.status} — retry as admin`);
        used = email;
        ({ res, body } = await bodyOf(adminCookie));
      }
      if (!res.ok || typeof body.jobId !== 'string') throw new Error(`${catalog} ${kind} ${res.status} ${JSON.stringify(body)}`);
      const label = `${catalog} ${kind} as ${used}`;
      console.log(`${label} started ${body.jobId}`);
      started.push({ label, jobId: body.jobId });
    }),
  );

  await Promise.all(launches);
  if (!started.length) throw new Error('Nothing started.');

  const timeoutMs = 90 * 60_000;
  const settled = await Promise.allSettled(started.map((job) => waitJob(admin, job.jobId, job.label, timeoutMs)));
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') console.error(`${started[index]!.label} ${result.reason instanceof Error ? result.reason.message : result.reason}`);
  }

  console.log('results');
  for (const id of ids) {
    const view = (await readJson(await admin(`/api/submissions/${id}`))) as View;
    console.log(
      JSON.stringify({
        id: view.submission.id,
        catalog: catalogPrefix(view.submission.catalogSubmissionId),
        stage: view.submission.stage,
        golden: view.golden?.gate ?? null,
        stability: view.stability?.gate ?? null,
        jobs: (view.jobs ?? []).slice(0, 6).map((j) => ({ kind: j.kind, status: j.status, error: j.error })),
      }),
    );
  }
}

async function main(): Promise<void> {
  if (hasFlag('discover')) {
    await discover();
    return;
  }
  await run();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

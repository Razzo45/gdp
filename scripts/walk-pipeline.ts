import './env';
import { mockGradeYes } from '../src/lib/ai/standIn';

const BASE = 'http://localhost:3000';
const SUB = 'b9c6e150-e185-423b-b953-39ec081ae540';

const NOTES = `1. The deliverable is a single PPTX file.
2. The deck uses a 16:9 page size.
3. The footer matches the required confidential line.
4. The title slide names the regional review.
5. The pack contains eight slides.
6. Region names match the workbook.
7. Revenue figures match the workbook.
8. Each slide keeps a clear title band.
9. Body type is locked across slides.
10. The deck is free of overlapping text.
11. Charts use the brief palette.
12. Speaker notes stay off the slides.`;

async function main() {
  const cookie = await signIn();
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });

  let view = await (await api(`/api/submissions/${SUB}`)).json();
  console.log(`stage=${view.submission?.stage} jobs=${JSON.stringify(view.jobs?.map((j: { kind: string; status: string }) => `${j.kind}:${j.status}`))}`);

  for (const job of view.jobs ?? []) {
    if (job.status === 'queued' || job.status === 'running') {
      const res = await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      console.log(`cancel ${job.id} ${res.status}`);
    }
  }

  if (view.submission?.stage === 'rubric') {
    const gen = await (await api(`/api/submissions/${SUB}/rubric/generate`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), source: NOTES, target: 40 }),
    })).json();
    console.log('generate', gen);
    await waitJob(api, gen.jobId, 'rubric_generate');
  }

  view = await (await api(`/api/submissions/${SUB}`)).json();
  const seated = view.rubric?.statements?.length ?? 0;
  console.log(`seated=${seated} golden=${view.golden?.gate?.percent} ok=${view.golden?.gate?.ok}`);

  if (view.submission?.stage === 'rubric' && seated > 0 && !view.golden?.gate?.ok) {
    const gold = await (await api(`/api/submissions/${SUB}/golden`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    })).json();
    console.log('golden', gold);
    await waitJob(api, gold.jobId, 'golden_autorate');
  }

  view = await (await api(`/api/submissions/${SUB}`)).json();
  console.log(`golden after=${view.golden?.gate?.percent} ok=${view.golden?.gate?.ok} ai=${view.aiOutputs?.length ?? view.files?.aiOutputs?.length}`);

  if (view.submission?.stage === 'rubric' && view.golden?.gate?.ok) {
    const send = await api(`/api/submissions/${SUB}/review/send`, { method: 'POST', body: '{}' });
    console.log('send-review', send.status, await send.text());
  }

  view = await (await api(`/api/submissions/${SUB}`)).json();
  if (view.submission?.stage === 'review') {
    const ids: string[] = (view.rubric?.statements ?? []).map((s: { id: string }) => s.id);
    const answers: Record<string, boolean> = {};
    const evidence: Record<string, string> = {};
    for (const id of ids) {
      answers[id] = mockGradeYes(id, true);
      evidence[id] = 'Walkthrough calibration matching the mock AI grade.';
    }
    const cal = await (await api(`/api/submissions/${SUB}/review/calibration`, {
      method: 'PUT',
      body: JSON.stringify({ answers, evidence, submit: true }),
    })).json();
    console.log('calibration', cal);
    const dec = await api(`/api/submissions/${SUB}/review/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', feedback: 'Walkthrough: calibration in band, approving to stability.' }),
    });
    console.log('approve', dec.status, await dec.text());
  }

  view = await (await api(`/api/submissions/${SUB}`)).json();
  if (view.submission?.stage === 'stability') {
    const stab = await (await api(`/api/submissions/${SUB}/stability`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    })).json();
    console.log('stability', stab);
    await waitJob(api, stab.jobId, 'stability_run');
  }

  view = await (await api(`/api/submissions/${SUB}`)).json();
  console.log(JSON.stringify({
    stage: view.submission?.stage,
    seated: view.rubric?.statements?.length,
    golden: view.golden?.gate,
    calibration: view.review?.submittedPercent,
    stability: view.stability?.gate,
    jobs: view.jobs?.map((j: { kind: string; status: string; error?: string }) => ({ kind: j.kind, status: j.status, error: j.error })),
  }, null, 2));
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@gdp.local', password: process.env['AUTH_LOCAL_PASSWORD'] || 'gdp-dev' }),
  });
  if (!res.ok) throw new Error(`signin ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ') || (res.headers.get('set-cookie')?.split(';')[0] ?? '');
  if (!cookie) throw new Error('signin returned no cookie');
  return cookie;
}

async function waitJob(api: (path: string, init?: RequestInit) => Promise<Response>, id: string, label: string) {
  if (!id) throw new Error(`${label} did not return a job id`);
  for (let i = 0; i < 90; i += 1) {
    const job = await (await api(`/api/jobs/${id}`)).json();
    const seeds = job.progress?.seeds;
    console.log(`${label} ${job.status} ${job.progress?.note ?? ''} ${seeds ? `${seeds.ok}ok/${seeds.failed}fail` : ''}`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`${label} ${job.status}: ${job.error}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} timed out`);
}

void main();

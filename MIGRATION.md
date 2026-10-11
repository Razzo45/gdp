# Migration from the legacy app

Reference snapshot: `WinterIsComing` @ `catalog-snapshot-20261008T135151Z`.
Engineering docs: `docs/engineering` (`09-database-reference.md`,
`13-application-contracts.md`).

## What was wrong, what changed

| legacy | now |
| --- | --- |
| `supabase.auth.getUser()` (network) + `has_gdp_access` / `has_permission` RPCs on every request and every client action | JWT verified locally in the proxy; roles from a 60 s cache; one network call only to refresh a token about to expire |
| 117 tables, ~369 SQL functions, RLS policies encoding business rules | 15 tables in schema `app`, one trigger, no RLS; every rule is a tested TypeScript service |
| five queues (`wirestock_jobs`, `wirestock_autorate_jobs`, `wirestock_rubric_generation_jobs`, `wirestock_execution_requests`, `wirestock_gemini_admission_*`) with lane/admission/reservation tables | one `app.jobs` table, `FOR UPDATE SKIP LOCKED`, lease + heartbeat + checkpoint |
| polling at 1.5 s / 5 s everywhere | poll 2.5 s only while a job is active on the open task |
| raw `fetch` to Gemini, one call per statement, "all-current-outputs-v1" payload that attached every output to every statement | `@google/genai`, structured output, 10 statements per call grouped by the curator-declared file scope, Files API cache by sha256, process-wide limiter + 429 cooldown |
| LibreOffice via a Python helper per request, no cache | render once per content hash, PDF cached in Storage + `derivatives`; OOXML *FILE FACTS* manifest alongside; text-digest fallback with an explicit no-render notice |
| rubric edits through `wirestock_local_overlays` + `rubric_runs` revisions | `rubrics` / `rubric_statements` with revision CAS; 409 returns current state |
| assignment/handoff/review event tables each with their own sequence | `submission_events` audit log + state columns on `submissions` |

Kept verbatim: the gates (100 / 20–50 / spread ≤ 5 / tolerance 20 / three
passes / explicit acceptance), the handoff ladder, the Catalog contract
(`/project-submissions/{id}`, `/save`, `/make-transition`, `files/upload-url`,
`/projects/{id}`), the export fields (`rubrics` s001 rows, `prompt`,
`taskPerformance`), the webhook signature scheme, the rubric contract
(affirmative Precise Boolean statements, 10 tags → 3 families, 5/15/30 of 50,
local + 8-attribute LLM lint, Jaccard 0.72), and the ported prompts.

## New since the snapshot

- PPTX/DOCX/XLSX grading via rendered PDF + manifest (see ARCHITECTURE.md).
- PMs see how many and which tasks each person holds (`/submissions/claims`,
  `GET /api/claims`).
- `landed_at` (first import), `last_seen_at`, `upstream_changed_at`,
  `rubric_claimed_at`, `review_claimed_at`, `last_claimed_at` on every task;
  shown in the task list and the claims page.

## Moving data

Auth stays on the live Supabase project so users keep their logins (same
UUIDs). Task rows, seats and the current rubric go into whichever Postgres
`DATABASE_URL` points at — Cloud SQL on GCP, or a scratch Neon. The importer
never writes to live Supabase.

```bash
npm run db:snapshot-supabase                 # read-only public.* → tmp/supabase-snapshot/
npm run db:migrate                           # app.* on DATABASE_URL
npm run db:import-snapshot                   # dry-run
npm run db:import-snapshot -- --apply        # write
```

`--apply` refuses a Supabase host. Existing `app.submissions` catalog ids are
left alone unless you pass `--replace`. `--sync-catalog` refreshes each task
from the Catalog after the snapshot payload is inserted.

What the importer writes:

1. `app.profiles` — live `public.profiles` ids/emails, plus stub rows for
   assignees that have no profile row.
2. `app.user_roles` — `full_access`/`users.manage` → `admin`,
   `submissions.control` → `pm`, `rubric_team` → `rubric_creator`,
   `review_team` → `reviewer`.
3. `app.watched_projects` — unique Catalog project ids from submissions,
   plus `wirestock_project_features` work/handoff status ids when present.
4. `app.submissions` — catalog payload already stored on
   `wirestock_submissions`, seats from `wirestock_submission_assignments`,
   stage from `wirestock_submission_states`.
5. Current rubric — latest non-superseded `wirestock_rubric_runs.rows`
   (tags re-corrected, questions made affirmative).

Golden verdicts, human overrides, calibrations, stability passes and review
decisions **are** migrated by `npm run db:import-eval -- --apply`. Legacy seat
ids (`b0_12`, `s001`, …) and `question` rows are remapped onto the new
statement ids. Re-run Golden only when you want a fresh autorate on new files.

```bash
npm run db:import-eval -- --apply
npm run db:repair-pipeline -- --apply   # optional --no-observe
```

Finished tasks stay in the snapshot for audit. They are imported as rows so
history and scores stay visible.

## Environment mapping

| legacy | new |
| --- | --- |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` |
| `GEMINI_API_KEY`, per-lane model settings | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FACTORY_MODEL`, `GEMINI_CONCURRENCY`, `AUTORATE_BATCH_SIZE` |
| `WIRESTOCK_*` token / secret | same names |
| admission/lane/capacity tables | gone; `GEMINI_CONCURRENCY` + `WORKER_CONCURRENCY` |
| LibreOffice python helper path | `LIBREOFFICE_BIN` (optional; auto-detected) |

## Operational differences

- There is no cron. Lease expiry and job deadlines are enforced by the worker
  loop (`expireOverdue` every ~60 s).
- Rate limiting is per process. Running more than one web/worker process
  against a tier-3 key: divide `GEMINI_CONCURRENCY` accordingly.
- Deactivating a user (`PATCH /api/users/:id { isActive:false }`) signs them
  out of Supabase and drops them from the role cache immediately on the
  instance that handled the request; other instances see it within 60 s.

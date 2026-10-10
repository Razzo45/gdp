-- GDP platform schema.
--
-- Everything lives in the `app` schema, which is NOT exposed through PostgREST
-- and carries no grants for anon/authenticated. The browser never talks to the
-- database: all reads and writes go through the Next.js server with a single
-- privileged connection. Authorization is enforced in the service layer under
-- row locks, so RLS is deliberately absent here.

create schema if not exists app;
revoke all on schema app from public;

-- ───────────────────────────────────────────── identity ──

create table app.profiles (
  id            uuid primary key,                       -- auth.users.id
  email         text not null unique,
  display_name  text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table app.user_roles (
  user_id     uuid not null references app.profiles(id) on delete cascade,
  role        text not null check (role in ('admin', 'pm', 'rubric_creator', 'reviewer')),
  granted_by  uuid references app.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role)
);

-- ───────────────────────────────────────────── catalog config ──

create table app.watched_projects (
  project_id          text primary key,
  label               text not null default '',
  -- The Data Program work stage: the only stage non-admins may publish from.
  work_status_id      text not null default '',
  -- The post-handoff stage: read-only upstream, still visible to who worked it.
  handoff_status_id   text not null default '',
  -- Cached project declaration (formSchema, workflow). Refreshed on each read.
  project             jsonb,
  project_fetched_at  timestamptz,
  added_by            uuid references app.profiles(id) on delete set null,
  created_at          timestamptz not null default now()
);

-- ───────────────────────────────────────────── submissions ──

create table app.submissions (
  id                     uuid primary key default gen_random_uuid(),
  catalog_submission_id  text not null unique,
  project_id             text not null,
  status_id              text,                          -- upstream status id
  title                  text not null default '',
  source                 jsonb not null,                -- latest upstream payload
  source_fingerprint     text not null,                 -- volatile-stripped hash
  landed_at              timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  upstream_changed_at    timestamptz,                   -- unresolved upstream change
  -- Monotonic local revision. Every local mutation bumps it; clients send the
  -- revision they loaded and a mismatch is a 409, never a silent overwrite.
  revision               bigint not null default 0,
  stage                  text not null default 'rubric'
                           check (stage in ('rubric', 'review', 'stability', 'handoff', 'done')),
  -- Seats. The seat, not a team list, decides who may act.
  rubric_assignee_id     uuid references app.profiles(id) on delete set null,
  rubric_claimed_at      timestamptz,
  reviewer_id            uuid references app.profiles(id) on delete set null,
  review_claimed_at      timestamptz,
  last_claimed_at        timestamptz,
  review_status          text check (review_status in ('pending', 'changes_requested', 'approved')),
  review_rubric_id       uuid,                          -- the rubric sent to review
  handoff_status         text check (handoff_status in
                           ('ready_for_review', 'bounced', 'stability_pass', 'final_review_pass', 'client_visible')),
  handoff_basis          jsonb,                         -- fingerprint bound at final_review_pass
  pushed_at              timestamptz,
  push_receipt           jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index submissions_project_stage_idx on app.submissions (project_id, stage);
create index submissions_rubric_assignee_idx on app.submissions (rubric_assignee_id) where rubric_assignee_id is not null;
create index submissions_reviewer_idx on app.submissions (reviewer_id) where reviewer_id is not null;

-- Immutable activity log: claims, assignments, review decisions, handoffs,
-- pushes. This is what the PM view and the per-record timeline read.
create table app.submission_events (
  id             bigint generated always as identity primary key,
  submission_id  uuid not null references app.submissions(id) on delete cascade,
  actor_id       uuid references app.profiles(id) on delete set null,
  action         text not null,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index submission_events_submission_idx on app.submission_events (submission_id, id);

-- AI output files uploaded by the rubric creator (inputs and Golden come from
-- the Catalog and are never copied here).
create table app.ai_output_files (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references app.submissions(id) on delete cascade,
  name           text not null,
  mime           text not null,
  size           bigint not null check (size >= 0),
  sha256         text not null,
  storage_path   text not null unique,
  uploaded_by    uuid references app.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  removed_at     timestamptz
);
create index ai_output_files_submission_idx on app.ai_output_files (submission_id) where removed_at is null;

-- ───────────────────────────────────────────── rubric ──

create table app.rubrics (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references app.submissions(id) on delete cascade,
  version        integer not null,
  -- CAS revision for statement edits; bumped by every statement write.
  revision       bigint not null default 0,
  seeds          jsonb not null default '[]'::jsonb,
  -- Factory provenance: model, bank, report, cost, stages. Read-only evidence.
  generation     jsonb not null default '{}'::jsonb,
  is_current     boolean not null default true,
  created_by     uuid references app.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (submission_id, version)
);
create unique index rubrics_current_idx on app.rubrics (submission_id) where is_current;

create table app.rubric_statements (
  id              uuid primary key default gen_random_uuid(),
  rubric_id       uuid not null references app.rubrics(id) on delete cascade,
  position        integer not null,
  family          text not null check (family in ('format', 'content', 'visual')),
  tag             text not null,
  statement       text not null check (length(trim(statement)) > 0),
  notes           text not null default '',
  -- 'output': graded against the output files only.
  -- 'inputs': the named input files are attached as REFERENCE_INPUT as well.
  scope           text not null default 'output' check (scope in ('output', 'inputs')),
  input_file_ids  text[] not null default '{}',
  -- Optional narrowing to one output file (Catalog golden file id or AI file id
  -- is resolved at grading time by name). Null = all current outputs.
  output_file     text,
  claim_key       text,
  origin          text not null default 'manual' check (origin in ('factory', 'bank', 'manual', 'import')),
  lint            jsonb,
  updated_by      uuid references app.profiles(id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (rubric_id, position)
);

-- Append-only per-statement Golden verdicts. The current verdict for a
-- statement is the newest row whose basis still matches the statement wording
-- and the current Golden file set.
create table app.golden_ratings (
  id             uuid primary key default gen_random_uuid(),
  rubric_id      uuid not null references app.rubrics(id) on delete cascade,
  statement_id   uuid not null references app.rubric_statements(id) on delete cascade,
  job_id         uuid,
  source         text not null check (source in ('ai', 'human')),
  verdict        boolean,                                -- null = grading error
  evidence       text not null default '',
  error          text,
  reason         text,                                   -- required for human overrides
  model          text,
  basis          jsonb not null,                         -- {statementHash, goldenFileIds, scope, inputFileIds}
  created_by     uuid references app.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  check (source <> 'human' or (reason is not null and length(trim(reason)) > 0))
);
create index golden_ratings_statement_idx on app.golden_ratings (statement_id, created_at desc);

-- Human AI eval (calibration). One row per save; the newest is current.
create table app.calibrations (
  id             uuid primary key default gen_random_uuid(),
  rubric_id      uuid not null references app.rubrics(id) on delete cascade,
  reviewer_id    uuid references app.profiles(id) on delete set null,
  answers        jsonb not null,                         -- {statementId: true|false}
  evidence       jsonb not null default '{}'::jsonb,     -- {statementId: text}
  score_percent  numeric not null check (score_percent >= 0 and score_percent <= 100),
  basis          jsonb not null,                         -- {rubricRevision, statementHashes, aiFileIds}
  submitted      boolean not null default false,         -- draft saves are not decisions
  created_at     timestamptz not null default now()
);
create index calibrations_rubric_idx on app.calibrations (rubric_id, created_at desc);

-- Review decisions are immutable events (see submission_events for the
-- timeline) and the current state lives on submissions.review_status.
create table app.review_feedback (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references app.submissions(id) on delete cascade,
  rubric_id      uuid references app.rubrics(id) on delete set null,
  reviewer_id    uuid references app.profiles(id) on delete set null,
  decision       text not null check (decision in ('approved', 'changes_requested')),
  feedback       text not null default '',
  calibration_id uuid references app.calibrations(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- Three ordered passes per group, one group per Stability run.
create table app.stability_passes (
  id             uuid primary key default gen_random_uuid(),
  rubric_id      uuid not null references app.rubrics(id) on delete cascade,
  group_id       uuid not null,
  job_id         uuid,
  pass_index     smallint not null check (pass_index between 1 and 3),
  answers        jsonb not null,                         -- {statementId: true|false|null}
  evidence       jsonb not null default '{}'::jsonb,
  errors         jsonb not null default '{}'::jsonb,
  score_percent  numeric check (score_percent >= 0 and score_percent <= 100),
  model          text,
  basis          jsonb not null,                         -- {rubricRevision, statementHashes, aiFileIds}
  created_at     timestamptz not null default now(),
  unique (group_id, pass_index)
);
create index stability_passes_rubric_idx on app.stability_passes (rubric_id, created_at desc);

create table app.stability_acceptances (
  id             uuid primary key default gen_random_uuid(),
  rubric_id      uuid not null references app.rubrics(id) on delete cascade,
  group_id       uuid not null,
  accepted_by    uuid references app.profiles(id) on delete set null,
  scores         numeric[] not null,
  spread         numeric not null,
  calibration_id uuid references app.calibrations(id) on delete set null,
  basis          jsonb not null,
  created_at     timestamptz not null default now()
);
create index stability_acceptances_rubric_idx on app.stability_acceptances (rubric_id, created_at desc);

-- ───────────────────────────────────────────── jobs ──

-- One durable queue for every background operation. Claimed with
-- FOR UPDATE SKIP LOCKED; owned by a lease token; heartbeat extends the lease;
-- an expired lease makes the row claimable again up to max_attempts.
create table app.jobs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('rubric_generate', 'golden_autorate', 'stability_run')),
  submission_id  uuid not null references app.submissions(id) on delete cascade,
  rubric_id      uuid references app.rubrics(id) on delete cascade,
  -- Caller-owned idempotency key: a lost response retried with the same key
  -- returns the same job instead of a duplicate.
  request_id     uuid not null unique,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'queued'
                   check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress       jsonb not null default '{}'::jsonb,     -- {done, total, note}
  checkpoint     jsonb not null default '{}'::jsonb,     -- resumable partial results
  result         jsonb,
  error          text,
  attempts       integer not null default 0,
  max_attempts   integer not null default 3,
  lease_token    uuid,
  lease_until    timestamptz,
  heartbeat_at   timestamptz,
  deadline_at    timestamptz not null default now() + interval '2 hours',
  created_by     uuid references app.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
-- At most one active job of a kind per submission.
create unique index jobs_one_active_idx on app.jobs (submission_id, kind)
  where status in ('queued', 'running');
create index jobs_claim_idx on app.jobs (status, created_at) where status in ('queued', 'running');

-- ───────────────────────────────────────────── provider caches ──

-- Gemini Files API handles, keyed by content hash. A reused URI saves the
-- upload and processing wait; it does not save inference tokens.
create table app.gemini_files (
  sha256      text primary key,
  uri         text not null,
  mime        text not null,
  size        bigint not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Converted document derivatives (e.g. PPTX -> PDF), keyed by source hash.
create table app.derivatives (
  source_sha256  text not null,
  kind           text not null,                          -- 'pdf'
  storage_path   text not null,
  mime           text not null,
  size           bigint not null,
  sha256         text not null,
  tool           text not null,                          -- converter identity
  created_at     timestamptz not null default now(),
  primary key (source_sha256, kind)
);

-- ───────────────────────────────────────────── webhooks ──

create table app.webhook_events (
  event_id     text primary key,
  event_type   text not null,
  submission_id text not null default '',
  project_id   text not null default '',
  status_id    text not null default '',
  occurred_at  timestamptz,
  received_at  timestamptz not null default now(),
  outcome      text not null default 'received',
  detail       text not null default ''
);

-- ───────────────────────────────────────────── helpers ──

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_touch before update on app.profiles
  for each row execute function app.touch_updated_at();
create trigger submissions_touch before update on app.submissions
  for each row execute function app.touch_updated_at();

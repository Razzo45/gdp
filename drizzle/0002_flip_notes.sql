-- Stability flips (a statement whose verdict differs between the three
-- passes) do not fail the gate, but the creator must look at each one before
-- accepting the run: either acknowledge it with a reason, or send the
-- statement back for a rewrite. One note per (group, statement); the newest
-- wins when re-noted.

create table app.stability_flip_notes (
  id           uuid primary key default gen_random_uuid(),
  rubric_id    uuid not null references app.rubrics(id) on delete cascade,
  group_id     uuid not null,
  statement_id uuid not null references app.rubric_statements(id) on delete cascade,
  action       text not null check (action in ('acknowledged', 'rewrite_requested')),
  note         text not null default '',
  created_by   uuid references app.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index stability_flip_notes_group_statement_key on app.stability_flip_notes (group_id, statement_id);
create index stability_flip_notes_rubric_idx on app.stability_flip_notes (rubric_id, created_at desc);

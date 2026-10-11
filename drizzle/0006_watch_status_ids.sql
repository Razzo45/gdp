-- Live board = watched project ∩ these Catalog statuses (work, handoff, plus extras).
alter table app.watched_projects add column if not exists status_ids jsonb not null default '[]';

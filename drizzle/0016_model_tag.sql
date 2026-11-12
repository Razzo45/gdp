-- Model tag from Catalog acceptance criteria (Argon / Carbon / Gemini 3.8).
-- Gemini 3.8 is parked work: filterable on the board, excluded from stuck/team metrics.
alter table app.submissions
  add column if not exists model_tag text not null default 'gemini_38';

alter table app.submissions drop constraint if exists submissions_model_tag_check;
alter table app.submissions add constraint submissions_model_tag_check
  check (model_tag in ('argon', 'carbon', 'gemini_38'));

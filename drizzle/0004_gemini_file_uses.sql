-- Which tasks hold a claim on a staged Files API object. The reaper deletes
-- the Gemini handle when every claimant has left grading, or the TTL is up.

create table app.gemini_file_uses (
  sha256        text not null,
  submission_id uuid not null references app.submissions(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (sha256, submission_id)
);
create index gemini_file_uses_submission_idx on app.gemini_file_uses (submission_id);

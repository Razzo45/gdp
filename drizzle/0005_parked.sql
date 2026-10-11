-- Parked = on the Catalog but not in the GDP work/handoff lane (live "Other").
alter table app.submissions drop constraint if exists submissions_stage_check;
alter table app.submissions add constraint submissions_stage_check
  check (stage in ('rubric', 'review', 'stability', 'handoff', 'done', 'parked'));

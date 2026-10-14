-- Lowest-priority “Need a hand” analysis jobs on the shared worker.
alter table app.jobs drop constraint if exists jobs_kind_check;
alter table app.jobs add constraint jobs_kind_check
  check (kind in ('rubric_generate', 'golden_autorate', 'stability_run', 'rubric_helper'));

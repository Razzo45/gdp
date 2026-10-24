-- View-only oversee role: same board and reports as PM, no workflow writes.
alter table app.user_roles drop constraint if exists user_roles_role_check;
alter table app.user_roles add constraint user_roles_role_check
  check (role in ('admin', 'pm', 'observer', 'rubric_creator', 'reviewer'));

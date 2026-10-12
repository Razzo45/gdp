-- Catalog sent a submitted task back. Pending until a PM accepts or dismisses.
alter table app.submissions
  add column if not exists catalog_return jsonb;

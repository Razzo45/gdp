-- Identity of a Catalog file after the first download. Reassessments look
-- this up (plus a cheap HEAD) so a 2 GB Golden is not fetched or staged again.

create table app.catalog_file_cache (
  file_id    text primary key,
  name       text not null,
  mime       text not null,
  size       bigint not null,
  etag       text,
  sha256     text not null,
  updated_at timestamptz not null default now()
);
create index catalog_file_cache_sha_idx on app.catalog_file_cache (sha256);

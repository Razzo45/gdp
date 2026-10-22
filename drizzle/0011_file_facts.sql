-- FILE FACTS measured from the bytes (ffprobe, image/PDF headers), by content
-- hash. A re-run that reuses a live Files API URI has no bytes, so it reads the
-- facts from here instead of sending only size and kind.

create table app.file_facts (
  sha256     text primary key,
  facts      text not null,
  created_at timestamptz not null default now()
);

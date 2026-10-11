-- Per-user passwords and one-time invite / recovery tokens.
-- AUTH_MODE=local on Railway uses these; Supabase Auth is not required.

alter table app.profiles add column if not exists password_hash text;

create table if not exists app.auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app.profiles(id) on delete cascade,
  purpose     text not null check (purpose in ('invite', 'recover')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists auth_tokens_user_idx on app.auth_tokens (user_id, purpose);

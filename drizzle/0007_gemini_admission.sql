-- Cross-instance Gemini ceiling + shared 429 cooldown.
-- Local AdaptiveAdmission still does AIMD and owner fairness.
-- Leases live on DATABASE_URL (app.*), never on live GDP / Supabase RPCs.

create table app.gemini_admission_leases (
  token uuid primary key,
  lane text not null check (lane in ('inference', 'files')),
  request_class text not null check (request_class in ('interactive', 'background')),
  lease_until timestamptz not null,
  created_at timestamptz not null default now()
);

create table app.gemini_admission_waiters (
  token uuid primary key,
  lane text not null check (lane in ('inference', 'files')),
  request_class text not null check (request_class in ('interactive', 'background')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index gemini_admission_waiters_order
  on app.gemini_admission_waiters (lane, request_class, requested_at);

create index gemini_admission_leases_active
  on app.gemini_admission_leases (lane, lease_until);

create table app.gemini_admission_state (
  lane text primary key check (lane in ('inference', 'files')),
  cooldown_until timestamptz not null default '-infinity',
  next_admit_at timestamptz not null default '-infinity',
  updated_at timestamptz not null default now()
);

insert into app.gemini_admission_state (lane) values ('inference'), ('files')
on conflict (lane) do nothing;

create function app.acquire_gemini_admission(
  target_token uuid,
  target_lane text,
  target_request_class text,
  lease_seconds integer default 90,
  max_active integer default 96,
  max_background integer default 95,
  minimum_interval_ms integer default 0
)
returns boolean
language plpgsql
as $$
declare
  active_count integer;
  background_count integer;
  interactive_count integer;
  background_waiting boolean;
  state_row app.gemini_admission_state;
  is_background boolean := target_request_class = 'background';
begin
  if target_lane not in ('inference', 'files') then
    raise exception 'invalid Gemini admission lane';
  end if;
  if target_request_class not in ('interactive', 'background') then
    raise exception 'invalid Gemini request class';
  end if;
  perform pg_advisory_xact_lock(hashtext('app-gemini-admission:' || target_lane));
  delete from app.gemini_admission_leases where lane = target_lane and lease_until <= now();
  delete from app.gemini_admission_waiters where expires_at <= now();
  insert into app.gemini_admission_waiters (token, lane, request_class, expires_at)
  values (target_token, target_lane, target_request_class, now() + interval '2 minutes')
  on conflict (token) do update set expires_at = excluded.expires_at;
  select * into state_row from app.gemini_admission_state where lane = target_lane for update;
  if not found then raise exception 'Gemini admission state is missing for lane %', target_lane; end if;
  if state_row.cooldown_until > now() or state_row.next_admit_at > now() then return false; end if;
  select count(*),
         count(*) filter (where request_class = 'background'),
         count(*) filter (where request_class = 'interactive')
    into active_count, background_count, interactive_count
  from app.gemini_admission_leases
  where lane = target_lane and lease_until >= now();
  if active_count >= greatest(1, max_active) then return false; end if;
  select exists (
    select 1 from app.gemini_admission_waiters
    where lane = target_lane and request_class = 'background'
  ) into background_waiting;
  if is_background then
    if background_count >= least(greatest(1, max_background), greatest(1, max_active)) then return false; end if;
    if exists (
      select 1 from app.gemini_admission_waiters
      where lane = target_lane
        and request_class = 'background'
        and (requested_at, token) < (
          select requested_at, token from app.gemini_admission_waiters where token = target_token
        )
    ) then return false; end if;
  else
    if background_waiting and interactive_count >=
      greatest(0, greatest(1, max_active) - least(greatest(1, max_background), greatest(1, max_active)))
    then return false; end if;
    if exists (
      select 1 from app.gemini_admission_waiters
      where lane = target_lane
        and request_class = 'interactive'
        and (requested_at, token) < (
          select requested_at, token from app.gemini_admission_waiters where token = target_token
        )
    ) then return false; end if;
  end if;
  insert into app.gemini_admission_leases (token, lane, request_class, lease_until)
  values (
    target_token,
    target_lane,
    target_request_class,
    now() + make_interval(secs => least(greatest(lease_seconds, 30), 180))
  );
  delete from app.gemini_admission_waiters where token = target_token;
  update app.gemini_admission_state
  set next_admit_at = now() + (greatest(0, minimum_interval_ms)::text || ' milliseconds')::interval,
      updated_at = now()
  where lane = target_lane;
  return true;
end;
$$;

create function app.release_gemini_admission(target_token uuid)
returns void
language plpgsql
as $$
begin
  delete from app.gemini_admission_leases where token = target_token;
  delete from app.gemini_admission_waiters where token = target_token;
end;
$$;

create function app.throttle_gemini_admission(target_lane text, cooldown_ms integer)
returns void
language plpgsql
as $$
begin
  if target_lane not in ('inference', 'files') then return; end if;
  perform pg_advisory_xact_lock(hashtext('app-gemini-admission:' || target_lane));
  update app.gemini_admission_state
  set cooldown_until = greatest(
        cooldown_until,
        now() + (least(greatest(cooldown_ms, 1000), 120000)::text || ' milliseconds')::interval
      ),
      updated_at = now()
  where lane = target_lane;
end;
$$;

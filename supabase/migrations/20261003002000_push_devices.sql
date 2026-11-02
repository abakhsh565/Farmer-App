-- Farmer App · migration 0020 · push notification devices
--
-- A push token is a property of a *handset*, not of a farmer. In this app that
-- distinction is not academic: the target user frequently shares one phone
-- between two people, and both may sign in on it across a day.
--
-- So the token is stored once, keyed by the token itself, and ownership is
-- reassigned when someone else signs in. Without that, farmer A keeps receiving
-- "your credit request was declined" notifications on a handset now in farmer
-- B's hands — which is worse than sending nothing at all.
--
-- The client never writes this table directly. `register_push_device` is the
-- only entry point, because reassignment is a decision the server has to make.

create table public.push_devices (
  id          uuid primary key default gen_random_uuid(),
  -- The FCM registration token. Unique: one handset, one row, always.
  token       text not null unique,
  -- Whoever is currently signed in on that handset. Null once the device is
  -- signed out, so a stale row cannot keep delivering to the previous farmer.
  party_id    uuid references public.parties (id) on delete cascade,
  platform    text not null default 'android' check (platform in ('android', 'web')),
  app_version text,
  -- Refreshed every time the app opens, so "is this device still active?" is a
  -- comparison rather than a guess.
  last_seen_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index push_devices_party_idx on public.push_devices (party_id) where party_id is not null;
create index push_devices_seen_idx on public.push_devices (last_seen_at desc);

comment on table public.push_devices is
  'One row per handset. Ownership follows whoever is signed in, because a shared phone is the normal case here — a token left pointing at the previous farmer would send one farmer''s credit and visit updates to another.';

-- ---------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------

-- Called on every app open. Claims the token for the current session, or
-- refreshes it if this farmer already owns it.
--
-- `previous_party_id` is returned so the caller can tell whether a token was
-- taken over, which is what makes it possible to log that handover rather than
-- discovering it later.
create or replace function public.register_push_device(
  p_token       text,
  p_platform    text default 'android',
  p_app_version text default null
)
returns table (
  device_id          uuid,
  previous_party_id  uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party   uuid := public.current_party_id();
  v_previous uuid;
  v_id      uuid;
begin
  if v_party is null then
    raise exception 'A device can only be registered by a signed-in farmer.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_token is null or length(btrim(p_token)) < 8 then
    raise exception 'That does not look like a push token.' using errcode = 'check_violation';
  end if;

  select d.party_id into v_previous
    from public.push_devices d
   where d.token = btrim(p_token);

  insert into public.push_devices (token, party_id, platform, app_version, last_seen_at)
  values (btrim(p_token), v_party, coalesce(p_platform, 'android'), p_app_version, now())
  on conflict (token) do update
    set party_id    = excluded.party_id,
        platform    = excluded.platform,
        app_version = coalesce(excluded.app_version, public.push_devices.app_version),
        last_seen_at = now()
  returning id into v_id;

  perform public.write_audit(
    'push.device_registered', 'push_devices', v_id, null,
    v_previous::text, v_party::text,
    jsonb_build_object('platform', coalesce(p_platform, 'android'), 'reassigned', v_previous is distinct from null and v_previous is distinct from v_party)
  );

  return query select v_id, v_previous;
end;
$$;

-- Signing out releases the handset, so the next person to sign in on it can
-- claim it. Without this the token stays attached to the previous farmer.
create or replace function public.release_push_device(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
begin
  update public.push_devices
     set party_id = null
   where token = p_token
     and party_id = v_party;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading and RLS
-- ---------------------------------------------------------------------------

alter table public.push_devices enable row level security;

-- A farmer may see their own handsets. They may not see anyone else's, and
-- they may not write: the registration function is the only path, so that token
-- reassignment cannot be bypassed with a direct insert.
create policy push_devices_own_read on public.push_devices
  for select to authenticated
  using (party_id = public.current_party_id());

grant select on public.push_devices to authenticated;
grant execute on function public.register_push_device(text, text, text) to authenticated;
grant execute on function public.release_push_device(text) to authenticated;
-- Farmer App · migration 0021 · the missing link between an account and an actor
--
-- Three defects are fixed here, all of them found by asking the live database
-- rather than the local schema files:
--
--  1. Signing in created an `auth.users` row and nothing else. `parties` stayed
--     empty, so `current_party_id()` was NULL, so *every* RLS policy in the RLS
--     migration matched nothing. A signed-in farmer saw an empty app and could
--     not write a row. There was no trigger on `auth.users` and no code path
--     that inserted a party: the account existed and the actor did not.
--
--  2. `dealers_within_radius(NULL, lat, lon, radius)` — the guest call the app
--     actually makes — raised `Farmer <NULL> not found.` It read the profile
--     into a record and then checked `not found`, which is true when the farmer
--     id is NULL. So the "0 dealers within 10 km" a guest saw was an error being
--     rendered as an empty list, which is why seeding dealers alone would not
--     have fixed it.
--
--  3. The farmer's saved location had no write path the client could use. The
--     table and its completeness constraint existed; nothing could set it. The
--     functions below are that path, and they validate server-side so the rules
--     do not depend on the picker being well behaved.

-- ---------------------------------------------------------------------------
-- 1 · Provisioning
-- ---------------------------------------------------------------------------
--
-- A party is a domain actor that happens to be authenticated. Creating one is
-- therefore part of becoming authenticated, not a second step a client may or
-- may not perform. It lives in a trigger so it cannot be skipped, and in a plain
-- function so it can be re-run for accounts that predate it.
--
-- Deliberately NOT a merge point. The PRD forbids merging accounts by phone
-- number, so a contact row that already exists is left alone rather than
-- re-pointed at the new party: the duplicate becomes visible to a human instead
-- of silently joining two people's records.

create or replace function public.provision_party(p_auth_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    auth.users;
  v_party   uuid;
  v_display text;
  v_locale  text;
  v_digits  text;
begin
  if p_auth_user is null then
    return null;
  end if;

  -- Already provisioned: make sure the dependent rows exist, then stop. This is
  -- what makes the function safe to call on every app launch.
  select id into v_party from public.parties where auth_user_id = p_auth_user;
  if v_party is not null then
    insert into public.farmer_profiles (party_id) values (v_party)
      on conflict (party_id) do nothing;
    insert into public.farmer_search_settings (farmer_id) values (v_party)
      on conflict (farmer_id) do nothing;
    return v_party;
  end if;

  select * into v_user from auth.users u where u.id = p_auth_user;
  if not found then
    return null;
  end if;

  -- An account with neither a phone nor an email is not an identity anybody can
  -- be held to; refuse rather than create a nameless actor.
  if v_user.phone is null and v_user.email is null then
    return null;
  end if;

  v_digits := regexp_replace(coalesce(v_user.phone, ''), '\D', '', 'g');

  v_display := coalesce(
    nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'display_name', '')), ''),
    case
      -- Never the whole number: a display name is shown to other people.
      when v_digits <> '' then '****' || right(v_digits, 4)
      else split_part(coalesce(v_user.email, 'farmer'), '@', 1)
    end
  );

  -- The column has a check constraint listing supported locales, so a metadata
  -- value that is not one of them must not reach the insert.
  v_locale := case
    when coalesce(v_user.raw_user_meta_data ->> 'locale', '') in ('ur', 'en', 'pa', 'sk', 'sd', 'ps')
      then v_user.raw_user_meta_data ->> 'locale'
    else 'ur'
  end;

  insert into public.parties (kind, auth_user_id, display_name, locale)
  values ('farmer', p_auth_user, left(v_display, 120), v_locale)
  returning id into v_party;

  -- The location row is created empty. The completeness constraint explicitly
  -- allows all-NULL coordinates, which is the honest state of a farmer who has
  -- not chosen a location yet — and it is what lets the app distinguish "no
  -- location" from "somewhere at 0,0".
  insert into public.farmer_profiles (party_id) values (v_party)
    on conflict (party_id) do nothing;

  insert into public.farmer_search_settings (farmer_id, radius_km) values (v_party, 10)
    on conflict (farmer_id) do nothing;

  -- The contact is the identifier, never an authorization. `verified_at` is set
  -- only from what the provider actually confirmed.
  if v_digits <> '' then
    insert into public.party_contacts (party_id, channel, value, raw_value, verified_at, is_primary)
    values (
      v_party, 'phone', v_digits, coalesce(v_user.phone, v_digits),
      v_user.phone_confirmed_at, true
    )
    on conflict (channel, value) do nothing;
  end if;

  if v_user.email is not null then
    insert into public.party_contacts (party_id, channel, value, raw_value, verified_at, is_primary)
    values (
      v_party, 'email', lower(v_user.email), v_user.email,
      v_user.email_confirmed_at, true
    )
    on conflict (channel, value) do nothing;
  end if;

  return v_party;
end;
$$;

comment on function public.provision_party(uuid) is
  'Creates the domain actor for an authenticated user, idempotently. Triggered by auth.users inserts so provisioning cannot be skipped by a client that forgets.';

create or replace function public.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.provision_party(new.id);
  return new;
end;
$$;

-- Dropped first so re-running this migration on a database that already has the
-- trigger is a no-op rather than an error.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.on_auth_user_created();

-- Backfill. Every account that already existed — including the test account
-- used to verify OTP — becomes an actor with a profile.
do $$
declare
  v_user record;
begin
  for v_user in
    select u.id
    from auth.users u
    where not exists (select 1 from public.parties p where p.auth_user_id = u.id)
      and (u.phone is not null or u.email is not null)
  loop
    perform public.provision_party(v_user.id);
  end loop;
end;
$$;

-- The self-healing entry point the app calls after a session is established.
-- Idempotent by construction, and returns NULL for a caller with no session so
-- a guest is not an error.
create or replace function public.ensure_party()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return null;
  end if;
  return public.provision_party(v_uid);
end;
$$;

comment on function public.ensure_party() is
  'Idempotently provisions the caller''s party, profile and search settings. Returns NULL for a guest session.';

grant execute on function public.ensure_party() to authenticated;

-- ---------------------------------------------------------------------------
-- 2 · Guest dealer search
-- ---------------------------------------------------------------------------
--
-- Same signature, same output, so nothing that already calls it changes. What
-- changes is who it accepts: a caller with no farmer id but real coordinates is
-- a guest doing a temporary search, which the PRD explicitly allows, and the
-- signed-in caller no longer has to be passed its own id by the client — the
-- session is the source of truth for that.

create or replace function public.dealers_within_radius(
  p_farmer_id uuid,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_radius_km integer default null
)
returns table (
  dealer_id        uuid,
  shop_name        text,
  distance_km      numeric,
  verified_at      timestamptz,
  opening_hours    text,
  sync_state       text,
  synced_at        timestamptz,
  is_accepting     boolean,
  effective_radius integer,
  used_temporary_area boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.farmer_search_settings;
  v_profile  public.farmer_profiles;
  v_farmer   uuid := p_farmer_id;
  v_origin   extensions.geography;
  v_radius   integer;
  v_temporary boolean := false;
begin
  -- The session decides who the caller is. A client that passes someone else's
  -- id gets its own saved location only if that id is its own; otherwise the id
  -- is ignored in favour of the session's party.
  if v_farmer is null then
    v_farmer := public.current_party_id();
  elsif v_farmer is distinct from public.current_party_id() then
    v_farmer := public.current_party_id();
  end if;

  if v_farmer is not null then
    select * into v_profile from public.farmer_profiles where party_id = v_farmer;
    select * into v_settings from public.farmer_search_settings where farmer_id = v_farmer;
  end if;

  if p_lat is not null and p_lon is not null then
    -- Caller supplied an origin: this is a temporary search area, and it is used
    -- for this query only. It is never written back to the profile — that is the
    -- whole reason "search near Kot Ladha" cannot silently become the farmer's
    -- location.
    v_origin    := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  else
    v_origin := v_profile.geog;
  end if;

  if v_origin is null then
    -- A guest with no coordinates, or a farmer who has never saved a location.
    -- Reported as no data rather than as an empty list, because "we do not know
    -- where you are" and "there is nothing near you" are different sentences and
    -- only one of them is fixable by the farmer.
    raise exception 'No search origin: the farmer has no default location and none was supplied.'
      using errcode = 'no_data_found';
  end if;

  v_radius := least(coalesce(p_radius_km, v_settings.radius_km, 10), 100);

  return query
    select
      d.id,
      d.shop_name,
      round((extensions.ST_Distance(d.geog, v_origin) / 1000.0)::numeric, 1),
      d.verified_at,
      d.opening_hours,
      d.sync_state,
      d.synced_at,
      d.is_accepting_requests,
      v_radius,
      v_temporary
    from public.dealer_profiles d
    where d.geog is not null
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    order by d.geog operator(extensions.<->) v_origin
    limit 200;
end;
$$;

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Radius search capped at 100 km. An origin supplied by the caller is treated as temporary and never written back to the farmer profile. Accepts guests by coordinates, and defaults the farmer to the session rather than to a client-supplied id.';

-- ---------------------------------------------------------------------------
-- 3 · The saved location
-- ---------------------------------------------------------------------------
--
-- Read and write are separate functions on purpose. Reading is free and belongs
-- to any signed-in farmer; writing is the single act that may replace a saved
-- location, so it is one function with one caller-facing meaning. There is no
-- "update my location" path from a search screen, because the PRD says a
-- temporary search must not be able to become the saved location silently.

create or replace function public.farmer_location_get()
returns table (
  label      text,
  lat        double precision,
  lon        double precision,
  source     text,
  set_at     timestamptz,
  radius_km  integer,
  area_id    uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
begin
  if v_party is null then
    -- A guest has no saved location. That is an answer, not a failure.
    return;
  end if;

  return query
    select
      f.default_location_label,
      f.default_lat,
      f.default_lon,
      f.default_location_source,
      f.location_set_at,
      coalesce(s.radius_km, 10),
      f.default_area_id
    from public.farmer_profiles f
    left join public.farmer_search_settings s on s.farmer_id = f.party_id
    where f.party_id = v_party;
end;
$$;

comment on function public.farmer_location_get() is
  'The farmer''s saved location and search radius. Returns no row for a guest rather than raising, because "not signed in" is not an error.';

create or replace function public.farmer_location_save(
  p_label     text,
  p_lat       double precision,
  p_lon       double precision,
  p_source    text default 'profile_entry',
  p_radius_km integer default null
)
returns table (
  label      text,
  lat        double precision,
  lon        double precision,
  source     text,
  set_at     timestamptz,
  radius_km  integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party  uuid := public.current_party_id();
  v_label  text := btrim(coalesce(p_label, ''));
  v_radius integer;
  v_set_at timestamptz := now();
begin
  -- Every rule below is enforced here, not in the picker. A caller that skips
  -- the UI entirely reaches the same checks.
  if v_party is null then
    raise exception 'Sign in to save a location.' using errcode = 'insufficient_privilege';
  end if;

  if p_lat is null or p_lon is null then
    raise exception 'A saved location needs both a latitude and a longitude.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    raise exception 'That location is outside the valid range.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A location with no name cannot be shown back to the farmer, and the
  -- completeness constraint would reject the pair as incomplete anyway.
  if v_label = '' or length(v_label) > 120 then
    raise exception 'A saved location needs a name of 1 to 120 characters.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_source is null or p_source not in ('profile_entry', 'device_permission', 'dealer_record') then
    raise exception 'Unknown location source.' using errcode = 'invalid_parameter_value';
  end if;

  -- Clamped rather than rejected: the PRD's 100 km ceiling is a rule about what
  -- the search may do, and the slider already cannot exceed it. A caller asking
  -- for more gets the maximum, the same way the radius search does.
  v_radius := least(greatest(coalesce(p_radius_km, 10), 1), 100);

  update public.farmer_profiles f
     set default_lat            = p_lat,
         default_lon            = p_lon,
         default_location_label = v_label,
         default_location_source = p_source,
         location_set_at        = v_set_at
   where f.party_id = v_party;

  if not found then
    -- The trigger should have created this. If it did not, say so instead of
    -- reporting a successful save of nothing.
    raise exception 'This account has no farmer profile to save a location into.'
      using errcode = 'no_data_found';
  end if;

  insert into public.farmer_search_settings (farmer_id, radius_km, updated_at)
  values (v_party, v_radius, v_set_at)
  on conflict (farmer_id) do update
    set radius_km = excluded.radius_km,
        updated_at = excluded.updated_at;

  return query
    select f.default_location_label, f.default_lat, f.default_lon,
           f.default_location_source, f.location_set_at, v_radius
    from public.farmer_profiles f
    where f.party_id = v_party;
end;
$$;

comment on function public.farmer_location_save(text, double precision, double precision, text, integer) is
  'The only path that may set the saved location. Validates coordinates, label and source server-side, and sets location_set_at so the app can say when it was chosen.';

create or replace function public.farmer_location_clear()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
begin
  if v_party is null then
    raise exception 'Sign in to change your saved location.' using errcode = 'insufficient_privilege';
  end if;

  update public.farmer_profiles f
     set default_lat = null,
         default_lon = null,
         default_location_label = null,
         default_location_source = null,
         location_set_at = null
   where f.party_id = v_party;

  return found;
end;
$$;

-- Reading is available to a guest (it answers "nothing saved"); writing is not,
-- so the permission error is the server refusing, not the UI hiding a button.
grant execute on function public.farmer_location_get() to anon, authenticated;
grant execute on function public.farmer_location_save(text, double precision, double precision, text, integer) to authenticated;
grant execute on function public.farmer_location_clear() to authenticated;

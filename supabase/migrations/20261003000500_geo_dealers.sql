-- Farmer App · migration 0005 · geography and the dealer read layer
--
-- The PRD asks for proper geospatial logic, a hard 100 km ceiling, and a
-- temporary search area that cannot silently become the farmer's location.
-- Those three are implemented as: PostGIS geography columns with GiST indexes,
-- a CHECK constraint on radius, and two separate tables (already created in
-- migration 0002) whose only overlap is a join, never a write.

-- ---------------------------------------------------------------------------
-- Geography on existing tables
-- ---------------------------------------------------------------------------

-- Generated so the point can never disagree with the lat/lon pair beside it.
alter table public.dealer_profiles
  add column geog extensions.geography(Point, 4326)
  generated always as (
    case
      when lat is not null and lon is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(lon, lat), 4326)::extensions.geography
      else null
    end
  ) stored;

create index dealer_profiles_geog_idx on public.dealer_profiles using gist (geog);

alter table public.farmer_profiles
  add column geog extensions.geography(Point, 4326)
  generated always as (
    case
      when default_lat is not null and default_lon is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(default_lon, default_lat), 4326)::extensions.geography
      else null
    end
  ) stored;

comment on column public.dealer_profiles.geog is
  'Generated from lat/lon, so a radius query can never use coordinates that disagree with the displayed ones.';

-- ---------------------------------------------------------------------------
-- Named areas
-- ---------------------------------------------------------------------------

create table public.areas (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_en     text not null,
  name_ur     text not null,
  names_local jsonb not null default '{}'::jsonb,
  district    text,
  geog        extensions.geography(Point, 4326),
  is_active   boolean not null default true
);

create index areas_geog_idx on public.areas using gist (geog);

insert into public.areas (code, name_en, name_ur, district, geog) values
  ('wazirabad',  'Wazirabad',  'وزیرآباد',  'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.1150, 32.4430), 4326)::extensions.geography),
  ('kot_ladha',  'Kot Ladha',  'کوٹ لادھا', 'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.0500, 32.3300), 4326)::extensions.geography),
  ('gujranwala', 'Gujranwala', 'گوجرانوالہ', 'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.1936, 32.1877), 4326)::extensions.geography);

-- Link the farmer's default area back to the catalog now that it exists.
alter table public.farmer_profiles
  add constraint farmer_profiles_default_area_fkey
  foreign key (default_area_id) references public.areas (id);

-- ---------------------------------------------------------------------------
-- Dealer inventory projection
-- ---------------------------------------------------------------------------

-- Declared before dealer_products because that table carries a foreign key to
-- it, and Postgres requires the referenced table to exist first.
create table public.canonical_products (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null,
  brand              text,
  category           text,
  -- Pakistan registration number, when the product has one. This is the value
  -- a scan result cites as evidence.
  registration_no    text,
  registered_on      date,
  active_ingredient  text,
  label_url          text,
  is_restricted      boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger canonical_products_touch before update on public.canonical_products
  for each row execute function public.touch_updated_at();

comment on column public.canonical_products.registration_no is
  'The registration the product evidence chain displays. NULL means unknown, and the UI must say unknown rather than imply unregistered.';

-- Read-facing only. `synced_at` and `sync_state` exist because the PRD requires
-- missing or stale information to be shown as such, never invented.
create table public.dealer_products (
  id                uuid primary key default gen_random_uuid(),
  dealer_id         uuid not null references public.dealer_profiles (id) on delete cascade,
  source_system     text not null default 'agri_shop_pos',
  source_ref        text not null,
  name              text not null,
  brand             text,
  category          text,
  -- The canonical product this listing corresponds to, so farmer-side evidence
  -- chains (scan -> product -> where to buy) can be joined reliably.
  canonical_product_id uuid references public.canonical_products (id),
  pack_size         text,
  registration_no   text,
  -- NULL means "the dealer system did not tell us", which is different from 0.
  available_qty     numeric check (available_qty >= 0),
  unit              text,
  unit_price        numeric check (unit_price >= 0),
  currency          text not null default 'PKR',
  in_stock          boolean,
  synced_at         timestamptz,
  sync_state        text not null default 'fresh' check (sync_state in ('fresh', 'stale', 'unreachable')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (dealer_id, source_system, source_ref)
);

create index dealer_products_dealer_idx on public.dealer_products (dealer_id, category);
create trigger dealer_products_touch before update on public.dealer_products
  for each row execute function public.touch_updated_at();

comment on column public.dealer_products.available_qty is
  'Nullable on purpose. NULL is "unknown", 0 is "confirmed none". The PRD forbids turning a missing value into a zero, and this column makes that mistake impossible to express.';

-- ---------------------------------------------------------------------------
-- Radius search
-- ---------------------------------------------------------------------------

-- Returns dealers inside the radius, and reports each one's freshness so the
-- caller cannot present a stale projection as current by accident.
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
  v_settings   public.farmer_search_settings;
  v_profile    public.farmer_profiles;
  v_origin     extensions.geography;
  v_radius     integer;
  v_temporary  boolean := false;
begin
  select * into v_profile from public.farmer_profiles where party_id = p_farmer_id;
  if not found then
    raise exception 'Farmer % not found.', p_farmer_id using errcode = 'no_data_found';
  end if;

  select * into v_settings from public.farmer_search_settings where farmer_id = p_farmer_id;

  if p_lat is not null and p_lon is not null then
    -- Caller supplied an origin: this is a temporary search area, and it is
    -- used for this query only.
    v_origin    := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  else
    v_origin := v_profile.geog;
  end if;

  if v_origin is null then
    raise exception 'No search origin: the farmer has no default location and none was supplied.'
      using errcode = 'no_data_found';
  end if;

  -- The ceiling is applied here as well as in the constraint, so a caller
  -- passing a huge radius gets 100 km rather than everything on earth.
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
    -- Nearest-first, and written operator(extensions.<->) because the operator
    -- lives in the extensions schema. Using it in ORDER BY is what lets the
    -- GiST index serve the sort instead of a full scan.
    order by d.geog operator(extensions.<->) v_origin
    limit 200;
end;
$$;

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Radius search capped at 100 km. An origin supplied by the caller is treated as temporary and never written back to the farmer profile.';

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

create table public.dealer_sync_runs (
  id              bigserial primary key,
  source_system   text not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  dealers_seen    integer not null default 0,
  products_seen   integer not null default 0,
  records_rejected integer not null default 0,
  error           text
);

comment on table public.dealer_sync_runs is
  'Every projection refresh is recorded. A dealer whose last successful run is old must be shown as stale, which requires knowing when the last good run happened.';

-- Marks a projection stale when nothing has confirmed it recently. Run on a
-- schedule; the UI reads sync_state rather than guessing from a timestamp.
create or replace function public.mark_stale_dealer_projections(p_max_age interval default '36 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with touched as (
    update public.dealer_profiles
       set sync_state = 'stale'
     where sync_state = 'fresh'
       and (synced_at is null or synced_at < now() - p_max_age)
    returning 1
  )
  select count(*) into v_count from touched;

  with touched as (
    update public.dealer_products
       set sync_state = 'stale'
     where sync_state = 'fresh'
       and (synced_at is null or synced_at < now() - p_max_age)
    returning 1
  )
  select v_count + count(*) into v_count from touched;

  return v_count;
end;
$$;

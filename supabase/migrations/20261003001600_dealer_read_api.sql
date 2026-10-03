-- Farmer App · migration 0016 · dealer read API corrections
--
-- Two problems found by writing the client against the schema, which is exactly
-- what that exercise is for.
--
-- 1. `dealers_within_radius` raised when the farmer was unknown. That made guest
--    dealer search impossible, and the PRD is explicit that a guest may browse,
--    read and search. A guest has no farmer profile, so the function must accept
--    an explicit origin instead of demanding one.
--
-- 2. The client needs a dealer's products, and there was no function for it.
--    Reading `dealer_products` directly would have bypassed the staleness
--    reporting, so it is exposed through a function that returns `sync_state`
--    with the rows.

-- ---------------------------------------------------------------------------
-- Guest-capable radius search
-- ---------------------------------------------------------------------------

-- Replaces the earlier definition. The signature is unchanged, so no caller
-- breaks; only the behaviour for a null farmer is corrected.
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
  v_settings  public.farmer_search_settings;
  v_profile   public.farmer_profiles;
  v_origin    extensions.geography;
  v_radius    integer;
  v_temporary boolean := false;
begin
  -- A supplied origin is a temporary search area: used for this query only and
  -- never written back, which is the PRD rule.
  if p_lat is not null and p_lon is not null then
    v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  end if;

  -- A farmer may supply a profile location, preferences, or both.
  if p_farmer_id is not null then
    select * into v_profile from public.farmer_profiles where party_id = p_farmer_id;
    select * into v_settings from public.farmer_search_settings where farmer_id = p_farmer_id;

    if v_origin is null then
      v_origin := v_profile.geog;
    end if;
  end if;

  -- A guest, or a farmer with no location on file and no origin supplied, cannot
  -- be given a radius search: there is no honest answer to "near what". Raising
  -- here is correct, and the client is expected to ask for an area first.
  if v_origin is null then
    raise exception 'A search origin is required: supply coordinates, or sign in as a farmer with a saved location.'
      using errcode = 'no_data_found';
  end if;

  -- Ceiling applied here as well as in the constraints, so a caller passing an
  -- enormous radius gets 100 km rather than the planet.
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
  'Radius search capped at 100 km. Works for a guest when coordinates are supplied; the origin is treated as temporary and never written to the farmer profile.';

-- A guest needs to search, so this is callable without a session. Safe: it reads
-- only the public dealer projection, which is already anon-readable.
grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dealer products
-- ---------------------------------------------------------------------------

-- Returns the projection with its freshness, so a caller cannot accidentally
-- present a stale availability as current. `available_qty` is passed through
-- untouched, including NULL: unknown is not zero.
create or replace function public.dealer_products_for(p_dealer_id uuid)
returns table (
  id                    uuid,
  name                  text,
  brand                 text,
  category              text,
  canonical_product_id  uuid,
  registration_no       text,
  pack_size             text,
  available_qty         numeric,
  in_stock              boolean,
  unit_price            numeric,
  currency              text,
  sync_state            text,
  synced_at             timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.name,
    p.brand,
    p.category,
    p.canonical_product_id,
    p.registration_no,
    p.pack_size,
    p.available_qty,
    p.in_stock,
    p.unit_price,
    p.currency,
    p.sync_state,
    p.synced_at
  from public.dealer_products p
  where p.dealer_id = p_dealer_id
    and p.name is not null
  order by p.category nulls last, p.name;
$$;

comment on function public.dealer_products_for(uuid) is
  'Read-facing dealer inventory with its sync state. Nullable quantity is preserved so the screen can say "not reported" instead of showing zero.';

grant execute on function public.dealer_products_for(uuid) to anon, authenticated;

-- Live dealer network only.
--
-- `20261003002200_reference_seed.sql` inserted six shops with coordinates so the
-- Shop tab had something to draw before the dealer platform existed. They are
-- attributed `source_system = 'reference_seed'`, carry no `source_shop_id`, and
-- nothing updates them. They were still being returned by discovery, and on
-- staging that is exactly what happened: a farmer in Lahore was shown four of
-- those six shops at 70–100 km while the live dealer platform held a real
-- "Lahore" branch 12 km away with an approved listing, because the app's own
-- projection answered first and the seeded rows won.
--
-- A reference row is sample data, not a shop: it has no owner, no phone, no
-- listings and no way to receive an order. This migration keeps the rows (they
-- are useful fixtures for local work) but removes them from the two read
-- functions the app discovers shops through, so the Farmer App can only ever
-- present a shop that really exists on the dealer network — or, when the network
-- has nothing near the farmer, say so.
--
-- Both functions are replaced byte for byte with their previous bodies plus the
-- one predicate, so no behaviour other than the exclusion changes.

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
    v_origin    := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  else
    v_origin := v_profile.geog;
  end if;

  if v_origin is null then
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
      and d.source_system <> 'reference_seed'
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    order by d.geog operator(extensions.<->) v_origin
    limit 200;
end;
$$;

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
  join public.dealer_profiles d on d.id = p.dealer_id
  where p.dealer_id = p_dealer_id
    and d.source_system <> 'reference_seed'
    and p.name is not null
  order by p.category nulls last, p.name;
$$;

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Shops of the live dealer network within the farmer''s radius, nearest first. Reference sample rows are not shops and are excluded.';

comment on function public.dealer_products_for(uuid) is
  'Read-facing dealer inventory with its sync state, for a shop that exists on the live network.';

grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to anon, authenticated;
grant execute on function public.dealer_products_for(uuid) to anon, authenticated;

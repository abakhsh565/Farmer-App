-- 150 km reach.
--
-- The live dealer network is thin outside the cities. The only approved dealer in
-- the Dera Ghazi Khan division is the Multan branch, and the real farmer accounts
-- in that division are at Alipur — 29.3818018, 70.9097965 — which is 105.7 km
-- from it. The 100 km ceiling therefore returned nothing for every farmer there,
-- while the marketplace itself answers over a wider radius.
--
-- This raises the projection's clamp to match the app's new ceiling. It is a
-- clamp, not a default: a farmer who chose 10 km still gets 10 km, and anything
-- outside the chosen radius is still shown as a suggestion rather than a result.

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

  v_radius := least(coalesce(p_radius_km, v_settings.radius_km, 10), 150);

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

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Shops of the live dealer network within the farmer''s radius (up to 150 km), nearest first. Reference sample rows are not shops and are excluded.';

grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to anon, authenticated;

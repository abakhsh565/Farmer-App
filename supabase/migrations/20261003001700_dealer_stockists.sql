-- Farmer App · migration 0017 · where a product can be bought
--
-- The last link in the chain the PRD requires:
--
--   crop problem → approved treatment → canonical product → live listings
--
-- The scan result already knew the first three. It got the fourth from a fixture
-- written beside the treatment, which is how the same shop ended up quoted at two
-- different prices on two screens — and how a recommendation could quietly become
-- a function of which shop had stock.
--
-- So the listings are read, not authored: one function over `dealer_products`
-- joined to the dealer projection, filtered to shops that have *not* said they are
-- out, ordered by real distance. `in_stock is null` means the dealer system did
-- not report it; those rows stay, because a shop that has not answered is not a
-- shop that has none.

create or replace function public.dealer_stockists_for(
  p_slug      text,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_radius_km integer default null
)
returns table (
  dealer_id   uuid,
  shop_name   text,
  distance_km numeric,
  unit_price  numeric,
  currency    text,
  pack_size   text,
  in_stock    boolean,
  sync_state  text,
  synced_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid;
  v_origin  extensions.geography;
  v_radius  integer;
begin
  -- An unknown slug is an empty answer, not an error: the app may cite a product
  -- the catalogue has not ingested yet, and a farmer cannot act on an exception.
  select c.id into v_product from public.canonical_products c where c.slug = p_slug;
  if v_product is null then
    return;
  end if;

  -- The app's known area first (it may be a guest's, or a temporary one); the
  -- signed-in farmer's saved location otherwise.
  if p_lat is not null and p_lon is not null then
    v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
  else
    select f.geog into v_origin from public.farmer_profiles f where f.party_id = auth.uid();
  end if;

  -- With no origin there is no honest answer to "who is near you", and inventing
  -- one would put a distance in front of a farmer that means nothing. Empty.
  if v_origin is null then
    return;
  end if;

  v_radius := least(coalesce(p_radius_km, 10), 100);

  return query
    select
      d.id,
      d.shop_name,
      round((extensions.ST_Distance(d.geog, v_origin) / 1000.0)::numeric, 1),
      p.unit_price,
      p.currency,
      p.pack_size,
      p.in_stock,
      d.sync_state,
      p.synced_at
    from public.dealer_products p
    join public.dealer_profiles d on d.id = p.dealer_id
    where p.canonical_product_id = v_product
      -- Confirmed-out is excluded; unreported is kept, as unknown rather than none.
      and p.in_stock is distinct from false
      and d.geog is not null
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    order by d.geog operator(extensions.<->) v_origin
    limit 50;
end;
$$;

comment on function public.dealer_stockists_for(text, double precision, double precision, integer) is
  'Nearest shops with a canonical product (by slug), inside a 100 km ceiling. Confirmed-out stock is excluded, unreported stock is returned as NULL so the screen can say "not reported" rather than "none".';

-- Browsing and scanning are guest-capable, so this is callable without a session.
-- Safe: it reads the dealer projection that is already anon-readable, and it
-- exposes no farmer data beyond a distance the caller supplied the origin for.
grant execute on function public.dealer_stockists_for(text, double precision, double precision, integer) to anon, authenticated;

-- Farmer App · migration 0022 · the reference set that makes the pipeline visible
--
-- The app was structurally complete and visibly empty: zero dealers, zero
-- listings, zero rates. Every "0 dealers within 10 km" and "No rate today" the
-- UI showed was therefore correct and useless — there was no way to tell a
-- working search from a broken one, and no way to walk the chain the PRD cares
-- about (crop problem → treatment → canonical product → shops listing it).
--
-- This seeds that chain. What it deliberately does NOT do is pretend the data is
-- official:
--
--   · Dealers are attributed to `source_system = 'reference_seed'` and left
--     `sync_state = 'stale'` with a two-day-old `synced_at`. They did not come
--     from the dealer POS, so a projection-freshness indicator must not claim
--     they did, and `verified_at` stays NULL because nobody has visited them.
--
--   · Rates are attributed to the pre-existing `research_feed` source, whose own
--     description already says its rows are not authoritative and are served
--     through the same path precisely so they cannot be mistaken for AMIS data.
--     AMIS is not credited with a single number here.
--
--   · No phone number is invented for a shop. An unlisted number is "unknown",
--     and a wrong one sends a farmer to a stranger.
--
-- Deleting all of it is a one-line change: `delete from public.dealer_profiles
-- where source_system = 'reference_seed'` cascades to the listings.

-- ---------------------------------------------------------------------------
-- Dealers
-- ---------------------------------------------------------------------------
--
-- Placed along the Wazirabad–Gujranwala–Sialkot corridor, which is where the
-- app's default area and the three existing `areas` rows already sit, so the
-- radius search can be exercised at 5, 10 and 25 km without inventing geometry.

insert into public.dealer_profiles (
  source_system, source_ref, shop_name, address, lat, lon,
  verified_at, verification_source, opening_hours,
  synced_at, sync_state, is_accepting_requests
)
values
  ('reference_seed', 'wazirabad-al-madina',
   'Al-Madina Agriculture Store', 'Main G.T. Road, Wazirabad', 32.4390, 74.1180,
   null, 'pending_field_verification', '09:00–19:00 (Mon–Sat)',
   now() - interval '2 days', 'stale', true),

  ('reference_seed', 'wazirabad-kissan-centre',
   'Kissan Pesticides & Fertiliser Centre', 'Sabzi Mandi Road, Wazirabad', 32.4470, 74.1080,
   null, 'pending_field_verification', '08:30–18:30 (Mon–Sat)',
   now() - interval '2 days', 'stale', true),

  ('reference_seed', 'kot-ladha-chaudhry',
   'Chaudhry Agri Services', 'Chak Road, Kot Ladha', 32.5150, 74.0500,
   null, 'pending_field_verification', '09:00–18:00 (Mon–Sat)',
   now() - interval '3 days', 'stale', true),

  ('reference_seed', 'gujranwala-punjab-seed',
   'Punjab Seed & Pesticide Centre', 'Kutchery Road, Gujranwala', 32.1900, 74.1900,
   null, 'pending_field_verification', '09:00–20:00 (Mon–Sat)',
   now() - interval '2 days', 'stale', true),

  ('reference_seed', 'gujranwala-bashir-sons',
   'Bashir Sons Agri Traders', 'G.T. Road, Gujranwala', 32.2100, 74.2100,
   null, 'pending_field_verification', '09:00–19:00 (Mon–Sat)',
   now() - interval '4 days', 'stale', false),

  ('reference_seed', 'sialkot-agri-mart',
   'Sialkot Agri Mart', 'Paris Road, Sialkot', 32.4945, 74.5229,
   null, 'pending_field_verification', '09:30–19:00 (Mon–Sat)',
   now() - interval '6 days', 'stale', true)
on conflict (source_system, source_ref) do nothing;

-- ---------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------
--
-- The join that makes a treatment actionable: a canonical product from the
-- knowledge seed, listed by a shop, with the price the shop reported.
--
-- Two of these carry a NULL price and one a NULL stock figure on purpose. The
-- schema insists NULL is "not reported" and never 0, and the only way that rule
-- is proven is if a real row exercises it — a listing whose price is genuinely
-- unquoted must render as unquoted, not as free.

insert into public.dealer_products (
  dealer_id, source_system, source_ref, name, brand, category,
  canonical_product_id, pack_size, registration_no,
  available_qty, unit, unit_price, currency, in_stock, synced_at, sync_state
)
select
  d.id,
  'reference_seed',
  v.source_ref,
  v.name,
  v.brand,
  v.category,
  c.id,
  v.pack_size,
  c.registration_no,
  v.available_qty,
  'pack',
  v.unit_price,
  'PKR',
  v.in_stock,
  now() - interval '2 days',
  'stale'
from (values
  ('wazirabad-al-madina',   'wazirabad-al-madina-confidor',   'Confidor 20% SL',        'Bayer',    'insecticide', 'confidor', '100 ml', 24::numeric, 850::numeric, true),
  ('wazirabad-al-madina',   'wazirabad-al-madina-tilt',      'Tilt 250 EC',            'Syngenta', 'fungicide',   'tilt',     '250 ml', 11::numeric, 1450::numeric, true),
  ('wazirabad-kissan-centre','wazirabad-kissan-confidor',    'Confidor 20% SL',        'Bayer',    'insecticide', 'confidor', '250 ml',  6::numeric, 1980::numeric, true),
  ('wazirabad-kissan-centre','wazirabad-kissan-roundup',     'Roundup',                'Bayer',    'herbicide',   'roundup',  '1 litre', null::numeric, null::numeric, null),
  ('kot-ladha-chaudhry',    'kot-ladha-tilt',                'Tilt 250 EC',            'Syngenta', 'fungicide',   'tilt',     '250 ml',  4::numeric, 1495::numeric, true),
  ('gujranwala-punjab-seed','gujranwala-punjab-roundup',     'Roundup',                'Bayer',    'herbicide',   'roundup',  '500 ml', 30::numeric, 760::numeric, true),
  ('gujranwala-punjab-seed','gujranwala-punjab-confidor',    'Confidor 20% SL',        'Bayer',    'insecticide', 'confidor', '100 ml', 18::numeric, 880::numeric, true),
  ('gujranwala-bashir-sons','gujranwala-bashir-tilt',        'Tilt 250 EC',            'Syngenta', 'fungicide',   'tilt',     '250 ml',  0::numeric, 1520::numeric, false),
  ('sialkot-agri-mart',     'sialkot-agri-mart-roundup',     'Roundup',                'Bayer',    'herbicide',   'roundup',  '1 litre',  9::numeric, 1380::numeric, true),
  ('sialkot-agri-mart',     'sialkot-agri-mart-tilt',        'Tilt 250 EC',            'Syngenta', 'fungicide',   'tilt',     '250 ml', null::numeric, null::numeric, true)
) as v(dealer_ref, source_ref, name, brand, category, product_slug, pack_size, available_qty, unit_price, in_stock)
join public.dealer_profiles d
  on d.source_system = 'reference_seed' and d.source_ref = v.dealer_ref
join public.canonical_products c on c.slug = v.product_slug
on conflict (dealer_id, source_system, source_ref) do nothing;

-- ---------------------------------------------------------------------------
-- Rates
-- ---------------------------------------------------------------------------
--
-- Dated with `current_date` rather than a fixed day, because a rate that is
-- always "yesterday" is not a useful fixture for testing the freshness rules —
-- the app must be able to show a recent rate as recent and the schema's 36-hour
-- window has to mean something. The `raw` column carries the disclosure that
-- travels with the row.

insert into public.market_observations (
  source_code, commodity_code, market_name, district, observed_on,
  min_price, max_price, modal_price, currency, unit, arrivals_tonnes, raw
)
values
  ('research_feed', 'wheat',  'Gujranwala Mandi', 'Gujranwala', current_date, 3850, 4050, 3950, 'PKR', '40kg', 118.5,
   '{"seed":"reference","note":"Illustrative row for pipeline verification. Not an official release and not an AMIS figure."}'::jsonb),

  ('research_feed', 'wheat',  'Wazirabad Mandi',  'Gujranwala', current_date, 3820, 4020, 3920, 'PKR', '40kg', 42.0,
   '{"seed":"reference","note":"Illustrative row for pipeline verification. Not an official release and not an AMIS figure."}'::jsonb),

  ('research_feed', 'cotton', 'Sialkot Mandi',    'Sialkot',    current_date, 8300, 8700, 8500, 'PKR', '40kg', null,
   '{"seed":"reference","note":"Illustrative row for pipeline verification. Not an official release and not an AMIS figure."}'::jsonb),

  ('research_feed', 'rice',   'Gujranwala Mandi', 'Gujranwala', current_date, 3600, 3800, 3700, 'PKR', '40kg', 65.5,
   '{"seed":"reference","note":"Illustrative row for pipeline verification. Not an official release and not an AMIS figure."}'::jsonb),

  ('research_feed', 'maize',  'Wazirabad Mandi',  'Gujranwala', current_date, 2100, 2300, 2200, 'PKR', '40kg', 12.0,
   '{"seed":"reference","note":"Illustrative row for pipeline verification. Not an official release and not an AMIS figure."}'::jsonb)
on conflict (source_code, commodity_code, market_name, observed_on) do nothing;

-- Farmer App · migration 0011 · market observations and weather readings
--
-- PRD, market: AMIS (or the approved source) -> ingestion adapter -> validation
-- -> normalisation -> observations -> internal market API. Daily updates
-- supported. Historical observations preserved. Never turn missing values into
-- zero. Never invent rates.
--
-- PRD, weather: an approved provider abstraction, WeatherAPI.com as the initial
-- MVP candidate, but the application must not be hard-coded to the provider. The
-- weather shown in the UI and the weather used by AI come from the same
-- normalised service. Advice is paused when the reading is unusable.
--
-- Both rules are implemented as nullability plus a serving function that reports
-- freshness, rather than as instructions to whoever writes the next screen.

-- ---------------------------------------------------------------------------
-- Sources and commodities
-- ---------------------------------------------------------------------------

create table public.market_sources (
  code         text primary key,
  name         text not null,
  kind         text not null check (kind in ('amis_punjab', 'dealer_submitted', 'manual_entry', 'research_feed')),
  -- Where the adapter fetches from. NULL means the source is collected another
  -- way (a dealer pushing figures), which is legitimate and must be expressible.
  endpoint_url text,
  is_active    boolean not null default true,
  notes        text
);

insert into public.market_sources (code, name, kind, notes) values
  ('amis_punjab', 'AMIS Punjab', 'amis_punjab', 'Approved agricultural market information source. The adapter normalises its records; no key is invented here.'),
  ('research_feed', 'Research feed', 'research_feed', 'Non-authoritative rows used in development. Served through the same path so it cannot be mistaken for live AMIS data.');

create table public.market_commodities (
  code       text primary key,
  name_en    text not null,
  name_ur    text not null,
  names_local jsonb not null default '{}'::jsonb,
  unit       text not null default '40kg',
  is_active  boolean not null default true
);

insert into public.market_commodities (code, name_en, name_ur, unit) values
  ('wheat',     'Wheat',     'گندم',   '40kg'),
  ('cotton',    'Cotton',    'کپاس',   '40kg'),
  ('rice',      'Rice',      'چاول',   '40kg'),
  ('maize',     'Maize',     'مکئی',   '40kg'),
  ('sugarcane', 'Sugarcane', 'گنا',    '40kg'),
  ('potato',    'Potato',    'آلو',    '40kg'),
  ('onion',     'Onion',     'پیاز',   '40kg'),
  ('gram',      'Gram',      'چنا',    '40kg');

-- ---------------------------------------------------------------------------
-- Observations
-- ---------------------------------------------------------------------------

-- Every price column is nullable, and at least one must be present. A missing
-- minimum is NULL and displays as "not reported"; it can never be stored as 0,
-- because 0 is a real price and the two must stay distinguishable.
create table public.market_observations (
  id             bigserial primary key,
  source_code    text not null references public.market_sources (code),
  commodity_code text not null references public.market_commodities (code),
  market_name    text not null,
  district       text,
  observed_on    date not null,
  min_price      numeric check (min_price >= 0),
  max_price      numeric check (max_price >= 0),
  modal_price    numeric check (modal_price >= 0),
  currency       text not null default 'PKR',
  unit           text not null default '40kg',
  -- Volume traded, when the source reports it. NULL is "not reported".
  arrivals_tonnes numeric check (arrivals_tonnes >= 0),
  -- The row exactly as received, so a normalisation mistake is debuggable and
  -- the original is never lost.
  raw            jsonb not null default '{}'::jsonb,
  ingested_at    timestamptz not null default now(),
  -- Which ingestion run produced this, for tracing a bad batch.
  run_id         bigint,
  constraint market_observations_some_price check (
    min_price is not null or max_price is not null or modal_price is not null
  ),
  constraint market_observations_price_order check (
    min_price is null or max_price is null or min_price <= max_price
  ),
  -- One row per source, commodity, market and day. Re-ingesting a day updates
  -- rather than duplicating, which is what makes a re-run safe.
  unique (source_code, commodity_code, market_name, observed_on)
);

create index market_observations_lookup_idx
  on public.market_observations (commodity_code, observed_on desc);

create index market_observations_market_idx
  on public.market_observations (market_name, commodity_code, observed_on desc);

comment on column public.market_observations.min_price is
  'NULL means the source did not report a minimum. It is never coerced to zero, because zero is a valid price and the two must remain distinguishable.';

-- Historical rows are never deleted or rewritten by the serving path.
comment on table public.market_observations is
  'Append-and-update only, keyed by source/commodity/market/day. History is preserved so a past rate can always be reconstructed from the raw payload.';

create table public.market_ingestion_runs (
  id             bigserial primary key,
  source_code    text not null references public.market_sources (code),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  rows_seen      integer not null default 0,
  rows_written   integer not null default 0,
  rows_rejected  integer not null default 0,
  -- Why rows were rejected, aggregated so a systematic parse error is obvious.
  rejection_reasons jsonb not null default '{}'::jsonb,
  error          text
);

-- ---------------------------------------------------------------------------
-- Internal market API
-- ---------------------------------------------------------------------------

-- The only way prices reach a client. Reports age and never invents a figure:
-- a commodity with no recent observation is returned with has_recent false
-- rather than an estimate.
create or replace function public.market_rates(
  p_commodity text default null,
  p_max_age_hours integer default 36
)
returns table (
  commodity_code text,
  commodity_name_en text,
  commodity_name_ur text,
  unit           text,
  market_name    text,
  observed_on    date,
  age_hours      numeric,
  min_price      numeric,
  max_price      numeric,
  modal_price    numeric,
  currency       text,
  source_code    text,
  source_name    text,
  is_recent      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with latest as (
    select distinct on (o.commodity_code, o.market_name)
      o.*
    from public.market_observations o
    where (p_commodity is null or o.commodity_code = p_commodity)
    order by o.commodity_code, o.market_name, o.observed_on desc, o.ingested_at desc
  )
  select
    l.commodity_code,
    c.name_en,
    c.name_ur,
    l.unit,
    l.market_name,
    l.observed_on,
    round((extract(epoch from (now() - l.observed_on::timestamptz)) / 3600.0)::numeric, 1),
    l.min_price,
    l.max_price,
    l.modal_price,
    l.currency,
    l.source_code,
    s.name,
    (l.observed_on >= (current_date - make_interval(hours => greatest(1, p_max_age_hours))::interval)::date)
  from latest l
  join public.market_commodities c on c.code = l.commodity_code
  join public.market_sources s on s.code = l.source_code
  order by c.name_en, l.market_name;
$$;

comment on function public.market_rates(text, integer) is
  'Serving path for both the UI and the AI. `is_recent` is reported rather than filtered, so a stale rate can be shown as stale instead of silently disappearing or being refreshed with a guess.';

-- ---------------------------------------------------------------------------
-- Weather provider abstraction
-- ---------------------------------------------------------------------------

create table public.weather_providers (
  code            text primary key,
  name            text not null,
  -- The PRD names WeatherAPI.com as the initial commercial candidate. The
  -- application talks to this table, not to that vendor.
  is_initial_candidate boolean not null default false,
  requires_api_key boolean not null default true,
  attribution     text,
  is_active       boolean not null default true,
  notes           text
);

insert into public.weather_providers (code, name, is_initial_candidate, attribution, notes) values
  ('weatherapi', 'WeatherAPI.com', true, 'Weather data by WeatherAPI.com',
   'Initial MVP candidate named in the PRD. Referenced only by this row; switching provider means adding a row and an adapter, not editing screens.'),
  ('research_fixture', 'Research fixture', false, 'Synthetic readings for development',
   'Development-only readings. Marked so the UI cannot present them as live weather.');

-- Readings are cached per rounded location cell, so a village shares one fetch
-- instead of one per farmer.
create table public.weather_readings (
  id             bigserial primary key,
  provider_code  text not null references public.weather_providers (code),
  lat_cell       numeric(8,3) not null,
  lon_cell       numeric(8,3) not null,
  -- When the provider says it was observed, and when we fetched it. Both matter:
  -- a fresh fetch of a stale observation is still stale.
  observed_at    timestamptz not null,
  fetched_at     timestamptz not null default now(),
  temp_c         numeric(5,2),
  feels_like_c   numeric(5,2),
  humidity_pct   integer check (humidity_pct between 0 and 100),
  precip_mm      numeric(7,2) check (precip_mm >= 0),
  wind_kph       numeric(6,2) check (wind_kph >= 0),
  wind_dir       text,
  condition_text text,
  condition_code text,
  -- Forecast rows are separated from current conditions by this, not by time.
  kind           text not null default 'current' check (kind in ('current', 'hourly', 'daily')),
  valid_from     timestamptz,
  valid_to       timestamptz,
  raw            jsonb not null default '{}'::jsonb,
  -- Set when the adapter could not reach the provider: the row records the
  -- failure so the UI can say "cannot read weather" instead of showing nothing.
  fetch_error    text,
  constraint weather_readings_cell check (lat_cell between -90 and 90 and lon_cell between -180 and 180)
);

create index weather_readings_lookup_idx
  on public.weather_readings (lat_cell, lon_cell, kind, observed_at desc);

comment on table public.weather_readings is
  'Normalised readings from whichever provider is active. Both the UI and the AI read this table, which is what makes "same source in both places" structural.';

create table public.weather_ingestion_runs (
  id             bigserial primary key,
  provider_code  text not null references public.weather_providers (code),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'failed')),
  cells_requested integer not null default 0,
  cells_written  integer not null default 0,
  error          text
);

-- Freshness, stated in one place so the UI and the advice engine cannot disagree
-- about whether a reading is usable.
create or replace function public.weather_freshness(p_reading_id bigint)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when r.fetch_error is not null then 'unavailable'
    when r.observed_at > now() - interval '90 minutes' then 'fresh'
    when r.observed_at > now() - interval '6 hours' then 'stale'
    else 'expired'
  end
  from public.weather_readings r
  where r.id = p_reading_id;
$$;

-- The gate the advice engine must consult. A reading that is unavailable, or
-- older than the usable window, pauses advice rather than being used anyway.
create or replace function public.weather_is_usable(
  p_lat double precision,
  p_lon double precision
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.weather_readings r
    where r.kind = 'current'
      and r.lat_cell = round(p_lat::numeric, 3)
      and r.lon_cell = round(p_lon::numeric, 3)
      and r.fetch_error is null
      and r.observed_at > now() - interval '90 minutes'
  );
$$;

comment on function public.weather_is_usable(double precision, double precision) is
  'Returns false when there is no current, error-free reading inside the freshness window. Advice built on weather must check this first and pause rather than guess.';

create or replace function public.latest_weather(
  p_lat double precision,
  p_lon double precision
)
returns table (
  provider_code  text,
  provider_name  text,
  attribution    text,
  observed_at    timestamptz,
  age_minutes    numeric,
  freshness      text,
  is_usable      boolean,
  temp_c         numeric,
  humidity_pct   integer,
  precip_mm      numeric,
  wind_kph       numeric,
  condition_text text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with r as (
    select wr.*
    from public.weather_readings wr
    where wr.kind = 'current'
      and wr.lat_cell = round(p_lat::numeric, 3)
      and wr.lon_cell = round(p_lon::numeric, 3)
    order by wr.observed_at desc
    limit 1
  )
  select
    r.provider_code,
    p.name,
    p.attribution,
    r.observed_at,
    round((extract(epoch from (now() - r.observed_at)) / 60.0)::numeric, 0),
    case
      when r.fetch_error is not null then 'unavailable'
      when r.observed_at > now() - interval '90 minutes' then 'fresh'
      when r.observed_at > now() - interval '6 hours' then 'stale'
      else 'expired'
    end,
    (r.fetch_error is null and r.observed_at > now() - interval '90 minutes'),
    r.temp_c,
    r.humidity_pct,
    r.precip_mm,
    r.wind_kph,
    r.condition_text
  from r
  join public.weather_providers p on p.code = r.provider_code;
$$;

comment on function public.latest_weather(double precision, double precision) is
  'Single weather read path for the app. Returns freshness and is_usable alongside the numbers, so no caller has to decide for itself whether the reading is trustworthy.';

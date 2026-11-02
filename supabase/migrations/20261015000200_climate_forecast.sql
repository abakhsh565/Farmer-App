-- Farmer App · migration 0027 · district forecast: storage + provenance
--
-- Step 1 asks for weather *history and forecast*. History landed in migration
-- 0026 (NASA POWER, keyless, CC BY 4.0). Forecast could not come from the same
-- vendor: NASA POWER's own documentation describes its temporal services as
-- hourly/daily/monthly/climatology, all near-real-time with a 2-3 day lag, and
-- documents no forecast product. Building "forecast" out of lagged observations
-- would have been a lie with a column name.
--
-- So the forecast source is WeatherAPI.com — the vendor the PRD already named as
-- the initial MVP candidate and that `weather_providers` already carries as
-- `is_initial_candidate` with its required attribution. That row needs no change
-- here; what is new is the table the adapter writes, and the provenance entry
-- that records the licence question honestly.
--
-- Licence status, recorded rather than assumed: WeatherAPI.com's own site
-- advertises the free plan with "commercial use is allowed", while its general
-- Terms and Conditions contain a clause saying site materials may not be used
-- commercially without a licence. Two pages, two answers, so the registry row
-- below is `needs_permission` and `commercial_ok = false` until that is resolved
-- in writing. The adapter is written and waits; nothing here pretends otherwise.

-- ---------------------------------------------------------------------------
-- Provenance for the forecast feed
-- ---------------------------------------------------------------------------

insert into public.intel_sources (
  code, name, kind, license, commercial_ok, coverage, update_cadence,
  access_method, status, notes
) values (
  'weatherapi',
  'WeatherAPI.com forecast',
  'forecast_risk',
  'Free tier advertised as commercial-use-allowed; the site T&C contains a conflicting clause — written confirmation pending',
  false,
  'global incl. Pakistan; 3-day forecast on the free plan',
  'daily',
  'api',
  'needs_permission',
  'PRD initial MVP candidate. Key lives in the Edge Function secret WEATHERAPI_KEY, never in the client bundle. Cited in the intel feed as forecast_risk only — never as outbreak proof.'
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- District forecasts
-- ---------------------------------------------------------------------------

-- Perishable by nature, so `issued_on` is part of the key rather than a column
-- that gets overwritten: re-pulling the same day upserts the same rows (a re-run
-- is safe), while tomorrow's pull adds new rows beside today's — which is what
-- makes forecast drift visible instead of silently rewriting what was believed
-- yesterday.
--
-- Every measure is nullable, and a day the vendor did not report is not stored at
-- all. Zero rain is a fact; a missing day is not, and the two must stay
-- distinguishable exactly as they do in `climate_observations`.
create table public.climate_forecasts (
  id            bigserial primary key,
  provider_code text not null references public.weather_providers (code),
  district_code text not null references public.districts (code),
  -- The day being forecast, and the day the forecast was issued.
  forecast_on   date not null,
  issued_on     date not null default current_date,
  tmax_c        numeric,
  tmin_c        numeric,
  precip_mm     numeric check (precip_mm is null or precip_mm >= 0),
  humidity_pct  numeric check (humidity_pct is null or (humidity_pct between 0 and 100)),
  wind_kph      numeric check (wind_kph is null or wind_kph >= 0),
  -- The vendor's own day object, so a normalisation mistake stays debuggable.
  raw           jsonb not null default '{}'::jsonb,
  ingested_at   timestamptz not null default now(),
  run_id        bigint,
  -- A row whose "forecast" is for a day that has already passed is a re-labelled
  -- observation. The database refuses it rather than trusting every future
  -- adapter to get this right.
  constraint climate_forecasts_horizon check (forecast_on >= issued_on),
  constraint climate_forecasts_temps check (
    tmax_c is null or tmin_c is null or tmin_c <= tmax_c
  ),
  unique (provider_code, district_code, forecast_on, issued_on)
);

create index climate_forecasts_lookup_idx
  on public.climate_forecasts (district_code, forecast_on);

comment on table public.climate_forecasts is
  'District forecasts, keyed by issue date so a later issue does not overwrite an earlier belief. Written only by the forecast-ingest function.';

comment on column public.climate_forecasts.issued_on is
  'The day this forecast was issued. Part of the unique key: re-pulling the same day updates, a new day adds. Forecast drift is data, not an overwrite.';

-- ---------------------------------------------------------------------------
-- RLS: public reads, server-only writes
-- ---------------------------------------------------------------------------

alter table public.climate_forecasts enable row level security;

create policy climate_forecasts_read on public.climate_forecasts
  for select to anon, authenticated using (true);

revoke insert, update, delete on public.climate_forecasts from authenticated;

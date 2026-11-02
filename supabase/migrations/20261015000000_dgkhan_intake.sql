-- Farmer App · migration 0026 · DG Khan intake: districts, climate, import runs
--
-- Step 1 of the Crop Intelligence build (DG Khan division pilot). No invented
-- endpoints: districts are reference data with headquarters coordinates from
-- public gazetteers; climate_observations stores normalised NASA POWER /
-- Open-Meteo district history written by the climate-ingest function; the two
-- run tables record every ingestion attempt so a failed fetch is visible rather
-- than silent. Nothing here claims a live AMIS or advisory API exists.

-- ---------------------------------------------------------------------------
-- Districts (DG Khan division pilot)
-- ---------------------------------------------------------------------------

create table public.districts (
  code text primary key,
  name_en text not null,
  name_ur text not null,
  division text not null,
  province text not null default 'Punjab',
  hq_lat double precision not null check (hq_lat between -90 and 90),
  hq_lon double precision not null check (hq_lon between -180 and 180),
  is_active boolean not null default true
);

comment on table public.districts is
  'Reference districts for the intelligence pilot. Coordinates are headquarters cities (approximate fetch points), never farm locations.';

insert into public.districts (code, name_en, name_ur, division, hq_lat, hq_lon) values
  ('dera_ghazi_khan', 'Dera Ghazi Khan', 'ڈیرہ غازی خان', 'Dera Ghazi Khan', 30.0325, 70.6402),
  ('taunsa',          'Taunsa',          'تونسہ',        'Dera Ghazi Khan', 30.7056, 70.6578),
  ('rajanpur',        'Rajanpur',        'راجن پور',     'Dera Ghazi Khan', 29.1038, 70.3202),
  ('layyah',          'Layyah',          'لیہ',          'Dera Ghazi Khan', 30.9648, 70.9399),
  ('muzaffargarh',    'Muzaffargarh',    'مظفر گڑھ',     'Dera Ghazi Khan', 30.0744, 71.1847),
  ('kot_addu',        'Kot Addu',        'کوٹ ادو',       'Dera Ghazi Khan', 30.4667, 70.9667)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The climate provider, registered before anything references it
-- ---------------------------------------------------------------------------

-- `climate_observations.provider_code` is a foreign key into the provider
-- registry, and NASA POWER was not in it: the registry was seeded with the
-- current-conditions vendors only, and the history source is a different kind of
-- provider — keyless, licensed CC BY 4.0, and carrying an attribution obligation
-- rather than a secret. Registered here, with the attribution the licence
-- requires, rather than relaxing the constraint to let an unknown code through.
insert into public.weather_providers (
  code, name, is_initial_candidate, requires_api_key, attribution, notes
) values (
  'nasa_power',
  'NASA POWER agroclimatology',
  false,
  false,
  'NASA POWER (NASA Langley Research Center) — data provided by the POWER Project, CC BY 4.0',
  'Keyless daily district history from 1981, used for climate features rather than current conditions. NASA asks for no more than ~5 concurrent requests; the ingest function makes one per call.'
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Climate observations (district history, normalised)
-- ---------------------------------------------------------------------------

-- One row per provider, district and day. Missing values stay NULL: a day the
-- vendor did not report is not a day of zero rain.
create table public.climate_observations (
  id bigserial primary key,
  provider_code text not null references public.weather_providers (code),
  district_code text not null references public.districts (code),
  observed_on date not null,
  tmax_c numeric,
  tmin_c numeric,
  precip_mm numeric check (precip_mm is null or precip_mm >= 0),
  humidity_pct numeric check (humidity_pct is null or (humidity_pct between 0 and 100)),
  wind_kph numeric check (wind_kph is null or wind_kph >= 0),
  raw jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now(),
  run_id bigint,
  unique (provider_code, district_code, observed_on)
);

create index climate_observations_lookup_idx
  on public.climate_observations (district_code, observed_on desc);

comment on table public.climate_observations is
  'District climate history for suitability and risk features. Re-pulling a range upserts rather than duplicating, so a re-run is safe.';

create table public.climate_ingestion_runs (
  id bigserial primary key,
  provider_code text not null references public.weather_providers (code),
  district_code text references public.districts (code),
  range_start date,
  range_end date,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  rows_seen integer not null default 0,
  rows_written integer not null default 0,
  error text
);

comment on table public.climate_ingestion_runs is
  'Every climate pull is recorded. A district with no rows and no failed run was never attempted; one with a failed run is known-broken.';

-- ---------------------------------------------------------------------------
-- Advisory import runs (automated attempts, honestly recorded)
-- ---------------------------------------------------------------------------

create table public.advisory_import_runs (
  id bigserial primary key,
  source_code text not null references public.intel_sources (code),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  rows_seen integer not null default 0,
  rows_written integer not null default 0,
  rows_rejected integer not null default 0,
  error text
);

comment on table public.advisory_import_runs is
  'Every advisory fetch attempt is recorded, including failures. A missing machine-readable feed is a failed run with a reason, never silently empty.';

-- ---------------------------------------------------------------------------
-- RLS: public reads, server-only writes
-- ---------------------------------------------------------------------------

alter table public.districts enable row level security;
alter table public.climate_observations enable row level security;
alter table public.climate_ingestion_runs enable row level security;
alter table public.advisory_import_runs enable row level security;

create policy districts_read on public.districts
  for select to anon, authenticated using (is_active);

create policy climate_observations_read on public.climate_observations
  for select to anon, authenticated using (true);

create policy climate_runs_read on public.climate_ingestion_runs
  for select to authenticated using (true);

create policy advisory_runs_read on public.advisory_import_runs
  for select to authenticated using (true);

revoke insert, update, delete on public.districts from authenticated;
revoke insert, update, delete on public.climate_observations from authenticated;
revoke insert, update, delete on public.climate_ingestion_runs from authenticated;
revoke insert, update, delete on public.advisory_import_runs from authenticated;

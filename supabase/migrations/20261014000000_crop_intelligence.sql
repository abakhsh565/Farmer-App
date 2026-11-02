-- Farmer App · migration 0025 · crop intelligence: dynamic-radius local feed
--
-- Brief §2 + §5, first backend slice. No hardcoded 10km: radius is a validated
-- metres parameter (1..500000) and directly controls ST_DWithin eligibility.
-- Larger radius includes more rows; it never raises severity/confidence.
--
-- Reuses: extensions.geography + GiST pattern from dealers_within_radius,
-- crop_catalog for crop scope, recommendations/farmer_insight_feed as the
-- canonical advice surface (this feed returns observations/advisories, it does
-- not duplicate recommendations).

-- ---------------------------------------------------------------------------
-- Source registry (brief §5: source data stays separate + provenance)
-- ---------------------------------------------------------------------------
create table public.intel_sources (
  code text primary key,
  name text not null,
  kind text not null check (kind in ('farmer_report', 'expert', 'official_advisory', 'forecast_risk', 'market_feed', 'weather_feed', 'soil_feed', 'stats_feed')),
  endpoint_url text,
  license text,
  commercial_ok boolean,
  coverage text,
  update_cadence text,
  access_method text not null default 'manual_csv' check (access_method in ('api', 'manual_csv', 'platform', 'dashboard_doc')),
  status text not null default 'manual_import' check (status in ('verified_api', 'manual_import', 'needs_permission', 'unavailable')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.intel_sources is
  'Registry of every upstream the intelligence feed may cite. A visible page is not an API: status stays manual_import until endpoint + license are verified.';

insert into public.intel_sources (code, name, kind, license, commercial_ok, coverage, update_cadence, access_method, status, notes) values
  ('platform_reports', 'Farmer reports (this app)', 'farmer_report', 'platform terms', true, 'per-report location', 'event-driven', 'platform', 'verified_api', 'First-party observations collected by community_create_post path; evidence=farmer_report until verified.'),
  ('expert_network', 'Expert verifications', 'expert', 'platform terms', true, 'per-report location', 'event-driven', 'platform', 'verified_api', 'Uses expert_verifications badge; evidence=expert_verified only after grant_expert_verification.'),
  ('open_meteo', 'Open-Meteo forecast/history', 'forecast_risk', 'CC BY 4.0 data; free API non-commercial only', false, 'global incl. Pakistan, 16-day forecast, ERA5 history', 'model-dependent', 'api', 'needs_permission', 'Free tier is non-commercial: budget paid plan for production or choose another vendor. Used only for forecast_risk, never as outbreak proof.'),
  ('nasa_power', 'NASA POWER agroclimatology', 'weather_feed', 'CC BY 4.0', true, 'global incl. Pakistan, daily from 1981', '2-7 day latency', 'api', 'verified_api', 'Best free commercial-safe history source. Point API max 20 params; avoid >5 concurrent.'),
  ('soilgrids', 'ISRIC SoilGrids 250m', 'soil_feed', 'CC BY 4.0 maps; REST API paused', true, 'global incl. Pakistan, static maps', 'irregular model releases', 'api', 'unavailable', 'REST paused: use WCS/WebDAV + cache. Never infer field precision from district.'),
  ('pbs_stats', 'Pakistan Bureau of Statistics agriculture', 'stats_feed', 'PBS dissemination policy, confirm per-product tier', true, 'national/province/district, 121 crops on dashboard', 'seasonal Rabi/Kharif', 'dashboard_doc', 'manual_import', 'Publications mostly PDF; no verified crop API. Manual CSV import path.'),
  ('amis_punjab', 'AMIS Punjab market rates', 'market_feed', 'unconfirmed: seek permission', false, 'Punjab mandis (list unconfirmed)', 'daily (unconfirmed)', 'dashboard_doc', 'needs_permission', 'amis.pk pages verified as pages only; no documented public API. Never scrape without permission.'),
  ('punjab_advisory', 'Punjab Agriculture crop advisories', 'official_advisory', 'unconfirmed: seek permission', false, 'Punjab districts (unconfirmed)', 'irregular', 'dashboard_doc', 'needs_permission', 'agripunjab.gov.pk/crop_advisory unreachable from research network; treat as manual import.');

-- ---------------------------------------------------------------------------
-- Crop reports: farmer + expert observations with geography
-- ---------------------------------------------------------------------------
create table public.crop_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.parties (id) on delete set null,
  crop_code text references public.crop_catalog (code),
  topic text not null check (topic in ('pest', 'disease', 'weed', 'water', 'weather_damage', 'other')),
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 4000),
  evidence text not null default 'farmer_report' check (evidence in ('farmer_report', 'expert_verified', 'official_advisory', 'forecast_risk')),
  status text not null default 'published' check (status in ('pending', 'published', 'rejected')),
  visibility text not null default 'public' check (visibility in ('public', 'hidden')),
  -- Approximate location only. Clients must round before insert; the feed never
  -- returns lat/lon, only distance_m + area_label.
  geog extensions.geography(Point, 4326) not null,
  area_label text not null,
  district text,
  cluster_id uuid,
  observed_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '21 days',
  source_code text not null default 'platform_reports' references public.intel_sources (code),
  source_ref text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  constraint crop_reports_expiry check (expires_at > observed_at)
);

create index crop_reports_geog_idx on public.crop_reports using gist (geog)
  where status = 'published' and visibility = 'public';
create index crop_reports_crop_time_idx on public.crop_reports (crop_code, observed_at desc)
  where status = 'published' and visibility = 'public';
create unique index crop_reports_idempotency_idx on public.crop_reports (reporter_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.crop_reports.geog is
  'Approximate report location (~village cell, never the exact field). Feed returns distance + area_label only.';

-- ---------------------------------------------------------------------------
-- Official advisories: district/region scope, never pinned to farmer coords
-- ---------------------------------------------------------------------------
create table public.agri_advisories (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null,
  crop_code text references public.crop_catalog (code),
  topic text not null check (topic in ('pest', 'disease', 'weed', 'water', 'weather_damage', 'sowing', 'other')),
  district text,
  area_label text not null,
  geog extensions.geography(Point, 4326),
  source_code text not null default 'punjab_advisory' references public.intel_sources (code),
  source_ref text,
  source_url text,
  published_at timestamptz not null default now(),
  valid_until timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint agri_advisories_validity check (valid_until is null or valid_until > published_at)
);

create index agri_advisories_geog_idx on public.agri_advisories using gist (geog)
  where is_active;
create index agri_advisories_crop_time_idx on public.agri_advisories (crop_code, published_at desc)
  where is_active;

comment on table public.agri_advisories is
  'Official advisories are regional. A district advisory is served as regional fallback, never as a point at the farmer location.';

-- ---------------------------------------------------------------------------
-- RLS: public read paths stay honest; writes go through guarded functions
-- ---------------------------------------------------------------------------
alter table public.intel_sources enable row level security;
alter table public.crop_reports enable row level security;
alter table public.agri_advisories enable row level security;

create policy intel_sources_read on public.intel_sources
  for select to anon, authenticated using (is_active);

-- Guests read published public rows; exact coords are never selected by the
-- feed function, and direct select exposes area_label only via the feed.
-- This policy keeps direct reads to live rows; the feed remains the product path.
create policy crop_reports_read on public.crop_reports
  for select to anon, authenticated
  using (status = 'published' and visibility = 'public' and expires_at > now());

create policy agri_advisories_read on public.agri_advisories
  for select to anon, authenticated
  using (is_active and (valid_until is null or valid_until > now()));

revoke insert, update, delete on public.intel_sources from authenticated;
revoke insert, update, delete on public.crop_reports from authenticated;
revoke insert, update, delete on public.agri_advisories from authenticated;

-- ---------------------------------------------------------------------------
-- Submit a report: approximate location required, idempotent, never exact
-- ---------------------------------------------------------------------------
create or replace function public.submit_crop_report(
  p_reporter_id uuid,
  p_crop_code text,
  p_topic text,
  p_title text,
  p_body text,
  p_lat double precision,
  p_lon double precision,
  p_area_label text,
  p_district text default null,
  p_observed_at timestamptz default null,
  p_idempotency_key text default null
)
returns public.crop_reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.crop_reports;
  v_lat double precision;
  v_lon double precision;
begin
  if p_reporter_id is null then
    raise exception 'Reporting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;
  if p_lat is null or p_lat < -90 or p_lat > 90 or p_lon is null or p_lon < -180 or p_lon > 180 then
    raise exception 'Invalid report location.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_area_label), '') = '' then
    raise exception 'An approximate area label is required; exact field locations are never stored.' using errcode = 'check_violation';
  end if;
  -- Round to ~1.1km cell so the stored point is approximate by construction.
  v_lat := round(p_lat::numeric, 2)::double precision;
  v_lon := round(p_lon::numeric, 2)::double precision;

  insert into public.crop_reports (
    reporter_id, crop_code, topic, title, body, evidence, status, visibility,
    geog, area_label, district, observed_at, source_code, idempotency_key
  ) values (
    p_reporter_id, p_crop_code, p_topic, btrim(p_title), btrim(p_body),
    'farmer_report', 'published', 'public',
    extensions.ST_SetSRID(extensions.ST_MakePoint(v_lon, v_lat), 4326)::extensions.geography,
    btrim(p_area_label), p_district, coalesce(p_observed_at, now()), 'platform_reports', p_idempotency_key
  )
  returning * into v_report;
  return v_report;
exception
  when unique_violation then
    select * into v_report from public.crop_reports
     where reporter_id = p_reporter_id and idempotency_key = p_idempotency_key;
    if found then return v_report; end if;
    raise;
end;
$$;

comment on function public.submit_crop_report(uuid, text, text, text, text, double precision, double precision, text, text, timestamptz, text) is
  'Farmer report intake. Rounds coords to 2 decimals (approximate cell), labels evidence farmer_report, idempotent on (reporter, key).';

-- ---------------------------------------------------------------------------
-- Dynamic-radius local feed: radius in METRES drives ST_DWithin directly
-- ---------------------------------------------------------------------------
create or replace function public.intel_feed(
  p_lat double precision,
  p_lon double precision,
  p_radius_m double precision default 10000,
  p_crop_code text default null,
  p_topic text default null,
  p_limit integer default 20
)
returns table (
  id uuid,
  kind text,
  title text,
  summary text,
  crop_code text,
  topic text,
  evidence text,
  area_label text,
  district text,
  observed_at timestamptz,
  valid_until timestamptz,
  distance_m double precision,
  source_code text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin extensions.geography;
begin
  if p_lat is null or p_lat < -90 or p_lat > 90 or p_lon is null or p_lon < -180 or p_lon > 180 then
    raise exception 'Invalid origin: lat/lon required.' using errcode = 'check_violation';
  end if;
  -- Brief §2: 8km/10km/100km/500km examples; metres stored + validated.
  if p_radius_m is null or p_radius_m < 1 or p_radius_m > 500000 then
    raise exception 'Radius must be between 1 and 500000 metres.' using errcode = 'check_violation';
  end if;

  v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;

  return query
  with reports as (
    select
      r.id, 'report'::text as kind, r.title, r.body as summary, r.crop_code, r.topic,
      r.evidence, r.area_label, r.district, r.observed_at, r.expires_at as valid_until,
      extensions.ST_Distance(r.geog, v_origin) as distance_m, r.source_code, r.cluster_id,
      r.observed_at as sort_at,
      row_number() over (
        partition by coalesce(r.cluster_id, r.id)
        order by case when r.evidence = 'expert_verified' then 0 else 1 end, r.observed_at desc, r.id
      ) as dup_rank
    from public.crop_reports r
    where r.status = 'published'
      and r.visibility = 'public'
      and r.observed_at <= now()
      and r.expires_at > now()
      and (p_crop_code is null or r.crop_code = p_crop_code or r.crop_code is null)
      and (p_topic is null or r.topic = p_topic)
      and extensions.ST_DWithin(r.geog, v_origin, p_radius_m)
  ),
  advisories as (
    -- Regional rows: included when their point (if any) is in radius OR when
    -- they carry no point (district scope) as honest fallback, labelled advisory.
    select
      a.id, 'advisory'::text as kind, a.title, a.summary, a.crop_code, a.topic,
      'official_advisory'::text as evidence, a.area_label, a.district, a.published_at as observed_at,
      a.valid_until, null::double precision as distance_m, a.source_code, null::uuid as cluster_id,
      a.published_at as sort_at, 1 as dup_rank
    from public.agri_advisories a
    where a.is_active
      and a.published_at <= now()
      and (a.valid_until is null or a.valid_until > now())
      and (p_crop_code is null or a.crop_code = p_crop_code or a.crop_code is null)
      and (p_topic is null or a.topic = p_topic)
      and (a.geog is null or extensions.ST_DWithin(a.geog, v_origin, p_radius_m))
  )
  select c.id, c.kind, c.title, c.summary, c.crop_code, c.topic, c.evidence,
         c.area_label, c.district, c.observed_at, c.valid_until, c.distance_m, c.source_code
  from (select * from reports where dup_rank = 1 union all select * from advisories) c
  -- Radius changes eligibility only; severity/confidence are never derived here.
  order by c.sort_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.intel_feed(double precision, double precision, double precision, text, text, integer) is
  'Dynamic-radius local intelligence. p_radius_m (metres) is the ST_DWithin argument; dedupes by cluster (verified, newest wins); expires at read time; returns distance + area_label, never coordinates.';

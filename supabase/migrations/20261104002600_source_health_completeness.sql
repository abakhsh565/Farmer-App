-- Phase 9 · complete source-health inventory and actionable failures
--
-- The source-health read was run-row-driven. A source that had never run — AMIS
-- Punjab and the Punjab advisory feed — therefore vanished instead of appearing
-- as `never`, and the market branch showed only the latest run across all market
-- sources rather than the latest run per source. Provider error text was also
-- dropped for weather, climate, market and soil.
--
-- This replacement keeps the same admin-only signature and return shape, but
-- starts the market and advisory branches from the registered source inventory,
-- reads the latest run per source, and carries `last_error` in every detail.

create or replace function public.ingestion_health()
returns table (
  source_code text,
  source_name text,
  source_kind text,
  access_status text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status text,
  rows_written integer,
  freshness text,
  detail jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_capability('admin') then
    raise exception 'Ingestion health requires admin capability.' using errcode = 'insufficient_privilege';
  end if;

  return query
  with
  weather_run as (
    select r.* from public.weather_ingestion_runs r
     where r.provider_code = 'open_meteo'
     order by r.started_at desc, r.id desc limit 1
  ),
  weather_last as (
    select max(r.observed_at) as observed_at from public.weather_readings r
     where r.provider_code = 'open_meteo' and r.kind = 'current' and r.fetch_error is null
  ),
  climate_run as (
    select r.* from public.climate_ingestion_runs r
     where r.provider_code = 'nasa_power'
     order by r.started_at desc, r.id desc limit 1
  ),
  climate_last as (
    select max(o.observed_on)::timestamptz as observed_at from public.climate_observations o
     where o.provider_code = 'nasa_power'
  ),
  forecast_run as (
    select r.* from public.climate_ingestion_runs r
     where r.provider_code in ('weatherapi', 'open_meteo')
     order by r.started_at desc, r.id desc limit 1
  ),
  forecast_last as (
    select max(f.issued_on)::timestamptz as issued_at from public.climate_forecasts f
     where f.provider_code in ('weatherapi', 'open_meteo')
  ),
  market_run as (
    select distinct on (r.source_code)
      r.source_code, r.started_at, r.finished_at, r.status,
      r.rows_seen, r.rows_written, r.rows_rejected, r.error
      from public.market_ingestion_runs r
     order by r.source_code, r.started_at desc, r.id desc
  ),
  market_success as (
    select r.source_code, max(r.finished_at) as finished_at
      from public.market_ingestion_runs r
     where r.status = 'ok'
     group by r.source_code
  ),
  market_last as (
    select o.source_code, max(o.observed_on)::timestamptz as observed_at
      from public.market_observations o
     group by o.source_code
  ),
  advisory_run as (
    select distinct on (r.source_code)
      r.source_code, r.started_at, r.finished_at, r.status,
      r.rows_written, r.rows_rejected, r.error
      from public.advisory_import_runs r
     order by r.source_code, r.started_at desc, r.id desc
  ),
  advisory_success as (
    select r.source_code, max(r.finished_at) as finished_at
      from public.advisory_import_runs r
     where r.status = 'ok'
     group by r.source_code
  ),
  soil_run as (
    select r.* from public.soil_ingestion_runs r
     where r.source_code = 'soilgrids'
     order by r.started_at desc, r.id desc limit 1
  ),
  soil_last as (
    select max(o.fetched_at) as fetched_at from public.soil_observations o
     where o.source_code = 'soilgrids'
  )
  select
    'open_meteo', coalesce(i.name, 'Open-Meteo'), 'weather', i.status,
    w.started_at,
    (select max(r.finished_at) from public.weather_ingestion_runs r where r.provider_code = 'open_meteo' and r.status = 'ok'),
    w.status, coalesce(w.cells_written, 0),
    case
      when wl.observed_at is null then 'empty'
      when wl.observed_at > now() - interval '90 minutes' then 'fresh'
      when wl.observed_at > now() - interval '6 hours' then 'stale'
      else 'expired'
    end,
    jsonb_build_object(
      'last_observed_at', wl.observed_at,
      'cells_requested', coalesce(w.cells_requested, 0),
      'last_error', w.error
    )
  from weather_run w
  left join public.intel_sources i on i.code = 'open_meteo'
  cross join weather_last wl
  union all
  select
    'nasa_power', coalesce(i.name, 'NASA POWER'), 'climate', i.status,
    c.started_at,
    (select max(r.finished_at) from public.climate_ingestion_runs r where r.provider_code = 'nasa_power' and r.status = 'ok'),
    c.status, coalesce(c.rows_written, 0),
    case
      when cl.observed_at is null then 'empty'
      when cl.observed_at > (current_date - 7)::timestamptz then 'current'
      when cl.observed_at > (current_date - 30)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object(
      'last_observed_on', cl.observed_at,
      'range', jsonb_build_array(c.range_start, c.range_end),
      'last_error', c.error
    )
  from climate_run c
  left join public.intel_sources i on i.code = 'nasa_power'
  cross join climate_last cl
  union all
  select
    f.provider_code, coalesce(wp.name, f.provider_code), 'forecast',
    coalesce(i.status, 'unverified'),
    f.started_at,
    (select max(r.finished_at) from public.climate_ingestion_runs r where r.provider_code = f.provider_code and r.status = 'ok'),
    f.status, coalesce(f.rows_written, 0),
    case
      when fl.issued_at is null then 'empty'
      when fl.issued_at >= current_date::timestamptz then 'fresh'
      when fl.issued_at >= (current_date - 2)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object(
      'last_issued_on', fl.issued_at,
      'last_error', f.error
    )
  from forecast_run f
  left join public.weather_providers wp on wp.code = f.provider_code
  left join public.intel_sources i on i.code = f.provider_code
  cross join forecast_last fl
  union all
  select
    ms.code, ms.name, 'market', coalesce(i.status, 'unverified'),
    m.started_at, succ.finished_at,
    coalesce(m.status, 'never'), coalesce(m.rows_written, 0),
    case
      when ml.observed_at is null then 'empty'
      when ml.observed_at >= (current_date - 36 * interval '1 hour')::timestamptz then 'fresh'
      when ml.observed_at >= (current_date - 7)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object(
      'last_observed_on', ml.observed_at,
      'rows_seen', coalesce(m.rows_seen, 0),
      'rows_rejected', coalesce(m.rows_rejected, 0),
      'registered_active', ms.is_active,
      'last_error', m.error
    )
  from public.market_sources ms
  left join market_run m on m.source_code = ms.code
  left join market_success succ on succ.source_code = ms.code
  left join market_last ml on ml.source_code = ms.code
  left join public.intel_sources i on i.code = ms.code
  union all
  select
    i.code, i.name, 'advisory', i.status,
    a.started_at, succ.finished_at,
    coalesce(a.status, 'never'), coalesce(a.rows_written, 0),
    case when exists (
      select 1 from public.agri_advisories ad
       where ad.is_active and ad.verification_status = 'verified'
         and (ad.valid_until is null or ad.valid_until > now())
    ) then 'current' else 'empty' end,
    jsonb_build_object(
      'rows_rejected', coalesce(a.rows_rejected, 0),
      'last_error', a.error
    )
  from public.intel_sources i
  left join advisory_run a on a.source_code = i.code
  left join advisory_success succ on succ.source_code = i.code
  where i.code = 'punjab_advisory'
  union all
  select
    'soilgrids', coalesce(i.name, 'ISRIC SoilGrids'), 'soil', i.status,
    s.started_at,
    (select max(r.finished_at) from public.soil_ingestion_runs r where r.source_code = 'soilgrids' and r.status = 'ok'),
    s.status, coalesce(s.cells_written, 0),
    case
      when sl.fetched_at is null then 'empty'
      when sl.fetched_at > now() - interval '180 days' then 'current'
      else 'stale'
    end,
    jsonb_build_object(
      'last_fetched_at', sl.fetched_at,
      'cells_requested', s.cells_requested,
      'last_error', s.error
    )
  from soil_run s
  left join public.intel_sources i on i.code = 'soilgrids'
  cross join soil_last sl;
end;
$$;

comment on function public.ingestion_health() is
  'Admin-only operational read: every registered market/advisory source, last attempt/success, freshness and provider error text, including sources that have never run. No credentials or raw payloads are returned.';

revoke execute on function public.ingestion_health() from public, anon;
grant execute on function public.ingestion_health() to authenticated;

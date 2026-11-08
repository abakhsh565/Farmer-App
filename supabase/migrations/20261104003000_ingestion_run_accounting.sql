-- Phase 9 · Accurate per-run ingestion accounting
--
-- The run tables previously recorded fetched/written units, but a batch upsert
-- reports no outcome: an attempted write was indistinguishable from an insert,
-- an update, an unchanged row or a duplicate. This migration adds a common set
-- of record counters and service-only recording functions that classify each
-- input row from the database's own result.
--
-- Existing `rows_seen`, `rows_written`, `cells_requested` and `cells_written`
-- keep their established meanings. In particular `cells_written` remains the
-- number of successful provider cells, not a count of depth/forecast rows.

alter table public.climate_ingestion_runs
  add column records_fetched integer not null default 0 check (records_fetched >= 0),
  add column records_inserted integer not null default 0 check (records_inserted >= 0),
  add column records_updated integer not null default 0 check (records_updated >= 0),
  add column records_skipped integer not null default 0 check (records_skipped >= 0),
  add column records_rejected integer not null default 0 check (records_rejected >= 0),
  add column records_failed integer not null default 0 check (records_failed >= 0);

alter table public.weather_ingestion_runs
  add column records_fetched integer not null default 0 check (records_fetched >= 0),
  add column records_inserted integer not null default 0 check (records_inserted >= 0),
  add column records_updated integer not null default 0 check (records_updated >= 0),
  add column records_skipped integer not null default 0 check (records_skipped >= 0),
  add column records_rejected integer not null default 0 check (records_rejected >= 0),
  add column records_failed integer not null default 0 check (records_failed >= 0);

alter table public.soil_ingestion_runs
  add column records_fetched integer not null default 0 check (records_fetched >= 0),
  add column records_inserted integer not null default 0 check (records_inserted >= 0),
  add column records_updated integer not null default 0 check (records_updated >= 0),
  add column records_skipped integer not null default 0 check (records_skipped >= 0),
  add column records_rejected integer not null default 0 check (records_rejected >= 0),
  add column records_failed integer not null default 0 check (records_failed >= 0);

comment on column public.climate_ingestion_runs.records_fetched is
  'Records returned by the provider before validation, including duplicates and rejected records.';
comment on column public.climate_ingestion_runs.records_inserted is
  'New target rows, reported by the recording RPC from INSERT ... ON CONFLICT ... RETURNING.';
comment on column public.climate_ingestion_runs.records_updated is
  'Existing target rows whose data changed. Unchanged rows are not included.';
comment on column public.climate_ingestion_runs.records_skipped is
  'Records not written because they were duplicates, unchanged, outside the supported horizon, or had no usable measurement.';
comment on column public.climate_ingestion_runs.records_rejected is
  'Structurally invalid records (for example an invalid date) that were refused before persistence.';
comment on column public.climate_ingestion_runs.records_failed is
  'Records whose persistence call failed. They are not reported as inserted or updated.';

comment on column public.weather_ingestion_runs.records_fetched is
  'Current and daily reading records returned by the provider before validation.';
comment on column public.weather_ingestion_runs.records_inserted is
  'New weather rows reported by the recording RPC.';
comment on column public.weather_ingestion_runs.records_updated is
  'Existing weather rows whose data changed.';
comment on column public.weather_ingestion_runs.records_skipped is
  'Duplicates, unchanged readings, and readings outside the parseable daily series.';
comment on column public.weather_ingestion_runs.records_rejected is
  'Records with an invalid observation date or other structural defect refused before persistence.';
comment on column public.weather_ingestion_runs.records_failed is
  'Reading rows whose persistence call failed. Provider fetch failures are represented by the run status and error, not as fetched rows.';

comment on column public.soil_ingestion_runs.records_fetched is
  'Depth records returned by SoilGrids for the requested cells.';
comment on column public.soil_ingestion_runs.records_inserted is
  'New soil depth rows reported by the recording RPC.';
comment on column public.soil_ingestion_runs.records_updated is
  'Existing soil depth rows whose data changed.';
comment on column public.soil_ingestion_runs.records_skipped is
  'Duplicate or unchanged depth rows.';
comment on column public.soil_ingestion_runs.records_rejected is
  'Soil depth records with an invalid depth interval refused before persistence.';
comment on column public.soil_ingestion_runs.records_failed is
  'Soil depth rows whose persistence call failed. Missing provider depths are not invented as rows.';

-- ---------------------------------------------------------------------------
-- Forecasts (live and archived share climate_ingestion_runs)
-- ---------------------------------------------------------------------------
create or replace function public.record_climate_forecasts(p_rows jsonb)
returns table (
  records_inserted integer,
  records_updated integer,
  records_unchanged integer,
  records_duplicate integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with raw as (
    select *
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      provider_code text,
      district_code text,
      forecast_on date,
      issued_on date,
      tmax_c numeric,
      tmin_c numeric,
      precip_mm numeric,
      humidity_pct numeric,
      wind_kph numeric,
      raw jsonb,
      source_url text,
      provenance jsonb,
      is_archived boolean,
      run_id bigint
    )
  ),
  deduped as (
    select distinct on (provider_code, district_code, forecast_on, issued_on) *
    from raw
    order by provider_code, district_code, forecast_on, issued_on, is_archived desc nulls last
  ),
  written as (
    insert into public.climate_forecasts (
      provider_code, district_code, forecast_on, issued_on,
      tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph,
      raw, source_url, provenance, is_archived, run_id
    )
    select
      provider_code, district_code, forecast_on, issued_on,
      tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph,
      coalesce(raw, '{}'::jsonb), source_url, coalesce(provenance, '{}'::jsonb),
      coalesce(is_archived, false), run_id
    from deduped
    on conflict (provider_code, district_code, forecast_on, issued_on) do update
      set tmax_c = excluded.tmax_c,
          tmin_c = excluded.tmin_c,
          precip_mm = excluded.precip_mm,
          humidity_pct = excluded.humidity_pct,
          wind_kph = excluded.wind_kph,
          raw = excluded.raw,
          source_url = excluded.source_url,
          provenance = excluded.provenance,
          is_archived = excluded.is_archived,
          run_id = excluded.run_id,
          ingested_at = now()
      where (
        public.climate_forecasts.tmax_c,
        public.climate_forecasts.tmin_c,
        public.climate_forecasts.precip_mm,
        public.climate_forecasts.humidity_pct,
        public.climate_forecasts.wind_kph,
        public.climate_forecasts.source_url,
        public.climate_forecasts.is_archived
      ) is distinct from (
        excluded.tmax_c,
        excluded.tmin_c,
        excluded.precip_mm,
        excluded.humidity_pct,
        excluded.wind_kph,
        excluded.source_url,
        excluded.is_archived
      )
    returning (xmax = 0) as inserted
  )
  select
    (select count(*)::integer from written where inserted),
    (select count(*)::integer from written where not inserted),
    ((select count(*) from deduped) - (select count(*) from written))::integer,
    ((select count(*) from raw) - (select count(*) from deduped))::integer;
$$;

comment on function public.record_climate_forecasts(jsonb) is
  'Records live or archived forecasts and reports inserts, changed updates, unchanged rows and within-batch duplicates from the database result. Service-only.';

revoke execute on function public.record_climate_forecasts(jsonb) from public, anon, authenticated;
grant execute on function public.record_climate_forecasts(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- District climate observations
-- ---------------------------------------------------------------------------
create or replace function public.record_climate_observations(p_rows jsonb)
returns table (
  records_inserted integer,
  records_updated integer,
  records_unchanged integer,
  records_duplicate integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with raw as (
    select *
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      provider_code text,
      district_code text,
      observed_on date,
      tmax_c numeric,
      tmin_c numeric,
      precip_mm numeric,
      humidity_pct numeric,
      wind_kph numeric,
      raw jsonb,
      source_url text,
      units jsonb,
      provenance jsonb,
      data_kind text,
      run_id bigint
    )
  ),
  deduped as (
    select distinct on (provider_code, district_code, observed_on) *
    from raw
    order by provider_code, district_code, observed_on, data_kind
  ),
  written as (
    insert into public.climate_observations (
      provider_code, district_code, observed_on,
      tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph,
      raw, source_url, units, provenance, data_kind, run_id
    )
    select
      provider_code, district_code, observed_on,
      tmax_c, tmin_c, precip_mm, humidity_pct, wind_kph,
      coalesce(raw, '{}'::jsonb), source_url, coalesce(units, '{}'::jsonb),
      coalesce(provenance, '{}'::jsonb), coalesce(data_kind, 'reanalysis'), run_id
    from deduped
    on conflict (provider_code, district_code, observed_on) do update
      set tmax_c = excluded.tmax_c,
          tmin_c = excluded.tmin_c,
          precip_mm = excluded.precip_mm,
          humidity_pct = excluded.humidity_pct,
          wind_kph = excluded.wind_kph,
          raw = excluded.raw,
          source_url = excluded.source_url,
          units = excluded.units,
          provenance = excluded.provenance,
          data_kind = excluded.data_kind,
          run_id = excluded.run_id,
          ingested_at = now()
      where (
        public.climate_observations.tmax_c,
        public.climate_observations.tmin_c,
        public.climate_observations.precip_mm,
        public.climate_observations.humidity_pct,
        public.climate_observations.wind_kph,
        public.climate_observations.source_url,
        public.climate_observations.units,
        public.climate_observations.data_kind
      ) is distinct from (
        excluded.tmax_c,
        excluded.tmin_c,
        excluded.precip_mm,
        excluded.humidity_pct,
        excluded.wind_kph,
        excluded.source_url,
        excluded.units,
        excluded.data_kind
      )
    returning (xmax = 0) as inserted
  )
  select
    (select count(*)::integer from written where inserted),
    (select count(*)::integer from written where not inserted),
    ((select count(*) from deduped) - (select count(*) from written))::integer,
    ((select count(*) from raw) - (select count(*) from deduped))::integer;
$$;

comment on function public.record_climate_observations(jsonb) is
  'Records reanalysis observations with insert/update/unchanged/duplicate outcomes. Service-only.';

revoke execute on function public.record_climate_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_climate_observations(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Weather readings
-- ---------------------------------------------------------------------------
create or replace function public.record_weather_readings(p_rows jsonb)
returns table (
  records_inserted integer,
  records_updated integer,
  records_unchanged integer,
  records_duplicate integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with raw as (
    select *
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      provider_code text,
      lat_cell numeric,
      lon_cell numeric,
      observed_at timestamptz,
      fetched_at timestamptz,
      temp_c numeric,
      feels_like_c numeric,
      humidity_pct integer,
      precip_mm numeric,
      wind_kph numeric,
      wind_dir text,
      condition_text text,
      condition_code text,
      kind text,
      valid_from timestamptz,
      valid_to timestamptz,
      raw jsonb,
      fetch_error text
    )
  ),
  deduped as (
    select distinct on (provider_code, lat_cell, lon_cell, kind, observed_at) *
    from raw
    order by provider_code, lat_cell, lon_cell, kind, observed_at, fetched_at desc nulls last
  ),
  written as (
    insert into public.weather_readings (
      provider_code, lat_cell, lon_cell, observed_at, fetched_at,
      temp_c, feels_like_c, humidity_pct, precip_mm, wind_kph, wind_dir,
      condition_text, condition_code, kind, valid_from, valid_to, raw, fetch_error
    )
    select
      provider_code, lat_cell, lon_cell, observed_at, coalesce(fetched_at, now()),
      temp_c, feels_like_c, humidity_pct, precip_mm, wind_kph, wind_dir,
      condition_text, condition_code, coalesce(kind, 'current'), valid_from, valid_to,
      coalesce(raw, '{}'::jsonb), fetch_error
    from deduped
    on conflict (provider_code, lat_cell, lon_cell, kind, observed_at) do update
      set fetched_at = excluded.fetched_at,
          temp_c = excluded.temp_c,
          feels_like_c = excluded.feels_like_c,
          humidity_pct = excluded.humidity_pct,
          precip_mm = excluded.precip_mm,
          wind_kph = excluded.wind_kph,
          wind_dir = excluded.wind_dir,
          condition_text = excluded.condition_text,
          condition_code = excluded.condition_code,
          valid_from = excluded.valid_from,
          valid_to = excluded.valid_to,
          raw = excluded.raw,
          fetch_error = excluded.fetch_error
      where (
        public.weather_readings.temp_c,
        public.weather_readings.feels_like_c,
        public.weather_readings.humidity_pct,
        public.weather_readings.precip_mm,
        public.weather_readings.wind_kph,
        public.weather_readings.wind_dir,
        public.weather_readings.condition_text,
        public.weather_readings.condition_code,
        public.weather_readings.valid_from,
        public.weather_readings.valid_to,
        public.weather_readings.fetch_error
      ) is distinct from (
        excluded.temp_c,
        excluded.feels_like_c,
        excluded.humidity_pct,
        excluded.precip_mm,
        excluded.wind_kph,
        excluded.wind_dir,
        excluded.condition_text,
        excluded.condition_code,
        excluded.valid_from,
        excluded.valid_to,
        excluded.fetch_error
      )
    returning (xmax = 0) as inserted
  )
  select
    (select count(*)::integer from written where inserted),
    (select count(*)::integer from written where not inserted),
    ((select count(*) from deduped) - (select count(*) from written))::integer,
    ((select count(*) from raw) - (select count(*) from deduped))::integer;
$$;

comment on function public.record_weather_readings(jsonb) is
  'Records current/daily readings with actual insert/update/unchanged/duplicate outcomes. Service-only.';

revoke execute on function public.record_weather_readings(jsonb) from public, anon, authenticated;
grant execute on function public.record_weather_readings(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Soil depth observations
-- ---------------------------------------------------------------------------
create or replace function public.record_soil_observations(p_rows jsonb)
returns table (
  records_inserted integer,
  records_updated integer,
  records_unchanged integer,
  records_duplicate integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with raw as (
    select *
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      source_code text,
      lat_cell numeric,
      lon_cell numeric,
      depth_top_cm smallint,
      depth_bottom_cm smallint,
      clay_pct numeric,
      sand_pct numeric,
      silt_pct numeric,
      ph numeric,
      soc_g_kg numeric,
      cec_cmol_kg numeric,
      bulk_density_g_cm3 numeric,
      uncertainty jsonb,
      source_url text,
      raw jsonb,
      fetched_at timestamptz
    )
  ),
  deduped as (
    select distinct on (source_code, lat_cell, lon_cell, depth_top_cm, depth_bottom_cm) *
    from raw
    order by source_code, lat_cell, lon_cell, depth_top_cm, depth_bottom_cm, fetched_at desc nulls last
  ),
  written as (
    insert into public.soil_observations (
      source_code, lat_cell, lon_cell, depth_top_cm, depth_bottom_cm,
      clay_pct, sand_pct, silt_pct, ph, soc_g_kg, cec_cmol_kg,
      bulk_density_g_cm3, uncertainty, source_url, fetched_at, raw
    )
    select
      coalesce(source_code, 'soilgrids'), lat_cell, lon_cell, depth_top_cm, depth_bottom_cm,
      clay_pct, sand_pct, silt_pct, ph, soc_g_kg, cec_cmol_kg,
      bulk_density_g_cm3, coalesce(uncertainty, '{}'::jsonb), source_url,
      coalesce(fetched_at, now()), coalesce(raw, '{}'::jsonb)
    from deduped
    on conflict (source_code, lat_cell, lon_cell, depth_top_cm, depth_bottom_cm) do update
      set clay_pct = excluded.clay_pct,
          sand_pct = excluded.sand_pct,
          silt_pct = excluded.silt_pct,
          ph = excluded.ph,
          soc_g_kg = excluded.soc_g_kg,
          cec_cmol_kg = excluded.cec_cmol_kg,
          bulk_density_g_cm3 = excluded.bulk_density_g_cm3,
          uncertainty = excluded.uncertainty,
          source_url = excluded.source_url,
          fetched_at = excluded.fetched_at,
          raw = excluded.raw
      where (
        public.soil_observations.clay_pct,
        public.soil_observations.sand_pct,
        public.soil_observations.silt_pct,
        public.soil_observations.ph,
        public.soil_observations.soc_g_kg,
        public.soil_observations.cec_cmol_kg,
        public.soil_observations.bulk_density_g_cm3,
        public.soil_observations.uncertainty,
        public.soil_observations.source_url
      ) is distinct from (
        excluded.clay_pct,
        excluded.sand_pct,
        excluded.silt_pct,
        excluded.ph,
        excluded.soc_g_kg,
        excluded.cec_cmol_kg,
        excluded.bulk_density_g_cm3,
        excluded.uncertainty,
        excluded.source_url
      )
    returning (xmax = 0) as inserted
  )
  select
    (select count(*)::integer from written where inserted),
    (select count(*)::integer from written where not inserted),
    ((select count(*) from deduped) - (select count(*) from written))::integer,
    ((select count(*) from raw) - (select count(*) from deduped))::integer;
$$;

comment on function public.record_soil_observations(jsonb) is
  'Records modelled soil depths with actual insert/update/unchanged/duplicate outcomes. Service-only.';

revoke execute on function public.record_soil_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_soil_observations(jsonb) to service_role;

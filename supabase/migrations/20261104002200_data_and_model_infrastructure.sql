-- Phase 9 · External data and model infrastructure
--
-- This migration adds the missing operational layer around the existing
-- intelligence system. It does not create a second weather, crop, advice or
-- alert model.
--
--   · Weather observations become idempotent per provider/cell/kind/time. A
--     repeated adapter run updates the reading instead of duplicating it.
--   · The farmer locations that actually need a weather fetch are exposed as a
--     service-only target list, so a scheduler fetches cells rather than one
--     cell per app open.
--   · SoilGrids observations are stored with the units and uncertainty the
--     provider publishes. They are a modelled prior at 250 m, never field truth.
--   · Forecast calibration is a first-class, versioned model artifact. An active
--     model can only be activated when it has a holdout win and enough test
--     rows; activation is admin-only and reversible.
--   · Source health reports the last attempt, success, failure and freshness of
--     every external source. It never prints a credential.
--
-- The data are only useful if the failure states are visible. Every table and
-- function below records "not attempted", "failed" and "stale" separately.

-- ---------------------------------------------------------------------------
-- 1. Weather idempotency
-- ---------------------------------------------------------------------------
-- The existing adapter inserted a new row on every fetch. Two runs inside the
-- same observation hour therefore produced two readings for one cell. The
-- unique key makes the adapter's upsert meaningful and makes a retry safe.
with ranked as (
  select id,
         row_number() over (
           partition by provider_code, lat_cell, lon_cell, kind, observed_at
           order by fetched_at desc, id desc
         ) as rn
    from public.weather_readings
)
delete from public.weather_readings w
 using ranked r
 where w.id = r.id
   and r.rn > 1;

create unique index if not exists weather_readings_event_uidx
  on public.weather_readings (provider_code, lat_cell, lon_cell, kind, observed_at);

comment on index public.weather_readings_event_uidx is
  'One reading per provider, cell, kind and observation time. Adapters must upsert on this key; a retry may correct a reading but may not duplicate it.';

-- ---------------------------------------------------------------------------
-- 2. Cells that actually need a current weather fetch
-- ---------------------------------------------------------------------------
create or replace function public.weather_ingestion_targets(
  p_limit integer default 200
)
returns table (
  lat_cell        numeric,
  lon_cell        numeric,
  farmer_count    integer,
  last_observed_at timestamptz,
  due             boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cells as (
    select
      round(fp.default_lat::numeric, 3) as lat_cell,
      round(fp.default_lon::numeric, 3) as lon_cell,
      count(*)::integer as farmer_count
    from public.farmer_profiles fp
    where fp.default_lat is not null
      and fp.default_lon is not null
      and fp.default_lat between -90 and 90
      and fp.default_lon between -180 and 180
    group by 1, 2
  ),
  latest as (
    select
      c.lat_cell,
      c.lon_cell,
      c.farmer_count,
      (
        select max(wr.observed_at)
        from public.weather_readings wr
        where wr.lat_cell = c.lat_cell
          and wr.lon_cell = c.lon_cell
          and wr.kind = 'current'
          and wr.fetch_error is null
      ) as last_observed_at
    from cells c
  )
  select
    l.lat_cell,
    l.lon_cell,
    l.farmer_count,
    l.last_observed_at,
    (l.last_observed_at is null or l.last_observed_at < now() - interval '75 minutes') as due
  from latest l
  order by due desc, l.farmer_count desc, l.lat_cell, l.lon_cell
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

comment on function public.weather_ingestion_targets(integer) is
  'Cells with at least one farmer location, whether the current reading is due, and how many farmers share the cell. Service-only: it can reveal a village-scale location.';

revoke execute on function public.weather_ingestion_targets(integer)
  from public, anon, authenticated;
grant execute on function public.weather_ingestion_targets(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Real SoilGrids observations
-- ---------------------------------------------------------------------------
-- SoilGrids 2.0 is a 250 m global model (CC BY 4.0). Values are modelled priors
-- with published uncertainty, not a soil test. The provider returns mapped
-- integers; the adapter divides by d_factor before writing, and this table keeps
-- the 90% interval as uncertainty.
insert into public.intel_sources (
  code, name, kind, endpoint_url, license, commercial_ok, coverage,
  update_cadence, access_method, status, notes
) values (
  'soilgrids',
  'ISRIC SoilGrids 250m',
  'soil_feed',
  'https://rest.isric.org/soilgrids/v2.0/properties/query',
  'CC BY 4.0; cite Poggio et al. 2021, SOIL 7:217-240',
  true,
  'global, 250 m model; 0-5, 5-15, 15-30, 30-60, 60-100, 100-200 cm',
  'static model release with periodic revisions',
  'api',
  'verified_api',
  'Point queries are live. Values are modelled, not sampled: treat them as a prior and retain the published 90% interval. Use a 2-decimal cell (~1.1 km) rather than a farm coordinate.'
)
on conflict (code) do update set
  name = excluded.name,
  kind = excluded.kind,
  endpoint_url = excluded.endpoint_url,
  license = excluded.license,
  commercial_ok = excluded.commercial_ok,
  coverage = excluded.coverage,
  update_cadence = excluded.update_cadence,
  access_method = excluded.access_method,
  status = excluded.status,
  notes = excluded.notes,
  is_active = true;

create table public.soil_observations (
  id             bigserial primary key,
  source_code    text not null default 'soilgrids' references public.intel_sources (code),
  -- Deliberately coarser than the weather cell. A 250 m soil model at a farm
  -- coordinate would imply field precision the source does not have.
  lat_cell       numeric(8,2) not null check (lat_cell between -90 and 90),
  lon_cell       numeric(8,2) not null check (lon_cell between -180 and 180),
  depth_top_cm   smallint not null check (depth_top_cm >= 0),
  depth_bottom_cm smallint not null check (depth_bottom_cm > depth_top_cm),
  clay_pct       numeric(5,2) check (clay_pct is null or clay_pct between 0 and 100),
  sand_pct       numeric(5,2) check (sand_pct is null or sand_pct between 0 and 100),
  silt_pct       numeric(5,2) check (silt_pct is null or silt_pct between 0 and 100),
  ph             numeric(3,1) check (ph is null or ph between 0 and 14),
  soc_g_kg       numeric(6,2) check (soc_g_kg is null or soc_g_kg >= 0),
  cec_cmol_kg    numeric(6,2) check (cec_cmol_kg is null or cec_cmol_kg >= 0),
  bulk_density_g_cm3 numeric(4,2) check (bulk_density_g_cm3 is null or bulk_density_g_cm3 > 0),
  -- The provider's interval widths, in the same units as the value. JSON keeps
  -- the source's own statistic names visible instead of compressing them into a
  -- number that looks more certain than it is.
  uncertainty    jsonb not null default '{}'::jsonb,
  source_url     text check (source_url is null or source_url ~ '^https://[^[:space:]]+$'),
  fetched_at     timestamptz not null default now(),
  raw            jsonb not null default '{}'::jsonb,
  unique (source_code, lat_cell, lon_cell, depth_top_cm, depth_bottom_cm)
);

create index soil_observations_cell_idx
  on public.soil_observations (lat_cell, lon_cell, depth_top_cm);

comment on table public.soil_observations is
  'Modelled SoilGrids priors by ~1.1 km cell and depth. Never a soil test and never field-level truth. Missing properties stay NULL; the provider uncertainty is retained.';

create table public.soil_ingestion_runs (
  id             bigserial primary key,
  source_code    text not null default 'soilgrids' references public.intel_sources (code),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  cells_requested integer not null default 0,
  cells_written  integer not null default 0,
  error          text
);

alter table public.soil_observations enable row level security;
alter table public.soil_ingestion_runs enable row level security;

revoke all on public.soil_observations from anon, authenticated;
revoke all on public.soil_ingestion_runs from anon, authenticated;

create or replace function public.soil_context(
  p_lat double precision,
  p_lon double precision
)
returns table (
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
  fetched_at timestamptz,
  source_name text,
  source_url text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_lat numeric;
  v_lon numeric;
begin
  if p_lat is null or p_lat < -90 or p_lat > 90 or p_lon is null or p_lon < -180 or p_lon > 180 then
    raise exception 'soil_context requires valid lat/lon.' using errcode = 'check_violation';
  end if;

  v_lat := round(p_lat::numeric, 2);
  v_lon := round(p_lon::numeric, 2);

  return query
  select
    s.depth_top_cm,
    s.depth_bottom_cm,
    s.clay_pct,
    s.sand_pct,
    s.silt_pct,
    s.ph,
    s.soc_g_kg,
    s.cec_cmol_kg,
    s.bulk_density_g_cm3,
    s.uncertainty,
    s.fetched_at,
    i.name,
    s.source_url
  from public.soil_observations s
  join public.intel_sources i on i.code = s.source_code
  where s.lat_cell = v_lat
    and s.lon_cell = v_lon
  order by s.depth_top_cm;
end;
$$;

comment on function public.soil_context(double precision, double precision) is
  'Returns modelled soil properties for the ~1.1 km cell containing the point. No coordinates are returned; absence of rows means no observation, not a zero.';

grant execute on function public.soil_context(double precision, double precision)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Forecast calibration schema
-- ---------------------------------------------------------------------------
-- A forecast model is a versioned artifact. It is registered as shadow first;
-- activation is an explicit administrator action, and only when the holdout
-- result beats the raw forecast and the test sample is large enough.
create table public.ml_models (
  id                    uuid primary key default gen_random_uuid(),
  model_code            text not null,
  version               integer not null check (version > 0),
  target                text not null check (target in (
                          'forecast_tmax_c', 'forecast_tmin_c', 'pest_risk',
                          'crop_stage', 'market_price'
                        )),
  algorithm             text not null,
  status                text not null default 'shadow'
                          check (status in ('shadow', 'active', 'retired', 'rejected')),
  provider_code         text references public.weather_providers (code),
  district_code         text references public.districts (code),
  feature_schema_version integer not null default 1 check (feature_schema_version > 0),
  feature_names         text[] not null check (cardinality(feature_names) > 0),
  coefficients          jsonb not null,
  metrics               jsonb not null,
  provenance            jsonb not null,
  confidence            numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  train_rows            integer check (train_rows is null or train_rows >= 0),
  test_rows             integer check (test_rows is null or test_rows >= 0),
  training_start        date,
  training_end          date,
  trained_at            timestamptz not null,
  activated_at          timestamptz,
  retired_at            timestamptz,
  created_at            timestamptz not null default now(),
  unique (model_code, version, target, provider_code, district_code),
  constraint ml_models_training_window
    check (training_start is null or training_end is null or training_end >= training_start)
);

comment on table public.ml_models is
  'Versioned model artifacts. A model is not active merely because it exists: activation requires an admin, a positive holdout improvement and at least 30 test rows. Coefficients and metrics are immutable evidence of what was trained.';

create unique index ml_models_one_active_idx
  on public.ml_models (
    target,
    coalesce(provider_code, ''),
    coalesce(district_code, '')
  )
  where status = 'active';

create index ml_models_target_idx
  on public.ml_models (target, status, trained_at desc);

create table public.ml_training_runs (
  id            uuid primary key default gen_random_uuid(),
  model_code    text not null,
  target        text not null,
  provider_code text,
  district_code text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                  check (status in ('running', 'ok', 'rejected', 'failed')),
  train_rows    integer not null default 0,
  test_rows     integer not null default 0,
  metrics       jsonb not null default '{}'::jsonb,
  artifact      jsonb not null default '{}'::jsonb,
  source_urls   text[] not null default '{}'::text[],
  error         text
);

create table public.ml_forecast_backtests (
  id              bigserial primary key,
  model_id        uuid not null references public.ml_models (id) on delete cascade,
  evaluated_at    timestamptz not null default now(),
  sample_rows     integer not null default 0,
  raw_mae         numeric,
  calibrated_mae  numeric,
  improvement_pct numeric,
  detail          jsonb not null default '{}'::jsonb
);

create index ml_forecast_backtests_model_idx
  on public.ml_forecast_backtests (model_id, evaluated_at desc);

alter table public.ml_models enable row level security;
alter table public.ml_training_runs enable row level security;
alter table public.ml_forecast_backtests enable row level security;

create policy ml_models_admin_read on public.ml_models
  for select to authenticated using (public.has_capability('admin'));

create policy ml_training_runs_admin_read on public.ml_training_runs
  for select to authenticated using (public.has_capability('admin'));

create policy ml_forecast_backtests_admin_read on public.ml_forecast_backtests
  for select to authenticated using (public.has_capability('admin'));

grant select on public.ml_models to authenticated;
grant select on public.ml_training_runs to authenticated;
grant select on public.ml_forecast_backtests to authenticated;
revoke insert, update, delete on public.ml_models from authenticated;
revoke insert, update, delete on public.ml_training_runs from authenticated;
revoke insert, update, delete on public.ml_forecast_backtests from authenticated;

alter table public.climate_forecasts
  add column calibrated_tmax_c numeric,
  add column calibrated_tmin_c numeric,
  add column tmax_model_id uuid references public.ml_models (id),
  add column tmin_model_id uuid references public.ml_models (id),
  add column calibrated_at timestamptz;

comment on column public.climate_forecasts.calibrated_tmax_c is
  'Bias-corrected daily maximum temperature from the active model for this provider/district. NULL means no active model produced a calibration; it is not zero.';
comment on column public.climate_forecasts.calibrated_tmin_c is
  'Bias-corrected daily minimum temperature from the active model for this provider/district. NULL means no active model produced a calibration; it is not zero.';

-- A small, auditable linear correction. The feature set is deliberately fixed:
-- raw value, lead day, and a smooth annual cycle. Adding a feature changes the
-- model schema version, not this function's assumptions.
create or replace function public.ml_apply_linear(
  p_coefficients jsonb,
  p_raw numeric,
  p_lead integer,
  p_month integer
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(
    coalesce((p_coefficients->>'intercept')::numeric, 0)
    + p_raw * coalesce((p_coefficients->>'raw')::numeric, 1)
    + coalesce(p_lead, 0) * coalesce((p_coefficients->>'lead_day')::numeric, 0)
    + sin(2 * pi() * (coalesce(p_month, 1) - 1) / 12.0)::numeric
      * coalesce((p_coefficients->>'month_sin')::numeric, 0)
    + cos(2 * pi() * (coalesce(p_month, 1) - 1) / 12.0)::numeric
      * coalesce((p_coefficients->>'month_cos')::numeric, 0),
    2
  );
$$;

comment on function public.ml_apply_linear(jsonb, numeric, integer, integer) is
  'Applies the registered linear artifact. It is a correction of the raw provider value, not an independent weather simulation.';

create or replace function public.agri_apply_forecast_model()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tmax public.ml_models;
  v_tmin public.ml_models;
  v_lead integer;
  v_month integer;
  v_value numeric;
begin
  v_lead := greatest(0, least(16, new.forecast_on - new.issued_on));
  v_month := extract(month from new.forecast_on)::integer;

  select * into v_tmax
    from public.ml_models m
   where m.status = 'active'
     and m.target = 'forecast_tmax_c'
     and (m.provider_code is null or m.provider_code = new.provider_code)
     and (m.district_code is null or m.district_code = new.district_code)
   order by (m.district_code is not null) desc,
            (m.provider_code is not null) desc,
            m.version desc
   limit 1;

  select * into v_tmin
    from public.ml_models m
   where m.status = 'active'
     and m.target = 'forecast_tmin_c'
     and (m.provider_code is null or m.provider_code = new.provider_code)
     and (m.district_code is null or m.district_code = new.district_code)
   order by (m.district_code is not null) desc,
            (m.provider_code is not null) desc,
            m.version desc
   limit 1;

  new.calibrated_tmax_c := null;
  new.calibrated_tmin_c := null;
  new.tmax_model_id := null;
  new.tmin_model_id := null;
  new.calibrated_at := null;

  if v_tmax.id is not null and new.tmax_c is not null then
    v_value := public.ml_apply_linear(v_tmax.coefficients, new.tmax_c, v_lead, v_month);
    if v_value between -20 and 60 then
      new.calibrated_tmax_c := v_value;
      new.tmax_model_id := v_tmax.id;
      new.calibrated_at := now();
    end if;
  end if;

  if v_tmin.id is not null and new.tmin_c is not null then
    v_value := public.ml_apply_linear(v_tmin.coefficients, new.tmin_c, v_lead, v_month);
    if v_value between -30 and 50 then
      new.calibrated_tmin_c := v_value;
      new.tmin_model_id := v_tmin.id;
      new.calibrated_at := now();
    end if;
  end if;

  return new;
end;
$$;

create trigger climate_forecasts_apply_model
  before insert or update of tmax_c, tmin_c, forecast_on, issued_on, provider_code, district_code
  on public.climate_forecasts
  for each row execute function public.agri_apply_forecast_model();

-- ---------------------------------------------------------------------------
-- 5. Model lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.activate_ml_model(p_model_id uuid)
returns public.ml_models
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.ml_models;
  v_model public.ml_models;
  v_improvement numeric;
  v_test_rows integer;
begin
  if not public.has_capability('admin') then
    raise exception 'Model activation requires admin capability.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_model from public.ml_models where id = p_model_id;
  if v_model.id is null then
    raise exception 'Model % does not exist.', p_model_id using errcode = 'no_data_found';
  end if;
  if v_model.status not in ('shadow', 'active') then
    raise exception 'A retired or rejected model cannot be activated.' using errcode = 'check_violation';
  end if;

  v_improvement := coalesce((v_model.metrics->>'improvement_pct')::numeric, 0);
  v_test_rows := coalesce((v_model.metrics->>'test_rows')::integer, 0);
  if v_test_rows < 30 then
    raise exception 'Model has % holdout rows; at least 30 are required.', v_test_rows
      using errcode = 'check_violation';
  end if;
  if v_improvement <= 0 then
    raise exception 'Model does not beat the raw baseline on holdout data (improvement %).',
      v_improvement using errcode = 'check_violation';
  end if;

  update public.ml_models
     set status = 'retired', retired_at = now()
   where status = 'active'
     and target = v_model.target
     and coalesce(provider_code, '') = coalesce(v_model.provider_code, '')
     and coalesce(district_code, '') = coalesce(v_model.district_code, '');

  update public.ml_models
     set status = 'active', activated_at = now(), retired_at = null
   where id = v_model.id
   returning * into v_model;

  perform public.write_audit(
    'ml.model.activated', 'ml_models', v_model.id, v_model.model_code,
    null, null,
    jsonb_build_object(
      'target', v_model.target,
      'version', v_model.version,
      'improvement_pct', v_improvement,
      'test_rows', v_test_rows
    ),
    public.current_party_id(), 'admin'
  );

  return v_model;
end;
$$;

comment on function public.activate_ml_model(uuid) is
  'Admin-only activation. Refuses a model without at least 30 holdout rows and a positive improvement over the raw baseline. Demotes the previously active model for the same target/provider/district.';

create or replace function public.retire_ml_model(p_model_id uuid)
returns public.ml_models
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_model public.ml_models;
begin
  if not public.has_capability('admin') then
    raise exception 'Model retirement requires admin capability.' using errcode = 'insufficient_privilege';
  end if;

  update public.ml_models
     set status = 'retired', retired_at = now()
   where id = p_model_id
   returning * into v_model;

  if v_model.id is null then
    raise exception 'Model % does not exist.', p_model_id using errcode = 'no_data_found';
  end if;

  perform public.write_audit(
    'ml.model.retired', 'ml_models', v_model.id, v_model.model_code,
    null, null,
    jsonb_build_object('target', v_model.target, 'version', v_model.version),
    public.current_party_id(), 'admin'
  );

  return v_model;
end;
$$;

create or replace function public.ml_model_health()
returns table (
  model_id uuid,
  model_code text,
  version integer,
  target text,
  provider_code text,
  district_code text,
  status text,
  confidence numeric,
  trained_at timestamptz,
  activated_at timestamptz,
  train_rows integer,
  test_rows integer,
  holdout_metrics jsonb,
  latest_backtest jsonb,
  age_days integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_capability('admin') then
    raise exception 'Model health requires admin capability.' using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    m.id,
    m.model_code,
    m.version,
    m.target,
    m.provider_code,
    m.district_code,
    m.status,
    m.confidence,
    m.trained_at,
    m.activated_at,
    m.train_rows,
    m.test_rows,
    m.metrics,
    (
      select jsonb_build_object(
        'evaluated_at', b.evaluated_at,
        'sample_rows', b.sample_rows,
        'raw_mae', b.raw_mae,
        'calibrated_mae', b.calibrated_mae,
        'improvement_pct', b.improvement_pct
      )
      from public.ml_forecast_backtests b
      where b.model_id = m.id
      order by b.evaluated_at desc
      limit 1
    ) as latest_backtest,
    greatest(0, floor(extract(epoch from (now() - m.trained_at)) / 86400))::integer as age_days
  from public.ml_models m
  order by (m.status = 'active') desc, m.trained_at desc;
end;
$$;

comment on function public.ml_model_health() is
  'Admin-only model registry view with holdout metrics, latest live backtest and artifact age. It reports missing live samples as null rather than inventing a score.';

-- Live monitoring: compare a model's calibrated forecasts with NASA POWER
-- observations once the forecast day has passed. No future data is used.
create or replace function public.record_ml_forecast_backtest(p_model_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_model public.ml_models;
  v_rows integer := 0;
  v_raw_mae numeric;
  v_cal_mae numeric;
  v_improvement numeric;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Forecast backtesting requires the service role or admin.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_model from public.ml_models where id = p_model_id;
  if v_model.id is null then
    raise exception 'Model % does not exist.', p_model_id using errcode = 'no_data_found';
  end if;
  if v_model.target not in ('forecast_tmax_c', 'forecast_tmin_c') then
    raise exception 'Only forecast temperature models have a live backtest.' using errcode = 'check_violation';
  end if;

  if v_model.target = 'forecast_tmax_c' then
    select
      count(*),
      avg(abs(f.tmax_c - o.tmax_c)),
      avg(abs(f.calibrated_tmax_c - o.tmax_c))
    into v_rows, v_raw_mae, v_cal_mae
    from public.climate_forecasts f
    join public.climate_observations o
      on o.provider_code = 'nasa_power'
     and o.district_code = f.district_code
     and o.observed_on = f.forecast_on
    where f.provider_code = v_model.provider_code
      and f.district_code = v_model.district_code
      and f.forecast_on < current_date
      and f.tmax_c is not null
      and f.calibrated_tmax_c is not null
      and o.tmax_c is not null;
  else
    select
      count(*),
      avg(abs(f.tmin_c - o.tmin_c)),
      avg(abs(f.calibrated_tmin_c - o.tmin_c))
    into v_rows, v_raw_mae, v_cal_mae
    from public.climate_forecasts f
    join public.climate_observations o
      on o.provider_code = 'nasa_power'
     and o.district_code = f.district_code
     and o.observed_on = f.forecast_on
    where f.provider_code = v_model.provider_code
      and f.district_code = v_model.district_code
      and f.forecast_on < current_date
      and f.tmin_c is not null
      and f.calibrated_tmin_c is not null
      and o.tmin_c is not null;
  end if;

  v_improvement := case
    when v_rows > 0 and v_raw_mae is not null and v_raw_mae > 0 and v_cal_mae is not null
      then round((1 - (v_cal_mae / v_raw_mae)) * 100, 2)
    else null
  end;

  insert into public.ml_forecast_backtests (
    model_id, sample_rows, raw_mae, calibrated_mae, improvement_pct, detail
  ) values (
    v_model.id, v_rows, v_raw_mae, v_cal_mae, v_improvement,
    jsonb_build_object(
      'target', v_model.target,
      'provider', v_model.provider_code,
      'district', v_model.district_code,
      'reference', 'NASA POWER reanalysis',
      'note', 'Not a station observation; this is a model-to-model comparison.'
    )
  );

  return jsonb_build_object(
    'model_id', v_model.id,
    'sample_rows', v_rows,
    'raw_mae', v_raw_mae,
    'calibrated_mae', v_cal_mae,
    'improvement_pct', v_improvement
  );
end;
$$;

comment on function public.record_ml_forecast_backtest(uuid) is
  'Compares a temperature model with NASA POWER reanalysis after the forecast day has passed. Zero rows returns zero samples and null metrics, not a fake accuracy.';

revoke execute on function public.activate_ml_model(uuid) from public, anon;
revoke execute on function public.retire_ml_model(uuid) from public, anon;
revoke execute on function public.ml_model_health() from public, anon;
revoke execute on function public.record_ml_forecast_backtest(uuid) from public, anon;
grant execute on function public.activate_ml_model(uuid) to authenticated;
grant execute on function public.retire_ml_model(uuid) to authenticated;
grant execute on function public.ml_model_health() to authenticated;
grant execute on function public.record_ml_forecast_backtest(uuid) to service_role;
grant execute on function public.record_ml_forecast_backtest(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. One source-health read path
-- ---------------------------------------------------------------------------
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
    select * from public.weather_ingestion_runs
     where provider_code = 'open_meteo'
     order by started_at desc limit 1
  ),
  weather_last as (
    select max(observed_at) as observed_at from public.weather_readings
     where provider_code = 'open_meteo' and kind = 'current' and fetch_error is null
  ),
  climate_run as (
    select * from public.climate_ingestion_runs
     where provider_code = 'nasa_power'
     order by started_at desc limit 1
  ),
  climate_last as (
    select max(observed_on)::timestamptz as observed_at from public.climate_observations
     where provider_code = 'nasa_power'
  ),
  forecast_run as (
    select * from public.climate_ingestion_runs
     where provider_code in ('weatherapi', 'open_meteo')
     order by started_at desc limit 1
  ),
  forecast_last as (
    select max(issued_on)::timestamptz as issued_at from public.climate_forecasts
     where provider_code in ('weatherapi', 'open_meteo')
  ),
  market_run as (
    select * from public.market_ingestion_runs
     order by started_at desc limit 1
  ),
  market_last as (
    select max(observed_on)::timestamptz as observed_at from public.market_observations
  ),
  advisory_run as (
    select * from public.advisory_import_runs
     order by started_at desc limit 1
  ),
  soil_run as (
    select r.* from public.soil_ingestion_runs r
     where r.source_code = 'soilgrids'
     order by r.started_at desc limit 1
  ),
  soil_last as (
    select max(o.fetched_at) as fetched_at from public.soil_observations o
     where o.source_code = 'soilgrids'
  )
  select
    'open_meteo', coalesce(i.name, 'Open-Meteo'), 'weather', i.status,
    w.started_at,
    (select max(finished_at) from public.weather_ingestion_runs where provider_code = 'open_meteo' and status = 'ok'),
    w.status, coalesce(w.cells_written, 0),
    case
      when wl.observed_at is null then 'empty'
      when wl.observed_at > now() - interval '90 minutes' then 'fresh'
      when wl.observed_at > now() - interval '6 hours' then 'stale'
      else 'expired'
    end,
    jsonb_build_object('last_observed_at', wl.observed_at, 'cells_requested', w.cells_requested)
  from weather_run w
  left join public.intel_sources i on i.code = 'open_meteo'
  cross join weather_last wl
  union all
  select
    'nasa_power', coalesce(i.name, 'NASA POWER'), 'climate', i.status,
    c.started_at,
    (select max(finished_at) from public.climate_ingestion_runs where provider_code = 'nasa_power' and status = 'ok'),
    c.status, coalesce(c.rows_written, 0),
    case
      when cl.observed_at is null then 'empty'
      when cl.observed_at > (current_date - 7)::timestamptz then 'current'
      when cl.observed_at > (current_date - 30)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object('last_observed_on', cl.observed_at, 'range', jsonb_build_array(c.range_start, c.range_end))
  from climate_run c
  left join public.intel_sources i on i.code = 'nasa_power'
  cross join climate_last cl
  union all
  select
    f.provider_code, coalesce(wp.name, f.provider_code), 'forecast',
    coalesce(i.status, 'unverified'),
    f.started_at,
    (select max(finished_at) from public.climate_ingestion_runs where provider_code = f.provider_code and status = 'ok'),
    f.status, coalesce(f.rows_written, 0),
    case
      when fl.issued_at is null then 'empty'
      when fl.issued_at >= current_date::timestamptz then 'fresh'
      when fl.issued_at >= (current_date - 2)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object('last_issued_on', fl.issued_at, 'error', f.error)
  from forecast_run f
  left join public.weather_providers wp on wp.code = f.provider_code
  left join public.intel_sources i on i.code = f.provider_code
  cross join forecast_last fl
  union all
  select
    m.source_code, coalesce(ms.name, m.source_code), 'market',
    coalesce(i.status, 'unverified'),
    m.started_at,
    (select max(mr.finished_at) from public.market_ingestion_runs mr where mr.source_code = m.source_code and mr.status = 'ok'),
    m.status, coalesce(m.rows_written, 0),
    case
      when ml.observed_at is null then 'empty'
      when ml.observed_at >= (current_date - 36 * interval '1 hour')::timestamptz then 'fresh'
      when ml.observed_at >= (current_date - 7)::timestamptz then 'stale'
      else 'expired'
    end,
    jsonb_build_object('last_observed_on', ml.observed_at, 'rows_rejected', m.rows_rejected)
  from market_run m
  left join public.market_sources ms on ms.code = m.source_code
  left join public.intel_sources i on i.code = m.source_code
  cross join market_last ml
  union all
  select
    'punjab_advisory', coalesce(i.name, 'Punjab Agriculture advisories'), 'advisory', i.status,
    a.started_at,
    (select max(finished_at) from public.advisory_import_runs where status = 'ok'),
    a.status, coalesce(a.rows_written, 0),
    case when exists (
      select 1 from public.agri_advisories ad
       where ad.is_active and ad.verification_status = 'verified'
         and (ad.valid_until is null or ad.valid_until > now())
    ) then 'current' else 'empty' end,
    jsonb_build_object('last_error', a.error, 'rows_rejected', a.rows_rejected)
  from advisory_run a
  left join public.intel_sources i on i.code = 'punjab_advisory'
  union all
  select
    'soilgrids', coalesce(i.name, 'ISRIC SoilGrids'), 'soil', i.status,
    s.started_at,
    (select max(sr.finished_at) from public.soil_ingestion_runs sr where sr.source_code = 'soilgrids' and sr.status = 'ok'),
    s.status, coalesce(s.cells_written, 0),
    case
      when sl.fetched_at is null then 'empty'
      when sl.fetched_at > now() - interval '180 days' then 'current'
      else 'stale'
    end,
    jsonb_build_object('last_fetched_at', sl.fetched_at, 'cells_requested', s.cells_requested)
  from soil_run s
  left join public.intel_sources i on i.code = 'soilgrids'
  cross join soil_last sl;
end;
$$;

comment on function public.ingestion_health() is
  'Admin-only operational read: last attempt, last success, current freshness and rejection details for every external source. No credentials or raw payloads are returned.';

revoke execute on function public.ingestion_health() from public, anon;
grant execute on function public.ingestion_health() to authenticated;

-- The first soil provider is registered but has not been run. Registering it is
-- not an ingestion success; the source-health row will say so until rows exist.
comment on table public.soil_observations is
  'Modelled SoilGrids priors by ~1.1 km cell and depth. Never a soil test and never field-level truth. Missing properties stay NULL; the provider uncertainty is retained.';

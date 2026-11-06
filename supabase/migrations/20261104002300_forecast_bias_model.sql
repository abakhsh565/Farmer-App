-- Phase 9 · Forecast bias model, service operations and calibrated risks
--
-- The two models below were trained by `scripts/train-forecast-bias.mjs` on
-- archived ECMWF IFS 00 UTC runs and NASA POWER MERRA-2 daily reanalysis. The
-- split is chronological, not random: 455 runs train, the last 193 rows test.
-- The artifact is committed beside this migration; these rows are generated
-- from it, not hand-edited.
--
-- Registration is not activation. Both rows start as `shadow`; an operator with
-- admin or service authority must call `activate_ml_model`, which still checks
-- the holdout row count and improvement. The model applies only to Layyah and
-- only to Open-Meteo ECMWF forecasts, so a different provider or district keeps
-- its raw value rather than borrowing a correction that was not trained for it.
--
-- This migration also makes the operational functions callable by the service
-- role. That is not a widening of farmer access: the service role is the
-- scheduler/deployment identity, and the alternative is an admin-only function
-- that no automation can run. The model checks remain in force.

-- ---------------------------------------------------------------------------
-- 1. Activation authority
-- ---------------------------------------------------------------------------
create or replace function public.activate_ml_model(p_model_id uuid)
returns public.ml_models
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_model public.ml_models;
  v_improvement numeric;
  v_test_rows integer;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Model activation requires admin or service authority.'
      using errcode = 'insufficient_privilege';
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
      'test_rows', v_test_rows,
      'authority', case when v_role = 'service_role' then 'service' else 'admin' end
    ),
    public.current_party_id(), 'admin'
  );

  return v_model;
end;
$$;

comment on function public.activate_ml_model(uuid) is
  'Admin-or-service activation. Refuses a model without at least 30 holdout rows and a positive improvement over the raw baseline. Demotes the previously active model for the same target/provider/district.';

revoke execute on function public.activate_ml_model(uuid) from public, anon;
grant execute on function public.activate_ml_model(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Model health for the operator, not only for an admin session
-- ---------------------------------------------------------------------------
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
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Model health requires admin or service authority.'
      using errcode = 'insufficient_privilege';
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
  'Admin-or-service model registry view with holdout metrics, latest live backtest and artifact age. It reports missing live samples as null rather than inventing a score.';

revoke execute on function public.ml_model_health() from public, anon;
grant execute on function public.ml_model_health() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Risks read the calibrated value when one exists
-- ---------------------------------------------------------------------------
-- The risk rule's threshold was written against the raw forecast vocabulary.
-- Applying it to a calibrated value is still the same rule: the calibration is a
-- correction of that provider value, not a different metric. The basis records
-- which temperature was actually used, so a served warning can be traced back to
-- the model rather than silently looking like a raw forecast.
create or replace function public.generate_forecast_risks(
  p_from date default current_date,
  p_to   date default current_date + 2
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer := 0;
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Generating forecast risks requires the service role or admin.' using errcode = 'insufficient_privilege';
  end if;

  with rule_metric as (
    select
      r.code, r.crop_code, r.topic, r.metric, r.operator, r.threshold, r.unit,
      r.label_en, r.label_ur, r.knowledge_entry_id, r.source_code,
      f.provider_code, f.district_code, f.forecast_on, f.issued_on,
      case r.metric
        when 'tmax_c'       then coalesce(f.calibrated_tmax_c, f.tmax_c)
        when 'tmin_c'       then coalesce(f.calibrated_tmin_c, f.tmin_c)
        when 'precip_mm'    then f.precip_mm
        when 'humidity_pct' then f.humidity_pct
        when 'wind_kph'     then f.wind_kph
      end as observed,
      case r.metric
        when 'tmax_c' then f.calibrated_tmax_c is not null
        when 'tmin_c' then f.calibrated_tmin_c is not null
        else false
      end as calibrated,
      case r.metric
        when 'tmax_c' then f.tmax_model_id
        when 'tmin_c' then f.tmin_model_id
        else null
      end as model_id
    from public.forecast_risk_rules r
    join public.climate_forecasts f on true
    where r.is_active
      and f.forecast_on between p_from and p_to
  ),
  fired as (
    select *
    from rule_metric
    where observed is not null
      and case operator
        when 'gt'  then observed >  threshold
        when 'gte' then observed >= threshold
        when 'lt'  then observed <  threshold
        when 'lte' then observed <= threshold
      end
  ),
  written as (
    insert into public.forecast_risks (
      rule_code, provider_code, district_code, crop_code, topic, risk_on, issued_on,
      metric, operator, threshold, observed_value, basis, title, title_ur, summary, summary_ur, expires_at
    )
    select
      code, provider_code, district_code, crop_code, topic, forecast_on, issued_on,
      metric, operator, threshold, observed,
      jsonb_build_object(
        'metric', metric,
        'observed', observed,
        'threshold', threshold,
        'unit', unit,
        'source_row', 'climate_forecasts',
        'calibrated', calibrated,
        'model_id', model_id
      ),
      format(label_en, round(observed, 1), forecast_on),
      format(label_ur, round(observed, 1), forecast_on),
      format('%s Published guidance: %s Risk, not an outbreak: this is what the forecast suggests, not what has been seen in a field.%s',
             unit,
             (select title_en from public.agri_knowledge_entries e where e.id = knowledge_entry_id),
             case when calibrated then ' Temperature is bias-corrected by the active model.' else '' end),
      format('%s شائع شدہ رہنمائی: %s خطرہ، وبا نہیں: یہ پیش گوئی ہے، کھیت میں دیکھی گئی چیز نہیں۔%s',
             unit,
             (select title_ur from public.agri_knowledge_entries e where e.id = knowledge_entry_id),
             case when calibrated then ' درجہ حرارت فعال ماڈل سے درست کیا گیا ہے۔' else '' end),
      (forecast_on + 1)::timestamptz
    from fired
    on conflict (rule_code, district_code, risk_on, issued_on) do update
      set observed_value = excluded.observed_value,
          basis          = excluded.basis,
          title          = excluded.title,
          title_ur       = excluded.title_ur,
          summary        = excluded.summary,
          summary_ur     = excluded.summary_ur,
          expires_at     = excluded.expires_at,
          observed_at    = now()
    returning 1
  )
  select count(*) into v_written from written;

  return v_written;
end;
$$;

comment on function public.generate_forecast_risks(date, date) is
  'Applies every active rule to the stored forecast for a window and upserts the resulting risk rows. Temperature metrics use the calibrated value when an active model produced one, and the basis records that. Idempotent per (rule, district, day, issue date). Every row it writes is a risk derived from a model, never an observation.';

revoke execute on function public.generate_forecast_risks(date, date) from public, anon;
grant execute on function public.generate_forecast_risks(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The real artifacts, registered as shadow
-- ---------------------------------------------------------------------------
-- Generated from artifacts/models/forecast-bias-layyah-seed.sql. The holdout
-- comparison is ECMWF IFS against NASA POWER reanalysis, not a station record:
-- these metrics measure a model-to-model correction, not field accuracy.
insert into public.ml_models (
  model_code, version, target, algorithm, status, provider_code, district_code,
  feature_schema_version, feature_names, coefficients, metrics, provenance,
  confidence, train_rows, test_rows, training_start, training_end, trained_at
) values (
  'ecmwf_ifs_forecast_bias_layyah', 1, 'forecast_tmax_c',
  'ridge_linear_bias_correction', 'shadow', 'open_meteo', 'layyah',
  1, array['intercept','raw','lead_day','month_sin','month_cos'],
  '{"intercept":6.877793263917056,"raw":0.8721785949652248,"lead_day":-0.08844602860594315,"month_sin":0.6844755964720441,"month_cos":-0.7257473847938721}'::jsonb,
  '{"test_rows":193,"train_rows":455,"raw_mae":3.598,"calibrated_mae":1.772,"improvement_pct":50.75,"raw_rmse":3.973,"calibrated_rmse":2.171,"raw_bias":-3.593,"calibrated_bias":-1.373,"train_raw_mae":2.994,"train_calibrated_mae":1.475,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"forecast_provider":"open_meteo","forecast_model":"ecmwf_ifs","forecast_run":"00 UTC archived run","reference_provider":"nasa_power","reference_product":"MERRA-2 daily reanalysis, 0.5 degree","license":"Open-Meteo CC BY 4.0 (free tier non-commercial); NASA POWER open data with attribution","limitation":"Reanalysis reference and global forecast grid; not a field or station measurement. Do not present holdout metrics as field accuracy."}'::jsonb,
  0.95, 455, 193,
  '2025-01-04'::date, '2026-10-24'::date,
  '2026-11-04T19:44:53.200Z'::timestamptz
) on conflict (model_code, version, target, provider_code, district_code) do nothing;

insert into public.ml_models (
  model_code, version, target, algorithm, status, provider_code, district_code,
  feature_schema_version, feature_names, coefficients, metrics, provenance,
  confidence, train_rows, test_rows, training_start, training_end, trained_at
) values (
  'ecmwf_ifs_forecast_bias_layyah', 1, 'forecast_tmin_c',
  'ridge_linear_bias_correction', 'shadow', 'open_meteo', 'layyah',
  1, array['intercept','raw','lead_day','month_sin','month_cos'],
  '{"intercept":3.672275915341093,"raw":0.8662820463208103,"lead_day":0.016503879529202875,"month_sin":0.03530063705993436,"month_cos":-2.089702943462793}'::jsonb,
  '{"test_rows":193,"train_rows":455,"raw_mae":2.011,"calibrated_mae":1.209,"improvement_pct":39.88,"raw_rmse":2.533,"calibrated_rmse":1.61,"raw_bias":-1.835,"calibrated_bias":-0.423,"train_raw_mae":1.426,"train_calibrated_mae":1.054,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"forecast_provider":"open_meteo","forecast_model":"ecmwf_ifs","forecast_run":"00 UTC archived run","reference_provider":"nasa_power","reference_product":"MERRA-2 daily reanalysis, 0.5 degree","license":"Open-Meteo CC BY 4.0 (free tier non-commercial); NASA POWER open data with attribution","limitation":"Reanalysis reference and global forecast grid; not a field or station measurement. Do not present holdout metrics as field accuracy."}'::jsonb,
  0.95, 455, 193,
  '2025-01-04'::date, '2026-10-24'::date,
  '2026-11-04T19:44:53.200Z'::timestamptz
) on conflict (model_code, version, target, provider_code, district_code) do nothing;

insert into public.ml_training_runs (
  model_code, target, provider_code, district_code, started_at, finished_at, status,
  train_rows, test_rows, metrics, artifact, source_urls
) values (
  'ecmwf_ifs_forecast_bias_layyah', 'forecast_tmax_c', 'open_meteo', 'layyah',
  '2026-11-04T19:44:53.200Z'::timestamptz, '2026-11-04T19:44:53.200Z'::timestamptz,
  'ok', 455, 193,
  '{"test_rows":193,"train_rows":455,"raw_mae":3.598,"calibrated_mae":1.772,"improvement_pct":50.75,"raw_rmse":3.973,"calibrated_rmse":2.171,"raw_bias":-3.593,"calibrated_bias":-1.373,"train_raw_mae":2.994,"train_calibrated_mae":1.475,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"coefficients":[6.877793263917056,0.8721785949652248,-0.08844602860594315,0.6844755964720441,-0.7257473847938721],"feature_names":["intercept","raw","lead_day","month_sin","month_cos"]}'::jsonb,
  array['https://single-runs-api.open-meteo.com/v1/forecast', 'https://power.larc.nasa.gov/api/temporal/daily/point', 'https://open-meteo.com/en/docs/single-runs-api', 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/']
);

insert into public.ml_training_runs (
  model_code, target, provider_code, district_code, started_at, finished_at, status,
  train_rows, test_rows, metrics, artifact, source_urls
) values (
  'ecmwf_ifs_forecast_bias_layyah', 'forecast_tmin_c', 'open_meteo', 'layyah',
  '2026-11-04T19:44:53.200Z'::timestamptz, '2026-11-04T19:44:53.200Z'::timestamptz,
  'ok', 455, 193,
  '{"test_rows":193,"train_rows":455,"raw_mae":2.011,"calibrated_mae":1.209,"improvement_pct":39.88,"raw_rmse":2.533,"calibrated_rmse":1.61,"raw_bias":-1.835,"calibrated_bias":-0.423,"train_raw_mae":1.426,"train_calibrated_mae":1.054,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"coefficients":[3.672275915341093,0.8662820463208103,0.016503879529202875,0.03530063705993436,-2.089702943462793],"feature_names":["intercept","raw","lead_day","month_sin","month_cos"]}'::jsonb,
  array['https://single-runs-api.open-meteo.com/v1/forecast', 'https://power.larc.nasa.gov/api/temporal/daily/point', 'https://open-meteo.com/en/docs/single-runs-api', 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/']
);

-- Phase 9 · Historical climate provenance and independent backtesting
--
-- The live forecast adapter and the training script already exist. This
-- migration adds the two missing pieces:
--
--   1. Every NASA POWER row can say what it is (gridded reanalysis, never a
--      ground observation), where it came from, its units and its coordinates.
--      Archived ECMWF rows can say the same, and are marked as archived so a
--      historical load is not confused with today's live forecast.
--   2. A model can be evaluated on forecasts issued *after* its training end,
--      with matched NASA POWER observations. The evaluation is stored in the
--      existing ml_forecast_backtests table, not in a second model system.
--
-- A backtest with too few matched rows, too few independent issue dates, or no
-- independent period is recorded as `insufficient`. It is never labelled a
-- success. The function computes the calibrated value from the registered
-- coefficients, so evaluation does not depend on whether the model happens to
-- be active when the archive is inserted.

alter table public.climate_observations
  add column source_url text,
  add column units jsonb not null default '{}'::jsonb,
  add column provenance jsonb not null default '{}'::jsonb,
  add column data_kind text not null default 'reanalysis'
    check (data_kind in ('reanalysis', 'station', 'satellite'));

comment on column public.climate_observations.data_kind is
  'reanalysis for NASA POWER. It is a gridded model product, not a ground-station observation.';
comment on column public.climate_observations.provenance is
  'Provider, product, coordinates, retrieval time, grid resolution and licence. Kept beside every row so a joined feature can be traced.';
comment on column public.climate_observations.units is
  'Units of the stored columns. NASA POWER temperatures are °C, precipitation mm, humidity %, wind km/h after conversion.';

alter table public.climate_forecasts
  add column source_url text,
  add column provenance jsonb not null default '{}'::jsonb,
  add column is_archived boolean not null default false;

comment on column public.climate_forecasts.is_archived is
  'True for a historical Single Runs archive load. Live ingestion leaves it false. Both use the same forecast table and the same issue/valid keys.';
comment on column public.climate_forecasts.provenance is
  'Provider, model, run time, coordinates, retrieval time and licence for this forecast issue.';

alter table public.ml_forecast_backtests
  add column district_code text references public.districts (code),
  add column provider_code text references public.weather_providers (code),
  add column period_start date,
  add column period_end date,
  add column issue_count integer not null default 0,
  add column coverage_pct numeric,
  add column raw_bias numeric,
  add column calibrated_bias numeric,
  add column horizon_metrics jsonb not null default '[]'::jsonb,
  add column status text not null default 'insufficient'
    check (status in ('insufficient', 'evaluated', 'failed')),
  add column verdict text not null default 'insufficient_evidence'
    check (verdict in ('insufficient_evidence', 'beats_raw', 'does_not_beat_raw', 'failed')),
  add column independent boolean not null default false,
  add column criteria jsonb not null default '{}'::jsonb;

comment on table public.ml_forecast_backtests is
  'One row per model evaluation. status=insufficient means the matched sample or independent issue count did not meet the stated criteria; metrics may still be shown for diagnosis, but must not be presented as validation success.';

create index ml_forecast_backtests_status_idx
  on public.ml_forecast_backtests (model_id, status, evaluated_at desc);

-- The old one-argument function is replaced. Dropping it also removes its
-- grants; they are restored explicitly below.
drop function if exists public.record_ml_forecast_backtest(uuid);

create or replace function public.record_ml_forecast_backtest(
  p_model_id uuid,
  p_from date default null,
  p_to date default null,
  p_min_samples integer default 30,
  p_min_issues integer default 3
)
returns jsonb
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
  v_from date;
  v_to date;
  v_independent boolean;
  v_rows integer := 0;
  v_eligible integer := 0;
  v_issues integer := 0;
  v_raw_mae numeric;
  v_cal_mae numeric;
  v_raw_bias numeric;
  v_cal_bias numeric;
  v_improvement numeric;
  v_coverage numeric;
  v_period_start date;
  v_period_end date;
  v_horizons jsonb := '[]'::jsonb;
  v_status text;
  v_verdict text;
  v_detail jsonb;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Forecast backtesting requires the service role or admin.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_min_samples is null or p_min_samples < 1 or p_min_issues is null or p_min_issues < 1 then
    raise exception 'p_min_samples and p_min_issues must both be at least 1.'
      using errcode = 'check_violation';
  end if;

  select * into v_model from public.ml_models where id = p_model_id;
  if v_model.id is null then
    raise exception 'Model % does not exist.', p_model_id using errcode = 'no_data_found';
  end if;
  if v_model.target not in ('forecast_tmax_c', 'forecast_tmin_c') then
    raise exception 'Only forecast temperature models have a historical backtest.'
      using errcode = 'check_violation';
  end if;

  -- Independent means the forecast issue date is strictly after the model's
  -- training end. A caller cannot request an earlier start and accidentally
  -- turn training data into a validation result.
  v_from := greatest(
    coalesce(p_from, (v_model.training_end + 1)::date, current_date - 30),
    coalesce((v_model.training_end + 1)::date, date '1900-01-01')
  );
  v_to := coalesce(p_to, current_date - 1);
  v_independent := v_model.training_end is not null;

  with forecast_scope as (
    select
      f.id,
      f.issued_on,
      f.forecast_on,
      (f.forecast_on - f.issued_on) as lead_day,
      case when v_model.target = 'forecast_tmax_c' then f.tmax_c else f.tmin_c end as raw_value,
      case when v_model.target = 'forecast_tmax_c' then o.tmax_c else o.tmin_c end as observed_value
    from public.climate_forecasts f
    left join public.climate_observations o
      on o.provider_code = 'nasa_power'
     and o.district_code = f.district_code
     and o.observed_on = f.forecast_on
    where f.provider_code = v_model.provider_code
      and f.district_code = v_model.district_code
      and f.issued_on between v_from and v_to
      and f.forecast_on < current_date
  ),
  eligible as (
    select count(*)::integer as n
    from forecast_scope
    where raw_value is not null
  ),
  scored as (
    select
      s.*,
      public.ml_apply_linear(
        v_model.coefficients,
        s.raw_value,
        s.lead_day,
        extract(month from s.forecast_on)::integer
      ) as calibrated_value
    from forecast_scope s
    where s.raw_value is not null
      and s.observed_value is not null
  ),
  summary as (
    select
      count(*)::integer as n,
      count(distinct issued_on)::integer as issues,
      avg(abs(raw_value - observed_value)) as raw_mae,
      avg(abs(calibrated_value - observed_value)) as cal_mae,
      avg(raw_value - observed_value) as raw_bias,
      avg(calibrated_value - observed_value) as cal_bias,
      min(issued_on) as period_start,
      max(issued_on) as period_end
    from scored
  ),
  horizons as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'lead_day', h.lead_day,
        'sample_rows', h.sample_rows,
        'raw_mae', h.raw_mae,
        'calibrated_mae', h.calibrated_mae,
        'improvement_pct', h.improvement_pct,
        'raw_bias', h.raw_bias,
        'calibrated_bias', h.calibrated_bias
      ) order by h.lead_day
    ), '[]'::jsonb) as value
    from (
      select
        lead_day,
        count(*)::integer as sample_rows,
        round(avg(abs(raw_value - observed_value))::numeric, 3) as raw_mae,
        round(avg(abs(calibrated_value - observed_value))::numeric, 3) as calibrated_mae,
        case
          when avg(abs(raw_value - observed_value)) > 0
            then round((1 - avg(abs(calibrated_value - observed_value)) / avg(abs(raw_value - observed_value))) * 100, 2)
          else null
        end as improvement_pct,
        round(avg(raw_value - observed_value)::numeric, 3) as raw_bias,
        round(avg(calibrated_value - observed_value)::numeric, 3) as calibrated_bias
      from scored
      group by lead_day
    ) h
  )
  select
    s.n,
    e.n,
    s.issues,
    round(s.raw_mae::numeric, 3),
    round(s.cal_mae::numeric, 3),
    round(s.raw_bias::numeric, 3),
    round(s.cal_bias::numeric, 3),
    s.period_start,
    s.period_end,
    h.value
  into
    v_rows, v_eligible, v_issues, v_raw_mae, v_cal_mae, v_raw_bias, v_cal_bias,
    v_period_start, v_period_end, v_horizons
  from summary s
  cross join eligible e
  cross join horizons h;

  v_improvement := case
    when v_rows > 0 and v_raw_mae is not null and v_raw_mae > 0 and v_cal_mae is not null
      then round((1 - (v_cal_mae / v_raw_mae)) * 100, 2)
    else null
  end;
  v_coverage := case
    when v_eligible > 0 then round((v_rows::numeric / v_eligible) * 100, 2)
    else null
  end;
  v_status := case
    when not v_independent or v_rows < p_min_samples or v_issues < p_min_issues then 'insufficient'
    else 'evaluated'
  end;
  v_verdict := case
    when v_status = 'insufficient' then 'insufficient_evidence'
    when v_improvement is not null and v_improvement > 0 then 'beats_raw'
    else 'does_not_beat_raw'
  end;

  v_detail := jsonb_build_object(
    'target', v_model.target,
    'provider', v_model.provider_code,
    'district', v_model.district_code,
    'independent', v_independent,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'eligible_rows', v_eligible,
    'matched_rows', v_rows,
    'coverage_pct', v_coverage,
    'issue_count', v_issues,
    'criteria', jsonb_build_object(
      'min_samples', p_min_samples,
      'min_issues', p_min_issues,
      'independent_after', v_model.training_end
    ),
    'reference', 'NASA POWER daily reanalysis (0.5 degree)',
    'reference_kind', 'gridded reanalysis, not a ground observation',
    'note', 'Model-to-model comparison. Insufficient evidence is not a success claim.'
  );

  insert into public.ml_forecast_backtests (
    model_id, sample_rows, raw_mae, calibrated_mae, improvement_pct, detail,
    district_code, provider_code, period_start, period_end, issue_count,
    coverage_pct, raw_bias, calibrated_bias, horizon_metrics, status, verdict,
    independent, criteria
  ) values (
    v_model.id, v_rows, v_raw_mae, v_cal_mae, v_improvement, v_detail,
    v_model.district_code, v_model.provider_code, v_period_start, v_period_end, v_issues,
    v_coverage, v_raw_bias, v_cal_bias, v_horizons, v_status, v_verdict,
    v_independent,
    jsonb_build_object('min_samples', p_min_samples, 'min_issues', p_min_issues)
  );

  return jsonb_build_object(
    'model_id', v_model.id,
    'target', v_model.target,
    'status', v_status,
    'verdict', v_verdict,
    'independent', v_independent,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'eligible_rows', v_eligible,
    'sample_rows', v_rows,
    'issue_count', v_issues,
    'coverage_pct', v_coverage,
    'raw_mae', v_raw_mae,
    'calibrated_mae', v_cal_mae,
    'improvement_pct', v_improvement,
    'raw_bias', v_raw_bias,
    'calibrated_bias', v_cal_bias,
    'horizon_metrics', v_horizons,
    'criteria', v_detail->'criteria'
  );
end;
$$;

comment on function public.record_ml_forecast_backtest(uuid, date, date, integer, integer) is
  'Evaluates a temperature model only on forecasts issued after its training end, matched to NASA POWER reanalysis. Refuses to label too-small or non-independent samples as evaluated. Returns coverage and per-horizon metrics.';

revoke execute on function public.record_ml_forecast_backtest(uuid, date, date, integer, integer)
  from public, anon;
grant execute on function public.record_ml_forecast_backtest(uuid, date, date, integer, integer)
  to authenticated, service_role;

-- Keep the existing health view useful by exposing the evaluation status and
-- coverage, not just the last row's MAE.
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
        'issue_count', b.issue_count,
        'coverage_pct', b.coverage_pct,
        'raw_mae', b.raw_mae,
        'calibrated_mae', b.calibrated_mae,
        'improvement_pct', b.improvement_pct,
        'raw_bias', b.raw_bias,
        'calibrated_bias', b.calibrated_bias,
        'status', b.status,
        'verdict', b.verdict,
        'independent', b.independent,
        'horizon_metrics', b.horizon_metrics
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
  'Admin-or-service model registry view with holdout metrics, latest independent backtest status, coverage and horizon detail.';

revoke execute on function public.ml_model_health() from public, anon;
grant execute on function public.ml_model_health() to authenticated, service_role;

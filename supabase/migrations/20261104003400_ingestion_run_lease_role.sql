-- Phase 9 · correct service-role detection for run-lease RPCs
--
-- The lease functions are SECURITY DEFINER, so `current_user` is the function
-- owner rather than the PostgREST caller. Migration 033 therefore rejected the
-- service-role RPC calls it was meant to allow. This forward-only replacement
-- reads the JWT role claim, matching the existing service-only functions, and
-- keeps the admin-capability fallback.

create or replace function public.touch_ingestion_run(
  p_kind text,
  p_run_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_updated integer := 0;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Renewing an ingestion run lease requires service authority.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_run_id is null then
    return false;
  end if;

  if p_kind = 'climate' then
    update public.climate_ingestion_runs
       set heartbeat_at = now(),
           lease_expires_at = now() + interval '15 minutes'
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  elsif p_kind = 'weather' then
    update public.weather_ingestion_runs
       set heartbeat_at = now(),
           lease_expires_at = now() + interval '15 minutes'
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  elsif p_kind = 'soil' then
    update public.soil_ingestion_runs
       set heartbeat_at = now(),
           lease_expires_at = now() + interval '15 minutes'
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  else
    raise exception 'Unknown ingestion run kind.' using errcode = 'invalid_parameter_value';
  end if;

  return v_updated > 0;
end;
$$;

create or replace function public.recover_abandoned_ingestion_runs(
  p_limit integer default 50
)
returns table (
  climate_recovered integer,
  weather_recovered integer,
  soil_recovered integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_climate integer := 0;
  v_weather integer := 0;
  v_soil integer := 0;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Recovering abandoned ingestion runs requires service authority.'
      using errcode = 'insufficient_privilege';
  end if;

  with candidates as (
    select id
      from public.climate_ingestion_runs
     where status = 'running'
       and lease_expires_at < now()
     order by lease_expires_at, id
     limit v_limit
     for update skip locked
  ), recovered as (
    update public.climate_ingestion_runs r
       set status = 'failed',
           finished_at = now(),
           recovered_at = now(),
           error = concat_ws(
             '; ',
             nullif(r.error, ''),
             'Recovered as abandoned: the run lease expired without a heartbeat.'
           )
      from candidates c
     where r.id = c.id
     returning 1
  )
  select count(*)::integer into v_climate from recovered;

  with candidates as (
    select id
      from public.weather_ingestion_runs
     where status = 'running'
       and lease_expires_at < now()
     order by lease_expires_at, id
     limit v_limit
     for update skip locked
  ), recovered as (
    update public.weather_ingestion_runs r
       set status = 'failed',
           finished_at = now(),
           recovered_at = now(),
           error = concat_ws(
             '; ',
             nullif(r.error, ''),
             'Recovered as abandoned: the run lease expired without a heartbeat.'
           )
      from candidates c
     where r.id = c.id
     returning 1
  )
  select count(*)::integer into v_weather from recovered;

  with candidates as (
    select id
      from public.soil_ingestion_runs
     where status = 'running'
       and lease_expires_at < now()
     order by lease_expires_at, id
     limit v_limit
     for update skip locked
  ), recovered as (
    update public.soil_ingestion_runs r
       set status = 'failed',
           finished_at = now(),
           recovered_at = now(),
           error = concat_ws(
             '; ',
             nullif(r.error, ''),
             'Recovered as abandoned: the run lease expired without a heartbeat.'
           )
      from candidates c
     where r.id = c.id
     returning 1
  )
  select count(*)::integer into v_soil from recovered;

  return query select v_climate, v_weather, v_soil;
end;
$$;

-- Phase 9 · ingestion run leases and abandoned-run recovery
--
-- A run that is killed after its run row is inserted used to remain `running`
-- forever because there was no way to distinguish an active request from a dead
-- one. This adds a renewable lease to every run table, a heartbeat RPC, and a
-- service-only recovery RPC. Recovery only touches a run whose lease has already
-- expired; an active adapter renews the lease between provider operations, so it
-- cannot be failed by a concurrent recovery.
--
-- The original error text and all accounting counters are preserved. Recovery
-- appends its reason and records `recovered_at`; it never invents successful
-- writes or changes the target data tables.

alter table public.climate_ingestion_runs
  add column heartbeat_at timestamptz not null default now(),
  add column lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  add column recovered_at timestamptz;

alter table public.weather_ingestion_runs
  add column heartbeat_at timestamptz not null default now(),
  add column lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  add column recovered_at timestamptz;

alter table public.soil_ingestion_runs
  add column heartbeat_at timestamptz not null default now(),
  add column lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  add column recovered_at timestamptz;

create index climate_ingestion_runs_running_lease_idx
  on public.climate_ingestion_runs (lease_expires_at)
  where status = 'running';
create index weather_ingestion_runs_running_lease_idx
  on public.weather_ingestion_runs (lease_expires_at)
  where status = 'running';
create index soil_ingestion_runs_running_lease_idx
  on public.soil_ingestion_runs (lease_expires_at)
  where status = 'running';

comment on column public.climate_ingestion_runs.heartbeat_at is
  'Last successful lease renewal by the running ingestion adapter.';
comment on column public.climate_ingestion_runs.lease_expires_at is
  'After this time a running run may be recovered as abandoned. Active adapters renew it before provider work.';
comment on column public.climate_ingestion_runs.recovered_at is
  'When abandoned-run recovery changed this row to failed. Null for normal terminal rows.';
comment on column public.weather_ingestion_runs.heartbeat_at is
  'Last successful lease renewal by the running ingestion adapter.';
comment on column public.weather_ingestion_runs.lease_expires_at is
  'After this time a running run may be recovered as abandoned. Active adapters renew it before provider work.';
comment on column public.weather_ingestion_runs.recovered_at is
  'When abandoned-run recovery changed this row to failed. Null for normal terminal rows.';
comment on column public.soil_ingestion_runs.heartbeat_at is
  'Last successful lease renewal by the running ingestion adapter.';
comment on column public.soil_ingestion_runs.lease_expires_at is
  'After this time a running run may be recovered as abandoned. Active adapters renew it before provider work.';
comment on column public.soil_ingestion_runs.recovered_at is
  'When abandoned-run recovery changed this row to failed. Null for normal terminal rows.';

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
  v_updated integer := 0;
begin
  if current_user <> 'service_role' and not public.has_capability('admin') then
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

comment on function public.touch_ingestion_run(text, bigint) is
  'Renews a running ingestion run lease. Returns false when the run is no longer running. Service-only.';

revoke execute on function public.touch_ingestion_run(text, bigint) from public, anon, authenticated;
grant execute on function public.touch_ingestion_run(text, bigint) to service_role;

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
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_climate integer := 0;
  v_weather integer := 0;
  v_soil integer := 0;
begin
  if current_user <> 'service_role' and not public.has_capability('admin') then
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

comment on function public.recover_abandoned_ingestion_runs(integer) is
  'Marks only running runs whose lease has expired as failed, preserving original error text and counters. Active leases are never touched. Service-only.';

revoke execute on function public.recover_abandoned_ingestion_runs(integer) from public, anon, authenticated;
grant execute on function public.recover_abandoned_ingestion_runs(integer) to service_role;

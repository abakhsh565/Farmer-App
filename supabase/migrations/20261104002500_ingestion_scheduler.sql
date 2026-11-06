-- Phase 9 · HTTP ingestion scheduling through the existing pg_cron + pg_net
--
-- The database already uses pg_cron for refresh jobs. pg_net is available on the
-- project but was not installed. This migration installs it and schedules the
-- deployed ingestion functions, so no second scheduler framework is introduced.
--
-- A small state table prevents a new dispatch from starting before the previous
-- one's lock expires. It does not claim the function finished; the function's
-- own run table is the authority for success/failure. If a dispatch throws or a
-- function fails, the lock expires and the next scheduled run retries.
--
-- Secrets are read from Vault at dispatch time. No key is stored in this file.

create extension if not exists pg_net;

create table public.ingestion_schedule_state (
  job_name         text primary key,
  function_name    text not null,
  cadence_seconds  integer not null check (cadence_seconds >= 60),
  locked_until     timestamptz,
  last_dispatch_at timestamptz,
  last_status      text not null default 'never'
                     check (last_status in ('never', 'dispatched', 'dispatch_failed')),
  last_error       text,
  dispatch_count   integer not null default 0,
  updated_at       timestamptz not null default now()
);

comment on table public.ingestion_schedule_state is
  'Dispatch lock and last-attempt state for HTTP ingestion. Source freshness remains in the per-provider run tables.';

alter table public.ingestion_schedule_state enable row level security;
create policy ingestion_schedule_state_admin_read on public.ingestion_schedule_state
  for select to authenticated using (public.has_capability('admin'));
revoke all on public.ingestion_schedule_state from anon, authenticated;
grant select on public.ingestion_schedule_state to authenticated;

create or replace function public.dispatch_ingestion_job(
  p_job_name text,
  p_url text,
  p_body jsonb,
  p_lock_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job text;
  v_gateway_key text;
  v_ingest_token text;
begin
  if p_job_name is null or p_job_name !~ '^[a-z0-9_-]{3,64}$' then
    raise exception 'Invalid ingestion job name.' using errcode = 'check_violation';
  end if;
  if p_url is null or p_url !~ '^https://[^[:space:]]+$' then
    raise exception 'Ingestion dispatch requires an HTTPS URL.' using errcode = 'check_violation';
  end if;
  if p_lock_seconds is null or p_lock_seconds < 60 or p_lock_seconds > 7200 then
    raise exception 'Lock seconds must be between 60 and 7200.' using errcode = 'check_violation';
  end if;

  insert into public.ingestion_schedule_state (
    job_name, function_name, cadence_seconds, locked_until, last_dispatch_at,
    last_status, last_error, dispatch_count, updated_at
  )
  values (
    p_job_name, regexp_replace(p_url, '^.*/', ''), 60,
    now() + make_interval(secs => p_lock_seconds), now(),
    'dispatched', null, 1, now()
  )
  on conflict (job_name) do update
    set locked_until = excluded.locked_until,
        last_dispatch_at = now(),
        last_status = 'dispatched',
        last_error = null,
        dispatch_count = public.ingestion_schedule_state.dispatch_count + 1,
        updated_at = now()
    where public.ingestion_schedule_state.locked_until is null
       or public.ingestion_schedule_state.locked_until < now()
  returning job_name into v_job;

  if v_job is null then
    return false;
  end if;

  select decrypted_secret into v_gateway_key
    from vault.decrypted_secrets
   where name = 'ingest_gateway_key'
   limit 1;
  select decrypted_secret into v_ingest_token
    from vault.decrypted_secrets
   where name = 'ingest_token'
   limit 1;
  if v_gateway_key is null or v_ingest_token is null then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion credentials are missing from Vault',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion credentials are missing from Vault.'
      using errcode = 'insufficient_privilege';
  end if;

  perform net.http_post(
    url := p_url,
    body := p_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_gateway_key,
      'x-ingest-key', v_ingest_token
    ),
    timeout_milliseconds := 60000
  );

  return true;
exception when others then
  update public.ingestion_schedule_state
     set last_status = 'dispatch_failed',
         last_error = sqlerrm,
         locked_until = now(),
         updated_at = now()
   where job_name = p_job_name;
  raise;
end;
$$;

comment on function public.dispatch_ingestion_job(text, text, jsonb, integer) is
  'Claims a dispatch lock and posts to a deployed ingestion function using Vault credentials. The per-function run table is the source of truth for completion.';

revoke execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) to service_role;

create or replace function public.ingestion_schedule_health()
returns table (
  job_name text,
  function_name text,
  cadence_seconds integer,
  last_dispatch_at timestamptz,
  last_status text,
  last_error text,
  locked_until timestamptz,
  dispatch_count integer,
  overdue boolean
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
    raise exception 'Ingestion schedule health requires admin or service authority.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    s.job_name, s.function_name, s.cadence_seconds, s.last_dispatch_at,
    s.last_status, s.last_error, s.locked_until, s.dispatch_count,
    (s.last_dispatch_at is null or
      s.last_dispatch_at < now() - make_interval(secs => greatest(s.cadence_seconds, 60) * 2)) as overdue
  from public.ingestion_schedule_state s
  order by s.job_name;
end;
$$;

comment on function public.ingestion_schedule_health() is
  'Admin-or-service dispatch health. Overdue means no dispatch within twice the cadence; it does not prove the provider succeeded.';

revoke execute on function public.ingestion_schedule_health() from public, anon;
grant execute on function public.ingestion_schedule_health() to authenticated, service_role;

-- Seed state so cadence is available even before the first dispatch.
insert into public.ingestion_schedule_state (job_name, function_name, cadence_seconds)
values
  ('weather',    'weather-ingest',              900),
  ('forecast',   'forecast-ingest',             10800),
  ('climate',    'climate-ingest',              86400),
  ('historical', 'historical-forecast-ingest',  604800),
  ('soil',       'soil-ingest',                 2592000)
on conflict (job_name) do nothing;

-- Five minute / three hourly / daily / weekly / monthly. The dispatch lock is
-- shorter than the next cadence, so a normal run cannot overlap; a stuck run
-- releases the lock for the next scheduled attempt.
select cron.unschedule(jobname)
from cron.job
where jobname in (
  'farmer-ingest-weather', 'farmer-ingest-forecast', 'farmer-ingest-climate',
  'farmer-ingest-historical', 'farmer-ingest-soil'
);

select cron.schedule(
  'farmer-ingest-weather', '*/15 * * * *',
  $job$select public.dispatch_ingestion_job(
    'weather',
    'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/weather-ingest',
    '{"targets":true,"limit":20}'::jsonb,
    240
  );$job$
);
select cron.schedule(
  'farmer-ingest-forecast', '5 */3 * * *',
  $job$select public.dispatch_ingestion_job(
    'forecast',
    'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/forecast-ingest',
    '{"district":"layyah","days":7}'::jsonb,
    600
  );$job$
);
select cron.schedule(
  'farmer-ingest-climate', '10 3 * * *',
  $job$select public.dispatch_ingestion_job(
    'climate',
    'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/climate-ingest',
    jsonb_build_object('district','layyah','start',(current_date - 7)::text,'end',(current_date - 1)::text),
    1800
  );$job$
);
select cron.schedule(
  'farmer-ingest-historical', '40 3 * * 0',
  $job$select public.dispatch_ingestion_job(
    'historical',
    'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/historical-forecast-ingest',
    jsonb_build_object('district','layyah','start',(current_date - 14)::text,'end',(current_date - 1)::text),
    3600
  );$job$
);
select cron.schedule(
  'farmer-ingest-soil', '20 4 1 * *',
  $job$select public.dispatch_ingestion_job(
    'soil',
    'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/soil-ingest',
    '{"all":true}'::jsonb,
    1800
  );$job$
);

-- Phase 9 · environment-safe HTTP ingestion scheduling
--
-- The first scheduler stored the deployed function URL in every cron command.
-- That made a shared migration environment-specific and risked dispatching a
-- production schedule to staging, or the reverse. This forward-only replacement
-- keeps the URL out of cron entirely: the dispatcher reads the project URL and
-- project ref from this project's Vault, validates that the pair is internally
-- consistent, and builds the function URL only after validation.
--
-- Vault is project-scoped. Never copy these values between staging and
-- production. The dispatcher has no hardcoded fallback and rejects missing or
-- mismatched configuration before making an HTTP request.
--
-- Existing schedules, cadence, lock semantics and service-role-only execution
-- are preserved.

-- PostgreSQL cannot rename an input parameter through CREATE OR REPLACE.
-- Drop and recreate the same signature; the migration re-grants service_role
-- immediately and cron commands are strings, so no SQL dependency is lost.
drop function if exists public.dispatch_ingestion_job(text, text, jsonb, integer);

create function public.dispatch_ingestion_job(
  p_job_name text,
  p_function_name text,
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
  v_project_url text;
  v_project_ref text;
  v_gateway_key text;
  v_ingest_token text;
  v_function_url text;
begin
  if p_job_name is null or p_job_name !~ '^[a-z0-9_-]{3,64}$' then
    raise exception 'Invalid ingestion job name.' using errcode = 'check_violation';
  end if;
  if p_function_name is null or p_function_name !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'Invalid ingestion function name.' using errcode = 'check_violation';
  end if;
  if p_lock_seconds is null or p_lock_seconds < 60 or p_lock_seconds > 7200 then
    raise exception 'Lock seconds must be between 60 and 7200.' using errcode = 'check_violation';
  end if;

  insert into public.ingestion_schedule_state (
    job_name, function_name, cadence_seconds, locked_until, last_dispatch_at,
    last_status, last_error, dispatch_count, updated_at
  )
  values (
    p_job_name, p_function_name, 60,
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

  select decrypted_secret into v_project_url
    from vault.decrypted_secrets
   where name = 'ingestion_project_url'
   limit 1;
  select decrypted_secret into v_project_ref
    from vault.decrypted_secrets
   where name = 'ingestion_project_ref'
   limit 1;

  if nullif(btrim(v_project_url), '') is null
     or nullif(btrim(v_project_ref), '') is null then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion project configuration is missing from Vault',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion project configuration is missing from Vault.'
      using errcode = 'insufficient_privilege';
  end if;

  v_project_url := rtrim(btrim(v_project_url), '/');
  v_project_ref := btrim(v_project_ref);

  if v_project_ref !~ '^[a-z0-9]{20}$' then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion project reference is invalid',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion project reference is invalid.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_project_url <> 'https://' || v_project_ref || '.supabase.co' then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion project URL does not match the configured project reference',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion project URL does not match the configured project reference.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_function_url := v_project_url || '/functions/v1/' || p_function_name;

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
    url := v_function_url,
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
  'Claims a dispatch lock and posts to a deployed ingestion function. The project URL/ref are resolved from Vault and must match; the per-function run table remains the completion authority.';

revoke execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) to service_role;

-- Recreate the same five schedules with function names, not URLs. Keeping the
-- existing job names preserves the established cadence and monitoring surface.
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
    'weather-ingest',
    '{"targets":true,"limit":20}'::jsonb,
    240
  );$job$
);
select cron.schedule(
  'farmer-ingest-forecast', '5 */3 * * *',
  $job$select public.dispatch_ingestion_job(
    'forecast',
    'forecast-ingest',
    '{"district":"layyah","days":7}'::jsonb,
    600
  );$job$
);
select cron.schedule(
  'farmer-ingest-climate', '10 3 * * *',
  $job$select public.dispatch_ingestion_job(
    'climate',
    'climate-ingest',
    jsonb_build_object('district','layyah','start',(current_date - 7)::text,'end',(current_date - 1)::text),
    1800
  );$job$
);
select cron.schedule(
  'farmer-ingest-historical', '40 3 * * 0',
  $job$select public.dispatch_ingestion_job(
    'historical',
    'historical-forecast-ingest',
    jsonb_build_object('district','layyah','start',(current_date - 14)::text,'end',(current_date - 1)::text),
    3600
  );$job$
);
select cron.schedule(
  'farmer-ingest-soil', '20 4 1 * *',
  $job$select public.dispatch_ingestion_job(
    'soil',
    'soil-ingest',
    '{"all":true}'::jsonb,
    1800
  );$job$
);

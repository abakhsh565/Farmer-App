-- Phase 9 · scheduler credential isolation
--
-- Migration 028 moved the ingestion project URL into Vault and validated the
-- URL/project-ref pair. This forward-only hardening adds the third isolation
-- check: the Vault gateway credential must be a project JWT whose `ref` claim
-- equals the configured project ref. A staging gateway key therefore cannot be
-- used with a production URL/ref pair, or the reverse.
--
-- Only the dispatcher changes. The existing five cron jobs from migration 028
-- keep calling the same signature, cadence and locks; no reschedule is needed.

create or replace function public.dispatch_ingestion_job(
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
  v_jwt_b64 text;
  v_credential_ref text;
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

  if v_project_url <> ('https://' || v_project_ref || '.supabase.co') then
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

  if v_gateway_key !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion gateway credential is not a project JWT',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion gateway credential is not a project JWT.'
      using errcode = 'invalid_parameter_value';
  end if;

  begin
    v_jwt_b64 := translate(split_part(v_gateway_key, '.', 2), '-_', '+/');
    v_jwt_b64 := rpad(v_jwt_b64, ((length(v_jwt_b64) + 3) / 4) * 4, '=');
    v_credential_ref := convert_from(decode(v_jwt_b64, 'base64'), 'UTF8')::jsonb ->> 'ref';
  exception when others then
    v_credential_ref := null;
  end;

  if v_credential_ref is null or v_credential_ref <> v_project_ref then
    update public.ingestion_schedule_state
       set last_status = 'dispatch_failed',
           last_error = 'ingestion gateway credential belongs to a different project',
           locked_until = now(),
           updated_at = now()
     where job_name = p_job_name;
    raise exception 'Ingestion gateway credential belongs to a different project.'
      using errcode = 'invalid_parameter_value';
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
  'Claims a dispatch lock and posts to a deployed ingestion function. The project URL/ref and gateway credential project must match; the per-function run table remains the completion authority.';

revoke execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.dispatch_ingestion_job(text, text, jsonb, integer) to service_role;

-- The five schedules from migration 028 are intentionally left untouched.

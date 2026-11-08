-- Phase 9 · durable ingestion run context
--
-- Counters and provider errors used to be written only by the terminal status
-- update. If that update failed, the run stayed `running` with no record of what
-- the provider had actually returned. This adds durable context columns plus
-- service-only RPCs that persist context before finalization, merge rather than
-- overwrite existing values, and finalize atomically.
--
-- `processing_errors` preserves every distinct meaningful failure. The legacy
-- `error` text is kept for existing readers and is rebuilt from that array, so a
-- later write cannot replace a provider error with a generic message.

alter table public.climate_ingestion_runs
  add column if not exists processing_errors jsonb not null default '[]'::jsonb;
alter table public.weather_ingestion_runs
  add column if not exists processing_errors jsonb not null default '[]'::jsonb;
alter table public.soil_ingestion_runs
  add column if not exists processing_errors jsonb not null default '[]'::jsonb;

comment on column public.climate_ingestion_runs.processing_errors is
  'Distinct provider and processing errors recorded for this run, in first-seen order. Preserved across context writes, finalization, and recovery.';
comment on column public.weather_ingestion_runs.processing_errors is
  'Distinct provider and processing errors recorded for this run, in first-seen order. Preserved across context writes, finalization, and recovery.';
comment on column public.soil_ingestion_runs.processing_errors is
  'Distinct provider and processing errors recorded for this run, in first-seen order. Preserved across context writes, finalization, and recovery.';

-- ---------------------------------------------------------------------------
-- Internal error merge helpers
-- ---------------------------------------------------------------------------
create or replace function public.merge_ingestion_errors(
  p_existing_error text,
  p_existing_errors jsonb,
  p_error text,
  p_errors jsonb
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  with existing_errors as (
    select case
      when jsonb_typeof(coalesce(p_existing_errors, '[]'::jsonb)) = 'array'
        then coalesce(p_existing_errors, '[]'::jsonb)
      else '[]'::jsonb
    end as errors
  ), inputs as (
    -- The legacy error text is only a fallback for rows that predate the
    -- processing_errors array. When the array exists, the text is its rendered
    -- form; adding it again would duplicate every error.
    select nullif(btrim(p_existing_error), '') as value, 0 as ord
      from existing_errors e
     where jsonb_array_length(e.errors) = 0
    union all
    select nullif(btrim(value), ''), ord
      from existing_errors e,
           jsonb_array_elements_text(e.errors) with ordinality as x(value, ord)
    union all
    select nullif(btrim(value), ''), 100000 + ord
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(coalesce(p_errors, '[]'::jsonb)) = 'array'
            then coalesce(p_errors, '[]'::jsonb)
          else '[]'::jsonb
        end
      ) with ordinality as x(value, ord)
    union all
    select nullif(btrim(p_error), ''), 200000
  ), normalized as (
    select value, ord
      from inputs
     where value is not null and value <> ''
  ), unique_errors as (
    select value, min(ord) as first_ord
      from normalized
     group by value
  )
  select coalesce(jsonb_agg(value order by first_ord), '[]'::jsonb)
    from unique_errors;
$$;

comment on function public.merge_ingestion_errors(text, jsonb, text, jsonb) is
  'Merges provider errors in first-seen order and removes duplicates. Internal helper.';

revoke execute on function public.merge_ingestion_errors(text, jsonb, text, jsonb)
  from public, anon, authenticated;

create or replace function public.ingestion_errors_text(p_errors jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(string_agg(value, '; ' order by ord), '')
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(coalesce(p_errors, '[]'::jsonb)) = 'array'
          then coalesce(p_errors, '[]'::jsonb)
        else '[]'::jsonb
      end
    ) with ordinality as x(value, ord);
$$;

comment on function public.ingestion_errors_text(jsonb) is
  'Renders the merged processing error array as the legacy error text. Internal helper.';

revoke execute on function public.ingestion_errors_text(jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read state
-- ---------------------------------------------------------------------------
create or replace function public.get_ingestion_run_state(
  p_kind text,
  p_run_id bigint
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
  v_state jsonb;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Reading an ingestion run state requires service authority.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_run_id is null then
    return null;
  end if;

  if p_kind = 'climate' then
    select jsonb_build_object(
      'run_id', r.id,
      'kind', 'climate',
      'status', r.status,
      'started_at', r.started_at,
      'finished_at', r.finished_at,
      'heartbeat_at', r.heartbeat_at,
      'lease_expires_at', r.lease_expires_at,
      'recovered_at', r.recovered_at,
      'records_fetched', r.records_fetched,
      'records_inserted', r.records_inserted,
      'records_updated', r.records_updated,
      'records_skipped', r.records_skipped,
      'records_rejected', r.records_rejected,
      'records_failed', r.records_failed,
      'rows_seen', r.rows_seen,
      'rows_written', r.rows_written,
      'cells_written', null,
      'error', r.error,
      'processing_errors', coalesce(r.processing_errors, '[]'::jsonb)
    )
      into v_state
      from public.climate_ingestion_runs r
     where r.id = p_run_id;
  elsif p_kind = 'weather' then
    select jsonb_build_object(
      'run_id', r.id,
      'kind', 'weather',
      'status', r.status,
      'started_at', r.started_at,
      'finished_at', r.finished_at,
      'heartbeat_at', r.heartbeat_at,
      'lease_expires_at', r.lease_expires_at,
      'recovered_at', r.recovered_at,
      'records_fetched', r.records_fetched,
      'records_inserted', r.records_inserted,
      'records_updated', r.records_updated,
      'records_skipped', r.records_skipped,
      'records_rejected', r.records_rejected,
      'records_failed', r.records_failed,
      'rows_seen', null,
      'rows_written', null,
      'cells_written', r.cells_written,
      'error', r.error,
      'processing_errors', coalesce(r.processing_errors, '[]'::jsonb)
    )
      into v_state
      from public.weather_ingestion_runs r
     where r.id = p_run_id;
  elsif p_kind = 'soil' then
    select jsonb_build_object(
      'run_id', r.id,
      'kind', 'soil',
      'status', r.status,
      'started_at', r.started_at,
      'finished_at', r.finished_at,
      'heartbeat_at', r.heartbeat_at,
      'lease_expires_at', r.lease_expires_at,
      'recovered_at', r.recovered_at,
      'records_fetched', r.records_fetched,
      'records_inserted', r.records_inserted,
      'records_updated', r.records_updated,
      'records_skipped', r.records_skipped,
      'records_rejected', r.records_rejected,
      'records_failed', r.records_failed,
      'rows_seen', null,
      'rows_written', null,
      'cells_written', r.cells_written,
      'error', r.error,
      'processing_errors', coalesce(r.processing_errors, '[]'::jsonb)
    )
      into v_state
      from public.soil_ingestion_runs r
     where r.id = p_run_id;
  else
    raise exception 'Unknown ingestion run kind.' using errcode = 'invalid_parameter_value';
  end if;

  return v_state;
end;
$$;

comment on function public.get_ingestion_run_state(text, bigint) is
  'Returns the actual persisted context for one ingestion run, or null. Service-only.';

revoke execute on function public.get_ingestion_run_state(text, bigint)
  from public, anon, authenticated;
grant execute on function public.get_ingestion_run_state(text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Durable pre-finalization context
-- ---------------------------------------------------------------------------
create or replace function public.record_ingestion_run_context(
  p_kind text,
  p_run_id bigint,
  p_counters jsonb default '{}'::jsonb,
  p_error text default null,
  p_errors jsonb default '[]'::jsonb,
  p_cells_written integer default null
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
  v_existing_error text;
  v_existing_errors jsonb;
  v_errors jsonb;
  v_error text;
  v_counters jsonb := coalesce(p_counters, '{}'::jsonb);
  v_state jsonb;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Recording ingestion run context requires service authority.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_run_id is null then
    return jsonb_build_object('ok', false, 'error', 'run id is required', 'state', null);
  end if;

  if p_kind = 'climate' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.climate_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.climate_ingestion_runs
       set records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           rows_seen = greatest(rows_seen, coalesce((v_counters->>'fetched')::integer, 0)),
           rows_written = greatest(
             rows_written,
             coalesce((v_counters->>'inserted')::integer, 0)
               + coalesce((v_counters->>'updated')::integer, 0)
           ),
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
  elsif p_kind = 'weather' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.weather_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.weather_ingestion_runs
       set records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           cells_written = case
             when p_cells_written is null then cells_written
             else greatest(cells_written, greatest(p_cells_written, 0))
           end,
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
  elsif p_kind = 'soil' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.soil_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.soil_ingestion_runs
       set records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           cells_written = case
             when p_cells_written is null then cells_written
             else greatest(cells_written, greatest(p_cells_written, 0))
           end,
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
  else
    raise exception 'Unknown ingestion run kind.' using errcode = 'invalid_parameter_value';
  end if;

  v_state := public.get_ingestion_run_state(p_kind, p_run_id);
  return jsonb_build_object('ok', true, 'state', v_state);
end;
$$;

comment on function public.record_ingestion_run_context(text, bigint, jsonb, text, jsonb, integer) is
  'Persists counters and provider errors before terminal finalization. Merges counters upward and errors by value; never clears useful context. Service-only.';

revoke execute on function public.record_ingestion_run_context(text, bigint, jsonb, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.record_ingestion_run_context(text, bigint, jsonb, text, jsonb, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Atomic terminal finalization
-- ---------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_kind text,
  p_run_id bigint,
  p_status text,
  p_error text default null,
  p_errors jsonb default '[]'::jsonb,
  p_counters jsonb default '{}'::jsonb,
  p_cells_written integer default null
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
  v_existing_error text;
  v_existing_errors jsonb;
  v_errors jsonb;
  v_error text;
  v_counters jsonb := coalesce(p_counters, '{}'::jsonb);
  v_updated integer := 0;
  v_state jsonb;
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Finalizing an ingestion run requires service authority.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('ok', 'partial', 'failed') then
    raise exception 'Invalid terminal ingestion status.' using errcode = 'invalid_parameter_value';
  end if;
  if p_run_id is null then
    return jsonb_build_object('ok', false, 'error', 'run id is required', 'state', null);
  end if;

  if p_kind = 'climate' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.climate_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.climate_ingestion_runs
       set status = p_status,
           finished_at = now(),
           records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           rows_seen = greatest(rows_seen, coalesce((v_counters->>'fetched')::integer, 0)),
           rows_written = greatest(
             rows_written,
             coalesce((v_counters->>'inserted')::integer, 0)
               + coalesce((v_counters->>'updated')::integer, 0)
           ),
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  elsif p_kind = 'weather' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.weather_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.weather_ingestion_runs
       set status = p_status,
           finished_at = now(),
           records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           cells_written = case
             when p_cells_written is null then cells_written
             else greatest(cells_written, greatest(p_cells_written, 0))
           end,
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  elsif p_kind = 'soil' then
    select r.error, r.processing_errors
      into v_existing_error, v_existing_errors
      from public.soil_ingestion_runs r
     where r.id = p_run_id and r.status = 'running'
       for update;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'error', 'run is no longer running',
        'state', public.get_ingestion_run_state(p_kind, p_run_id)
      );
    end if;

    v_errors := public.merge_ingestion_errors(v_existing_error, v_existing_errors, p_error, p_errors);
    v_error := public.ingestion_errors_text(v_errors);

    update public.soil_ingestion_runs
       set status = p_status,
           finished_at = now(),
           records_fetched = greatest(records_fetched, coalesce((v_counters->>'fetched')::integer, 0)),
           records_inserted = greatest(records_inserted, coalesce((v_counters->>'inserted')::integer, 0)),
           records_updated = greatest(records_updated, coalesce((v_counters->>'updated')::integer, 0)),
           records_skipped = greatest(records_skipped, coalesce((v_counters->>'skipped')::integer, 0)),
           records_rejected = greatest(records_rejected, coalesce((v_counters->>'rejected')::integer, 0)),
           records_failed = greatest(records_failed, coalesce((v_counters->>'failed')::integer, 0)),
           cells_written = case
             when p_cells_written is null then cells_written
             else greatest(cells_written, greatest(p_cells_written, 0))
           end,
           error = v_error,
           processing_errors = v_errors
     where id = p_run_id and status = 'running';
    get diagnostics v_updated = row_count;
  else
    raise exception 'Unknown ingestion run kind.' using errcode = 'invalid_parameter_value';
  end if;

  v_state := public.get_ingestion_run_state(p_kind, p_run_id);
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'error', 'run is no longer running', 'state', v_state);
  end if;
  return jsonb_build_object('ok', true, 'state', v_state);
end;
$$;

comment on function public.finalize_ingestion_run(text, bigint, text, text, jsonb, jsonb, integer) is
  'Atomically applies terminal status while merging counters upward and preserving every previously recorded processing error. Service-only.';

revoke execute on function public.finalize_ingestion_run(text, bigint, text, text, jsonb, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_ingestion_run(text, bigint, text, text, jsonb, jsonb, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Recovery preserves context
-- ---------------------------------------------------------------------------
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
  v_reason constant text :=
    'Recovered as abandoned: the run lease expired without a heartbeat.';
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
           processing_errors = public.merge_ingestion_errors(
             r.error, r.processing_errors, v_reason, '[]'::jsonb
           ),
           error = public.ingestion_errors_text(
             public.merge_ingestion_errors(
               r.error, r.processing_errors, v_reason, '[]'::jsonb
             )
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
           processing_errors = public.merge_ingestion_errors(
             r.error, r.processing_errors, v_reason, '[]'::jsonb
           ),
           error = public.ingestion_errors_text(
             public.merge_ingestion_errors(
               r.error, r.processing_errors, v_reason, '[]'::jsonb
             )
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
           processing_errors = public.merge_ingestion_errors(
             r.error, r.processing_errors, v_reason, '[]'::jsonb
           ),
           error = public.ingestion_errors_text(
             public.merge_ingestion_errors(
               r.error, r.processing_errors, v_reason, '[]'::jsonb
             )
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
  'Marks only expired running runs as failed, preserving counters and all processing errors while appending the recovery reason exactly once. Active leases are never touched. Service-only.';

revoke execute on function public.recover_abandoned_ingestion_runs(integer)
  from public, anon, authenticated;
grant execute on function public.recover_abandoned_ingestion_runs(integer) to service_role;

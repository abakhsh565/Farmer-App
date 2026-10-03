-- Farmer App · migration 0014 · retention, decay and projection maintenance
--
-- PRD: automated retention jobs. Raw voice ~7 days, AI images/videos ~30 days
-- after the structured result, technical traces ~14–30 days, failed/temporary
-- uploads cleaned automatically, behavioural signals strong for ~90 days then
-- decayed, and important structured history retained.
--
-- The numbers are not written here. They live in retention_policies, and this
-- migration only schedules the work. A target that can be changed without a
-- deployment is the difference between a policy and a hard-coded guess.

-- ---------------------------------------------------------------------------
-- One entry point per class of work, so a job can be run by hand to investigate
-- ---------------------------------------------------------------------------

-- Raw voice beyond its window. Audio is the most identifying medium and has no
-- value once transcribed, so it is purged on the shortest clock.
create or replace function public.job_purge_voice()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000) where media_class = 'voice_note';
$$;

-- Scan imagery once the structured result is settled.
create or replace function public.job_purge_scan_media()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000)
   where media_class in ('scan_source', 'scan_derived');
$$;

create or replace function public.job_purge_community_media()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000)
   where media_class in ('community_photo', 'community_video');
$$;

-- Interactions and technical traces. Anything trace-shaped carries the same
-- window, so it is expressed once.
create or replace function public.job_purge_technical_traces(p_days integer default 21)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_runs integer := 0;
  v_tmp  integer := 0;
begin
  delete from public.market_ingestion_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  delete from public.weather_ingestion_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  delete from public.dealer_sync_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  -- Expired temporary search areas are session artefacts and go quickly.
  delete from public.farmer_temporary_areas where expires_at < now() - interval '1 day';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  -- Stories past their expiry, with their views.
  delete from public.community_stories where expires_at < now() - interval '7 days';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  -- Read notifications that nobody has looked at in a quarter.
  delete from public.notification_events
   where read_at is not null and read_at < now() - interval '90 days';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  return v_runs;
end;
$$;

-- Expired inferences stop being shown. They are not deleted, because an old
-- guess is evidence of how a decision was reached.
create or replace function public.job_expire_inferences()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with dismissed as (
    update public.crop_inferences
       set dismissed_at = now()
     where dismissed_at is null
       and promoted_fact_id is null
       and expires_at is not null
       and expires_at <= now()
    returning 1
  )
  select count(*) into v_count from dismissed;

  return v_count;
end;
$$;

-- Advice that has passed its validity window is retired, and its announcement
-- with it, so a stale recommendation cannot sit on the home screen looking
-- current.
create or replace function public.job_expire_recommendations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.recommendations
       set withdrawn_at = now(), withdraw_reason = 'validity window passed'
     where withdrawn_at is null
       and valid_until is not null
       and valid_until <= now()
    returning id
  )
  select count(*) into v_count from expired;

  update public.notification_events n
     set dismissed_at = now()
   where n.dismissed_at is null
     and n.recommendation_id in (
       select r.id from public.recommendations r where r.withdrawn_at is not null
     );

  return v_count;
end;
$$;

-- Behaviour decays by being read through signal_weight rather than by being
-- rewritten, but very old rows are pruned so the table does not grow forever.
create or replace function public.job_prune_decayed_signals(p_days integer default 400)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.behaviour_signals
     where observed_at < now() - make_interval(days => p_days)
       and strength = 'weak'
    returning 1
  )
  select count(*) into v_count from gone;

  return v_count;
end;
$$;

-- A dealer whose projection has not been confirmed recently must be shown as
-- stale rather than as current.
create or replace function public.job_refresh_dealer_staleness()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.mark_stale_dealer_projections('36 hours');
$$;

-- Verification is not forever. An expired licence must not keep a badge lit.
create or replace function public.job_expire_verifications()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.expert_verifications
       set status = 'suspended',
           suspended_at = now(),
           suspension_reason = 'verification expired'
     where status = 'verified'
       and expires_at is not null
       and expires_at <= now()
    returning party_id
  ),
  revoked as (
    update public.party_capabilities c
       set revoked_at = now()
     where c.capability = 'expert'
       and c.revoked_at is null
       and c.party_id in (select party_id from expired)
    returning 1
  ),
  logged as (
    insert into public.expert_verification_history (party_id, from_status, to_status, note)
    select party_id, 'verified', 'suspended', 'Automatic expiry of the verification period'
    from expired
    returning 1
  )
  select count(*) into v_count from expired;

  return v_count;
end;
$$;

create or replace function public.job_purge_stale_uploads()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.purge_stale_uploads('24 hours');
$$;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Long-lived deployments have pg_cron available. Local development and CI often
-- do not, and the schema must still apply cleanly there, so scheduling is
-- wrapped rather than assumed.
do $$
declare
  v_has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into v_has_cron;

  if not v_has_cron then
    raise notice 'pg_cron is not installed in this database; retention jobs are not scheduled here. The job functions above remain callable by hand or by an external scheduler.';
    return;
  end if;

  -- Unscheduling first makes this migration re-runnable.
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in (
     'farmer-purge-voice', 'farmer-purge-scan-media', 'farmer-purge-community-media',
     'farmer-purge-traces', 'farmer-expire-inferences', 'farmer-expire-recommendations',
     'farmer-prune-signals', 'farmer-refresh-dealer-staleness', 'farmer-expire-verifications',
     'farmer-purge-uploads'
   );

  -- Voice: frequent, because the window is short and the data is sensitive.
  perform cron.schedule('farmer-purge-voice', '17 */4 * * *', $job$select public.job_purge_voice();$job$);
  -- Scan and community media: daily is enough for a 30 day window.
  perform cron.schedule('farmer-purge-scan-media', '23 2 * * *', $job$select public.job_purge_scan_media();$job$);
  perform cron.schedule('farmer-purge-community-media', '31 2 * * *', $job$select public.job_purge_community_media();$job$);
  -- Traces: nightly.
  perform cron.schedule('farmer-purge-traces', '41 3 * * *', $job$select public.job_purge_technical_traces();$job$);
  -- Failed uploads: hourly, so a broken client cannot fill storage overnight.
  perform cron.schedule('farmer-purge-uploads', '9 * * * *', $job$select public.job_purge_stale_uploads();$job$);
  -- Advice and inferences: hourly, so nothing stale survives a day.
  perform cron.schedule('farmer-expire-recommendations', '5 * * * *', $job$select public.job_expire_recommendations();$job$);
  perform cron.schedule('farmer-expire-inferences', '25 * * * *', $job$select public.job_expire_inferences();$job$);
  -- Signals: weekly prune, since decay is a read-time effect.
  perform cron.schedule('farmer-prune-signals', '13 4 * * 0', $job$select public.job_prune_decayed_signals();$job$);
  -- Projections and badges: every two hours.
  perform cron.schedule('farmer-refresh-dealer-staleness', '7 */2 * * *', $job$select public.job_refresh_dealer_staleness();$job$);
  perform cron.schedule('farmer-expire-verifications', '11 5 * * *', $job$select public.job_expire_verifications();$job$);
end;
$$;

comment on function public.job_purge_technical_traces(integer) is
  'Deletes ingestion and sync runs, expired temporary areas, dead stories and long-read notifications. The 14–30 day band from the PRD is the p_days default.';

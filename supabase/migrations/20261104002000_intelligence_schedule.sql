-- Phase 8 launch hardening: run the existing intelligence jobs on a schedule.
--
-- The job wrappers already exist and are service-only; nothing scheduled them.
-- As a result crop stages, recommendations, alert production and learned
-- interests only advanced when a farmer opened the app or an operator called the
-- functions by hand. That is not a proactive intelligence system.
--
-- Every function below is bounded and idempotent:
--   · crop stages only recalculate open, unconfirmed crops;
--   · recommendations upsert by dedupe key and use each farmer's cooldown;
--   · alerts are independently cooled down and capped per farmer;
--   · interest learning only refreshes derived interests.
--
-- The schedules are staggered away from the existing retention/expiry jobs so a
-- small deployment does not pile every task onto the same minute. pg_cron may be
-- absent in local development; in that case the functions remain callable and no
-- schedule is invented.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'farmer-refresh-crop-stages') then
      perform cron.unschedule('farmer-refresh-crop-stages');
    end if;
    perform cron.schedule(
      'farmer-refresh-crop-stages',
      '19 2 * * *',
      'select public.job_refresh_crop_stages();'
    );

    if exists (select 1 from cron.job where jobname = 'farmer-refresh-recommendations') then
      perform cron.unschedule('farmer-refresh-recommendations');
    end if;
    perform cron.schedule(
      'farmer-refresh-recommendations',
      '17 * * * *',
      'select public.job_refresh_all_recommendations();'
    );

    if exists (select 1 from cron.job where jobname = 'farmer-refresh-alerts') then
      perform cron.unschedule('farmer-refresh-alerts');
    end if;
    perform cron.schedule(
      'farmer-refresh-alerts',
      '2,17,32,47 * * * *',
      'select public.job_refresh_all_alerts();'
    );

    if exists (select 1 from cron.job where jobname = 'farmer-refresh-intelligence') then
      perform cron.unschedule('farmer-refresh-intelligence');
    end if;
    perform cron.schedule(
      'farmer-refresh-intelligence',
      '29 2 * * *',
      'select public.job_refresh_farmer_intelligence(90);'
    );
  end if;
end;
$$;

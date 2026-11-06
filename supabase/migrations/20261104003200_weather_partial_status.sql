-- Phase 9 · weather partial-run status
--
-- The weather adapter has always intended to report `partial` when some cells
-- succeed and others fail, but `weather_ingestion_runs.status` only allowed
-- `running`, `ok` and `failed`. A partial update therefore violated the check
-- constraint; because the adapter ignored the update error, the run remained
-- `running` even after a successful HTTP response. Migration 030 added the
-- accounting columns but did not widen this status domain.
--
-- This is a forward-only correction of the status domain. It does not rewrite
-- any applied migration or invent a successful run.

alter table public.weather_ingestion_runs
  drop constraint if exists weather_ingestion_runs_status_check;

alter table public.weather_ingestion_runs
  add constraint weather_ingestion_runs_status_check
  check (status in ('running', 'ok', 'partial', 'failed'));

comment on column public.weather_ingestion_runs.status is
  'running while in progress; ok when every requested cell completed; partial when some cells succeeded and some failed or records were skipped; failed when no cell succeeded.';

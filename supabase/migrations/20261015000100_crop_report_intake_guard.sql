-- Farmer App · migration 0027 · field-report intake: the author comes from the
-- session, not from the request body
--
-- `submit_crop_report` shipped in 0025 taking `p_reporter_id uuid`. That is a
-- client-supplied identity in a `security definer` function, and it means any
-- caller holding the anon key could file a report *as* another farmer — the
-- exact thing a traceable report cannot allow, and the reason every other write
-- in this chain derives its actor from `auth.uid()`.
--
-- The body is otherwise unchanged: same validation, same two-decimal rounding,
-- same idempotency on (reporter, key). What changes is where the reporter comes
-- from, and who may call it.

-- The old signature is dropped, not left beside the new one: an overload nobody
-- calls is still an overload an attacker can call.
drop function if exists public.submit_crop_report(
  uuid, text, text, text, text, double precision, double precision, text, text, timestamptz, text
);

create or replace function public.submit_crop_report(
  p_crop_code text,
  p_topic text,
  p_title text,
  p_body text,
  p_lat double precision,
  p_lon double precision,
  p_area_label text,
  p_district text default null,
  p_observed_at timestamptz default null,
  p_idempotency_key text default null
)
returns public.crop_reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.crop_reports;
  v_reporter uuid;
  v_lat double precision;
  v_lon double precision;
begin
  -- The actor is the session's party. A guest has none, and is told so rather
  -- than silently filing an anonymous report.
  v_reporter := public.current_party_id();
  if v_reporter is null then
    raise exception 'Reporting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;
  if p_lat is null or p_lat < -90 or p_lat > 90 or p_lon is null or p_lon < -180 or p_lon > 180 then
    raise exception 'Invalid report location.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_area_label), '') = '' then
    raise exception 'An approximate area label is required; exact field locations are never stored.' using errcode = 'check_violation';
  end if;
  -- Round to ~1.1km cell so the stored point is approximate by construction.
  v_lat := round(p_lat::numeric, 2)::double precision;
  v_lon := round(p_lon::numeric, 2)::double precision;

  insert into public.crop_reports (
    reporter_id, crop_code, topic, title, body, evidence, status, visibility,
    geog, area_label, district, observed_at, source_code, idempotency_key
  ) values (
    v_reporter, p_crop_code, p_topic, btrim(p_title), btrim(p_body),
    'farmer_report', 'published', 'public',
    extensions.ST_SetSRID(extensions.ST_MakePoint(v_lon, v_lat), 4326)::extensions.geography,
    btrim(p_area_label), p_district, coalesce(p_observed_at, now()), 'platform_reports', p_idempotency_key
  )
  returning * into v_report;
  return v_report;
exception
  when unique_violation then
    select * into v_report from public.crop_reports
     where reporter_id = v_reporter and idempotency_key = p_idempotency_key;
    if found then return v_report; end if;
    raise;
end;
$$;

comment on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text) is
  'Farmer report intake. Author is the caller''s own party (no client-supplied id); rounds coords to 2 decimals; labels evidence farmer_report; idempotent on (reporter, key).';

-- A guest must not be able to file a report at all, and `create function` grants
-- EXECUTE to PUBLIC by default — which for a `security definer` function is a
-- standing invitation. Revoked here and granted only where it belongs.
revoke all on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text) from public;
revoke all on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text) from anon;
grant execute on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text) to authenticated;

-- Farmer App · migration 0029 · the field report's photo
--
-- Step 1's fourth source asks for a "report a problem in your field" flow with
-- approximate location, crop **and photo**. The first three landed in 0026; the
-- photo did not, and without it the flow is a written description of a plant
-- disease. That is not a detail: Step 2 turns on a person deciding whether a
-- report is true, and the person deciding needs to see the leaf.
--
-- WHY A SECOND STORAGE BUCKET AND NOT `storage.buckets`' EXISTING ONES
--
-- The four buckets in 0012 are named for what they hold — `scan-media` is a
-- camera frame the AI diagnoses, `community` is a post, `verification` is a
-- qualification. A report photo is neither, and filing it under a neighbour's
-- class would mean its retention, its access rules and its deletion all follow
-- the wrong owner. A bucket is also the cheapest thing in this schema to add:
-- it is one row, and it carries no enum change.
--
-- WHY NOT `media_assets` AND `media_class`
--
-- `media_assets` is the right home for this, and it cannot be used yet — not by
-- preference but by a hard constraint. `media_class` is an enum, the new class
-- would have to be added with `alter type ... add value`, and the whole chain is
-- shipped as ONE transaction (`supabase/apply-all.sql`, `begin; … commit;`).
-- PostgreSQL refuses to *use* a value added by `alter type` in the same
-- transaction that adds it, so the chain would fail on the paste that matters
-- most. Reusing an existing class instead (`scan_source`) would put a field
-- report's evidence under a class whose retention rule is written for a scan.
-- So the report carries its own three columns until the enum can be extended
-- safely, and this comment is the note to move it then.

-- ---------------------------------------------------------------------------
-- The bucket
-- ---------------------------------------------------------------------------

-- Private, 15 MiB. Private because a field photo is the farmer's own: it is
-- served to a reviewer through the policies below, never by URL.
insert into storage.buckets (id, name, public, file_size_limit)
values ('report-media', 'report-media', false, 15728640)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Storage access: the owner's own folder, and a reviewer's read
-- ---------------------------------------------------------------------------
--
-- Paths are `{auth uid}/{uuid}.{ext}`, so the first folder segment *is* the
-- uploader's auth id and ownership is a property of the path rather than of a
-- row that could disagree with it. The report insert function checks the same
-- prefix, so a client cannot file a report pointing at someone else's photo —
-- and cannot upload into someone else's folder to begin with.

create policy report_media_own_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy report_media_own_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- A replace is what a retried upload does. It is scoped to the same folder and
-- to the same owner, so a retry cannot overwrite anyone else's object.
create policy report_media_own_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Whoever is reviewing reports has to be able to see them. `expert` is the
-- capability `grant_expert_verification` already writes, so this reuses the
-- verification gate rather than inventing a second notion of who a reviewer is.
create policy report_media_reviewer_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'report-media'
    and (
      public.has_capability('expert')
      or public.has_capability('admin')
      or public.has_capability('moderator')
    )
  );

-- ---------------------------------------------------------------------------
-- The photo's reference, on the report itself
-- ---------------------------------------------------------------------------

-- Three columns, all-or-nothing: a path with no declared type and size could
-- not be validated, and a type with no path names an object that does not
-- exist. The `check` below refuses a half-filled triple rather than storing one.
alter table public.crop_reports
  add column if not exists photo_path  text,
  add column if not exists photo_mime  text,
  add column if not exists photo_bytes bigint;

alter table public.crop_reports
  drop constraint if exists crop_reports_photo_complete;

alter table public.crop_reports
  add constraint crop_reports_photo_complete check (
    (photo_path is null and photo_mime is null and photo_bytes is null)
    or (
      photo_path is not null
      and photo_mime is not null
      and photo_bytes is not null
      and length(btrim(photo_path)) between 1 and 400
      and photo_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')
      and photo_bytes > 0
      and photo_bytes <= 15728640
    )
  );

comment on column public.crop_reports.photo_path is
  'Object path inside the private `report-media` bucket, always `{uploader auth uid}/{uuid}.{ext}`. The insert function refuses a path outside the caller''s own folder, so a report can never cite a photo it did not upload.';

comment on column public.crop_reports.photo_bytes is
  'Declared size, validated against the 15 MiB cap and the bucket''s own limit. Never inferred from the file the client claims to have sent.';

-- ---------------------------------------------------------------------------
-- Registration: the owner comes from the session, not the body
-- ---------------------------------------------------------------------------
--
-- `validate_media_upload` (0012) takes `p_owner_id` as a parameter and is
-- granted to `authenticated`, which lets any signed-in caller register a media
-- asset owned by any other party — the same defect `submit_crop_report` had
-- before 0027, in the same kind of `security definer` function. It is the
-- registration step for the upload path, so it is fixed here rather than left
-- as the one remaining place where a client names an owner.
create or replace function public.validate_media_upload(
  p_owner_id  uuid,
  p_class     public.media_class,
  p_bucket    text,
  p_path      text,
  p_mime      text,
  p_bytes     bigint
)
returns public.media_assets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed text[];
  v_max     bigint;
  v_asset   public.media_assets;
  v_caller  uuid := public.current_party_id();
begin
  -- A caller may only register its own asset, whatever it passes as a
  -- parameter. A session with no party owns nothing and is told so.
  if v_caller is null then
    raise exception 'Registering media requires an identified account.' using errcode = 'insufficient_privilege';
  end if;
  if p_owner_id is distinct from v_caller then
    raise exception 'A client may only register its own media.' using errcode = 'insufficient_privilege';
  end if;

  v_allowed := case p_class
    when 'voice_note'           then array['audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/aac']
    when 'community_photo'      then array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
    when 'community_video'      then array['video/mp4', 'video/webm', 'video/quicktime']
    when 'scan_source'          then array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
    when 'scan_derived'         then array['image/jpeg', 'image/png', 'image/webp']
    when 'verification_evidence' then array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  end;

  v_max := case p_class
    when 'voice_note'           then 10485760
    when 'community_photo'      then 15728640
    when 'community_video'      then 52428800
    when 'scan_source'          then 26214400
    when 'verification_evidence' then 26214400
    else 15728640
  end;

  if not (p_mime = any (v_allowed)) then
    raise exception 'A % may not be uploaded as %.', p_mime, p_class using errcode = 'check_violation';
  end if;

  if p_bytes > v_max then
    raise exception 'File is % bytes; the limit for % is % bytes.', p_bytes, p_class, v_max
      using errcode = 'check_violation';
  end if;

  insert into public.media_assets (
    owner_id, media_class, state, bucket, storage_path, mime_type, bytes, validated_at
  ) values (
    p_owner_id, p_class, 'uploading', p_bucket, p_path, p_mime, p_bytes, now()
  )
  returning * into v_asset;

  return v_asset;
end;
$$;

comment on function public.validate_media_upload(uuid, public.media_class, text, text, text, bigint) is
  'Registers an upload after checking its class, type and size. The owner is the caller''s own party; a client can no longer register an asset for somebody else.';

-- ---------------------------------------------------------------------------
-- submit_crop_report, with the photo
-- ---------------------------------------------------------------------------
--
-- Redefined rather than overloaded: an overload nobody calls is still an
-- overload an attacker can call, which is why 0027 dropped the previous
-- signature instead of adding beside it. The three photo parameters are
-- optional and appended, so a caller that sends none gets exactly the 0027
-- behaviour.

drop function if exists public.submit_crop_report(
  text, text, text, text, double precision, double precision, text, text, timestamptz, text
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
  p_idempotency_key text default null,
  p_photo_path text default null,
  p_photo_mime text default null,
  p_photo_bytes bigint default null
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
  v_uid text := auth.uid()::text;
  v_path text := nullif(btrim(coalesce(p_photo_path, '')), '');
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

  -- The photo is optional, and blank is treated as absent: a farmer whose
  -- upload failed must still be able to warn a neighbour, and refusing the
  -- sentence because the picture is missing would lose the warning.
  if v_path is not null then
    -- The path has to be under the caller's own folder. Without this a report
    -- could cite any object in the bucket, including another farmer's photo.
    if v_uid is null or v_path not like v_uid || '/%' then
      raise exception 'A report photo must be inside your own upload folder.' using errcode = 'insufficient_privilege';
    end if;
    if p_photo_mime is null or p_photo_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic') then
      raise exception 'A report photo must be a JPEG, PNG, WebP or HEIC image.' using errcode = 'check_violation';
    end if;
    if p_photo_bytes is null or p_photo_bytes <= 0 or p_photo_bytes > 15728640 then
      raise exception 'A report photo must be between 1 byte and 15 MB.' using errcode = 'check_violation';
    end if;
  end if;

  -- Round to ~1.1km cell so the stored point is approximate by construction.
  v_lat := round(p_lat::numeric, 2)::double precision;
  v_lon := round(p_lon::numeric, 2)::double precision;

  insert into public.crop_reports (
    reporter_id, crop_code, topic, title, body, evidence, status, visibility,
    geog, area_label, district, observed_at, source_code, idempotency_key,
    photo_path, photo_mime, photo_bytes
  ) values (
    v_reporter, p_crop_code, p_topic, btrim(p_title), btrim(p_body),
    'farmer_report', 'published', 'public',
    extensions.ST_SetSRID(extensions.ST_MakePoint(v_lon, v_lat), 4326)::extensions.geography,
    btrim(p_area_label), p_district, coalesce(p_observed_at, now()), 'platform_reports', p_idempotency_key,
    case when v_path is null then null else v_path end,
    case when v_path is null then null else p_photo_mime end,
    case when v_path is null then null else p_photo_bytes end
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

comment on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text, text, text, bigint) is
  'Farmer report intake, with an optional photo. Author is the caller''s own party; coordinates are rounded to 2 decimals; a photo path must sit in the caller''s own upload folder. Idempotent on (reporter, key).';

revoke all on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text, text, text, bigint) from public;
revoke all on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text, text, text, bigint) from anon;
grant execute on function public.submit_crop_report(text, text, text, text, double precision, double precision, text, text, timestamptz, text, text, text, bigint) to authenticated;

-- Farmer App · migration 0012 · media, processing states and retention
--
-- PRD: client-side compression where practical, server-side validation,
-- an optimised display representation, a higher-quality representation when the
-- AI needs to diagnose, processing states, and automatic cleanup on the
-- retention policy. Original large camera files must not be retained
-- unnecessarily.
--
-- So a media asset records *which* class it is, and the class determines when it
-- dies. The retention numbers themselves live in retention_policies (migration
-- 0001) rather than here, because the PRD calls them technical targets and a
-- target should be changeable without a deployment.

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------

-- Private buckets. Community display copies are served through signed URLs, so
-- a leaked path is not a leaked photo.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('scan-media',   'scan-media',   false, 26214400),
  ('voice-notes',  'voice-notes',  false, 10485760),
  ('community',    'community',    false, 52428800),
  ('verification', 'verification', false, 26214400)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

create table public.media_assets (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.parties (id) on delete cascade,
  media_class     public.media_class not null,
  state           public.media_state not null default 'pending',
  bucket          text not null,
  storage_path    text not null,
  mime_type       text not null,
  bytes           bigint not null check (bytes > 0),
  -- Display and analysis representations are separate rows linked by this, so
  -- the compressed copy can be purged on a different schedule than the original.
  derived_from    uuid references public.media_assets (id) on delete set null,
  representation  text not null default 'original' check (representation in ('original', 'display', 'analysis')),
  width           integer check (width > 0),
  height          integer check (height > 0),
  duration_seconds numeric(7,2) check (duration_seconds >= 0),
  -- Server-side validation outcome. A file that fails is never marked ready.
  validated_at    timestamptz,
  validation_note text,
  -- Retention. purge_after is computed from the policy when the asset reached a
  -- settled state, and is what the cleanup job reads.
  retention_basis timestamptz,
  purge_after     timestamptz,
  purged_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (bucket, storage_path),
  constraint media_assets_purged_consistency check (
    (state = 'purged') = (purged_at is not null)
  )
);

create trigger media_assets_touch before update on public.media_assets
  for each row execute function public.touch_updated_at();

create index media_assets_owner_idx on public.media_assets (owner_id, created_at desc);
create index media_assets_purge_idx on public.media_assets (purge_after) where purged_at is null;

comment on column public.media_assets.representation is
  'Separates the display copy from the analysis copy. Compression is allowed to be aggressive for display and conservative for diagnosis, which the PRD asks for in one breath and which a single file cannot satisfy.';

comment on column public.media_assets.purge_after is
  'Set when the asset settles, from retention_policies. NULL means not yet scheduled, which is different from never.';

-- Compute the purge deadline from policy, in one place, whenever an asset
-- reaches a state where its clock should start.
create or replace function public.schedule_media_purge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy public.retention_policies;
begin
  if new.purge_after is not null and new.state not in ('purged') then
    return new;
  end if;

  select * into v_policy from public.retention_policies where media_class = new.media_class;
  if not found then
    return new;
  end if;

  -- Voice and community media age from creation; scan media ages from the
  -- structured result, because until the diagnosis exists the image is still in
  -- use.
  if v_policy.retain_after = 'created' then
    new.retention_basis := coalesce(new.retention_basis, new.created_at);
  else
    if new.state <> 'ready' and new.state <> 'processing' then
      -- Not yet finished with; leave unscheduled rather than guessing.
      return new;
    end if;
    new.retention_basis := coalesce(new.retention_basis, now());
  end if;

  new.purge_after := new.retention_basis + make_interval(days => v_policy.retain_days);
  return new;
end;
$$;

create trigger media_assets_schedule_purge
  before insert or update of state on public.media_assets
  for each row execute function public.schedule_media_purge();

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

-- Marks assets due for purging and returns them so the caller can delete the
-- objects from storage. The row is kept with state 'purged': the image is gone,
-- the fact that it existed and when it was removed is not.
create or replace function public.purge_due_media(p_limit integer default 500)
returns table (
  asset_id    uuid,
  bucket      text,
  storage_path text,
  media_class public.media_class
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select m.id
    from public.media_assets m
    where m.purged_at is null
      and m.purge_after is not null
      and m.purge_after <= now()
    order by m.purge_after
    limit greatest(1, least(p_limit, 5000))
    for update skip locked
  ),
  marked as (
    update public.media_assets m
       set state = 'purged', purged_at = now(), storage_path = 'purged/' || m.id::text
     where m.id in (select id from due)
    returning m.id, m.bucket, m.storage_path, m.media_class
  )
  select id, bucket, storage_path, media_class from marked;
end;
$$;

comment on function public.purge_due_media(integer) is
  'Scheduled job body. Marks assets whose retention has expired and returns their storage paths for deletion. `for update skip locked` keeps two concurrent runs from purging the same asset twice.';

-- Failed and abandoned uploads are cleaned up on a much shorter clock than
-- content, because they are pure cost.
create or replace function public.purge_stale_uploads(p_max_age interval default '24 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.media_assets m
     where m.state in ('pending', 'uploading')
       and m.created_at < now() - p_max_age
    returning 1
  )
  select count(*) into v_count from gone;

  return v_count;
end;
$$;

comment on function public.purge_stale_uploads(interval) is
  'Deletes upload rows that never completed. These hold no user value and would otherwise accumulate forever.';

-- ---------------------------------------------------------------------------
-- Server-side validation
-- ---------------------------------------------------------------------------

-- Called by the upload path before an asset is trusted. Rejects rather than
-- sanitises: a wrong file is the uploader's problem, not a silent conversion.
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
begin
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

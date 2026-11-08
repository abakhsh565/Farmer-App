-- Phase 3 completion · agricultural knowledge lifecycle
--
-- The knowledge engine already had bilingual entries, a source registry,
-- evidence dossiers, review authorities, publication guards, expiry and
-- recommendation withdrawal. Four operational gaps remained:
--
--   1. There was no acquisition path: every entry had to be inserted by hand,
--      with no run ledger, content hash, duplicate handling or item audit.
--   2. The dossier lifecycle had no explicit `withdrawn` state. Withdrawal was
--      only an implicit consequence of unpublishing a knowledge row.
--   3. Retrieval accepted a district but never filtered by it, ignored the
--      entry's stage applicability, and returned no licence metadata.
--   4. Source licensing/permission and knowledge-specific freshness were not
--      recorded, so an operator could not tell why a source was blocked or
--      which published guidance had gone stale.
--
-- This migration adds those capabilities without changing the existing
-- publication, review, expiry or recommendation guards. No reviewer, source
-- permission, advisory or agricultural claim is seeded. A source whose
-- permission is unknown stays blocked for new ingestion until a human records
-- the licensing decision.

-- ---------------------------------------------------------------------------
-- Source licensing, permission and freshness
-- ---------------------------------------------------------------------------
alter table public.agri_knowledge_sources
  add column if not exists license_name text,
  add column if not exists license_url text
    check (license_url is null or license_url ~ '^https://[^[:space:]]+$'),
  add column if not exists permission_status text not null default 'unknown'
    check (permission_status in ('granted', 'needs_permission', 'unknown', 'not_required')),
  add column if not exists freshness_days integer
    check (freshness_days is null or freshness_days between 1 and 3650),
  add column if not exists last_checked_at timestamptz;

comment on column public.agri_knowledge_sources.permission_status is
  'Recorded human decision about whether this publisher permits reuse. New ingestion requires granted or not_required; unknown and needs_permission stay blocked.';
comment on column public.agri_knowledge_sources.freshness_days is
  'Optional source-specific review interval. Null means no automatic staleness claim; it does not mean the source is current.';

update public.agri_knowledge_sources
   set license_name = 'Farmer App internal editorial content',
       permission_status = 'not_required',
       last_checked_at = now()
 where code = 'app_editorial'
   and (license_name is null or permission_status = 'unknown');

update public.agri_knowledge_sources
   set license_name = coalesce(
         license_name,
         'Government of Punjab website content; reuse permission not recorded'
       ),
       permission_status = case
         when permission_status = 'unknown' then 'unknown'
         else permission_status
       end,
       last_checked_at = coalesce(last_checked_at, now())
 where code = 'punjab_agri';

-- ---------------------------------------------------------------------------
-- Explicit withdrawal in the evidence lifecycle
-- ---------------------------------------------------------------------------
alter table public.agri_evidence_items
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawal_reason text,
  add column if not exists license_name text,
  add column if not exists license_url text
    check (license_url is null or license_url ~ '^https://[^[:space:]]+$');

alter table public.agri_evidence_items
  drop constraint if exists agri_evidence_items_status_check;
alter table public.agri_evidence_items
  add constraint agri_evidence_items_status_check
  check (status in (
    'draft', 'submitted', 'under_review', 'correction_requested',
    'approved', 'rejected', 'published', 'withdrawn', 'expired', 'superseded'
  ));

alter table public.agri_evidence_reviews
  drop constraint if exists agri_evidence_reviews_action_check;
alter table public.agri_evidence_reviews
  add constraint agri_evidence_reviews_action_check
  check (action in (
    'create', 'submit', 'start_review', 'source_check',
    'applicability_check', 'approve', 'reject', 'request_correction',
    'resubmit', 'publish', 'withdraw', 'expire', 'supersede'
  ));

alter table public.agri_knowledge_entries
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawal_reason text;

comment on column public.agri_evidence_items.withdrawn_at is
  'When a content manager withdrew this dossier. Withdrawal is distinct from expiry: it is a human decision, not a validity clock.';
comment on column public.agri_knowledge_entries.withdrawn_at is
  'When the published entry was withdrawn. Retrieval excludes withdrawn rows even if a stale publication flag remains.';

-- A re-published entry is no longer withdrawn. Clearing the marker here keeps
-- `is_published` and the withdrawal fields from contradicting each other.
create or replace function public.agri_knowledge_clear_withdrawal_on_publish()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_published and not old.is_published then
    new.withdrawn_at := null;
    new.withdrawal_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists agri_knowledge_clear_withdrawal on public.agri_knowledge_entries;
create trigger agri_knowledge_clear_withdrawal
  before update of is_published on public.agri_knowledge_entries
  for each row
  when (old.is_published is distinct from new.is_published)
  execute function public.agri_knowledge_clear_withdrawal_on_publish();

-- Publishing a version makes older versions of the same slug non-current. The
-- existing withdrawal trigger then removes recommendations built from the old
-- version; the history remains auditable.
create or replace function public.agri_knowledge_single_published_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_published then
    update public.agri_knowledge_entries e
       set is_published = false
     where e.slug = new.slug
       and e.id <> new.id
       and e.is_published;
  end if;
  return null;
end;
$$;

drop trigger if exists agri_knowledge_single_version on public.agri_knowledge_entries;
create trigger agri_knowledge_single_version
  after update of is_published on public.agri_knowledge_entries
  for each row
  when (new.is_published and old.is_published is distinct from new.is_published)
  execute function public.agri_knowledge_single_published_version();

revoke execute on function public.agri_knowledge_clear_withdrawal_on_publish()
  from public, anon, authenticated;
revoke execute on function public.agri_knowledge_single_published_version()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Knowledge acquisition ledger
-- ---------------------------------------------------------------------------
create table public.agri_knowledge_ingestion_runs (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique
    check (length(btrim(idempotency_key)) between 8 and 200),
  request_hash     text not null,
  source_code      text not null references public.agri_knowledge_sources (code),
  -- These are the submitted values, not yet trusted content. Validation happens
  -- inside the ingestion transaction so a bad document still leaves a failed
  -- run record instead of being rejected before it can be audited.
  document_url     text,
  document_title   text,
  publisher        text,
  published_on     date,
  accessed_at      timestamptz not null default now(),
  language         text not null default 'bilingual'
    check (language in ('en', 'ur', 'bilingual')),
  license_name     text,
  license_url      text,
  status           text not null default 'running'
    check (status in ('running', 'ok', 'partial', 'failed')),
  items_fetched    integer not null default 0 check (items_fetched >= 0),
  items_accepted   integer not null default 0 check (items_accepted >= 0),
  items_duplicate  integer not null default 0 check (items_duplicate >= 0),
  items_rejected   integer not null default 0 check (items_rejected >= 0),
  items_failed     integer not null default 0 check (items_failed >= 0),
  detail           jsonb not null default '{}'::jsonb,
  error            text,
  requested_by     uuid references public.parties (id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);

comment on table public.agri_knowledge_ingestion_runs is
  'One audited acquisition attempt per source document. The idempotency key makes a retry a replay, not a second import; the request hash rejects a key reused for different content.';

create index agri_knowledge_ingestion_runs_source_idx
  on public.agri_knowledge_ingestion_runs (source_code, started_at desc);
create index agri_knowledge_ingestion_runs_status_idx
  on public.agri_knowledge_ingestion_runs (status, started_at desc);

alter table public.agri_knowledge_ingestion_runs enable row level security;
revoke all on public.agri_knowledge_ingestion_runs from public, anon, authenticated;
grant select on public.agri_knowledge_ingestion_runs to service_role;

create table public.agri_knowledge_ingestion_items (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references public.agri_knowledge_ingestion_runs (id) on delete cascade,
  source_code        text not null,
  external_key       text,
  content_hash       text not null,
  slug               text not null,
  entry_version      integer not null check (entry_version > 0),
  title_en           text not null,
  title_ur           text not null,
  crop_code          text references public.crop_catalog (code),
  topic              text not null,
  problem_type       text not null,
  stages             text[] not null default '{}'::text[],
  districts          text[] not null default '{}'::text[],
  status             text not null default 'accepted' check (status = 'accepted'),
  knowledge_entry_id uuid references public.agri_knowledge_entries (id) on delete set null,
  evidence_item_id   uuid references public.agri_evidence_items (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (source_code, content_hash),
  unique (run_id, external_key)
);

comment on table public.agri_knowledge_ingestion_items is
  'Accepted items only. Rejections and duplicates are recorded in the parent run detail; the unique content hash prevents re-importing the same source text.';

create index agri_knowledge_ingestion_items_run_idx
  on public.agri_knowledge_ingestion_items (run_id, created_at);

alter table public.agri_knowledge_ingestion_items enable row level security;
revoke all on public.agri_knowledge_ingestion_items from public, anon, authenticated;
grant select on public.agri_knowledge_ingestion_items to service_role;

-- Parse a bounded JSON string array without inventing values.
create or replace function public.agri_json_text_array(p_value jsonb)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct btrim(v)), '{}'::text[])
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(coalesce(p_value, '[]'::jsonb)) = 'array'
          then coalesce(p_value, '[]'::jsonb)
        else '[]'::jsonb
      end
    ) as x(v)
   where btrim(v) <> '';
$$;

revoke execute on function public.agri_json_text_array(jsonb) from public, anon, authenticated;

-- A human records the publisher's permission and licence. This never grants
-- permission by itself and cannot be inferred from an institution's reputation.
create or replace function public.agri_set_source_terms(
  p_code              text,
  p_permission_status text,
  p_license_name      text default null,
  p_license_url       text default null,
  p_freshness_days    integer default null,
  p_note              text default null
)
returns public.agri_knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_before public.agri_knowledge_sources;
  v_after public.agri_knowledge_sources;
begin
  if not public.has_capability('admin') then
    raise exception 'Recording source terms requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if p_permission_status not in ('granted', 'needs_permission', 'unknown', 'not_required') then
    raise exception 'Unknown source permission status.' using errcode = 'check_violation';
  end if;
  if p_license_url is not null and p_license_url !~ '^https://[^[:space:]]+$' then
    raise exception 'A licence URL must be a direct HTTPS reference.' using errcode = 'check_violation';
  end if;
  if p_freshness_days is not null and (p_freshness_days < 1 or p_freshness_days > 3650) then
    raise exception 'Freshness days must be between 1 and 3650.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.agri_knowledge_sources where code = p_code for update;
  if not found then
    raise exception 'Source % not found.', p_code using errcode = 'no_data_found';
  end if;

  if p_permission_status in ('granted', 'not_required')
     and coalesce(nullif(btrim(p_license_name), ''), v_before.license_name) is null then
    raise exception 'Granting or recording permission requires a licence name.' using errcode = 'check_violation';
  end if;

  update public.agri_knowledge_sources
     set permission_status = p_permission_status,
         license_name = coalesce(nullif(btrim(p_license_name), ''), license_name),
         license_url = coalesce(nullif(btrim(p_license_url), ''), license_url),
         freshness_days = coalesce(p_freshness_days, freshness_days),
         last_checked_at = now()
   where code = p_code
  returning * into v_after;

  perform public.write_audit(
    'agri.source_terms_recorded', 'agri_knowledge_sources', null, p_code,
    v_before.permission_status, v_after.permission_status,
    jsonb_build_object(
      'license_name', v_after.license_name,
      'license_url', v_after.license_url,
      'freshness_days', v_after.freshness_days,
      'note', nullif(btrim(p_note), '')
    ),
    v_actor, 'admin'
  );
  return v_after;
end;
$$;

comment on function public.agri_set_source_terms(text, text, text, text, integer, text) is
  'Admin-only record of a publisher permission and licence decision. It does not grant permission and no permission is seeded.';

revoke execute on function public.agri_set_source_terms(text, text, text, text, integer, text)
  from public, anon;
grant execute on function public.agri_set_source_terms(text, text, text, text, integer, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Knowledge document ingestion
-- ---------------------------------------------------------------------------
create or replace function public.agri_ingest_knowledge_document(
  p_source_code     text,
  p_idempotency_key text,
  p_document        jsonb,
  p_items           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := public.current_party_id();
  v_source         public.agri_knowledge_sources;
  v_run            public.agri_knowledge_ingestion_runs;
  v_existing       public.agri_knowledge_ingestion_runs;
  v_run_json       jsonb;
  v_request_hash   text;
  v_items          jsonb := coalesce(p_items, '[]'::jsonb);
  v_document       jsonb := coalesce(p_document, '{}'::jsonb);

  v_url            text;
  v_document_title text;
  v_publisher      text;
  v_published_on   date;
  v_accessed_at    timestamptz;
  v_language       text;
  v_license_name   text;
  v_license_url    text;
  v_valid_until    timestamptz;
  v_document_ref   text;
  v_document_districts text[];
  v_document_stages    text[];

  v_item           jsonb;
  v_hash           text;
  v_external       text;
  v_slug           text;
  v_entry_version  integer;
  v_title_en       text;
  v_title_ur       text;
  v_body_en        text;
  v_body_ur        text;
  v_crop           text;
  v_problem        text;
  v_topic          text;
  v_evidence_topic text;
  v_stages         text[];
  v_districts      text[];
  v_regions        text[];
  v_symptoms       text[];
  v_classification text;
  v_source_type    text;
  v_provenance     text;
  v_reason         text;
  v_entry_id       uuid;
  v_evidence_id    uuid;

  v_fetched        integer := 0;
  v_accepted       integer := 0;
  v_duplicate      integer := 0;
  v_rejected       integer := 0;
  v_status         text;
  v_duplicates     jsonb := '[]'::jsonb;
  v_rejections     jsonb := '[]'::jsonb;
  v_stage          text;
  v_item_stages    text[];
begin
  -- The RPC is executable by service_role only. A signed-in caller must hold a
  -- content-manager or admin capability; a service-role call has no party and
  -- is the trusted backend acquisition path. The run ledger records that
  -- distinction, so an ingestion is never mistaken for a human review act.
  if v_actor is not null
     and not public.agri_has_authority_role('content_manager')
     and not public.has_capability('admin') then
    raise exception 'Knowledge ingestion requires content-manager or admin authority.' using errcode = 'insufficient_privilege';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'p_items must be a JSON array.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(v_document) <> 'object' then
    raise exception 'p_document must be a JSON object.' using errcode = 'check_violation';
  end if;

  select * into v_source from public.agri_knowledge_sources where code = p_source_code;
  if not found or not v_source.is_active then
    raise exception 'An active source registry entry is required.' using errcode = 'no_data_found';
  end if;

  v_url := nullif(btrim(v_document->>'url'), '');
  v_document_title := nullif(btrim(v_document->>'title'), '');
  v_publisher := coalesce(
    nullif(btrim(v_document->>'publisher'), ''),
    nullif(btrim(v_source.publisher), ''),
    v_source.name
  );
  v_document_ref := nullif(btrim(v_document->>'document_ref'), '');
  v_license_name := coalesce(
    nullif(btrim(v_document->>'license_name'), ''),
    nullif(btrim(v_source.license_name), '')
  );
  v_license_url := coalesce(
    nullif(btrim(v_document->>'license_url'), ''),
    nullif(btrim(v_source.license_url), '')
  );
  v_language := coalesce(nullif(btrim(v_document->>'language'), ''), 'bilingual');
  v_document_districts := public.agri_json_text_array(v_document->'districts');
  v_document_stages := public.agri_json_text_array(v_document->'stages');

  v_request_hash := md5(
    p_source_code || '|' || btrim(p_idempotency_key) || '|' ||
    v_document::text || '|' || v_items::text
  );

  insert into public.agri_knowledge_ingestion_runs (
    idempotency_key, request_hash, source_code, document_url, document_title,
    publisher, published_on, accessed_at, language, license_name, license_url,
    requested_by, status
  ) values (
    btrim(p_idempotency_key), v_request_hash, p_source_code,
    v_url, v_document_title, v_publisher, null,
    now(),
    'bilingual', v_license_name,
    v_license_url, v_actor, 'running'
  )
  on conflict (idempotency_key) do nothing
  returning * into v_run;

  if v_run.id is null then
    select * into v_existing
      from public.agri_knowledge_ingestion_runs
     where idempotency_key = btrim(p_idempotency_key);
    if v_existing.request_hash <> v_request_hash then
      return jsonb_build_object(
        'ok', false,
        'error', 'This idempotency key was already used with a different payload.',
        'run_id', v_existing.id
      );
    end if;
    return jsonb_build_object(
      'ok', v_existing.status in ('ok', 'partial'),
      'replay', true,
      'status', v_existing.status,
      'run_id', v_existing.id,
      'counts', jsonb_build_object(
        'fetched', v_existing.items_fetched,
        'accepted', v_existing.items_accepted,
        'duplicate', v_existing.items_duplicate,
        'rejected', v_existing.items_rejected,
        'failed', v_existing.items_failed
      ),
      'detail', v_existing.detail,
      'error', v_existing.error
    );
  end if;

  begin
    if v_source.permission_status not in ('granted', 'not_required') then
      raise exception 'Source % has no recorded reuse permission (%).', p_source_code, v_source.permission_status
        using errcode = 'insufficient_privilege';
    end if;
    if v_url is null or v_url !~ '^https://[^[:space:]]+$' then
      raise exception 'A direct HTTPS document URL is required.' using errcode = 'check_violation';
    end if;
    if v_document_title is null or length(v_document_title) > 400 then
      raise exception 'A document title of 1-400 characters is required.' using errcode = 'check_violation';
    end if;
    v_published_on := (v_document->>'published_on')::date;
    if v_published_on is null then
      raise exception 'A publication date is required.' using errcode = 'check_violation';
    end if;
    if v_published_on > current_date then
      raise exception 'A future publication date cannot be ingested as current evidence.' using errcode = 'check_violation';
    end if;
    v_accessed_at := coalesce((v_document->>'accessed_at')::timestamptz, now());
    v_valid_until := (v_document->>'valid_until')::timestamptz;
    if v_valid_until is null or v_valid_until <= now() then
      raise exception 'A future validity end is required for the evidence review window.' using errcode = 'check_violation';
    end if;
    if v_license_name is null then
      raise exception 'Licence metadata is required before ingesting a document.' using errcode = 'check_violation';
    end if;
    if v_license_url is not null and v_license_url !~ '^https://[^[:space:]]+$' then
      raise exception 'A licence URL must be a direct HTTPS reference.' using errcode = 'check_violation';
    end if;
    if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 100 then
      raise exception 'Between 1 and 100 items are required per document.' using errcode = 'check_violation';
    end if;

    update public.agri_knowledge_ingestion_runs
       set document_url = v_url,
           document_title = v_document_title,
           publisher = v_publisher,
           published_on = v_published_on,
           accessed_at = v_accessed_at,
           license_name = v_license_name,
           license_url = v_license_url
     where id = v_run.id;

    for v_item in select value from jsonb_array_elements(v_items) loop
      v_fetched := v_fetched + 1;
      v_reason := null;
      v_title_en := nullif(btrim(v_item->>'title_en'), '');
      v_title_ur := nullif(btrim(v_item->>'title_ur'), '');
      v_body_en := nullif(btrim(v_item->>'body_en'), '');
      v_body_ur := nullif(btrim(v_item->>'body_ur'), '');
      v_external := nullif(btrim(v_item->>'external_key'), '');
      v_hash := md5(
        p_source_code || '|' || coalesce(v_title_en, '') || '|' || coalesce(v_body_en, '') ||
        '|' || coalesce(v_title_ur, '') || '|' || coalesce(v_body_ur, '')
      );
      v_slug := nullif(btrim(v_item->>'slug'), '');
      v_crop := nullif(btrim(v_item->>'crop_code'), '');
      v_problem := nullif(btrim(v_item->>'problem_type'), '');
      v_topic := nullif(btrim(v_item->>'topic'), '');
      v_stages := public.agri_json_text_array(v_item->'stages');
      if cardinality(v_stages) = 0 then v_stages := v_document_stages; end if;
      v_districts := public.agri_json_text_array(v_item->'districts');
      if cardinality(v_districts) = 0 then v_districts := v_document_districts; end if;
      v_regions := public.agri_json_text_array(v_item->'regions');
      v_symptoms := public.agri_json_text_array(v_item->'symptoms');
      v_classification := nullif(btrim(v_item->>'classification'), '');

      if v_title_en is null or v_title_ur is null or v_body_en is null or v_body_ur is null then
        v_reason := 'Bilingual title and body are required.';
      elsif length(v_title_en) > 300 or length(v_title_ur) > 300
         or length(v_body_en) > 12000 or length(v_body_ur) > 12000 then
        v_reason := 'Title or body exceeds the accepted length.';
      elsif v_slug is not null and v_slug !~ '^[a-z0-9][a-z0-9-]{2,119}$' then
        v_reason := 'Slug must be lowercase letters, digits and hyphens.';
      elsif cardinality(v_districts) > 30 or cardinality(v_stages) > 20
         or cardinality(v_regions) > 20 or cardinality(v_symptoms) > 20 then
        v_reason := 'Applicability arrays exceed the accepted length.';
      elsif v_problem is not null and v_problem not in (
        'pest', 'disease', 'weed', 'disorder', 'agronomy', 'safety', 'nutrition', 'water', 'other'
      ) then
        v_reason := 'Unknown problem type.';
      elsif v_topic is not null and length(v_topic) > 60 then
        v_reason := 'Topic exceeds 60 characters.';
      else
        for v_stage in select unnest(v_stages) loop
          if not exists (
            select 1 from unnest(enum_range(null::public.crop_stage)) e
             where e::text = v_stage
          ) then
            v_reason := 'Unknown crop stage: ' || v_stage;
            exit;
          end if;
        end loop;
      end if;

      if v_reason is null and v_crop is not null
         and not exists (select 1 from public.crop_catalog c where c.code = v_crop) then
        v_reason := 'Unknown crop code: ' || v_crop;
      end if;

      if v_reason is null and v_external is not null and exists (
        select 1 from public.agri_knowledge_ingestion_items i
         where i.run_id = v_run.id and i.external_key = v_external
      ) then
        v_reason := 'Duplicate external key in this run.';
      end if;

      if v_reason is null and exists (
        select 1 from public.agri_knowledge_ingestion_items i
         where i.source_code = p_source_code and i.content_hash = v_hash
      ) then
        v_duplicate := v_duplicate + 1;
        v_duplicates := v_duplicates || jsonb_build_array(jsonb_build_object(
          'external_key', v_external,
          'content_hash', v_hash,
          'reason', 'identical content already ingested from this source'
        ));
        continue;
      end if;

      if v_reason is not null then
        v_rejected := v_rejected + 1;
        v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
          'external_key', v_external,
          'reason', v_reason
        ));
        continue;
      end if;

      if v_problem is null then
        v_problem := 'other';
      end if;
      if v_topic is null then
        v_topic := case v_problem
          when 'pest' then 'pest'
          when 'disease' then 'disease'
          when 'weed' then 'weed'
          when 'water' then 'irrigation'
          else 'agronomy'
        end;
      end if;
      v_evidence_topic := case v_problem
        when 'pest' then 'pest'
        when 'disease' then 'disease'
        when 'weed' then 'weed'
        when 'water' then 'water'
        when 'agronomy' then 'sowing'
        when 'disorder' then 'other'
        when 'nutrition' then 'other'
        when 'safety' then 'other'
        else 'other'
      end;

      if v_classification is null then
        v_classification := case v_source.source_type
          when 'official_extension' then 'official_government'
          when 'regulator' then 'official_government'
          when 'qualified_expert' then 'qualified_expert'
          when 'community' then 'unverified_submission'
          else 'supplementary_editorial'
        end;
      end if;
      if v_classification not in (
        'official_government', 'peer_reviewed_research', 'qualified_expert',
        'supplementary_editorial', 'unverified_submission'
      ) then
        v_rejected := v_rejected + 1;
        v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
          'external_key', v_external,
          'reason', 'Unknown evidence classification.'
        ));
        continue;
      end if;

      v_source_type := case v_source.source_type
        when 'official_extension' then 'official_extension'
        when 'regulator' then 'regulator'
        when 'university' then 'university'
        when 'supplementary' then 'supplementary_editorial'
        when 'editorial' then 'supplementary_editorial'
        when 'community' then 'community'
        else 'unknown'
      end;

      if v_slug is null then
        v_slug := 'kb-' || replace(lower(p_source_code), '_', '-') || '-' || left(v_hash, 12);
      end if;
      select coalesce(max(version), 0) + 1 into v_entry_version
        from public.agri_knowledge_entries where slug = v_slug;

      v_provenance := left(
        v_source.name || ' — ' || v_document_title || ' (accessed ' || v_accessed_at::date || ')',
        900
      );

      insert into public.agri_knowledge_entries (
        slug, version, title_en, title_ur, body_en, body_ur, body_local,
        crop_code, applies_to_stages, topic, provenance, is_published,
        problem_type, symptoms, regions, source_code, source_url,
        source_published_on, source_accessed_on, evidence_tier
      ) values (
        v_slug, v_entry_version, v_title_en, v_title_ur, v_body_en, v_body_ur, '{}'::jsonb,
        v_crop, v_stages::public.crop_stage[], v_topic, v_provenance, false,
        v_problem, v_symptoms, v_regions, p_source_code, v_url,
        v_published_on, v_accessed_at::date, 'supplementary'
      )
      returning id into v_entry_id;

      insert into public.agri_evidence_items (
        evidence_key, target_kind, target_ref, version,
        source_organization, source_type, source_code, source_url, document_ref,
        document_title, published_on, accessed_at, language,
        crop_code, topic, districts, stages, classification,
        status, valid_from, valid_until, created_by, license_name, license_url
      ) values (
        'knowledge_entry:' || v_entry_id::text || ':v1', 'knowledge_entry',
        v_entry_id::text, 1,
        v_publisher, v_source_type, p_source_code, v_url, v_document_ref,
        v_document_title, v_published_on, v_accessed_at, 'bilingual',
        v_crop, v_evidence_topic, v_districts, v_stages, v_classification,
        'draft', now(), v_valid_until, v_actor, v_license_name, v_license_url
      )
      returning id into v_evidence_id;

      update public.agri_knowledge_entries
         set evidence_item_id = v_evidence_id
       where id = v_entry_id;

      perform public.agri_log_evidence_event(
        v_evidence_id, 'create', null, 'draft',
        'Draft created by knowledge ingestion run ' || v_run.id::text,
        jsonb_build_object(
          'run_id', v_run.id,
          'content_hash', v_hash,
          'source_code', p_source_code,
          'channel', case when v_actor is null then 'service_role_ingestion' else 'authenticated_ingestion' end
        ),
        'submitter'
      );

      insert into public.agri_knowledge_ingestion_items (
        run_id, source_code, external_key, content_hash, slug, entry_version,
        title_en, title_ur, crop_code, topic, problem_type, stages, districts,
        status, knowledge_entry_id, evidence_item_id
      ) values (
        v_run.id, p_source_code, v_external, v_hash, v_slug, v_entry_version,
        v_title_en, v_title_ur, v_crop, v_topic, v_problem, v_stages, v_districts,
        'accepted', v_entry_id, v_evidence_id
      );

      v_accepted := v_accepted + 1;
    end loop;

    v_status := case
      when v_accepted = 0 then 'failed'
      when v_rejected > 0 then 'partial'
      else 'ok'
    end;

    update public.agri_knowledge_ingestion_runs
       set status = v_status,
           items_fetched = v_fetched,
           items_accepted = v_accepted,
           items_duplicate = v_duplicate,
           items_rejected = v_rejected,
           items_failed = 0,
           detail = jsonb_build_object(
             'duplicates', v_duplicates,
             'rejections', v_rejections
           ),
           error = case when v_accepted = 0 then 'No item passed validation.' else null end,
           finished_at = now()
     where id = v_run.id;

    select to_jsonb(r) into v_run_json
      from public.agri_knowledge_ingestion_runs r where r.id = v_run.id;

    return jsonb_build_object(
      'ok', v_status in ('ok', 'partial'),
      'replay', false,
      'status', v_status,
      'run_id', v_run.id,
      'counts', jsonb_build_object(
        'fetched', v_fetched,
        'accepted', v_accepted,
        'duplicate', v_duplicate,
        'rejected', v_rejected,
        'failed', 0
      ),
      'duplicates', v_duplicates,
      'rejections', v_rejections,
      'run', v_run_json
    );
  exception when others then
    update public.agri_knowledge_ingestion_runs
       set status = 'failed',
           items_fetched = v_fetched,
           items_accepted = 0,
           items_duplicate = v_duplicate,
           items_rejected = v_rejected,
           error = SQLERRM,
           detail = jsonb_build_object(
             'duplicates', v_duplicates,
             'rejections', v_rejections
           ),
           finished_at = now()
     where id = v_run.id;

    return jsonb_build_object(
      'ok', false,
      'replay', false,
      'status', 'failed',
      'run_id', v_run.id,
      'error', SQLERRM,
      'counts', jsonb_build_object(
        'fetched', v_fetched,
        'accepted', 0,
        'duplicate', v_duplicate,
        'rejected', v_rejected,
        'failed', 0
      )
    );
  end;
end;
$$;

comment on function public.agri_ingest_knowledge_document(text, text, jsonb, jsonb) is
  'Service-only, idempotent acquisition of one source document. Validates source permission, licence, date, bilingual content, crop and stage applicability; creates unpublished knowledge and a draft evidence dossier; records duplicates and rejections in the run ledger. It never publishes or approves anything.';

revoke execute on function public.agri_ingest_knowledge_document(text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.agri_ingest_knowledge_document(text, text, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Explicit withdrawal
-- ---------------------------------------------------------------------------
create or replace function public.agri_withdraw_evidence(
  p_evidence_id uuid,
  p_reason      text
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
  v_from text;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A withdrawal reason is required.' using errcode = 'check_violation';
  end if;
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then
    raise exception 'Evidence dossier not found.' using errcode = 'no_data_found';
  end if;
  if not public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts) then
    raise exception 'You need content-manager authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('approved', 'published') then
    raise exception 'Only approved or published evidence can be withdrawn.' using errcode = 'check_violation';
  end if;
  v_from := v_item.status;

  if v_item.status = 'published' then
    if v_item.target_kind = 'knowledge_entry' then
      update public.agri_knowledge_entries
         set is_published = false,
             withdrawn_at = now(),
             withdrawal_reason = btrim(p_reason)
       where id = v_item.target_ref::uuid;
    elsif v_item.target_kind = 'official_advisory' then
      update public.agri_advisories
         set is_active = false
       where id = v_item.target_ref::uuid;
    else
      update public.forecast_risk_rules
         set is_active = false,
             deactivated_at = now(),
             deactivated_by = v_actor,
             deactivation_note = btrim(p_reason)
       where code = v_item.target_ref;
    end if;
  end if;

  update public.agri_evidence_items
     set status = 'withdrawn',
         withdrawn_at = now(),
         withdrawal_reason = btrim(p_reason)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'withdraw', v_from, 'withdrawn', btrim(p_reason), '{}'::jsonb, 'content_manager'
  );
  perform public.write_audit(
    'agri.evidence_withdrawn', 'agri_evidence_items', p_evidence_id, v_item.target_ref,
    v_from, 'withdrawn', jsonb_build_object('reason', btrim(p_reason)), v_actor, 'content_manager'
  );
  return v_item;
end;
$$;

comment on function public.agri_withdraw_evidence(uuid, text) is
  'Content-manager withdrawal of approved or published evidence. It unpublishes the linked target, records the reason in the append-only ledger and audit log, and lets the existing trigger withdraw recommendations built from the affected knowledge version.';

revoke execute on function public.agri_withdraw_evidence(uuid, text) from public, anon;
grant execute on function public.agri_withdraw_evidence(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Operational monitoring
-- ---------------------------------------------------------------------------
create or replace function public.agri_knowledge_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- A service-role operations probe has no party; the function is not granted
  -- to anon/authenticated without a role, so null is the trusted service path.
  if public.current_party_id() is not null
     and not (public.has_capability('admin') or public.agri_has_review_access()) then
    raise exception 'Knowledge health requires admin or review authority.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'sources', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where is_active),
        'permission_ready', count(*) filter (where permission_status in ('granted', 'not_required')),
        'permission_blocked', count(*) filter (where permission_status in ('unknown', 'needs_permission')),
        'licensed', count(*) filter (where license_name is not null)
      ) from public.agri_knowledge_sources
    ),
    'knowledge', (
      select jsonb_build_object(
        'total', count(*),
        'published', count(*) filter (where is_published),
        'withdrawn', count(*) filter (where withdrawn_at is not null),
        'verified', count(*) filter (where is_published and evidence_tier = 'verified'),
        'supplementary', count(*) filter (where is_published and evidence_tier = 'supplementary'),
        'without_evidence', count(*) filter (where evidence_item_id is null)
      ) from public.agri_knowledge_entries
    ),
    'evidence', (
      select jsonb_build_object(
        'draft', count(*) filter (where status = 'draft'),
        'submitted', count(*) filter (where status = 'submitted'),
        'under_review', count(*) filter (where status = 'under_review'),
        'correction_requested', count(*) filter (where status = 'correction_requested'),
        'approved', count(*) filter (where status = 'approved'),
        'published', count(*) filter (where status = 'published'),
        'withdrawn', count(*) filter (where status = 'withdrawn'),
        'expired', count(*) filter (where status = 'expired'),
        'rejected', count(*) filter (where status = 'rejected'),
        'superseded', count(*) filter (where status = 'superseded')
      ) from public.agri_evidence_items
    ),
    'stale_or_expiring_published', (
      select count(*)
        from public.agri_knowledge_entries e
        join public.agri_evidence_items ev on ev.id = e.evidence_item_id
        left join public.agri_knowledge_sources s on s.code = coalesce(ev.source_code, e.source_code)
       where e.is_published
         and e.withdrawn_at is null
         and ev.status = 'published'
         and (
           (s.freshness_days is not null
             and ev.accessed_at < now() - make_interval(days => s.freshness_days))
           or (ev.valid_until is not null and ev.valid_until <= now() + interval '30 days')
         )
    ),
    'expiring_30d', (
      select count(*) from public.agri_evidence_items
       where status = 'published'
         and valid_until is not null
         and valid_until > now()
         and valid_until <= now() + interval '30 days'
    ),
    'ingestion', (
      select jsonb_build_object(
        'runs_30d', count(*),
        'failed_30d', count(*) filter (where status = 'failed'),
        'partial_30d', count(*) filter (where status = 'partial'),
        'last_run_at', max(started_at),
        'items_accepted_30d', coalesce(sum(items_accepted), 0),
        'items_duplicate_30d', coalesce(sum(items_duplicate), 0),
        'items_rejected_30d', coalesce(sum(items_rejected), 0)
      ) from public.agri_knowledge_ingestion_runs
       where started_at > now() - interval '30 days'
    ),
    'authorities', (
      select jsonb_build_object(
        'evidence_reviewers', count(*) filter (where authority = 'evidence_reviewer'),
        'content_managers', count(*) filter (where authority = 'content_manager')
      ) from public.agri_review_authorities where revoked_at is null
    )
  );
end;
$$;

comment on function public.agri_knowledge_health() is
  'Admin/reviewer operational read: source permission readiness, lifecycle counts, stale or expiring published guidance, ingestion outcomes and active review authorities. It returns no farmer data.';

revoke execute on function public.agri_knowledge_health() from public, anon;
grant execute on function public.agri_knowledge_health() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retrieval: crop, stage, district and licence aware
-- ---------------------------------------------------------------------------
drop function if exists public.ai_knowledge_search(text, text, text, integer);

create or replace function public.ai_knowledge_search(
  p_query    text,
  p_crop     text default null,
  p_district text default null,
  p_limit    integer default 4,
  p_stage    text default null
)
returns table (
  id                  uuid,
  slug                text,
  version             integer,
  title_en            text,
  title_ur            text,
  body_en             text,
  body_ur             text,
  topic               text,
  problem_type        text,
  symptoms            text[],
  regions             text[],
  crop_code           text,
  provenance          text,
  evidence_tier       text,
  source_code         text,
  source_name         text,
  source_url          text,
  source_published_on date,
  source_updated_on   date,
  source_accessed_on  date,
  stages              text[],
  districts           text[],
  source_publisher    text,
  source_license      text,
  stale               boolean,
  score               double precision,
  used_embedding      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with content as (
    select regexp_replace(
      lower(left(coalesce(nullif(btrim(p_query), ''), ''), 500)),
      '\m(how|what|when|where|why|who|which|do|does|did|i|we|you|they|he|she|it|the|a|an|and|or|in|on|of|to|for|from|at|by|with|about|as|is|are|was|were|be|been|being|can|could|should|would|will|shall|may|might|must|please|tell|me|my|our|your|their|his|her|its|this|that|these|those|there|if|after|before|more|most|much|many|any|all|not|no|so|than|then|also|just|very|but|into|over|under|use|using|has|have|had)\M',
      ' ', 'gi'
    ) as terms
  ), q as (
    select
      websearch_to_tsquery('simple', coalesce(nullif(btrim(content.terms), ''), 'crop')) as strict,
      websearch_to_tsquery(
        'simple',
        coalesce(
          nullif(regexp_replace(btrim(content.terms), '[[:space:]]+', ' OR ', 'g'), ''),
          'crop'
        )
      ) as broad
      from content
  ), documents as (
    select e.*,
           ev.status as evidence_status,
           ev.stages as evidence_stages,
           ev.districts as evidence_districts,
           ev.accessed_at as evidence_accessed_at,
           ev.valid_until as evidence_valid_until,
           ev.source_organization as evidence_publisher,
           coalesce(ev.license_name, s.license_name) as source_license,
           s.freshness_days,
           coalesce(ev.source_organization, s.publisher, s.name) as source_publisher,
           to_tsvector(
             'simple',
             coalesce(e.title_en, '') || ' ' || coalesce(e.title_ur, '') || ' ' ||
             coalesce(e.body_en, '') || ' ' || coalesce(e.body_ur, '') || ' ' ||
             coalesce(e.topic, '') || ' ' || coalesce(e.problem_type, '') || ' ' ||
             coalesce(array_to_string(e.symptoms, ' '), '') || ' ' || coalesce(e.slug, '')
           ) as document
      from public.agri_knowledge_entries e
      left join public.agri_evidence_items ev on ev.id = e.evidence_item_id
      left join public.agri_knowledge_sources s on s.code = coalesce(ev.source_code, e.source_code)
     where e.is_published
       and e.withdrawn_at is null
       and (e.evidence_item_id is null or ev.status = 'published')
       and (ev.valid_until is null or ev.valid_until > now())
  )
  select
    e.id, e.slug, e.version, e.title_en, e.title_ur, e.body_en, e.body_ur,
    e.topic, e.problem_type, e.symptoms, e.regions, e.crop_code, e.provenance,
    e.evidence_tier, e.source_code, s.name, e.source_url,
    e.source_published_on, e.source_updated_on, e.source_accessed_on,
    coalesce(e.applies_to_stages::text[], '{}'::text[]),
    coalesce(e.evidence_districts, '{}'::text[]),
    e.source_publisher,
    e.source_license,
    coalesce(
      (e.freshness_days is not null
        and e.evidence_accessed_at < now() - make_interval(days => e.freshness_days))
      or (e.evidence_valid_until is not null and e.evidence_valid_until <= now()),
      false
    ),
    least(
      1.0,
      ts_rank(e.document, q.strict) * 8
      + ts_rank(e.document, q.broad) * 3
      + case e.evidence_tier when 'verified' then 0.12 when 'supplementary' then 0.05 else 0 end
    )::double precision as score,
    false as used_embedding
  from documents e
  cross join q
  left join public.agri_knowledge_sources s on s.code = e.source_code
  where
    (
      e.document @@ q.strict
      or e.document @@ q.broad
      or (
        btrim(coalesce(p_query, '')) <> ''
        and (
          e.title_en ilike '%' || left(btrim(p_query), 80) || '%'
          or e.title_ur ilike '%' || left(btrim(p_query), 80) || '%'
          or e.slug ilike '%' || left(btrim(p_query), 80) || '%'
        )
      )
    )
    and (
      p_district is null
      or cardinality(coalesce(e.evidence_districts, '{}'::text[])) = 0
      or p_district = any (coalesce(e.evidence_districts, '{}'::text[]))
    )
    and (
      p_stage is null
      or cardinality(coalesce(e.applies_to_stages, '{}'::public.crop_stage[])) = 0
      or p_stage::public.crop_stage = any (e.applies_to_stages)
    )
  order by
    (p_crop is not null and e.crop_code = p_crop) desc,
    (
      p_stage is not null
      and cardinality(coalesce(e.applies_to_stages, '{}'::public.crop_stage[])) > 0
      and p_stage::public.crop_stage = any (e.applies_to_stages)
    ) desc,
    (
      p_district is not null
      and cardinality(coalesce(e.evidence_districts, '{}'::text[])) > 0
      and p_district = any (coalesce(e.evidence_districts, '{}'::text[]))
    ) desc,
    case e.evidence_tier when 'verified' then 3 when 'supplementary' then 2 else 1 end desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, text, integer, text) is
  'Published, non-withdrawn, source-labelled knowledge only. Crop match ranks first, then stage applicability, explicit district applicability, evidence tier and text score. Excludes rows whose evidence is not published and returns licence/publisher freshness metadata.';

revoke execute on function public.ai_knowledge_search(text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.ai_knowledge_search(text, text, text, integer, text)
  to service_role;

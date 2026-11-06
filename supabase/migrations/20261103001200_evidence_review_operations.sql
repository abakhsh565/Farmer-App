-- Farmer App · migration 0044 · Phase 5.2 evidence review operations
--
-- Every transition is a security-definer RPC. The reviewer identity is the JWT
-- party; no RPC accepts a reviewer id. Content creation/submission, source and
-- applicability verification, agronomic approval, and publication are separate
-- acts with separate authorities.
--
-- The review ledger is append-only. The target rows keep their own content and
-- version; evidence changes require a new dossier version, never an edit to an
-- approved historical decision.

create or replace function public.agri_log_evidence_event(
  p_evidence_id uuid,
  p_action      text,
  p_from_status text,
  p_to_status   text,
  p_note        text,
  p_detail      jsonb,
  p_actor_role  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.agri_evidence_reviews (
    evidence_id, actor_id, actor_role, action, from_status, to_status, note, detail
  ) values (
    p_evidence_id, public.current_party_id(), p_actor_role, p_action,
    p_from_status, p_to_status, nullif(btrim(p_note), ''), coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.agri_log_evidence_event(uuid, text, text, text, text, jsonb, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Intake
-- ---------------------------------------------------------------------------
create or replace function public.agri_create_evidence(
  p_target_kind          text,
  p_target_ref           text,
  p_source_organization  text,
  p_source_type          text,
  p_classification       text,
  p_document_title       text,
  p_topic                text default 'other',
  p_source_url           text default null,
  p_source_code          text default null,
  p_document_ref         text default null,
  p_published_on         date default null,
  p_accessed_at          timestamptz default now(),
  p_language             text default 'en',
  p_crop_code            text default null,
  p_districts            text[] default '{}'::text[],
  p_stages               text[] default '{}'::text[],
  p_confidence           numeric default null,
  p_valid_from           timestamptz default now(),
  p_valid_until          timestamptz default null,
  p_supersedes_id        uuid default null,
  p_submit               boolean default false
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := public.current_party_id();
  v_label          text;
  v_target_crop    text;
  v_target_topic   text;
  v_target_district text;
  v_crop           text := p_crop_code;
  v_topic          text := p_topic;
  v_districts      text[] := coalesce(p_districts, '{}'::text[]);
  v_stages         text[] := coalesce(p_stages, '{}'::text[]);
  v_supersedes     uuid := p_supersedes_id;
  v_version        integer;
  v_key            text;
  v_status         text;
  v_item           public.agri_evidence_items;
  v_open           uuid;
begin
  if v_actor is null then
    raise exception 'An identified account is required.' using errcode = 'insufficient_privilege';
  end if;
  if p_target_kind not in ('knowledge_entry', 'official_advisory', 'forecast_rule') then
    raise exception 'Unknown evidence target kind.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_source_organization), '') = '' then
    raise exception 'A source organisation is required.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_document_title), '') = '' then
    raise exception 'A source document title is required.' using errcode = 'check_violation';
  end if;
  if p_source_type not in (
    'official_government', 'official_extension', 'regulator', 'university',
    'peer_reviewed', 'qualified_expert', 'supplementary_editorial', 'community', 'unknown'
  ) then
    raise exception 'Unknown source type.' using errcode = 'check_violation';
  end if;
  if p_classification not in (
    'official_government', 'peer_reviewed_research', 'qualified_expert',
    'supplementary_editorial', 'unverified_submission'
  ) then
    raise exception 'Unknown evidence classification.' using errcode = 'check_violation';
  end if;
  if p_language not in ('en', 'ur', 'bilingual') then
    raise exception 'Unknown evidence language.' using errcode = 'check_violation';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'Confidence must be between 0 and 1.' using errcode = 'check_violation';
  end if;
  if p_source_url is not null and p_source_url !~ '^https://[^[:space:]]+$' then
    raise exception 'A source URL must be a direct HTTPS reference.' using errcode = 'check_violation';
  end if;
  if p_source_code is not null and not exists (
    select 1 from public.agri_knowledge_sources where code = p_source_code
  ) then
    raise exception 'Source registry code % not found.', p_source_code using errcode = 'no_data_found';
  end if;
  if p_valid_until is not null and p_valid_until <= p_valid_from then
    raise exception 'The validity end must be after its start.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from unnest(v_stages) s
     where not exists (
       select 1 from unnest(enum_range(null::public.crop_stage)) e where e::text = s
     )
  ) then
    raise exception 'Evidence stages must be known crop stages.' using errcode = 'check_violation';
  end if;

  if p_target_kind = 'knowledge_entry' then
    if p_target_ref !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'A knowledge evidence target must be a UUID.' using errcode = 'check_violation';
    end if;
    select title_en, crop_code, topic
      into v_label, v_target_crop, v_target_topic
      from public.agri_knowledge_entries
     where id = p_target_ref::uuid;
  elsif p_target_kind = 'official_advisory' then
    if p_target_ref !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'An advisory evidence target must be a UUID.' using errcode = 'check_violation';
    end if;
    select title, crop_code, topic, district
      into v_label, v_target_crop, v_target_topic, v_target_district
      from public.agri_advisories
     where id = p_target_ref::uuid;
  else
    select label_en, crop_code, topic
      into v_label, v_target_crop, v_target_topic
      from public.forecast_risk_rules
     where code = p_target_ref;
  end if;

  if v_label is null then
    raise exception 'The evidence target does not exist.' using errcode = 'no_data_found';
  end if;

  -- The evidence's applicability is derived where the target states it. This
  -- prevents a scoped manager from widening an advisory into another district
  -- merely by sending an empty district array.
  if v_target_crop is not null then
    if v_crop is null then
      v_crop := v_target_crop;
    elsif v_crop <> v_target_crop then
      raise exception 'The evidence crop must match the target crop.' using errcode = 'check_violation';
    end if;
  end if;

  if v_target_district is not null then
    if cardinality(v_districts) = 0 then
      v_districts := array[v_target_district];
    elsif not (v_target_district = any (v_districts)) then
      raise exception 'The evidence districts must include the advisory district.' using errcode = 'check_violation';
    end if;
  end if;

  if v_topic is null or v_topic = 'other' then
    v_topic := v_target_topic;
  elsif v_topic <> v_target_topic then
    raise exception 'The evidence topic must match the target topic.' using errcode = 'check_violation';
  end if;

  if not public.agri_has_authority('content_manager', v_crop, v_districts) then
    raise exception 'You need content-management authority for this crop and district scope.' using errcode = 'insufficient_privilege';
  end if;

  -- One open dossier per target. A rejected/expired/superseded dossier is closed;
  -- a published one is replaced only through a new version.
  select id into v_open
    from public.agri_evidence_items
   where target_kind = p_target_kind
     and target_ref = p_target_ref
     and status in ('draft', 'submitted', 'under_review', 'correction_requested', 'approved')
   limit 1;
  if v_open is not null then
    raise exception 'An open evidence dossier already exists for this target.' using errcode = 'unique_violation';
  end if;

  if v_supersedes is null then
    select id into v_supersedes
      from public.agri_evidence_items
     where target_kind = p_target_kind and target_ref = p_target_ref and status = 'published'
     order by version desc limit 1;
  else
    if not exists (
      select 1 from public.agri_evidence_items
       where id = v_supersedes
         and target_kind = p_target_kind
         and target_ref = p_target_ref
         and status = 'published'
    ) then
      raise exception 'A superseded dossier must be a published version of the same target.' using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.agri_evidence_items
   where target_kind = p_target_kind and target_ref = p_target_ref;
  v_key := p_target_kind || ':' || p_target_ref || ':v' || v_version;
  v_status := case when p_submit then 'submitted' else 'draft' end;

  insert into public.agri_evidence_items (
    evidence_key, target_kind, target_ref, version, supersedes_id,
    source_organization, source_type, source_code, source_url, document_ref,
    document_title, published_on, accessed_at, language,
    crop_code, topic, districts, stages, classification, confidence,
    status, submitted_by, submitted_at, valid_from, valid_until, created_by
  ) values (
    v_key, p_target_kind, p_target_ref, v_version, v_supersedes,
    btrim(p_source_organization), p_source_type, p_source_code,
    nullif(btrim(p_source_url), ''), nullif(btrim(p_document_ref), ''),
    btrim(p_document_title), p_published_on, coalesce(p_accessed_at, now()), p_language,
    v_crop, v_topic, v_districts, v_stages, p_classification, p_confidence,
    v_status,
    case when p_submit then v_actor else null end,
    case when p_submit then now() else null end,
    coalesce(p_valid_from, now()), p_valid_until, v_actor
  )
  returning * into v_item;

  perform public.agri_log_evidence_event(
    v_item.id, 'create', null, v_status,
    'Evidence dossier created for ' || v_label,
    jsonb_build_object('target_kind', p_target_kind, 'target_ref', p_target_ref, 'version', v_version),
    'content_manager'
  );
  if p_submit then
    perform public.agri_log_evidence_event(
      v_item.id, 'submit', 'draft', 'submitted', 'Submitted for review', '{}'::jsonb, 'content_manager'
    );
  end if;

  perform public.write_audit(
    'agri.evidence_created', 'agri_evidence_items', v_item.id, p_target_ref,
    null, v_item.status,
    jsonb_build_object('target_kind', p_target_kind, 'version', v_version, 'classification', p_classification),
    v_actor, 'content_manager'
  );
  return v_item;
end;
$$;

comment on function public.agri_create_evidence(text, text, text, text, text, text, text, text, text, text, date, timestamptz, text, text, text[], text[], numeric, timestamptz, timestamptz, uuid, boolean) is
  'Content-manager intake. Derives crop/topic/district from the target, blocks a second open dossier, versions automatically, and records the creator from the session.';

create or replace function public.agri_submit_evidence(p_evidence_id uuid)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
begin
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then
    raise exception 'Evidence dossier not found.' using errcode = 'no_data_found';
  end if;
  if not public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts) then
    raise exception 'You need content-management authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('draft', 'correction_requested') then
    raise exception 'Only a draft or correction-requested dossier can be submitted.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set status = 'submitted',
         submitted_by = v_actor,
         submitted_at = now(),
         source_check_status = 'pending',
         applicability_status = 'pending',
         agronomic_status = 'pending',
         reviewer_id = null,
         reviewed_at = null,
         review_started_at = null,
         review_note = null,
         rejection_reason = null,
         correction_note = null
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'submit', 'draft', 'submitted', 'Submitted for review', '{}'::jsonb, 'content_manager'
  );
  return v_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- Review acts
-- ---------------------------------------------------------------------------
create or replace function public.agri_start_review(p_evidence_id uuid)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
begin
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then
    raise exception 'Evidence dossier not found.' using errcode = 'no_data_found';
  end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this crop and district scope.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status = 'under_review' and v_item.reviewer_id = v_actor then
    return v_item;
  end if;
  if v_item.status <> 'submitted' then
    raise exception 'Only a submitted dossier can enter review.' using errcode = 'check_violation';
  end if;
  if v_item.created_by = v_actor or v_item.submitted_by = v_actor then
    raise exception 'A reviewer cannot review evidence they created or submitted.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set status = 'under_review',
         reviewer_id = v_actor,
         review_started_at = now()
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'start_review', 'submitted', 'under_review',
    'Review started', '{}'::jsonb, 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_set_source_check(
  p_evidence_id uuid,
  p_status      text,
  p_note        text
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
begin
  if p_status not in ('authentic', 'not_authentic') then
    raise exception 'Source check must be authentic or not_authentic.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A source check needs a note describing what was inspected.' using errcode = 'check_violation';
  end if;

  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status <> 'under_review' or v_item.reviewer_id <> v_actor then
    raise exception 'Only the reviewer who started the review can check its source.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set source_check_status = p_status,
         review_note = btrim(p_note)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'source_check', 'under_review', 'under_review',
    btrim(p_note),
    jsonb_build_object('source_check_status', p_status), 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_set_applicability_check(
  p_evidence_id uuid,
  p_status      text,
  p_note        text
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
begin
  if p_status not in ('applicable', 'not_applicable') then
    raise exception 'Applicability check must be applicable or not_applicable.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'An applicability check needs a note about crop, district and stage.' using errcode = 'check_violation';
  end if;

  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status <> 'under_review' or v_item.reviewer_id <> v_actor then
    raise exception 'Only the reviewer who started the review can check applicability.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set applicability_status = p_status,
         review_note = btrim(p_note)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'applicability_check', 'under_review', 'under_review',
    btrim(p_note),
    jsonb_build_object('applicability_status', p_status), 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_approve_evidence(
  p_evidence_id uuid,
  p_note        text
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
begin
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Approval requires a short review note.' using errcode = 'check_violation';
  end if;

  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status <> 'under_review' or v_item.reviewer_id <> v_actor then
    raise exception 'Only the reviewer who started the review can approve it.' using errcode = 'check_violation';
  end if;
  if v_item.source_check_status <> 'authentic' then
    raise exception 'The source must be checked as authentic before approval.' using errcode = 'check_violation';
  end if;
  if v_item.applicability_status <> 'applicable' then
    raise exception 'Crop, district and stage applicability must be checked before approval.' using errcode = 'check_violation';
  end if;
  if v_item.classification = 'unverified_submission' then
    raise exception 'Unverified farmer/community material cannot be approved as guidance. Reclassify it first.' using errcode = 'check_violation';
  end if;
  if v_item.valid_until is null or v_item.valid_until <= now() then
    raise exception 'Approval requires a future validity end.' using errcode = 'check_violation';
  end if;
  if v_item.source_url is null and v_item.document_ref is null then
    raise exception 'Approval requires a source URL or a document reference that can be inspected.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set status = 'approved',
         agronomic_status = 'approved',
         reviewer_id = v_actor,
         reviewed_at = now(),
         review_note = btrim(p_note)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'approve', 'under_review', 'approved', btrim(p_note),
    jsonb_build_object('classification', v_item.classification), 'evidence_reviewer'
  );
  perform public.write_audit(
    'agri.evidence_approved', 'agri_evidence_items', p_evidence_id, v_item.target_ref,
    'under_review', 'approved',
    jsonb_build_object('target_kind', v_item.target_kind, 'classification', v_item.classification),
    v_actor, 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_reject_evidence(
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
    raise exception 'A rejection reason is required.' using errcode = 'check_violation';
  end if;

  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('submitted', 'under_review', 'correction_requested') then
    raise exception 'This dossier cannot be rejected in its current state.' using errcode = 'check_violation';
  end if;
  v_from := v_item.status;

  update public.agri_evidence_items
     set status = 'rejected',
         agronomic_status = 'rejected',
         reviewer_id = v_actor,
         reviewed_at = now(),
         rejection_reason = btrim(p_reason),
         review_note = btrim(p_reason)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'reject', v_from, 'rejected', btrim(p_reason), '{}'::jsonb, 'evidence_reviewer'
  );
  perform public.write_audit(
    'agri.evidence_rejected', 'agri_evidence_items', p_evidence_id, v_item.target_ref,
    v_from, 'rejected', jsonb_build_object('reason', btrim(p_reason)),
    v_actor, 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_request_correction(
  p_evidence_id uuid,
  p_note        text
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
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A correction request needs a note.' using errcode = 'check_violation';
  end if;

  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts) then
    raise exception 'You need evidence-reviewer authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('submitted', 'under_review') then
    raise exception 'Corrections can only be requested on submitted or in-review evidence.' using errcode = 'check_violation';
  end if;
  v_from := v_item.status;

  update public.agri_evidence_items
     set status = 'correction_requested',
         reviewer_id = v_actor,
         correction_note = btrim(p_note),
         review_note = btrim(p_note),
         agronomic_status = 'pending',
         reviewed_at = null
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'request_correction', v_from, 'correction_requested', btrim(p_note),
    '{}'::jsonb, 'evidence_reviewer'
  );
  return v_item;
end;
$$;

create or replace function public.agri_update_and_resubmit(
  p_evidence_id         uuid,
  p_document_title      text,
  p_source_url          text,
  p_document_ref        text,
  p_classification      text,
  p_valid_until         timestamptz,
  p_note                text
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
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts) then
    raise exception 'You need content-management authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('draft', 'correction_requested') then
    raise exception 'Only a draft or correction-requested dossier can be amended.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Describe the correction before resubmitting.' using errcode = 'check_violation';
  end if;
  if p_classification not in (
    'official_government', 'peer_reviewed_research', 'qualified_expert',
    'supplementary_editorial', 'unverified_submission'
  ) then
    raise exception 'Unknown evidence classification.' using errcode = 'check_violation';
  end if;
  if p_source_url is not null and p_source_url !~ '^https://[^[:space:]]+$' then
    raise exception 'A source URL must be a direct HTTPS reference.' using errcode = 'check_violation';
  end if;
  if p_valid_until is not null and p_valid_until <= v_item.valid_from then
    raise exception 'The validity end must be after its start.' using errcode = 'check_violation';
  end if;
  v_from := v_item.status;

  update public.agri_evidence_items
     set document_title = coalesce(nullif(btrim(p_document_title), ''), document_title),
         source_url = nullif(btrim(p_source_url), ''),
         document_ref = nullif(btrim(p_document_ref), ''),
         classification = p_classification,
         valid_until = p_valid_until,
         status = 'submitted',
         source_check_status = 'pending',
         applicability_status = 'pending',
         agronomic_status = 'pending',
         reviewer_id = null,
         reviewed_at = null,
         review_started_at = null,
         review_note = null,
         rejection_reason = null,
         correction_note = null,
         submitted_by = v_actor,
         submitted_at = now()
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'resubmit', v_from, 'submitted', btrim(p_note),
    jsonb_build_object('classification', p_classification), 'content_manager'
  );
  return v_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publication, expiry and supersession
-- ---------------------------------------------------------------------------
create or replace function public.agri_publish_evidence(
  p_evidence_id uuid,
  p_alert_level text default null
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
  v_k public.agri_knowledge_entries;
  v_a public.agri_advisories;
  v_r public.forecast_risk_rules;
  v_entry public.agri_knowledge_entries;
  v_source public.intel_sources;
  v_tier text;
  v_target_id uuid;
  v_target_table text;
  v_target_ref text;
  v_target_label text;
  v_old public.agri_evidence_items;
begin
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts) then
    raise exception 'You need content-manager authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status <> 'approved' then
    raise exception 'Only approved evidence can be published.' using errcode = 'check_violation';
  end if;
  if v_item.valid_until is null or v_item.valid_until <= now() then
    raise exception 'This evidence has no future validity window.' using errcode = 'check_violation';
  end if;

  if v_item.target_kind = 'knowledge_entry' then
    select * into v_k from public.agri_knowledge_entries where id = v_item.target_ref::uuid for update;
    if not found then raise exception 'Knowledge entry not found.' using errcode = 'no_data_found'; end if;
    if v_k.is_published and v_k.evidence_item_id is not null and v_k.evidence_item_id <> p_evidence_id
       and (v_item.supersedes_id is null or v_k.evidence_item_id <> v_item.supersedes_id) then
      raise exception 'This knowledge entry already has different published evidence; create a superseding dossier.' using errcode = 'check_violation';
    end if;
    v_tier := case v_item.classification
      when 'official_government' then 'verified'
      when 'peer_reviewed_research' then 'verified'
      when 'qualified_expert' then 'verified'
      when 'supplementary_editorial' then 'supplementary'
      else null
    end;
    if v_tier is null then
      raise exception 'Unverified material cannot be published as knowledge.' using errcode = 'check_violation';
    end if;
    if v_tier = 'verified' and coalesce(v_item.source_code, v_k.source_code) is null then
      raise exception 'Verified knowledge publication needs a source registry code.' using errcode = 'check_violation';
    end if;
    if v_tier = 'verified' and coalesce(v_item.source_url, v_k.source_url) is null then
      raise exception 'Verified knowledge publication needs a direct source URL.' using errcode = 'check_violation';
    end if;
    v_target_id := v_k.id;
    v_target_table := 'agri_knowledge_entries';
    v_target_ref := v_k.slug;
    v_target_label := v_k.title_en;
  elsif v_item.target_kind = 'official_advisory' then
    select * into v_a from public.agri_advisories where id = v_item.target_ref::uuid for update;
    if not found then raise exception 'Advisory not found.' using errcode = 'no_data_found'; end if;
    if p_alert_level is null or p_alert_level not in ('info', 'watch', 'urgent') then
      raise exception 'Publishing an official advisory needs an alert level.' using errcode = 'check_violation';
    end if;
    if v_item.classification <> 'official_government' then
      raise exception 'Only official government evidence can be published as an official advisory.' using errcode = 'check_violation';
    end if;
    if v_a.verification_status = 'verified' and v_a.evidence_item_id is not null and v_a.evidence_item_id <> p_evidence_id
       and (v_item.supersedes_id is null or v_a.evidence_item_id <> v_item.supersedes_id) then
      raise exception 'This advisory already has different verified evidence; create a superseding dossier.' using errcode = 'check_violation';
    end if;
    if v_a.source_url is null or v_a.source_url !~ '^https://[^[:space:]]+$' then
      raise exception 'The advisory needs a direct HTTPS source URL before verification.' using errcode = 'check_violation';
    end if;
    if v_a.district is null or btrim(v_a.district) = '' then
      raise exception 'The advisory needs a district before verification.' using errcode = 'check_violation';
    end if;
    if v_a.valid_until is null or v_a.valid_until <= now() then
      raise exception 'The advisory needs a future validity window before verification.' using errcode = 'check_violation';
    end if;
    if v_a.published_at > now() then
      raise exception 'A future-dated advisory cannot be verified as current.' using errcode = 'check_violation';
    end if;
    if v_a.title_ur is null or v_a.summary_ur is null then
      raise exception 'The advisory needs its checked Urdu title and summary before verification.' using errcode = 'check_violation';
    end if;
    select * into v_source from public.intel_sources where code = v_a.source_code;
    if not found or not v_source.is_active or v_source.kind <> 'official_advisory' then
      raise exception 'The advisory source must be an active official_advisory source.' using errcode = 'check_violation';
    end if;
    v_target_id := v_a.id;
    v_target_table := 'agri_advisories';
    v_target_ref := v_a.source_ref;
    v_target_label := v_a.title;
  else
    select * into v_r from public.forecast_risk_rules where code = v_item.target_ref for update;
    if not found then raise exception 'Forecast rule not found.' using errcode = 'no_data_found'; end if;
    if v_item.classification not in ('official_government', 'peer_reviewed_research', 'qualified_expert') then
      raise exception 'A forecast threshold needs authoritative agronomic evidence.' using errcode = 'check_violation';
    end if;
    if v_r.is_active and v_r.evidence_item_id is not null and v_r.evidence_item_id <> p_evidence_id then
      raise exception 'The rule is active with different evidence; deactivate it before publishing a new version.' using errcode = 'check_violation';
    end if;
    select * into v_entry from public.agri_knowledge_entries where id = v_r.knowledge_entry_id;
    if not found or not v_entry.is_published or v_entry.evidence_tier <> 'verified' then
      raise exception 'The rule cites unpublished or non-verified knowledge.' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.agri_evidence_items k
       where k.id = v_entry.evidence_item_id
         and k.status = 'published'
         and k.classification in ('official_government', 'peer_reviewed_research', 'qualified_expert')
    ) then
      raise exception 'The rule''s cited knowledge must have its own published authoritative evidence.' using errcode = 'check_violation';
    end if;
    select * into v_source from public.intel_sources where code = v_r.source_code;
    if not found or not v_source.is_active or v_source.kind <> 'forecast_risk' then
      raise exception 'The rule needs an active forecast-risk source.' using errcode = 'check_violation';
    end if;
    v_target_id := null;
    v_target_table := 'forecast_risk_rules';
    v_target_ref := v_r.code;
    v_target_label := v_r.label_en;
  end if;

  -- Publish the dossier first: the target guards read the dossier state in the
  -- same transaction and must see it before the target may become official.
  update public.agri_evidence_items
     set status = 'published', published_at = now()
   where id = p_evidence_id
  returning * into v_item;

  if v_target_table = 'agri_knowledge_entries' then
    update public.agri_knowledge_entries
       set evidence_item_id = p_evidence_id,
           is_published = true,
           evidence_tier = v_tier,
           reviewed_by = v_item.reviewer_id,
           reviewed_at = v_item.reviewed_at,
           source_code = coalesce(v_item.source_code, source_code),
           source_url = coalesce(v_item.source_url, source_url),
           source_published_on = coalesce(v_item.published_on, source_published_on),
           source_accessed_on = coalesce(v_item.accessed_at::date, source_accessed_on)
     where id = v_target_id;
  elsif v_target_table = 'agri_advisories' then
    update public.agri_advisories
       set evidence_item_id = p_evidence_id,
           verification_status = 'verified',
           verified_at = v_item.reviewed_at,
           verified_by = v_item.reviewer_id,
           verification_note = v_item.review_note,
           alert_level = p_alert_level,
           is_active = true
     where id = v_target_id;
  else
    update public.forecast_risk_rules
       set evidence_item_id = p_evidence_id,
           version = greatest(version, v_item.version),
           is_active = true,
           activated_at = now(),
           activated_by = v_actor,
           activation_note = v_item.review_note,
           deactivated_at = null,
           deactivated_by = null,
           deactivation_note = null
     where code = v_target_ref;
  end if;

  if v_item.supersedes_id is not null then
    select * into v_old from public.agri_evidence_items where id = v_item.supersedes_id for update;
    if v_old.status = 'published' then
      update public.agri_evidence_items
         set status = 'superseded', superseded_by = p_evidence_id
       where id = v_old.id;
      perform public.agri_log_evidence_event(
        v_old.id, 'supersede', 'published', 'superseded',
        'Superseded by version ' || v_item.version || ' of the same target',
        jsonb_build_object('superseded_by', p_evidence_id), 'content_manager'
      );
    end if;
  end if;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'publish', 'approved', 'published',
    'Published ' || v_target_label,
    jsonb_build_object('target_kind', v_item.target_kind, 'target_ref', v_item.target_ref, 'alert_level', p_alert_level),
    'content_manager'
  );
  perform public.write_audit(
    'agri.evidence_published', v_target_table, v_target_id, v_target_ref,
    'approved', 'published',
    jsonb_build_object('evidence_item_id', p_evidence_id, 'evidence_version', v_item.version, 'alert_level', p_alert_level),
    v_actor, 'content_manager'
  );
  return v_item;
end;
$$;

create or replace function public.agri_expire_evidence(
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
    raise exception 'An expiry reason is required.' using errcode = 'check_violation';
  end if;
  select * into v_item from public.agri_evidence_items where id = p_evidence_id for update;
  if not found then raise exception 'Evidence dossier not found.' using errcode = 'no_data_found'; end if;
  if not public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts) then
    raise exception 'You need content-manager authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_item.status not in ('approved', 'published') then
    raise exception 'Only approved or published evidence can expire.' using errcode = 'check_violation';
  end if;
  v_from := v_item.status;

  if v_item.target_kind = 'knowledge_entry' and v_item.status = 'published' then
    update public.agri_knowledge_entries set is_published = false where id = v_item.target_ref::uuid;
  elsif v_item.target_kind = 'official_advisory' and v_item.status = 'published' then
    update public.agri_advisories set is_active = false where id = v_item.target_ref::uuid;
  elsif v_item.target_kind = 'forecast_rule' and v_item.status = 'published' then
    update public.forecast_risk_rules
       set is_active = false, deactivated_at = now(), deactivated_by = v_actor, deactivation_note = btrim(p_reason)
     where code = v_item.target_ref;
  end if;

  update public.agri_evidence_items
     set status = 'expired', expired_at = now(), review_note = btrim(p_reason)
   where id = p_evidence_id
  returning * into v_item;

  perform public.agri_log_evidence_event(
    p_evidence_id, 'expire', v_from, 'expired', btrim(p_reason), '{}'::jsonb, 'content_manager'
  );
  perform public.write_audit(
    'agri.evidence_expired', 'agri_evidence_items', p_evidence_id, v_item.target_ref,
    v_from, 'expired', jsonb_build_object('reason', btrim(p_reason)), v_actor, 'content_manager'
  );
  return v_item;
end;
$$;

create or replace function public.agri_supersede_evidence(
  p_old_id uuid,
  p_new_id uuid,
  p_note   text
)
returns public.agri_evidence_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_old public.agri_evidence_items;
  v_new public.agri_evidence_items;
  v_current uuid;
begin
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A supersession note is required.' using errcode = 'check_violation';
  end if;
  select * into v_old from public.agri_evidence_items where id = p_old_id for update;
  select * into v_new from public.agri_evidence_items where id = p_new_id for update;
  if v_old.id is null or v_new.id is null then
    raise exception 'Both evidence dossiers must exist.' using errcode = 'no_data_found';
  end if;
  if not public.agri_has_authority('content_manager', v_old.crop_code, v_old.districts) then
    raise exception 'You need content-manager authority for this evidence.' using errcode = 'insufficient_privilege';
  end if;
  if v_old.status <> 'published' or v_new.status <> 'published' then
    raise exception 'Both evidence dossiers must be published before supersession.' using errcode = 'check_violation';
  end if;
  if v_old.target_kind <> v_new.target_kind or v_old.target_ref <> v_new.target_ref then
    raise exception 'Only evidence for the same target can supersede.' using errcode = 'check_violation';
  end if;
  if v_new.version <= v_old.version then
    raise exception 'The replacement must be a newer version.' using errcode = 'check_violation';
  end if;
  if v_old.superseded_by is not null then
    raise exception 'This evidence is already superseded.' using errcode = 'check_violation';
  end if;
  if v_new.supersedes_id <> p_old_id then
    raise exception 'The newer dossier must record the older dossier as supersedes_id.' using errcode = 'check_violation';
  end if;
  if v_old.target_kind = 'knowledge_entry' then
    select evidence_item_id into v_current from public.agri_knowledge_entries where id = v_old.target_ref::uuid;
  elsif v_old.target_kind = 'official_advisory' then
    select evidence_item_id into v_current from public.agri_advisories where id = v_old.target_ref::uuid;
  else
    select evidence_item_id into v_current from public.forecast_risk_rules where code = v_old.target_ref;
  end if;
  if v_current <> p_new_id then
    raise exception 'The target is not currently published from the replacement dossier.' using errcode = 'check_violation';
  end if;

  update public.agri_evidence_items
     set status = 'superseded', superseded_by = p_new_id
   where id = p_old_id
  returning * into v_old;
  perform public.agri_log_evidence_event(
    p_old_id, 'supersede', 'published', 'superseded', btrim(p_note),
    jsonb_build_object('superseded_by', p_new_id), 'content_manager'
  );
  perform public.write_audit(
    'agri.evidence_superseded', 'agri_evidence_items', p_old_id, v_old.target_ref,
    'published', 'superseded', jsonb_build_object('superseded_by', p_new_id), v_actor, 'content_manager'
  );
  return v_old;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reviewer workspace reads
-- ---------------------------------------------------------------------------
create or replace function public.agri_review_queue(
  p_status      text default null,
  p_target_kind text default null,
  p_search      text default null,
  p_limit       integer default 50
)
returns table (
  id                 uuid,
  target_kind        text,
  target_ref         text,
  target_label       text,
  document_title     text,
  source_organization text,
  source_type        text,
  classification     text,
  status             text,
  crop_code          text,
  topic              text,
  districts          text[],
  stages             text[],
  version            integer,
  valid_until        timestamptz,
  submitted_at       timestamptz,
  reviewer_id        uuid,
  supersedes_id      uuid,
  rejection_reason   text,
  can_review         boolean,
  can_manage         boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not public.agri_has_review_access() then
    raise exception 'Review access is required.' using errcode = 'insufficient_privilege';
  end if;
  if p_status is not null and p_status not in (
    'draft', 'submitted', 'under_review', 'correction_requested', 'approved',
    'rejected', 'published', 'expired', 'superseded'
  ) then
    raise exception 'Unknown evidence status filter.' using errcode = 'check_violation';
  end if;
  if p_target_kind is not null and p_target_kind not in ('knowledge_entry', 'official_advisory', 'forecast_rule') then
    raise exception 'Unknown evidence target filter.' using errcode = 'check_violation';
  end if;

  return query
  select
    i.id,
    i.target_kind,
    i.target_ref,
    case i.target_kind
      when 'knowledge_entry' then (select e.title_en from public.agri_knowledge_entries e where e.id = i.target_ref::uuid)
      when 'official_advisory' then (select a.title from public.agri_advisories a where a.id = i.target_ref::uuid)
      else (select r.label_en from public.forecast_risk_rules r where r.code = i.target_ref)
    end as target_label,
    i.document_title,
    i.source_organization,
    i.source_type,
    i.classification,
    i.status,
    i.crop_code,
    i.topic,
    i.districts,
    i.stages,
    i.version,
    i.valid_until,
    i.submitted_at,
    i.reviewer_id,
    i.supersedes_id,
    i.rejection_reason,
    public.agri_has_authority('evidence_reviewer', i.crop_code, i.districts) as can_review,
    public.agri_has_authority('content_manager', i.crop_code, i.districts) as can_manage
  from public.agri_evidence_items i
  where (p_status is null or i.status = p_status)
    and (p_target_kind is null or i.target_kind = p_target_kind)
    and (
      public.agri_has_authority('evidence_reviewer', i.crop_code, i.districts)
      or public.agri_has_authority('content_manager', i.crop_code, i.districts)
    )
    and (
      p_search is null
      or p_search = ''
      or i.document_title ilike '%' || p_search || '%'
      or i.source_organization ilike '%' || p_search || '%'
      or i.target_ref ilike '%' || p_search || '%'
      or coalesce(
        case i.target_kind
          when 'knowledge_entry' then (select e.title_en from public.agri_knowledge_entries e where e.id = i.target_ref::uuid)
          when 'official_advisory' then (select a.title from public.agri_advisories a where a.id = i.target_ref::uuid)
          else (select r.label_en from public.forecast_risk_rules r where r.code = i.target_ref)
        end, ''
      ) ilike '%' || p_search || '%'
    )
  order by case i.status
    when 'submitted' then 1 when 'under_review' then 2 when 'correction_requested' then 3
    when 'approved' then 4 when 'published' then 5 when 'rejected' then 6
    when 'expired' then 7 when 'superseded' then 8 else 9 end,
    coalesce(i.submitted_at, i.created_at) desc
  limit v_limit;
end;
$$;

create or replace function public.agri_review_targets(p_target_kind text default null)
returns table (
  target_kind           text,
  target_ref            text,
  label                 text,
  crop_code             text,
  topic                 text,
  current_state         text,
  current_evidence_id   uuid,
  current_evidence_status text,
  version               integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.agri_has_review_access() then
    raise exception 'Review access is required.' using errcode = 'insufficient_privilege';
  end if;
  if p_target_kind is not null and p_target_kind not in ('knowledge_entry', 'official_advisory', 'forecast_rule') then
    raise exception 'Unknown target kind.' using errcode = 'check_violation';
  end if;

  return query
  select x.target_kind, x.target_ref, x.label, x.crop_code, x.topic,
         x.current_state, x.current_evidence_id, x.current_evidence_status, x.version
  from (
    select 'knowledge_entry'::text as target_kind, e.id::text as target_ref,
           e.title_en as label, e.crop_code, e.topic,
           case when e.is_published then 'published' else 'unpublished' end as current_state,
           e.evidence_item_id as current_evidence_id,
           (select i.status from public.agri_evidence_items i where i.id = e.evidence_item_id) as current_evidence_status,
           e.version
      from public.agri_knowledge_entries e
    union all
    select 'official_advisory'::text, a.id::text, a.title, a.crop_code, a.topic,
           a.verification_status, a.evidence_item_id,
           (select i.status from public.agri_evidence_items i where i.id = a.evidence_item_id),
           null::integer
      from public.agri_advisories a
    union all
    select 'forecast_rule'::text, r.code, r.label_en, r.crop_code, r.topic,
           case when r.is_active then 'active' else 'inactive' end, r.evidence_item_id,
           (select i.status from public.agri_evidence_items i where i.id = r.evidence_item_id),
           r.version
      from public.forecast_risk_rules r
  ) x
  where p_target_kind is null or x.target_kind = p_target_kind
  order by x.target_kind, x.label
  limit 200;
end;
$$;

create or replace function public.agri_evidence_detail(p_evidence_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_item public.agri_evidence_items;
  v_can_review boolean;
  v_can_manage boolean;
  v_target jsonb;
  v_reviews jsonb;
  v_usage integer;
  v_last_used timestamptz;
  v_decisions jsonb;
begin
  if v_actor is null then
    raise exception 'An identified account is required.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_item from public.agri_evidence_items where id = p_evidence_id;
  if not found then
    raise exception 'Evidence dossier not found.' using errcode = 'no_data_found';
  end if;
  v_can_review := public.agri_has_authority('evidence_reviewer', v_item.crop_code, v_item.districts);
  v_can_manage := public.agri_has_authority('content_manager', v_item.crop_code, v_item.districts);
  if not (v_can_review or v_can_manage or v_item.created_by = v_actor or v_item.submitted_by = v_actor or public.has_capability('admin')) then
    raise exception 'You are not authorized to view this evidence.' using errcode = 'insufficient_privilege';
  end if;

  if v_item.target_kind = 'knowledge_entry' then
    select jsonb_build_object(
      'kind', 'knowledge_entry', 'title', e.title_en, 'title_ur', e.title_ur,
      'slug', e.slug, 'version', e.version, 'state', case when e.is_published then 'published' else 'unpublished' end,
      'crop_code', e.crop_code, 'topic', e.topic, 'evidence_tier', e.evidence_tier
    ) into v_target
    from public.agri_knowledge_entries e where e.id = v_item.target_ref::uuid;
  elsif v_item.target_kind = 'official_advisory' then
    select jsonb_build_object(
      'kind', 'official_advisory', 'title', a.title, 'title_ur', a.title_ur,
      'district', a.district, 'verification_status', a.verification_status,
      'is_active', a.is_active, 'source_code', a.source_code, 'source_url', a.source_url,
      'valid_until', a.valid_until, 'alert_level', a.alert_level, 'crop_code', a.crop_code, 'topic', a.topic
    ) into v_target
    from public.agri_advisories a where a.id = v_item.target_ref::uuid;
  else
    select jsonb_build_object(
      'kind', 'forecast_rule', 'code', r.code, 'label_en', r.label_en, 'label_ur', r.label_ur,
      'is_active', r.is_active, 'metric', r.metric, 'operator', r.operator, 'threshold', r.threshold,
      'unit', r.unit, 'version', r.version, 'activated_at', r.activated_at,
      'knowledge_entry_id', r.knowledge_entry_id, 'source_code', r.source_code, 'crop_code', r.crop_code, 'topic', r.topic
    ) into v_target
    from public.forecast_risk_rules r where r.code = v_item.target_ref;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'action', r.action, 'actor_id', r.actor_id, 'actor_role', r.actor_role,
    'actor_name', (select p.display_name from public.parties p where p.id = r.actor_id),
    'from_status', r.from_status, 'to_status', r.to_status, 'note', r.note,
    'detail', r.detail, 'created_at', r.created_at
  ) order by r.created_at), '[]'::jsonb) into v_reviews
  from public.agri_evidence_reviews r where r.evidence_id = v_item.id;

  select count(*), max(created_at) into v_usage, v_last_used
    from public.recommendations where evidence_item_id = v_item.id and withdrawn_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'alert_level', r.alert_level, 'alert_source_kind', r.alert_source_kind,
    'created_at', r.created_at, 'valid_until', r.valid_until
  ) order by r.created_at desc), '[]'::jsonb) into v_decisions
  from (
    select id, alert_level, alert_source_kind, created_at, valid_until
      from public.recommendations where evidence_item_id = v_item.id
     order by created_at desc limit 20
  ) r;

  return jsonb_build_object(
    'evidence', to_jsonb(v_item),
    'target', coalesce(v_target, '{}'::jsonb),
    'review_history', v_reviews,
    'usage', jsonb_build_object('live_decisions', v_usage, 'last_used_at', v_last_used, 'latest', v_decisions),
    'access', jsonb_build_object(
      'can_review', v_can_review,
      'can_manage', v_can_manage,
      'is_submitter', v_item.created_by = v_actor or v_item.submitted_by = v_actor,
      'is_reviewer', v_item.reviewer_id = v_actor,
      'can_start_review', v_can_review and v_item.status = 'submitted' and v_item.created_by <> v_actor and v_item.submitted_by <> v_actor,
      'can_check', v_can_review and v_item.status = 'under_review' and v_item.reviewer_id = v_actor,
      'can_approve', v_can_review and v_item.status = 'under_review' and v_item.reviewer_id = v_actor
        and v_item.source_check_status = 'authentic' and v_item.applicability_status = 'applicable',
      'can_publish', v_can_manage and v_item.status = 'approved',
      'can_expire', v_can_manage and v_item.status in ('approved', 'published')
    )
  );
end;
$$;

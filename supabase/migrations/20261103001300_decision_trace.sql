-- Farmer App · migration 0045 · Phase 5.2 decision trace
--
-- The recommendation row remains the canonical decision and the notification
-- event remains only a pointer to it. This migration adds the minimum missing
-- columns and one before-write trigger:
--
--   · evidence_item_id is the dossier used at generation time;
--   · decision_trace is the internal, reproducible explanation of that choice.
--
-- The farmer-facing explanation is a projection of the same row. It never
-- exposes reviewer ids, internal notes or another farmer's context.

create or replace function public.agri_attach_recommendation_trace()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_ref text;
  v_evidence_id uuid;
  v_evidence public.agri_evidence_items%rowtype;
  v_crop text;
  v_stage text;
  v_district text;
  v_scoring integer;
  v_trace jsonb;
begin
  if new.decision_trace is not null and new.decision_trace <> '{}'::jsonb then
    return new;
  end if;

  if new.source_ref like 'official_advisory:%' then
    v_kind := 'official_advisory';
    v_ref := substring(new.source_ref from length('official_advisory:') + 1);
    select evidence_item_id into v_evidence_id
      from public.agri_advisories where id = v_ref::uuid;
  elsif new.source_ref like 'forecast_risk:%' then
    v_kind := 'forecast_rule';
    v_ref := substring(new.source_ref from length('forecast_risk:') + 1);
    select evidence_item_id into v_evidence_id
      from public.forecast_risk_rules where code = v_ref;
  elsif new.alert_rule_code like 'advisory:%' then
    v_kind := 'official_advisory';
    v_ref := substring(new.alert_rule_code from length('advisory:') + 1);
    select evidence_item_id into v_evidence_id
      from public.agri_advisories where id = v_ref::uuid;
  elsif new.alert_rule_code like 'forecast:%' then
    v_kind := 'forecast_rule';
    v_ref := substring(new.alert_rule_code from length('forecast:') + 1);
    select evidence_item_id into v_evidence_id
      from public.forecast_risk_rules where code = v_ref;
  elsif new.source::text = 'knowledge_base' and new.source_ref is not null then
    v_kind := 'knowledge_entry';
    select e.evidence_item_id, e.slug into v_evidence_id, v_ref
      from public.agri_knowledge_entries e
     where e.slug = new.source_ref
       and (new.knowledge_version is null or e.version = new.knowledge_version)
     order by e.version desc
     limit 1;
    if v_evidence_id is null and v_ref is null then
      select e.evidence_item_id, e.slug into v_evidence_id, v_ref
        from public.agri_knowledge_entries e
       where e.slug = new.source_ref
       order by e.version desc
       limit 1;
    end if;
  end if;

  if v_evidence_id is not null then
    select * into v_evidence from public.agri_evidence_items where id = v_evidence_id;
    new.evidence_item_id := coalesce(new.evidence_item_id, v_evidence_id);
  end if;

  if new.crop_id is not null then
    select ci.crop_code, ci.stage::text into v_crop, v_stage
      from public.crop_instances ci where ci.id = new.crop_id;
  end if;
  select nullif(btrim(ip.district), '') into v_district
    from public.farmer_intelligence_profiles ip where ip.farmer_id = new.farmer_id;

  select coalesce((value #>> '{}')::integer, 1) into v_scoring
    from public.intelligence_config where key = 'scoring_version';

  v_trace := jsonb_build_object(
    'trace_version', 1,
    'generated_at', now(),
    'source_kind', new.alert_source_kind,
    'source', new.source,
    'source_ref', new.source_ref,
    'source_label', new.source_label,
    'source_url', new.source_url,
    'alert_rule_code', new.alert_rule_code,
    'evidence_item_id', coalesce(new.evidence_item_id, v_evidence_id),
    'target_kind', v_kind,
    'target_ref', v_ref,
    'evidence_version', v_evidence.version,
    'evidence_status', v_evidence.status,
    'evidence_classification', v_evidence.classification,
    'evidence_valid_until', v_evidence.valid_until,
    'source_check_status', v_evidence.source_check_status,
    'applicability_status', v_evidence.applicability_status,
    'agronomic_status', v_evidence.agronomic_status,
    'reviewed_at', v_evidence.reviewed_at,
    'reviewer_id', v_evidence.reviewer_id,
    'rule_version', new.rule_version,
    'knowledge_version', new.knowledge_version,
    'scoring_version', v_scoring,
    'score_components', coalesce(new.reason_context -> 'components', '{}'::jsonb),
    'crop_code', v_crop,
    'stage', v_stage,
    'district', v_district,
    'alert_level', new.alert_level,
    'validity', jsonb_build_object('valid_from', new.valid_from, 'valid_until', new.valid_until),
    'eligibility', coalesce(new.reason_context, '{}'::jsonb),
    'included', true
  );
  new.decision_trace := v_trace;
  return new;
end;
$$;

comment on function public.agri_attach_recommendation_trace() is
  'Attaches a bounded, reproducible trace to every new canonical recommendation. It records source, versions, evidence snapshot, crop/stage/district and eligibility; it never records coordinates, phone numbers or free text.';

create trigger recommendations_decision_trace
  before insert or update on public.recommendations
  for each row execute function public.agri_attach_recommendation_trace();

-- Backfill only the empty traces. The trigger resolves evidence for old rows too
-- and never rewrites an existing decision's trace.
update public.recommendations
   set decision_trace = '{}'::jsonb
 where decision_trace = '{}'::jsonb;

create or replace function public.recommendation_decision_trace(p_recommendation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_rec public.recommendations%rowtype;
  v_evidence public.agri_evidence_items%rowtype;
  v_has_evidence boolean := false;
  v_staff boolean;
  v_reviews jsonb := '[]'::jsonb;
  v_usage integer := 0;
  v_crop text;
  v_stage text;
  v_district text;
  v_farmer jsonb;
  v_internal jsonb;
begin
  select * into v_rec from public.recommendations where id = p_recommendation_id;
  if not found then
    raise exception 'Recommendation not found.' using errcode = 'no_data_found';
  end if;
  v_staff := public.agri_has_review_access() or public.has_capability('admin');
  if v_rec.farmer_id <> public.current_farmer_id() and not v_staff then
    raise exception 'This decision belongs to another farmer.' using errcode = 'insufficient_privilege';
  end if;

  if v_rec.evidence_item_id is not null then
    select * into v_evidence from public.agri_evidence_items where id = v_rec.evidence_item_id;
    v_has_evidence := v_evidence.id is not null;
  end if;
  v_crop := v_rec.decision_trace ->> 'crop_code';
  v_stage := v_rec.decision_trace ->> 'stage';
  v_district := v_rec.decision_trace ->> 'district';

  if v_staff and v_has_evidence then
    select coalesce(jsonb_agg(jsonb_build_object(
      'action', r.action, 'actor_role', r.actor_role, 'from_status', r.from_status,
      'to_status', r.to_status, 'note', r.note, 'created_at', r.created_at
    ) order by r.created_at), '[]'::jsonb) into v_reviews
    from public.agri_evidence_reviews r where r.evidence_id = v_evidence.id;
    select count(*) into v_usage from public.recommendations where evidence_item_id = v_evidence.id;
  end if;

  v_farmer := jsonb_build_object(
    'role', 'farmer',
    'recommendation_id', v_rec.id,
    'title', v_rec.title,
    'body', v_rec.body,
    'action_label', v_rec.action_label,
    'why', jsonb_build_object(
      'reason_code', v_rec.reason_code,
      'reason_context', coalesce(v_rec.reason_context, '{}'::jsonb),
      'crop_code', v_crop,
      'stage', v_stage,
      'alert_source_kind', v_rec.alert_source_kind
    ),
    'source', jsonb_build_object(
      'kind', v_rec.alert_source_kind,
      'label', v_rec.source_label,
      'url', v_rec.source_url,
      'evidence_status', case when v_has_evidence then v_evidence.status else 'not_linked' end,
      'evidence_classification', case when v_has_evidence then v_evidence.classification else null end,
      'verified_guidance', v_has_evidence and v_evidence.status = 'published'
        and v_evidence.classification in ('official_government', 'peer_reviewed_research', 'qualified_expert'),
      'reviewed', v_has_evidence and v_evidence.reviewed_at is not null,
      'valid_until', case when v_has_evidence then v_evidence.valid_until else v_rec.valid_until end
    ),
    'generated_at', v_rec.created_at,
    'valid_until', v_rec.valid_until
  );

  v_internal := jsonb_build_object(
    'role', 'internal_audit',
    'recommendation_id', v_rec.id,
    'created_at', v_rec.created_at,
    'validity', jsonb_build_object('valid_from', v_rec.valid_from, 'valid_until', v_rec.valid_until),
    'rule', jsonb_build_object(
      'alert_rule_code', v_rec.alert_rule_code,
      'rule_version', v_rec.rule_version,
      'knowledge_version', v_rec.knowledge_version,
      'scoring_version', v_rec.decision_trace ->> 'scoring_version',
      'score_components', v_rec.decision_trace -> 'score_components'
    ),
    'farmer_context', jsonb_build_object(
      'crop_code', v_crop, 'stage', v_stage, 'district', v_district
    ),
    'eligibility', v_rec.decision_trace -> 'eligibility',
    'included', v_rec.decision_trace -> 'included',
    'exclusion_reasons', v_rec.decision_trace -> 'exclusion_reasons',
    'trace', v_rec.decision_trace,
    'evidence', case when v_has_evidence then jsonb_build_object(
      'item_id', v_evidence.id,
      'version', v_evidence.version,
      'status', v_evidence.status,
      'classification', v_evidence.classification,
      'source_organization', v_evidence.source_organization,
      'source_type', v_evidence.source_type,
      'source_code', v_evidence.source_code,
      'source_url', v_evidence.source_url,
      'document_title', v_evidence.document_title,
      'document_ref', v_evidence.document_ref,
      'published_on', v_evidence.published_on,
      'accessed_at', v_evidence.accessed_at,
      'language', v_evidence.language,
      'crop_code', v_evidence.crop_code,
      'topic', v_evidence.topic,
      'districts', v_evidence.districts,
      'stages', v_evidence.stages,
      'valid_from', v_evidence.valid_from,
      'valid_until', v_evidence.valid_until,
      'reviewer_id', v_evidence.reviewer_id,
      'reviewed_at', v_evidence.reviewed_at,
      'review_note', v_evidence.review_note,
      'source_check_status', v_evidence.source_check_status,
      'applicability_status', v_evidence.applicability_status,
      'agronomic_status', v_evidence.agronomic_status
    ) else null end,
    'review_history', v_reviews,
    'same_evidence_decisions', v_usage
  );

  if v_staff then
    return jsonb_build_object('farmer_explanation', v_farmer, 'internal', v_internal);
  end if;

  -- A farmer sees their own decision and its public evidence summary, never the
  -- internal audit block, reviewer identity or another farmer's context.
  return jsonb_build_object('farmer_explanation', v_farmer);
end;
$$;

comment on function public.recommendation_decision_trace(uuid) is
  'Two-level explanation for one canonical recommendation: a farmer-safe projection and, only for review/admin callers, the evidence, versions, eligibility and review history.';

-- ---------------------------------------------------------------------------
-- Execute grants: only the signed-in browser can reach these RPCs. The two
-- evidence tables stay RLS-enabled with no client policies, so PostgREST direct
-- reads/writes are denied; every read goes through these checked functions.
-- ---------------------------------------------------------------------------
revoke execute on function public.agri_attach_recommendation_trace() from public, anon, authenticated;
revoke execute on function public.agri_log_evidence_event(uuid, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.agri_block_review_ledger_mutation() from public, anon, authenticated;
revoke execute on function public.agri_touch_evidence() from public, anon, authenticated;
revoke execute on function public.agri_guard_knowledge_publication() from public, anon, authenticated;
revoke execute on function public.agri_guard_advisory_publication() from public, anon, authenticated;
revoke execute on function public.agri_guard_rule_activation() from public, anon, authenticated;

revoke execute on function public.agri_has_authority(text, text, text[]) from public, anon;
revoke execute on function public.agri_has_authority_role(text) from public, anon;
revoke execute on function public.agri_has_review_access() from public, anon;
revoke execute on function public.agri_review_context() from public, anon;
revoke execute on function public.grant_agri_review_authority(uuid, text, text[], text[], text) from public, anon;
revoke execute on function public.revoke_agri_review_authority(uuid, text, text) from public, anon;
revoke execute on function public.agri_create_evidence(text, text, text, text, text, text, text, text, text, text, date, timestamptz, text, text, text[], text[], numeric, timestamptz, timestamptz, uuid, boolean) from public, anon;
revoke execute on function public.agri_submit_evidence(uuid) from public, anon;
revoke execute on function public.agri_start_review(uuid) from public, anon;
revoke execute on function public.agri_set_source_check(uuid, text, text) from public, anon;
revoke execute on function public.agri_set_applicability_check(uuid, text, text) from public, anon;
revoke execute on function public.agri_approve_evidence(uuid, text) from public, anon;
revoke execute on function public.agri_reject_evidence(uuid, text) from public, anon;
revoke execute on function public.agri_request_correction(uuid, text) from public, anon;
revoke execute on function public.agri_update_and_resubmit(uuid, text, text, text, text, timestamptz, text) from public, anon;
revoke execute on function public.agri_publish_evidence(uuid, text) from public, anon;
revoke execute on function public.agri_expire_evidence(uuid, text) from public, anon;
revoke execute on function public.agri_supersede_evidence(uuid, uuid, text) from public, anon;
revoke execute on function public.agri_review_queue(text, text, text, integer) from public, anon;
revoke execute on function public.agri_review_targets(text) from public, anon;
revoke execute on function public.agri_evidence_detail(uuid) from public, anon;
revoke execute on function public.recommendation_decision_trace(uuid) from public, anon;

grant execute on function public.agri_has_authority(text, text, text[]) to authenticated;
grant execute on function public.agri_has_authority_role(text) to authenticated;
grant execute on function public.agri_has_review_access() to authenticated;
grant execute on function public.agri_review_context() to authenticated;
grant execute on function public.grant_agri_review_authority(uuid, text, text[], text[], text) to authenticated;
grant execute on function public.revoke_agri_review_authority(uuid, text, text) to authenticated;
grant execute on function public.agri_create_evidence(text, text, text, text, text, text, text, text, text, text, date, timestamptz, text, text, text[], text[], numeric, timestamptz, timestamptz, uuid, boolean) to authenticated;
grant execute on function public.agri_submit_evidence(uuid) to authenticated;
grant execute on function public.agri_start_review(uuid) to authenticated;
grant execute on function public.agri_set_source_check(uuid, text, text) to authenticated;
grant execute on function public.agri_set_applicability_check(uuid, text, text) to authenticated;
grant execute on function public.agri_approve_evidence(uuid, text) to authenticated;
grant execute on function public.agri_reject_evidence(uuid, text) to authenticated;
grant execute on function public.agri_request_correction(uuid, text) to authenticated;
grant execute on function public.agri_update_and_resubmit(uuid, text, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.agri_publish_evidence(uuid, text) to authenticated;
grant execute on function public.agri_expire_evidence(uuid, text) to authenticated;
grant execute on function public.agri_supersede_evidence(uuid, uuid, text) to authenticated;
grant execute on function public.agri_review_queue(text, text, text, integer) to authenticated;
grant execute on function public.agri_review_targets(text) to authenticated;
grant execute on function public.agri_evidence_detail(uuid) to authenticated;
grant execute on function public.recommendation_decision_trace(uuid) to authenticated;

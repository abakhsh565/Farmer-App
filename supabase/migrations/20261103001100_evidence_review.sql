-- Farmer App · migration 0043 · Phase 5.2 evidence and review management
--
-- This is not a second knowledge or alert engine. It is the missing review
-- dossier around the existing agricultural content:
--
--   agri_knowledge_entries ─┐
--   agri_advisories         ├─ evidence_item_id ─▶ agri_evidence_items
--   forecast_risk_rules     ┘                         │
--                                                     └─▶ agri_evidence_reviews
--
-- Publication and activation are guarded at the table boundary: a target cannot
-- become published/verified/active unless its linked evidence is published. The
-- separation of powers is deliberate:
--
--   evidence_reviewer  checks source authenticity, applicability and agronomy;
--   content_manager    publishes already-approved evidence and targets.
--
-- `admin` is not either authority. An administrator may grant authority, but the
-- grant is a recorded human decision and does not itself make anyone an
-- agronomist. No authority, evidence, reviewer, advisory or threshold is seeded.

-- ---------------------------------------------------------------------------
-- Review authorities
-- ---------------------------------------------------------------------------
create table public.agri_review_authorities (
  id                uuid primary key default gen_random_uuid(),
  party_id          uuid not null references public.parties (id) on delete cascade,
  authority         text not null check (authority in ('evidence_reviewer', 'content_manager')),
  -- An empty scope means "all" and is only appropriate for a national/lead role.
  scope_crops       text[] not null default '{}'::text[],
  scope_districts   text[] not null default '{}'::text[],
  granted_by        uuid references public.parties (id) on delete set null,
  granted_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  note              text not null,
  unique (party_id, authority)
);

comment on table public.agri_review_authorities is
  'Named human authority for agricultural review. Separate from admin: an administrator is not automatically an agronomist, and content publication is not agronomic approval.';

create index agri_review_authorities_active_idx
  on public.agri_review_authorities (party_id, authority)
  where revoked_at is null;

alter table public.agri_review_authorities enable row level security;
revoke all on public.agri_review_authorities from public, anon, authenticated;

create or replace function public.agri_has_authority_role(p_authority text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.agri_review_authorities a
     where a.party_id = public.current_party_id()
       and a.authority = p_authority
       and a.revoked_at is null
  );
$$;

comment on function public.agri_has_authority_role(text) is
  'Whether the caller holds the named authority at all, regardless of scope. Used only for workspace entry, never for a specific evidence decision.';

create or replace function public.agri_has_authority(
  p_authority text,
  p_crop      text default null,
  p_districts text[] default '{}'::text[]
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.agri_review_authorities a
     where a.party_id = public.current_party_id()
       and a.authority = p_authority
       and a.revoked_at is null
       and (
         cardinality(a.scope_crops) = 0
         or (p_crop is not null and p_crop = any (a.scope_crops))
       )
       and (
         cardinality(a.scope_districts) = 0
         or (cardinality(p_districts) > 0 and a.scope_districts @> p_districts)
       )
  );
$$;

comment on function public.agri_has_authority(text, text, text[]) is
  'True only when the authority scope actually covers the evidence. A null crop or empty district set means all, so it requires an all-scope authority; a scoped reviewer can never widen it by omission. Admin capability is deliberately not consulted.';

create or replace function public.agri_has_review_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.agri_has_authority_role('evidence_reviewer')
      or public.agri_has_authority_role('content_manager');
$$;

create or replace function public.agri_review_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_review boolean;
  v_manage boolean;
begin
  if v_actor is null then
    raise exception 'An identified account is required.' using errcode = 'insufficient_privilege';
  end if;

  v_review := public.agri_has_authority_role('evidence_reviewer');
  v_manage := public.agri_has_authority_role('content_manager');

  return jsonb_build_object(
    'party_id', v_actor,
    'can_review', v_review,
    'can_manage', v_manage,
    'can_grant', public.has_capability('admin'),
    'authorities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'authority', a.authority,
        'scope_crops', a.scope_crops,
        'scope_districts', a.scope_districts,
        'granted_at', a.granted_at
      ) order by a.authority)
      from public.agri_review_authorities a
      where a.party_id = v_actor and a.revoked_at is null
    ), '[]'::jsonb),
    'counts', case
      when v_review or v_manage then (
        select jsonb_build_object(
          'submitted', count(*) filter (where status = 'submitted'),
          'under_review', count(*) filter (where status = 'under_review'),
          'correction_requested', count(*) filter (where status = 'correction_requested'),
          'approved', count(*) filter (where status = 'approved'),
          'published', count(*) filter (where status = 'published'),
          'rejected', count(*) filter (where status = 'rejected'),
          'closed', count(*) filter (where status in ('expired', 'superseded'))
        )
        from public.agri_evidence_items
      )
      else '{}'::jsonb
    end
  );
end;
$$;

comment on function public.agri_review_context() is
  'The signed-in person''s review roles, scopes and aggregate queue counts. It never exposes a role inferred from admin.';

create or replace function public.grant_agri_review_authority(
  p_party_id       uuid,
  p_authority      text,
  p_scope_crops    text[] default '{}'::text[],
  p_scope_districts text[] default '{}'::text[],
  p_note           text default null
)
returns public.agri_review_authorities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_row public.agri_review_authorities;
begin
  if not public.has_capability('admin') then
    raise exception 'Granting review authority requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if p_authority not in ('evidence_reviewer', 'content_manager') then
    raise exception 'Unknown review authority.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Granting review authority requires a note.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.parties p where p.id = p_party_id) then
    raise exception 'Party % not found.', p_party_id using errcode = 'no_data_found';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_scope_crops, '{}'::text[])) c
     where not exists (select 1 from public.crop_catalog cc where cc.code = c)
  ) then
    raise exception 'Review scope contains an unknown crop code.' using errcode = 'check_violation';
  end if;

  insert into public.agri_review_authorities (
    party_id, authority, scope_crops, scope_districts, granted_by, note
  ) values (
    p_party_id, p_authority, coalesce(p_scope_crops, '{}'::text[]),
    coalesce(p_scope_districts, '{}'::text[]), v_actor, btrim(p_note)
  )
  on conflict (party_id, authority) do update
    set scope_crops = excluded.scope_crops,
        scope_districts = excluded.scope_districts,
        granted_by = excluded.granted_by,
        granted_at = now(),
        revoked_at = null,
        note = excluded.note
  returning * into v_row;

  perform public.write_audit(
    'agri.review_authority_granted', 'agri_review_authorities', v_row.id, p_authority,
    null, 'active',
    jsonb_build_object('party_id', p_party_id, 'scopes', jsonb_build_object(
      'crops', v_row.scope_crops, 'districts', v_row.scope_districts
    )),
    v_actor, 'admin'
  );

  return v_row;
end;
$$;

comment on function public.grant_agri_review_authority(uuid, text, text[], text[], text) is
  'Admin-only authority grant. It records a named human decision; it never makes the grantee an agronomist and does not seed an authority.';

create or replace function public.revoke_agri_review_authority(
  p_party_id  uuid,
  p_authority text,
  p_note      text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
begin
  if not public.has_capability('admin') then
    raise exception 'Revoking review authority requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Revoking review authority requires a note.' using errcode = 'check_violation';
  end if;

  update public.agri_review_authorities
     set revoked_at = now(), note = btrim(p_note)
   where party_id = p_party_id and authority = p_authority and revoked_at is null;
  if not found then return false; end if;

  perform public.write_audit(
    'agri.review_authority_revoked', 'agri_review_authorities', null, p_authority,
    'active', 'revoked', jsonb_build_object('party_id', p_party_id, 'note', btrim(p_note)),
    v_actor, 'admin'
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evidence dossier
-- ---------------------------------------------------------------------------
create table public.agri_evidence_items (
  id                    uuid primary key default gen_random_uuid(),
  evidence_key          text not null unique,
  target_kind           text not null check (target_kind in ('knowledge_entry', 'official_advisory', 'forecast_rule')),
  target_ref            text not null,
  version               integer not null check (version > 0),
  supersedes_id         uuid references public.agri_evidence_items (id) on delete set null,
  superseded_by         uuid references public.agri_evidence_items (id) on delete set null,

  source_organization   text not null check (length(btrim(source_organization)) between 1 and 240),
  source_type           text not null check (source_type in (
                          'official_government', 'official_extension', 'regulator',
                          'university', 'peer_reviewed', 'qualified_expert',
                          'supplementary_editorial', 'community', 'unknown'
                        )),
  source_code           text references public.agri_knowledge_sources (code) on delete set null,
  source_url            text check (source_url is null or source_url ~ '^https://[^[:space:]]+$'),
  document_ref          text,
  document_title        text not null check (length(btrim(document_title)) between 1 and 400),
  published_on          date,
  accessed_at           timestamptz not null default now(),
  language              text not null default 'en' check (language in ('en', 'ur', 'bilingual')),

  crop_code             text references public.crop_catalog (code) on delete set null,
  topic                 text not null default 'other' check (topic in ('pest', 'disease', 'weed', 'water', 'weather_damage', 'sowing', 'other')),
  districts             text[] not null default '{}'::text[],
  stages                text[] not null default '{}'::text[],
  classification        text not null check (classification in (
                          'official_government', 'peer_reviewed_research',
                          'qualified_expert', 'supplementary_editorial',
                          'unverified_submission'
                        )),
  confidence            numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),

  status                text not null default 'draft' check (status in (
                          'draft', 'submitted', 'under_review', 'correction_requested',
                          'approved', 'rejected', 'published', 'expired', 'superseded'
                        )),
  source_check_status   text not null default 'pending' check (source_check_status in ('pending', 'authentic', 'not_authentic')),
  applicability_status  text not null default 'pending' check (applicability_status in ('pending', 'applicable', 'not_applicable')),
  agronomic_status      text not null default 'pending' check (agronomic_status in ('pending', 'approved', 'rejected')),

  submitted_by          uuid references public.parties (id) on delete set null,
  submitted_at          timestamptz,
  review_started_at     timestamptz,
  reviewer_id           uuid references public.parties (id) on delete set null,
  reviewed_at           timestamptz,
  review_note            text,
  rejection_reason      text,
  correction_note       text,

  valid_from            timestamptz not null default now(),
  valid_until           timestamptz,
  published_at          timestamptz,
  expired_at            timestamptz,

  created_by             uuid references public.parties (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (target_kind, target_ref, version),
  constraint agri_evidence_validity check (valid_until is null or valid_until > valid_from),
  constraint agri_evidence_approved_state check (
    status not in ('approved', 'published')
    or (
      source_check_status = 'authentic'
      and applicability_status = 'applicable'
      and agronomic_status = 'approved'
      and reviewer_id is not null
      and reviewed_at is not null
      and valid_until is not null
      and classification <> 'unverified_submission'
    )
  ),
  constraint agri_evidence_published_state check (
    status <> 'published' or published_at is not null
  )
);

comment on table public.agri_evidence_items is
  'One reviewable evidence dossier per content version. It records source, document, applicability, classification and the separate source/applicability/agronomy checks. Publication is a separate content-manager act.';

create index agri_evidence_queue_idx on public.agri_evidence_items (status, submitted_at desc);
create index agri_evidence_target_idx on public.agri_evidence_items (target_kind, target_ref, version desc);
create index agri_evidence_expiry_idx on public.agri_evidence_items (valid_until) where status = 'published';

alter table public.agri_evidence_items enable row level security;
revoke all on public.agri_evidence_items from public, anon, authenticated;

create table public.agri_evidence_reviews (
  id           uuid primary key default gen_random_uuid(),
  evidence_id  uuid not null references public.agri_evidence_items (id) on delete cascade,
  actor_id     uuid references public.parties (id) on delete set null,
  actor_role   text not null check (actor_role in ('evidence_reviewer', 'content_manager', 'admin', 'submitter')),
  action       text not null check (action in (
                 'create', 'submit', 'start_review', 'source_check',
                 'applicability_check', 'approve', 'reject', 'request_correction',
                 'resubmit', 'publish', 'expire', 'supersede'
               )),
  from_status  text,
  to_status    text,
  note         text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.agri_evidence_reviews is
  'Append-only review ledger. It records every transition, the actor and the stated reason; it is never edited or deleted by a client path.';

create index agri_evidence_reviews_item_idx
  on public.agri_evidence_reviews (evidence_id, created_at desc);

alter table public.agri_evidence_reviews enable row level security;
revoke all on public.agri_evidence_reviews from public, anon, authenticated;

create or replace function public.agri_block_review_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  if session_user = 'postgres' then
    return old;
  end if;
  raise exception 'The evidence review ledger is append-only.' using errcode = 'insufficient_privilege';
end;
$$;

create trigger agri_evidence_reviews_append_only
  before update or delete on public.agri_evidence_reviews
  for each row execute function public.agri_block_review_ledger_mutation();

create or replace function public.agri_touch_evidence()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger agri_evidence_items_touch
  before update on public.agri_evidence_items
  for each row execute function public.agri_touch_evidence();

-- ---------------------------------------------------------------------------
-- Links to the existing content and recommendation objects
-- ---------------------------------------------------------------------------
alter table public.agri_knowledge_entries
  add column if not exists evidence_item_id uuid references public.agri_evidence_items (id) on delete set null;
alter table public.agri_advisories
  add column if not exists evidence_item_id uuid references public.agri_evidence_items (id) on delete set null;
alter table public.forecast_risk_rules
  add column if not exists evidence_item_id uuid references public.agri_evidence_items (id) on delete set null,
  add column if not exists version integer not null default 1 check (version > 0),
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references public.parties (id) on delete set null,
  add column if not exists deactivation_note text;
alter table public.recommendations
  add column if not exists evidence_item_id uuid references public.agri_evidence_items (id) on delete set null,
  add column if not exists decision_trace jsonb not null default '{}'::jsonb;

comment on column public.agri_knowledge_entries.evidence_item_id is
  'The evidence dossier that authorised this version''s publication. Legacy rows may be null; a new publication cannot be.';
comment on column public.agri_advisories.evidence_item_id is
  'The verified evidence dossier behind an official advisory. Direct verification without a published dossier is blocked.';
comment on column public.forecast_risk_rules.evidence_item_id is
  'The approved evidence dossier behind an active forecast rule. Activation without a published dossier is blocked.';
comment on column public.recommendations.evidence_item_id is
  'The evidence item used when this decision was generated. It is a snapshot pointer; later evidence changes do not rewrite history.';
comment on column public.recommendations.decision_trace is
  'Reproducible internal trace for this decision: source, rule/version, evidence snapshot, farmer-context fields and eligibility reasons. No exact coordinates or other farmers'' data.';

create index if not exists agri_knowledge_evidence_idx on public.agri_knowledge_entries (evidence_item_id);
create index if not exists agri_advisories_evidence_idx on public.agri_advisories (evidence_item_id);
create index if not exists agri_forecast_rules_evidence_idx on public.forecast_risk_rules (evidence_item_id);
create index if not exists recommendations_evidence_idx on public.recommendations (evidence_item_id);

-- ---------------------------------------------------------------------------
-- Publication/activation guards
-- ---------------------------------------------------------------------------
create or replace function public.agri_guard_knowledge_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_published then
    if new.evidence_item_id is null or not exists (
      select 1 from public.agri_evidence_items e
       where e.id = new.evidence_item_id
         and e.target_kind = 'knowledge_entry'
         and e.target_ref = new.id::text
         and e.status = 'published'
    ) then
      raise exception 'Published knowledge must be linked to its published evidence dossier.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger agri_knowledge_publication_guard
  before insert or update on public.agri_knowledge_entries
  for each row execute function public.agri_guard_knowledge_publication();

create or replace function public.agri_guard_advisory_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.verification_status = 'verified' then
    if new.evidence_item_id is null or not exists (
      select 1 from public.agri_evidence_items e
       where e.id = new.evidence_item_id
         and e.target_kind = 'official_advisory'
         and e.target_ref = new.id::text
         and e.status = 'published'
    ) then
      raise exception 'Verified advisories require a published evidence dossier.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger agri_advisory_publication_guard
  before insert or update on public.agri_advisories
  for each row execute function public.agri_guard_advisory_publication();

create or replace function public.agri_guard_rule_activation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_active and (tg_op = 'INSERT' or not old.is_active) then
    if new.evidence_item_id is null or not exists (
      select 1 from public.agri_evidence_items e
       where e.id = new.evidence_item_id
         and e.target_kind = 'forecast_rule'
         and e.target_ref = new.code
         and e.status = 'published'
    ) then
      raise exception 'Active forecast rules require a published evidence dossier.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger agri_rule_activation_guard
  before insert or update on public.forecast_risk_rules
  for each row execute function public.agri_guard_rule_activation();

-- ---------------------------------------------------------------------------
-- Existing verification/activation paths stay in place and gain the guard.
-- `verify_official_advisory()` and `activate_forecast_risk_rule()` keep their
-- original source and threshold checks; their UPDATE now fails unless a
-- published evidence dossier is already linked. The normal path is
-- agri_publish_evidence(), which also updates the content target.
-- ---------------------------------------------------------------------------

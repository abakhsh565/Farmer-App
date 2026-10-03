-- Farmer App · migration 0009 · moderation
--
-- PRD: Report -> Moderation Case -> Admin/Moderation Review -> Action -> Audit.
-- Outcomes available: dismiss, warn, hide/restrict, remove, escalate. A report
-- must NOT automatically equal permanent deletion. AI may detect and prioritise
-- risk, but must not independently perform irreversible moderation decisions.
--
-- Two of those become constraints rather than habits:
--   * a report is not a case outcome, so `community_reports` has no outcome
--     column at all — it cannot delete anything even by mistake
--   * any outcome beyond dismiss/escalate requires a human actor, enforced by
--     a CHECK constraint on the action row itself
--
-- "Audit" is the shared audit_log from migration 0001, so moderation is
-- auditable in the same ledger as credit and verification rather than its own
-- private trail.

create table public.community_reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid references public.parties (id) on delete set null,
  target_type    public.moderation_target not null,
  target_id      uuid not null,
  -- Why. Fixed vocabulary so reports can be triaged consistently.
  reason_code    text not null check (reason_code in (
    'spam', 'abuse', 'misinformation', 'unsafe_advice', 'off_topic', 'duplicate', 'other'
  )),
  note           text,
  -- The reporter's own account of what they saw. Kept alongside the target so
  -- the case survives the target later being edited.
  snapshot       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index community_reports_target_idx on public.community_reports (target_type, target_id, created_at desc);

-- One open report per reporter per target: reporting the same post five times is
-- noise, and noise is what makes a moderation queue unusable.
create unique index community_reports_one_open_idx
  on public.community_reports (reporter_id, target_type, target_id)
  where reporter_id is not null;

comment on table public.community_reports is
  'A report records an allegation. It carries no outcome and references no action: reporting is not moderating, and no row here can hide or delete anything.';

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

create table public.moderation_cases (
  id             uuid primary key default gen_random_uuid(),
  -- Human-readable reference for support conversations.
  reference      text not null unique default ('MC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  target_type    public.moderation_target not null,
  target_id      uuid not null,
  status         text not null default 'open' check (status in ('open', 'triaged', 'reviewing', 'resolved', 'dismissed')),
  severity       text not null default 'normal' check (severity in ('low', 'normal', 'high', 'urgent')),
  -- How many distinct reports fed this case. Evidence of a pattern, not a verdict.
  report_count   integer not null default 0,
  -- Automation may raise this and set severity. It may not resolve the case.
  risk_score     numeric check (risk_score >= 0 and risk_score <= 1),
  risk_signals   jsonb not null default '[]'::jsonb,
  assigned_to    uuid references public.parties (id),
  opened_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  constraint moderation_cases_resolved_consistency check (
    (status in ('resolved', 'dismissed')) = (resolved_at is not null)
  )
);

create unique index moderation_cases_open_target_idx
  on public.moderation_cases (target_type, target_id)
  where status in ('open', 'triaged', 'reviewing');

create index moderation_cases_queue_idx on public.moderation_cases (status, severity, opened_at);

comment on column public.moderation_cases.risk_score is
  'Set by automated triage to order the queue. It cannot close a case; only a human action with an outcome can, which the actions table enforces.';

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------

create table public.moderation_actions (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references public.moderation_cases (id) on delete cascade,
  outcome        public.moderation_outcome not null,
  -- Who or what performed it. 'automated' exists so triage can be recorded
  -- honestly instead of being disguised as a human action.
  performed_by_kind text not null default 'human' check (performed_by_kind in ('human', 'automated')),
  actor_id       uuid references public.parties (id),
  reason         text not null,
  -- How long a restriction lasts, when the outcome is time-bound.
  expires_at     timestamptz,
  -- Reversal, so a wrong call is correctable and the correction is visible.
  reversed_at    timestamptz,
  reversed_by    uuid references public.parties (id),
  created_at     timestamptz not null default now(),
  -- The core rule. An automated actor may only dismiss or escalate: everything
  -- punitive is reserved for a human, and a human is required to be named.
  constraint moderation_actions_human_for_punitive check (
    (performed_by_kind = 'automated' and outcome in ('dismiss', 'escalate'))
    or (performed_by_kind = 'human' and actor_id is not null)
  ),
  constraint moderation_actions_expiry check (expires_at is null or expires_at > created_at)
);

create index moderation_actions_case_idx on public.moderation_actions (case_id, created_at desc);

comment on constraint moderation_actions_human_for_punitive on public.moderation_actions is
  'A warn, restrict, hide or remove with performed_by_kind = automated is rejected by the database, and a human outcome with no named actor is rejected too. AI triage cannot delete a farmer''s post.';

-- ---------------------------------------------------------------------------
-- Applying an outcome
-- ---------------------------------------------------------------------------

-- One function that both records the decision and applies it, so an outcome can
-- never be recorded without taking effect (or take effect without a record).
create or replace function public.moderate_apply(
  p_case_id     uuid,
  p_outcome     public.moderation_outcome,
  p_reason      text,
  p_actor_id    uuid default null,
  p_expires_at  timestamptz default null
)
returns public.moderation_actions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case   public.moderation_cases;
  v_action public.moderation_actions;
  v_actor  uuid := coalesce(p_actor_id, public.current_party_id());
  v_kind   text;
begin
  select * into v_case from public.moderation_cases where id = p_case_id for update;
  if not found then
    raise exception 'Moderation case % not found.', p_case_id using errcode = 'no_data_found';
  end if;

  v_kind := case when v_actor is null then 'automated' else 'human' end;

  -- Mirrors the table constraint with a clearer message. The constraint is the
  -- real guard; this is the explanation.
  if v_kind = 'human' and not public.has_capability('moderator') and not public.has_capability('admin') then
    raise exception 'Moderation requires the moderator or admin capability.' using errcode = 'insufficient_privilege';
  end if;

  if v_kind = 'automated' and p_outcome not in ('dismiss', 'escalate') then
    raise exception 'An automated system may only dismiss or escalate; % requires a human moderator.', p_outcome
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.moderation_actions (case_id, outcome, performed_by_kind, actor_id, reason, expires_at)
  values (p_case_id, p_outcome, v_kind, v_actor, p_reason, p_expires_at)
  returning * into v_action;

  -- Apply the effect to the target.
  if p_outcome in ('hide', 'remove', 'restrict') then
    if v_case.target_type = 'post' then
      update public.community_posts
         set hidden_at = now(), hidden_by = v_actor, hidden_reason = p_reason
       where id = v_case.target_id;
    elsif v_case.target_type = 'reply' then
      update public.community_replies
         set hidden_at = now(), hidden_by = v_actor, hidden_reason = p_reason
       where id = v_case.target_id;
    elsif v_case.target_type = 'story' then
      update public.community_stories
         set expires_at = now()
       where id = v_case.target_id;
    end if;
  end if;

  -- A dismiss or a resolved punitive action closes the case. An escalation
  -- deliberately leaves it open for the next reviewer.
  if p_outcome in ('dismiss', 'warn', 'hide', 'restrict', 'remove') then
    update public.moderation_cases
       set status = case when p_outcome = 'dismiss' then 'dismissed' else 'resolved' end,
           resolved_at = now()
     where id = p_case_id;
  elsif p_outcome = 'escalate' then
    update public.moderation_cases
       set status = 'reviewing', severity = 'high'
     where id = p_case_id;
  end if;

  perform public.write_audit(
    'moderation.action',
    'moderation_cases',
    p_case_id,
    v_case.reference,
    v_case.status::text,
    p_outcome::text,
    jsonb_build_object(
      'outcome', p_outcome,
      'performed_by_kind', v_kind,
      'target_type', v_case.target_type,
      'target_id', v_case.target_id,
      'reason', p_reason
    ),
    v_actor,
    case when v_kind = 'automated' then 'system' else 'moderator' end
  );

  return v_action;
end;
$$;

comment on function public.moderate_apply(uuid, public.moderation_outcome, text, uuid, timestamptz) is
  'Records the decision and applies it in one transaction, and is the only path to hiding or removing content. Escalation leaves the case open on purpose.';

-- ---------------------------------------------------------------------------
-- Intake
-- ---------------------------------------------------------------------------

-- A report opens or joins a case. It never resolves one.
create or replace function public.community_report_content(
  p_reporter_id uuid,
  p_target_type public.moderation_target,
  p_target_id   uuid,
  p_reason_code text,
  p_note        text default null
)
returns public.moderation_cases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.moderation_cases;
  v_id   uuid;
begin
  if p_reporter_id is null then
    raise exception 'Reporting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.community_reports (reporter_id, target_type, target_id, reason_code, note)
  values (p_reporter_id, p_target_type, p_target_id, p_reason_code, p_note)
  returning id into v_id;

  select * into v_case
    from public.moderation_cases
   where target_type = p_target_type
     and target_id = p_target_id
     and status in ('open', 'triaged', 'reviewing');

  if not found then
    insert into public.moderation_cases (target_type, target_id, report_count)
    values (p_target_type, p_target_id, 1)
    returning * into v_case;
  else
    update public.moderation_cases
       set report_count = report_count + 1,
           status = case when status = 'open' then 'triaged' else status end
     where id = v_case.id
    returning * into v_case;
  end if;

  perform public.write_audit(
    'moderation.report_filed', 'moderation_cases', v_case.id, v_case.reference,
    null, v_case.status,
    jsonb_build_object('reason_code', p_reason_code, 'target_type', p_target_type, 'target_id', p_target_id, 'report_id', v_id),
    p_reporter_id,
    'farmer'
  );

  return v_case;
exception
  when unique_violation then
    -- Already reported by this farmer; return the case it belongs to.
    select * into v_case
      from public.moderation_cases
     where target_type = p_target_type
       and target_id = p_target_id
       and status in ('open', 'triaged', 'reviewing');
    if found then
      return v_case;
    end if;
    raise;
end;
$$;

comment on function public.community_report_content(uuid, public.moderation_target, uuid, text, text) is
  'Files an allegation and groups it into a case. Nothing here can hide or remove content, which is what keeps "a report is not a deletion" true by construction.';

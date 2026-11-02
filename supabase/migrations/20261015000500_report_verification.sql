-- Farmer App · migration 0030 · the verification loop
--
-- Step 2. Step 1 got reports *in*; nothing yet turns one into intelligence. The
-- evidence column already exists on `crop_reports` — `farmer_report` by default,
-- and `expert_verified`, `official_advisory` and `forecast_risk` as the three
-- ways a report can earn more than a farmer's word. What did not exist is a way
-- to *reach* those three values, a record of who did it, and any rule about who
-- is entitled to.
--
-- The design rule this migration enforces everywhere: **evidence is only ever
-- raised by a named person acting inside a stated competence, and every raise is
-- reversible and recorded.** No path here upgrades a report automatically, and
-- nothing can label a forecast a fact.
--
-- The state machine is deliberately one step wide:
--
--     farmer_report ──confirm──▶ expert_verified
--                   ──match────▶ official_advisory
--          ▲                         │
--          └──────── withdraw ───────┘
--
-- A report at `farmer_report` can be promoted. A promoted report cannot be
-- promoted *again* by the other path, and cannot be silently re-rated: the way
-- to change the basis is to withdraw first, which puts both acts in the ledger
-- instead of hiding the first one behind the second.

-- ---------------------------------------------------------------------------
-- The current review state, on the report
-- ---------------------------------------------------------------------------

-- Three columns rather than a status enum: the *history* lives in
-- `report_reviews`, and these are only where the report stands now. Keeping both
-- means "who vouched for this" is answerable without a join, and "how many times
-- did the answer change" is answerable with one.
alter table public.crop_reports
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.parties (id) on delete set null,
  add column if not exists review_note text,
  add column if not exists matched_advisory_id uuid references public.agri_advisories (id) on delete set null;

comment on column public.crop_reports.reviewed_by is
  'The person who last raised this report''s evidence. Null on a report nobody has reviewed, which is the default and the majority case.';

comment on column public.crop_reports.matched_advisory_id is
  'The official advisory an `official_advisory` report was matched to. Set only by match_report_to_advisory, so the claim points at the document rather than at a reviewer''s memory of it.';

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table public.report_reviews (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references public.crop_reports (id) on delete cascade,
  reviewer_id    uuid references public.parties (id) on delete set null,
  -- The capability the reviewer acted on, recorded rather than inferred from the
  -- reviewer's roles at read time: a badge can be revoked, and the review it
  -- authorised must not be re-explained after the fact.
  reviewer_basis text not null check (reviewer_basis in ('expert', 'admin')),
  action         text not null check (action in ('confirm_expert', 'match_official', 'withdraw')),
  from_evidence  text not null check (from_evidence in ('farmer_report', 'expert_verified', 'official_advisory', 'forecast_risk')),
  to_evidence    text not null check (to_evidence in ('farmer_report', 'expert_verified', 'official_advisory', 'forecast_risk')),
  advisory_id    uuid references public.agri_advisories (id) on delete set null,
  note           text,
  created_at     timestamptz not null default now(),
  constraint report_reviews_changes_something check (from_evidence <> to_evidence)
);

create index report_reviews_report_idx on public.report_reviews (report_id, created_at desc);
create index report_reviews_reviewer_idx on public.report_reviews (reviewer_id, created_at desc);

comment on table public.report_reviews is
  'Append-only record of every evidence change on a report: who, on what basis, from what to what, and why. A withdrawal is a row here, never a delete — the wrong call stays visible next to the right one.';

-- ---------------------------------------------------------------------------
-- Forecast risk: a rule that may not exist without a citation
-- ---------------------------------------------------------------------------

-- A rule is a threshold on one forecast metric, and it is *data* rather than
-- code for the same reason retention policies are: a threshold is an agronomic
-- judgement, and a judgement should be changeable by the person who owns it
-- without a deployment.
--
-- The constraint that matters is `knowledge_entry_id`: it is NOT NULL, so a rule
-- cannot be written until the published entry that justifies its threshold
-- exists. That is what keeps "the model says conditions suit a pest" from being
-- an assertion with no author.
create table public.forecast_risk_rules (
  code             text primary key,
  crop_code        text references public.crop_catalog (code),
  topic            text not null check (topic in ('pest', 'disease', 'weed', 'water', 'weather_damage', 'other')),
  -- Which forecast column, and the comparison. The pair is the whole rule.
  metric           text not null check (metric in ('tmax_c', 'tmin_c', 'precip_mm', 'humidity_pct', 'wind_kph')),
  operator         text not null check (operator in ('gt', 'gte', 'lt', 'lte')),
  threshold        numeric not null,
  unit             text not null,
  -- The justification, and the wording the served row carries.
  knowledge_entry_id uuid not null references public.agri_knowledge_entries (id),
  source_code      text not null references public.intel_sources (code),
  label_en         text not null check (position('%s' in label_en) > 0),
  label_ur         text not null check (position('%s' in label_ur) > 0),
  -- What the threshold is, in words. "The entry says 'light and steady'; this
  -- number is the interpretation" is the honest kind of note here.
  threshold_basis  text not null,
  -- Off until an agronomist turns it on. See activate_forecast_risk_rule.
  is_active        boolean not null default false,
  activated_at     timestamptz,
  activated_by     uuid references public.parties (id) on delete set null,
  activation_note  text,
  created_at       timestamptz not null default now()
);

comment on table public.forecast_risk_rules is
  'Thresholds the forecast-risk generator may apply. A rule is inert until an agronomist activates it: a migration may ship the mechanism, but it cannot assert that a number is agronomically right.';

comment on column public.forecast_risk_rules.knowledge_entry_id is
  'The published entry that justifies this threshold. NOT NULL on purpose — the mechanism refuses to exist without a citation.';

create table public.forecast_risks (
  id            uuid primary key default gen_random_uuid(),
  rule_code     text not null references public.forecast_risk_rules (code) on delete cascade,
  provider_code text not null references public.weather_providers (code),
  district_code text not null references public.districts (code),
  crop_code     text references public.crop_catalog (code),
  topic         text not null check (topic in ('pest', 'disease', 'weed', 'water', 'weather_damage', 'other')),
  -- The day the risk is about, taken from the forecast row's own date.
  risk_on       date not null,
  issued_on     date not null,
  -- The evidence, stored so the claim can be re-checked without re-running the
  -- model: which metric, which comparison, what was measured, against what.
  metric        text not null,
  operator      text not null,
  threshold     numeric not null,
  observed_value numeric,
  basis         jsonb not null default '{}'::jsonb,
  -- Both languages, because the rule carries both and a warning a farmer cannot
  -- read is not a warning. `intel_feed` returns all four so the client picks by
  -- locale, exactly as it picks a district's name. Advisories imported from a
  -- source document stay single-language: that text is a quotation, and there is
  -- nothing to translate it into.
  title         text not null,
  title_ur      text,
  summary       text not null,
  summary_ur    text,
  observed_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  constraint forecast_risks_expiry check (expires_at > risk_on::timestamptz),
  unique (rule_code, district_code, risk_on, issued_on)
);

create index forecast_risks_lookup_idx on public.forecast_risks (district_code, risk_on desc);
create index forecast_risks_crop_time_idx on public.forecast_risks (crop_code, risk_on desc);

comment on table public.forecast_risks is
  'Conditions the forecast says are likely to favour a problem. Every row is a *risk*: it is derived from a model rather than observed in a field, it is labelled as such wherever it is shown, and it can never be served as an outbreak.';

-- ---------------------------------------------------------------------------
-- The one rule this repository can justify
-- ---------------------------------------------------------------------------
--
-- Step 2 names "weather models say conditions suit a pest" as the third evidence
-- path, and this repository cannot honestly implement it yet. The published
-- knowledge set (migration 0019) states pest thresholds as *field* counts —
-- "a pheromone trap count that rises for two consecutive weeks", "the adult count
-- on the underside of a leaf crosses the economic threshold" — and neither is a
-- function of a forecast. Inventing a temperature or humidity number for pink
-- bollworm and labelling the output with an extension bulletin would attribute a
-- claim to a source that does not make it.
--
-- What the set does state, and a forecast can answer, is wind. The `spray-wind`
-- entry says to spray "when the wind is light and steady", that high wind causes
-- drift onto neighbouring fields, and that it is a legal and health risk. That is
-- a genuine forecast-derivable condition with a citation, so it is the rule that
-- ships — as a *proposal*, inactive, with the interpretation it requires written
-- down.
insert into public.forecast_risk_rules (
  code, crop_code, topic, metric, operator, threshold, unit,
  knowledge_entry_id, source_code, label_en, label_ur, threshold_basis, is_active
)
values (
  'spray-wind-too-strong',
  null,
  'weather_damage',
  'wind_kph',
  'gt',
  20,
  'km/h',
  (select id from public.agri_knowledge_entries where slug = 'spray-wind'),
  'weatherapi',
  'Wind is forecast above %s km/h, so spraying would drift onto neighbouring fields. It is a spray-conditions warning, not a forecast of damage.',
  'ہوا %s کلومیٹر فی گھنٹہ سے زیادہ رہنے کی پیش گوئی ہے، اس لیے سپرے پڑوسی کھیتوں میں جائے گا۔ یہ سپرے کے حالات کی تنبیہ ہے، نقصان کی پیش گوئی نہیں۔',
  'The cited entry says "light and steady" and that high wind causes drift; it states no number. 20 km/h is an interpretation, not a quote — which is exactly why this rule ships inactive and needs an agronomist''s sign-off (activate_forecast_risk_rule) before it can produce a row.',
  false
)
on conflict (code) do nothing;

comment on column public.forecast_risk_rules.threshold_basis is
  'What the number is and where it came from. For spray-wind-too-strong it records that the source states no number, so the value is visible as the interpretation it is.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.report_reviews enable row level security;
alter table public.forecast_risk_rules enable row level security;
alter table public.forecast_risks enable row level security;

-- Live risks are public, like every other row the feed serves.
create policy forecast_risks_read on public.forecast_risks
  for select to anon, authenticated
  using (expires_at > now());

-- The rules are published read-only: a threshold that silently changed is worse
-- than no threshold, so the wording and the number are visible to anyone.
create policy forecast_risk_rules_read on public.forecast_risk_rules
  for select to anon, authenticated
  using (true);

-- The review ledger is readable by the reviewer and by the report's own author.
-- A farmer may see who stood behind their report; that is the point of a record.
create policy report_reviews_read on public.report_reviews
  for select to authenticated
  using (
    reviewer_id = public.current_party_id()
    or report_id in (select r.id from public.crop_reports r where r.reporter_id = public.current_party_id())
    or public.has_capability('admin')
    or public.has_capability('moderator')
  );

revoke insert, update, delete on public.report_reviews from authenticated;
revoke insert, update, delete on public.forecast_risk_rules from authenticated;
revoke insert, update, delete on public.forecast_risks from authenticated;

-- ---------------------------------------------------------------------------
-- Who may review what
-- ---------------------------------------------------------------------------

-- The client asks this to decide whether to show a review surface at all. It
-- returns the *basis*, not a boolean, because "you are an expert but not for
-- cotton" is the state a review screen has to be able to explain.
create or replace function public.my_review_capability()
returns table (
  can_review    boolean,
  is_admin      boolean,
  is_expert     boolean,
  crop_codes    text[],
  verified_until timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_admin boolean := false;
  v_ver   public.expert_verifications;
begin
  if v_actor is null then
    return query select false, false, false, '{}'::text[], null::timestamptz;
    return;
  end if;

  v_admin := public.has_capability('admin');

  select * into v_ver
    from public.expert_verifications
   where party_id = v_actor
     and status = 'verified'
     and suspended_at is null
     and (expires_at is null or expires_at > now());

  -- An expert whose badge has lapsed keeps the capability row but is no longer a
  -- reviewer. The two are deliberately allowed to disagree, because the badge is
  -- the thing with an expiry date.
  return query select
    v_admin or found,
    v_admin,
    found,
    coalesce(v_ver.crop_codes, '{}'::text[]),
    v_ver.expires_at;
end;
$$;

comment on function public.my_review_capability() is
  'Whether the caller may review reports, and on what basis. An expert keeps the capability after a lapsed verification; the badge expiring is what stops the reviewing.';

-- ---------------------------------------------------------------------------
-- Confirming a report with expertise
-- ---------------------------------------------------------------------------

create or replace function public.verify_crop_report(
  p_report_id uuid,
  p_note      text default null
)
returns public.crop_reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report  public.crop_reports;
  v_actor   uuid := public.current_party_id();
  v_admin   boolean;
  v_ver     public.expert_verifications;
  v_basis   text;
begin
  if v_actor is null then
    raise exception 'Reviewing a report requires an identified account.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_report from public.crop_reports where id = p_report_id for update;
  if not found then
    raise exception 'Report % not found.', p_report_id using errcode = 'no_data_found';
  end if;

  v_admin := public.has_capability('admin');

  select * into v_ver
    from public.expert_verifications
   where party_id = v_actor
     and status = 'verified'
     and suspended_at is null
     and (expires_at is null or expires_at > now());

  if not (v_admin or found) then
    raise exception 'Confirming a field report requires verified expertise.' using errcode = 'insufficient_privilege';
  end if;
  v_basis := case when v_admin and not found then 'admin' else 'expert' end;

  -- An author cannot vouch for themselves. This is the rule that makes the
  -- column worth anything: a report confirmed by its own reporter is a farmer
  -- grading their own homework wearing an expert's badge.
  if v_report.reporter_id is not null and v_report.reporter_id = v_actor and not v_admin then
    raise exception 'You cannot confirm your own report.' using errcode = 'insufficient_privilege';
  end if;

  -- Competence, not seniority. An expert verified for wheat does not get to
  -- vouch for a cotton disease, and a report that names no crop can be confirmed
  -- by anyone verified. Admin is the final authority, so it is not constrained —
  -- and the row records that it acted as admin.
  if not v_admin and v_report.crop_code is not null
     and not (v_report.crop_code = any (coalesce(v_ver.crop_codes, '{}'::text[]))) then
    raise exception 'Your verification does not cover %. A report outside your crops needs an admin.', v_report.crop_code
      using errcode = 'insufficient_privilege';
  end if;

  if v_report.status <> 'published' then
    raise exception 'A % report cannot be confirmed.', v_report.status using errcode = 'check_violation';
  end if;
  if v_report.expires_at <= now() then
    raise exception 'This report has expired and is no longer served.' using errcode = 'check_violation';
  end if;

  -- Only from an unverified report. To change an expert confirmation into an
  -- official match the reviewer withdraws first, so both acts are on the record
  -- rather than the first being erased by the second.
  if v_report.evidence <> 'farmer_report' then
    if v_report.evidence = 'expert_verified' then
      raise exception 'This report is already confirmed. Withdraw the confirmation first to change it.' using errcode = 'check_violation';
    end if;
    raise exception 'This report is already recorded as %. Withdraw that first to change it.', v_report.evidence
      using errcode = 'check_violation';
  end if;

  update public.crop_reports
     set evidence     = 'expert_verified',
         reviewed_at  = now(),
         reviewed_by  = v_actor,
         review_note  = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_report_id
  returning * into v_report;

  insert into public.report_reviews (
    report_id, reviewer_id, reviewer_basis, action, from_evidence, to_evidence, note
  ) values (
    p_report_id, v_actor, v_basis, 'confirm_expert', 'farmer_report', 'expert_verified',
    nullif(btrim(coalesce(p_note, '')), '')
  );

  perform public.write_audit(
    'intel.report_confirmed', 'crop_reports', p_report_id, null,
    'farmer_report', 'expert_verified',
    jsonb_build_object('basis', v_basis, 'crop_code', v_report.crop_code),
    v_actor, v_basis
  );

  return v_report;
end;
$$;

comment on function public.verify_crop_report(uuid, text) is
  'Raises a field report to expert_verified. Requires a live verification covering the report''s crop, refuses self-review, and records the act in report_reviews and the audit log.';

grant execute on function public.verify_crop_report(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Matching a report to an official advisory
-- ---------------------------------------------------------------------------

-- A match is a *claim about two rows*, so the function checks that the two rows
-- can be about the same thing before it ties them together: the advisory must be
-- live, its crop must be the report's crop or unset (an unset crop is an
-- everything advisory), and its topic must be the report's topic. Without that,
-- "official" would mean "an official document exists somewhere", which is how a
-- match becomes a decoration.
create or replace function public.match_report_to_advisory(
  p_report_id   uuid,
  p_advisory_id uuid,
  p_note        text default null
)
returns public.crop_reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report   public.crop_reports;
  v_advisory public.agri_advisories;
  v_actor    uuid := public.current_party_id();
  v_basis    text;
begin
  if v_actor is null then
    raise exception 'Reviewing a report requires an identified account.' using errcode = 'insufficient_privilege';
  end if;

  if not public.has_capability('admin') then
    if not exists (
      select 1 from public.expert_verifications ev
       where ev.party_id = v_actor
         and ev.status = 'verified'
         and ev.suspended_at is null
         and (ev.expires_at is null or ev.expires_at > now())
    ) then
      raise exception 'Matching an advisory requires verified expertise or admin.' using errcode = 'insufficient_privilege';
    end if;
    v_basis := 'expert';
  else
    v_basis := 'admin';
  end if;

  select * into v_report from public.crop_reports where id = p_report_id for update;
  if not found then
    raise exception 'Report % not found.', p_report_id using errcode = 'no_data_found';
  end if;

  select * into v_advisory from public.agri_advisories where id = p_advisory_id;
  if not found then
    raise exception 'Advisory % not found.', p_advisory_id using errcode = 'no_data_found';
  end if;

  -- A report that is not being served cannot be matched to anything: the match
  -- would be recorded against a row no farmer will ever see.
  if v_report.status <> 'published' then
    raise exception 'A % report cannot be matched to an advisory.', v_report.status using errcode = 'check_violation';
  end if;
  if v_report.expires_at <= now() then
    raise exception 'This report has expired and is no longer served.' using errcode = 'check_violation';
  end if;

  if v_report.evidence <> 'farmer_report' then
    raise exception 'This report is already recorded as %. Withdraw that first to match an advisory.', v_report.evidence
      using errcode = 'check_violation';
  end if;

  if not v_advisory.is_active then
    raise exception 'That advisory is no longer active.' using errcode = 'check_violation';
  end if;
  if v_advisory.published_at > now() then
    raise exception 'That advisory is not published yet.' using errcode = 'check_violation';
  end if;
  if v_advisory.valid_until is not null and v_advisory.valid_until <= now() then
    raise exception 'That advisory has expired.' using errcode = 'check_violation';
  end if;

  if v_advisory.topic <> v_report.topic then
    raise exception 'The advisory is about % and the report is about %; they do not match.', v_advisory.topic, v_report.topic
      using errcode = 'check_violation';
  end if;
  if v_advisory.crop_code is not null and v_advisory.crop_code is distinct from v_report.crop_code then
    raise exception 'The advisory names % and the report names %; they do not match.',
      v_advisory.crop_code, coalesce(v_report.crop_code, 'no crop')
      using errcode = 'check_violation';
  end if;

  update public.crop_reports
     set evidence             = 'official_advisory',
         matched_advisory_id  = p_advisory_id,
         reviewed_at          = now(),
         reviewed_by          = v_actor,
         review_note          = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_report_id
  returning * into v_report;

  insert into public.report_reviews (
    report_id, reviewer_id, reviewer_basis, action, from_evidence, to_evidence, advisory_id, note
  ) values (
    p_report_id, v_actor, v_basis, 'match_official', 'farmer_report', 'official_advisory', p_advisory_id,
    nullif(btrim(coalesce(p_note, '')), '')
  );

  perform public.write_audit(
    'intel.report_matched', 'crop_reports', p_report_id, null,
    'farmer_report', 'official_advisory',
    jsonb_build_object('advisory_id', p_advisory_id, 'basis', v_basis, 'advisory_source', v_advisory.source_url),
    v_actor, v_basis
  );

  return v_report;
end;
$$;

comment on function public.match_report_to_advisory(uuid, uuid, text) is
  'Records that a field report matches a live official advisory on crop and topic, and stores the advisory id so the claim points at the document.';

grant execute on function public.match_report_to_advisory(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Withdrawing a verification
-- ---------------------------------------------------------------------------

-- A wrong call has to be correctable, and the correction has to be as visible as
-- the call. Withdrawal returns the report to `farmer_report` — it does not
-- delete it, and it does not delete the review that promoted it.
create or replace function public.withdraw_report_verification(
  p_report_id uuid,
  p_reason    text
)
returns public.crop_reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.crop_reports;
  v_actor  uuid := public.current_party_id();
  v_basis  text;
  -- Read before the update: the UPDATE nulls the column and RETURNING then
  -- overwrites v_report, so the ledger row would otherwise always claim the
  -- withdrawal was of an expert confirmation.
  v_prev_evidence text;
begin
  if v_actor is null then
    raise exception 'Withdrawing a verification requires an identified account.' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Withdrawing a verification requires a reason.' using errcode = 'check_violation';
  end if;

  select * into v_report from public.crop_reports where id = p_report_id for update;
  if not found then
    raise exception 'Report % not found.', p_report_id using errcode = 'no_data_found';
  end if;

  if v_report.evidence = 'farmer_report' then
    raise exception 'This report has no verification to withdraw.' using errcode = 'check_violation';
  end if;
  if v_report.evidence = 'forecast_risk' then
    raise exception 'A forecast risk is not a verification and cannot be withdrawn this way.' using errcode = 'check_violation';
  end if;

  v_prev_evidence := v_report.evidence;

  -- The reviewer who made the call, or an admin. Nobody else.
  if public.has_capability('admin') then
    v_basis := 'admin';
  elsif v_report.reviewed_by = v_actor then
    v_basis := 'expert';
  else
    raise exception 'Only the reviewer who made this call, or an admin, can withdraw it.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.crop_reports
     set evidence            = 'farmer_report',
         reviewed_at         = now(),
         reviewed_by         = v_actor,
         review_note         = btrim(p_reason),
         matched_advisory_id = null
   where id = p_report_id
  returning * into v_report;

  insert into public.report_reviews (
    report_id, reviewer_id, reviewer_basis, action, from_evidence, to_evidence, note
  ) values (
    p_report_id, v_actor, v_basis, 'withdraw', v_prev_evidence,
    'farmer_report', btrim(p_reason)
  );

  perform public.write_audit(
    'intel.report_verification_withdrawn', 'crop_reports', p_report_id, null,
    null, 'farmer_report', jsonb_build_object('reason', btrim(p_reason), 'basis', v_basis),
    v_actor, v_basis
  );

  return v_report;
end;
$$;

comment on function public.withdraw_report_verification(uuid, text) is
  'Returns a reviewed report to farmer_report, with a reason. Only the original reviewer or an admin; the promotion stays in the ledger.';

grant execute on function public.withdraw_report_verification(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Activating a threshold
-- ---------------------------------------------------------------------------

-- Admin, a reason, and the act is recorded. This is the only way a rule can
-- start producing rows, and it is deliberately a person's decision rather than a
-- default: a threshold is agronomy, and this schema does not own agronomy.
create or replace function public.activate_forecast_risk_rule(
  p_code text,
  p_note text
)
returns public.forecast_risk_rules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule  public.forecast_risk_rules;
  v_actor uuid := public.current_party_id();
  v_entry public.agri_knowledge_entries;
begin
  if not public.has_capability('admin') then
    raise exception 'Activating a risk threshold requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Activating a threshold requires a note saying why it is right.' using errcode = 'check_violation';
  end if;

  select * into v_rule from public.forecast_risk_rules where code = p_code for update;
  if not found then
    raise exception 'Risk rule % not found.', p_code using errcode = 'no_data_found';
  end if;

  select * into v_entry from public.agri_knowledge_entries where id = v_rule.knowledge_entry_id;
  if not found or not v_entry.is_published then
    raise exception 'Rule % cites an entry that is missing or unpublished.', p_code using errcode = 'check_violation';
  end if;

  update public.forecast_risk_rules
     set is_active       = true,
         activated_at    = now(),
         activated_by    = v_actor,
         activation_note = btrim(p_note)
   where code = p_code
  returning * into v_rule;

  perform public.write_audit(
    'intel.risk_rule_activated', 'forecast_risk_rules', null, p_code,
    'inactive', 'active',
    jsonb_build_object('threshold', v_rule.threshold, 'metric', v_rule.metric, 'citation', v_entry.slug),
    v_actor, 'admin'
  );

  return v_rule;
end;
$$;

comment on function public.activate_forecast_risk_rule(text, text) is
  'Turns a threshold on, with a reason, as an admin. A rule with no citation cannot be activated — the knowledge entry it points at must exist and be published.';

grant execute on function public.activate_forecast_risk_rule(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Generating the risks
-- ---------------------------------------------------------------------------

-- Applies the active rules to the stored forecast. Runs over `climate_forecasts`,
-- which is already keyed by issue date, so the same day re-run is an upsert and a
-- new issue date adds beside yesterday's belief instead of rewriting it.
--
-- The expiry is the end of the day the risk is about: a spray warning for
-- Thursday is not intelligence on Friday, and leaving it in the feed would be
-- exactly the drift the evidence column exists to prevent.
create or replace function public.generate_forecast_risks(
  p_from date default current_date,
  p_to   date default current_date + 2
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer := 0;
  -- Read from the request's own claims rather than from auth.role(), whose
  -- presence depends on the auth schema the database was initialised with. This
  -- is the value PostgREST sets from the calling key: 'service_role' for the
  -- server key, 'authenticated'/'anon' for the client keys.
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role <> 'service_role' and not public.has_capability('admin') then
    raise exception 'Generating forecast risks requires the service role or admin.' using errcode = 'insufficient_privilege';
  end if;

  with rule_metric as (
    select
      r.code, r.crop_code, r.topic, r.metric, r.operator, r.threshold, r.unit,
      r.label_en, r.label_ur, r.knowledge_entry_id, r.source_code,
      f.provider_code, f.district_code, f.forecast_on, f.issued_on,
      case r.metric
        when 'tmax_c'       then f.tmax_c
        when 'tmin_c'       then f.tmin_c
        when 'precip_mm'    then f.precip_mm
        when 'humidity_pct' then f.humidity_pct
        when 'wind_kph'     then f.wind_kph
      end as observed
    from public.forecast_risk_rules r
    join public.climate_forecasts f on true
    where r.is_active
      and f.forecast_on between p_from and p_to
  ),
  fired as (
    select *
    from rule_metric
    where observed is not null
      and case operator
        when 'gt'  then observed >  threshold
        when 'gte' then observed >= threshold
        when 'lt'  then observed <  threshold
        when 'lte' then observed <= threshold
      end
  ),
  written as (
    insert into public.forecast_risks (
      rule_code, provider_code, district_code, crop_code, topic, risk_on, issued_on,
      metric, operator, threshold, observed_value, basis, title, title_ur, summary, summary_ur, expires_at
    )
    select
      code, provider_code, district_code, crop_code, topic, forecast_on, issued_on,
      metric, operator, threshold, observed,
      jsonb_build_object('metric', metric, 'observed', observed, 'threshold', threshold,
                         'unit', unit, 'source_row', 'climate_forecasts'),
      -- `%s` becomes the measurement, `%s` becomes the day. The label is written
      -- by the person who set the threshold, so the wording and the number come
      -- from the same decision.
      format(label_en, round(observed, 1), forecast_on),
      format(label_ur, round(observed, 1), forecast_on),
      format('%s Published guidance: %s Risk, not an outbreak: this is what the forecast suggests, not what has been seen in a field.',
             unit, (select title_en from public.agri_knowledge_entries e where e.id = knowledge_entry_id)),
      format('%s شائع شدہ رہنمائی: %s خطرہ، وبا نہیں: یہ پیش گوئی ہے، کھیت میں دیکھی گئی چیز نہیں۔',
             unit, (select title_ur from public.agri_knowledge_entries e where e.id = knowledge_entry_id)),
      (forecast_on + 1)::timestamptz
    from fired
    on conflict (rule_code, district_code, risk_on, issued_on) do update
      set observed_value = excluded.observed_value,
          basis          = excluded.basis,
          title          = excluded.title,
          title_ur       = excluded.title_ur,
          summary        = excluded.summary,
          summary_ur     = excluded.summary_ur,
          expires_at     = excluded.expires_at,
          observed_at    = now()
    returning 1
  )
  select count(*) into v_written from written;

  return v_written;
end;
$$;

comment on function public.generate_forecast_risks(date, date) is
  'Applies every active rule to the stored forecast for a window and upserts the resulting risk rows. Idempotent per (rule, district, day, issue date). Every row it writes is a risk derived from a model, never an observation.';

grant execute on function public.generate_forecast_risks(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The queue a reviewer works from
-- ---------------------------------------------------------------------------

-- Newest unverified reports, nearest first when an origin is given, and never a
-- coordinate: the reviewer sees the same approximate area the feed shows, which
-- is what keeps the review path from becoming a way to read exact farm
-- locations out of the database.
create or replace function public.report_review_queue(
  p_lat      double precision default null,
  p_lon      double precision default null,
  p_radius_m double precision default 500000,
  p_limit    integer default 20
)
returns table (
  id           uuid,
  crop_code    text,
  topic        text,
  title        text,
  body         text,
  area_label   text,
  district     text,
  observed_at  timestamptz,
  photo_path   text,
  photo_mime   text,
  distance_m   double precision
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin extensions.geography;
  v_actor  uuid := public.current_party_id();
begin
  if v_actor is null then
    raise exception 'The review queue requires an identified account.' using errcode = 'insufficient_privilege';
  end if;
  if not (
    public.has_capability('admin')
    or exists (
      select 1 from public.expert_verifications ev
       where ev.party_id = v_actor and ev.status = 'verified' and ev.suspended_at is null
         and (ev.expires_at is null or ev.expires_at > now())
    )
  ) then
    raise exception 'The review queue requires verified expertise or admin.' using errcode = 'insufficient_privilege';
  end if;

  if p_lat is null or p_lon is null then
    return query
      select r.id, r.crop_code, r.topic, r.title, r.body, r.area_label, r.district,
             r.observed_at, r.photo_path, r.photo_mime, null::double precision
        from public.crop_reports r
       where r.evidence = 'farmer_report'
         and r.status = 'published'
         and r.expires_at > now()
       order by r.observed_at desc
       limit greatest(1, least(coalesce(p_limit, 20), 100));
    return;
  end if;

  if p_radius_m is null or p_radius_m < 1 or p_radius_m > 500000 then
    raise exception 'Radius must be between 1 and 500000 metres.' using errcode = 'check_violation';
  end if;

  v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;

  return query
    select r.id, r.crop_code, r.topic, r.title, r.body, r.area_label, r.district,
           r.observed_at, r.photo_path, r.photo_mime,
           extensions.ST_Distance(r.geog, v_origin)
      from public.crop_reports r
     where r.evidence = 'farmer_report'
       and r.status = 'published'
       and r.expires_at > now()
       and extensions.ST_DWithin(r.geog, v_origin, p_radius_m)
     order by extensions.ST_Distance(r.geog, v_origin), r.observed_at desc
     limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.report_review_queue(double precision, double precision, double precision, integer) is
  'Unverified reports for a reviewer to work, nearest first when an origin is given. Returns area_label and distance, never coordinates.';

grant execute on function public.report_review_queue(double precision, double precision, double precision, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- The feed, with risks
-- ---------------------------------------------------------------------------
--
-- Redefined to carry the third kind, and to carry the Urdu wording a risk is
-- written in. A risk is district-scope like an advisory and is served on one of
-- two grounds: the origin's nearest district is the risk's district, or the
-- origin is inside the radius of the district headquarters the risk was computed
-- for. Being strict here is what stops a Layyah spray warning appearing in
-- Rajanpur.
--
-- Dropped rather than replaced: the return type gains two columns, and
-- `create or replace` cannot change a function's result row.
drop function if exists public.intel_feed(
  double precision, double precision, double precision, text, text, integer
);

create or replace function public.intel_feed(
  p_lat double precision,
  p_lon double precision,
  p_radius_m double precision default 10000,
  p_crop_code text default null,
  p_topic text default null,
  p_limit integer default 20
)
returns table (
  id uuid,
  kind text,
  title text,
  summary text,
  crop_code text,
  topic text,
  evidence text,
  area_label text,
  district text,
  observed_at timestamptz,
  valid_until timestamptz,
  distance_m double precision,
  source_code text,
  title_ur text,
  summary_ur text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin extensions.geography;
begin
  if p_lat is null or p_lat < -90 or p_lat > 90 or p_lon is null or p_lon < -180 or p_lon > 180 then
    raise exception 'Invalid origin: lat/lon required.' using errcode = 'check_violation';
  end if;
  if p_radius_m is null or p_radius_m < 1 or p_radius_m > 500000 then
    raise exception 'Radius must be between 1 and 500000 metres.' using errcode = 'check_violation';
  end if;

  v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;

  return query
  with nearest_district as (
    select d.code
      from public.districts d
     where d.is_active
     order by extensions.ST_Distance(
       extensions.ST_SetSRID(extensions.ST_MakePoint(d.hq_lon, d.hq_lat), 4326)::extensions.geography,
       v_origin
     )
     limit 1
  ),
  reports as (
    select
      r.id, 'report'::text as kind, r.title, r.body as summary, r.crop_code, r.topic,
      r.evidence, r.area_label, r.district, r.observed_at, r.expires_at as valid_until,
      extensions.ST_Distance(r.geog, v_origin) as distance_m, r.source_code, r.cluster_id,
      r.observed_at as sort_at, null::text as title_ur, null::text as summary_ur,
      row_number() over (
        partition by coalesce(r.cluster_id, r.id)
        order by case when r.evidence = 'expert_verified' then 0 else 1 end, r.observed_at desc, r.id
      ) as dup_rank
    from public.crop_reports r
    where r.status = 'published'
      and r.visibility = 'public'
      and r.observed_at <= now()
      and r.expires_at > now()
      and (p_crop_code is null or r.crop_code = p_crop_code or r.crop_code is null)
      and (p_topic is null or r.topic = p_topic)
      and extensions.ST_DWithin(r.geog, v_origin, p_radius_m)
  ),
  advisories as (
    select
      a.id, 'advisory'::text as kind, a.title, a.summary, a.crop_code, a.topic,
      'official_advisory'::text as evidence, a.area_label, a.district, a.published_at as observed_at,
      a.valid_until, null::double precision as distance_m, a.source_code, null::uuid as cluster_id,
      a.published_at as sort_at, null::text as title_ur, null::text as summary_ur, 1 as dup_rank
    from public.agri_advisories a
    where a.is_active
      and a.published_at <= now()
      and (a.valid_until is null or a.valid_until > now())
      and (p_crop_code is null or a.crop_code = p_crop_code or a.crop_code is null)
      and (p_topic is null or a.topic = p_topic)
      and (a.geog is null or extensions.ST_DWithin(a.geog, v_origin, p_radius_m))
  ),
  risks as (
    select
      k.id, 'risk'::text as kind, k.title,
      k.summary, k.crop_code, k.topic,
      'forecast_risk'::text as evidence,
      d.name_en as area_label, d.name_en as district,
      k.observed_at, k.expires_at as valid_until,
      extensions.ST_Distance(
        extensions.ST_SetSRID(extensions.ST_MakePoint(d.hq_lon, d.hq_lat), 4326)::extensions.geography,
        v_origin
      ) as distance_m,
      'weatherapi'::text as source_code, null::uuid as cluster_id,
      k.observed_at as sort_at, k.title_ur, k.summary_ur, 1 as dup_rank
    from public.forecast_risks k
    join public.districts d on d.code = k.district_code
    where k.expires_at > now()
      and (k.crop_code is null or p_crop_code is null or k.crop_code = p_crop_code)
      and (p_topic is null or k.topic = p_topic)
      and (
        k.district_code = (select code from nearest_district)
        or extensions.ST_DWithin(
          extensions.ST_SetSRID(extensions.ST_MakePoint(d.hq_lon, d.hq_lat), 4326)::extensions.geography,
          v_origin, p_radius_m
        )
      )
  )
  select c.id, c.kind, c.title, c.summary, c.crop_code, c.topic, c.evidence,
         c.area_label, c.district, c.observed_at, c.valid_until, c.distance_m, c.source_code,
         c.title_ur, c.summary_ur
  from (select * from reports where dup_rank = 1 union all select * from advisories union all select * from risks) c
  order by c.sort_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.intel_feed(double precision, double precision, double precision, text, text, integer) is
  'Dynamic-radius local intelligence: reports (radius-gated), advisories (regional fallback) and forecast risks (nearest district or radius). Returns the evidence on every row and no coordinates at all. title_ur/summary_ur are null for a row whose source text is a quotation rather than authored wording.';

-- A read model the guest may use, granted explicitly rather than left to the
-- CREATE FUNCTION default: for a `security definer` function, EXECUTE to PUBLIC
-- is a standing invitation, and re-creating the function above silently reset it.
revoke all on function public.intel_feed(double precision, double precision, double precision, text, text, integer) from public;
grant execute on function public.intel_feed(double precision, double precision, double precision, text, text, integer) to anon, authenticated, service_role;

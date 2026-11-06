-- Farmer App · migration 0036 · Phase 1 intelligence foundation
--
-- One place where "what this farmer cares about" is decided, so every future
-- surface — home feed, AI answers, product/dealer ranking, notifications — reads
-- the same state instead of growing its own scoring.
--
-- What already existed and is reused rather than duplicated:
--   · farmer_profiles        — identity + default location
--   · crop_instances/facts    — confirmed farming context (facts cannot hold guesses)
--   · crop_inferences         — hypotheses, promoted only by a human act
--   · behaviour_signals       — raw behaviour, with source/strength/decay
--   · signal_weight()         — the existing decay curve
--   · recommendations         — the single canonical advice object
--
-- What this migration adds:
--   · farmer_intelligence_profiles — a small, derived snapshot per farmer
--   · farmer_interests             — explicit and learned interests, one row per topic
--   · farmer_preferences           — explicit farmer choices (opaque, versioned values)
--   · intelligence_config          — versioned weights, readable by the app
--   · intelligence_rules           — declarative personalization rules (matcher v1)
--   · intelligence_feedback        — the learning signal, idempotent per action
--   · record_behaviour_event()     — the only intake, owner derived from the session
--   · farmer_intelligence_context()— one context object for UI, AI and scoring
--   · intelligence_recommendation_feed() — transparent scored ranking
--
-- Deliberate limits:
--   · No free text is accepted from clients into behaviour rows; subjects are
--     slugs. A search query can contain a name, a phone number or a field
--     boundary, and none of that belongs in an analytics table.
--   · Weight, confidence and score are always 0..1 so they compose.
--   · Nothing here writes to crop_facts. Behaviour reorders relevance; it never
--     becomes a confirmed fact.

-- ---------------------------------------------------------------------------
-- Derived profile snapshot
-- ---------------------------------------------------------------------------
create table public.farmer_intelligence_profiles (
  farmer_id          uuid primary key references public.farmer_profiles (party_id) on delete cascade,
  primary_crop_code  text references public.crop_catalog (code),
  district           text,
  language           text not null default 'en' check (language in ('en', 'ur')),
  engagement_level   text not null default 'new'
                     check (engagement_level in ('new', 'exploring', 'engaged', 'dormant')),
  interest_summary   jsonb not null default '{}'::jsonb,
  signals_count      integer not null default 0 check (signals_count >= 0),
  computed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger farmer_intelligence_profiles_touch
  before update on public.farmer_intelligence_profiles
  for each row execute function public.touch_updated_at();

comment on table public.farmer_intelligence_profiles is
  'A derived snapshot, never the source of truth. Interests and behaviour live in their own tables; this row exists so a screen can read one small object instead of joining the history.';

-- ---------------------------------------------------------------------------
-- Interests: explicit, learned, or corrected by feedback
-- ---------------------------------------------------------------------------
create table public.farmer_interests (
  id            uuid primary key default gen_random_uuid(),
  farmer_id     uuid not null references public.farmer_profiles (party_id) on delete cascade,
  -- Namespaced slug: crop:wheat, product:urea, topic:pest. Keeps every future
  -- interest type in one namespace without a new table per kind.
  topic         text not null check (topic ~ '^[a-z]+:[a-z0-9_-]{1,60}$'),
  crop_code     text references public.crop_catalog (code),
  weight        numeric not null default 0.3 check (weight >= 0 and weight <= 1),
  confidence    numeric not null default 0.3 check (confidence >= 0 and confidence <= 1),
  source        text not null default 'behaviour'
                check (source in ('explicit', 'behaviour', 'feedback', 'system')),
  -- An explicit interest is never silently overwritten by learning.
  pinned        boolean not null default false,
  dismissed_at  timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (farmer_id, topic)
);

create index farmer_interests_live_idx
  on public.farmer_interests (farmer_id, weight desc)
  where dismissed_at is null;

create trigger farmer_interests_touch
  before update on public.farmer_interests
  for each row execute function public.touch_updated_at();

comment on table public.farmer_interests is
  'One row per farmer per topic. source=explicit and pinned rows are protected from learning; feedback may lower a learned weight but never rewrites a stated preference.';

-- ---------------------------------------------------------------------------
-- Explicit preferences (farmer-controlled algorithm settings)
-- ---------------------------------------------------------------------------
create table public.farmer_preferences (
  farmer_id  uuid not null references public.farmer_profiles (party_id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_.]{1,40}$'),
  -- Small, versioned value. Examples: {"topics":["pest","water"]} or false.
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (farmer_id, key),
  constraint farmer_preferences_small check (octet_length(value::text) <= 2048)
);

create trigger farmer_preferences_touch
  before update on public.farmer_preferences
  for each row execute function public.touch_updated_at();

comment on table public.farmer_preferences is
  'Explicit farmer choices. Learning may not write here: this table is what the farmer said, and the settings screen is its only author.';

-- ---------------------------------------------------------------------------
-- Configuration: one versioned row per knob
-- ---------------------------------------------------------------------------
create table public.intelligence_config (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  value       jsonb not null,
  version     integer not null default 1 check (version > 0),
  description text not null,
  updated_at  timestamptz not null default now()
);

comment on table public.intelligence_config is
  'Weights and limits for scoring, versioned so a change can be explained. Readable by the app; written only by a migration or the service role.';

insert into public.intelligence_config (key, value, description) values
  ('decay_half_life_days', '30'::jsonb,
   'Half-life used when turning behaviour into an interest weight.'),
  ('confidence_weight', '0.2'::jsonb,
   'Share of a recommendation score contributed by the recommendation confidence.'),
  ('interest_weight', '0.5'::jsonb,
   'Multiplier applied to a matching interest weight.'),
  ('max_interest_boost', '0.25'::jsonb,
   'Ceiling on the total interest contribution, so one enthusiasm cannot dominate the feed.'),
  ('negative_feedback_penalty', '0.15'::jsonb,
   'Penalty per not-relevant/dismissed verdict inside the penalty window.'),
  ('negative_penalty_cap', '0.45'::jsonb,
   'Ceiling on negative feedback penalty for one recommendation.'),
  ('negative_window_days', '30'::jsonb,
   'How long a negative verdict keeps affecting a recommendation.'),
  ('scoring_version', '1'::jsonb,
   'Which scoring formula produced a score. Bump when the formula changes.');

-- ---------------------------------------------------------------------------
-- Rules: declarative, evaluated by matcher v1
-- ---------------------------------------------------------------------------
create table public.intelligence_rules (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z][a-z0-9_]{1,60}$'),
  description text not null,
  scope       text not null default 'recommendation'
              check (scope in ('recommendation', 'feed', 'interest')),
  -- Matcher v1 understands {"match":"primary_crop"} and {"match":"interest"}.
  -- Unknown conditions are stored but contribute nothing; they are never
  -- guessed at, and scoring stays explainable.
  condition   jsonb not null default '{}'::jsonb,
  weight      numeric not null default 0 check (weight >= -1 and weight <= 1),
  priority    integer not null default 100,
  is_active   boolean not null default true,
  version     integer not null default 1 check (version > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger intelligence_rules_touch
  before update on public.intelligence_rules
  for each row execute function public.touch_updated_at();

comment on table public.intelligence_rules is
  'Personalization rules as data. The matcher is code, the weights are configuration, and an unknown condition is inert rather than interpreted.';

insert into public.intelligence_rules (code, description, scope, condition, weight, priority) values
  ('primary_crop_match', 'Boost advice about the farmer''s main crop.', 'recommendation',
   '{"match":"primary_crop"}'::jsonb, 0.15, 10),
  ('interest_topic_match', 'Boost advice whose kind matches a live interest.', 'recommendation',
   '{"match":"interest"}'::jsonb, 0.2, 20),
  ('explicit_preference_boost', 'Boost topics the farmer explicitly asked for.', 'recommendation',
   '{"match":"preference"}'::jsonb, 0.1, 30),
  ('negative_feedback_penalty', 'Lower advice the farmer marked not relevant.', 'recommendation',
   '{"match":"negative_feedback"}'::jsonb, -1, 40);

-- ---------------------------------------------------------------------------
-- Extend the existing behaviour log, additively
-- ---------------------------------------------------------------------------
alter table public.behaviour_signals
  add column event_key   text,
  add column session_id  text,
  add column occurred_at timestamptz,
  add column context     jsonb not null default '{}'::jsonb;

-- Idempotency: one accepted event per key per farmer. A retried flush after a
-- timeout therefore records once, not twice.
create unique index behaviour_signals_event_key_idx
  on public.behaviour_signals (farmer_id, event_key)
  where event_key is not null;

create index behaviour_signals_occurred_idx
  on public.behaviour_signals (farmer_id, occurred_at desc)
  where occurred_at is not null;

comment on column public.behaviour_signals.event_key is
  'Client-generated idempotency key. Optional for historical rows; new intake requires one.';
comment on column public.behaviour_signals.occurred_at is
  'When the farmer acted, from the device clock. observed_at remains the server arrival time; the two are never conflated.';
comment on column public.behaviour_signals.context is
  'Coarse slugs only (screen, crop, stage, topic). No free text, no contact details, no exact coordinates.';

-- ---------------------------------------------------------------------------
-- Feedback: the learning signal
-- ---------------------------------------------------------------------------
create table public.intelligence_feedback (
  id                uuid primary key default gen_random_uuid(),
  farmer_id         uuid not null references public.farmer_profiles (party_id) on delete cascade,
  recommendation_id uuid references public.recommendations (id) on delete cascade,
  insight_ref       text,
  verdict           text not null
                    check (verdict in ('helpful', 'not_relevant', 'acted', 'dismissed', 'saved')),
  reason            text check (reason is null or length(btrim(reason)) <= 280),
  context           jsonb not null default '{}'::jsonb,
  idempotency_key   text,
  created_at        timestamptz not null default now(),
  constraint intelligence_feedback_context_small check (octet_length(context::text) <= 2048)
);

create unique index intelligence_feedback_idempotency_idx
  on public.intelligence_feedback (farmer_id, idempotency_key)
  where idempotency_key is not null;

create index intelligence_feedback_farmer_idx
  on public.intelligence_feedback (farmer_id, created_at desc);

comment on table public.intelligence_feedback is
  'A farmer''s verdict on one piece of advice. Feedback is evidence for ranking, never a rewrite of the advice itself.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.farmer_intelligence_profiles enable row level security;
alter table public.farmer_interests enable row level security;
alter table public.farmer_preferences enable row level security;
alter table public.intelligence_config enable row level security;
alter table public.intelligence_rules enable row level security;
alter table public.intelligence_feedback enable row level security;

create policy farmer_intelligence_profiles_own on public.farmer_intelligence_profiles
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy farmer_interests_own on public.farmer_interests
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy farmer_preferences_own on public.farmer_preferences
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy intelligence_feedback_own on public.intelligence_feedback
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy intelligence_config_read on public.intelligence_config
  for select to authenticated using (true);

create policy intelligence_rules_read on public.intelligence_rules
  for select to authenticated using (is_active);

-- Writes are RPC-only. A client that could set its own interest weight could
-- rank its own feed, which is the one thing this layer must not allow.
revoke insert, update, delete on public.farmer_intelligence_profiles from authenticated;
revoke insert, update, delete on public.farmer_interests from authenticated;
revoke insert, update, delete on public.farmer_preferences from authenticated;
revoke insert, update, delete on public.intelligence_config from authenticated;
revoke insert, update, delete on public.intelligence_rules from authenticated;
revoke insert, update, delete on public.intelligence_feedback from authenticated;

-- ---------------------------------------------------------------------------
-- Intake: the only route for behaviour
-- ---------------------------------------------------------------------------
create or replace function public.record_behaviour_event(
  p_event_key    text,
  p_signal_type  text,
  p_source       text,
  p_subject      text default null,
  p_crop_id      uuid default null,
  p_crop_code    text default null,
  p_strength     public.signal_strength default 'moderate',
  p_weight_hint  numeric default null,
  p_context      jsonb default '{}'::jsonb,
  p_occurred_at  timestamptz default now(),
  p_session_id   text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer  uuid := public.current_farmer_id();
  v_key     text;
  v_id      bigint;
  v_types   constant text[] := array[
    'screen_view','search','product_view','dealer_view','insight_open','insight_act',
    'insight_dismiss','scan_start','scan_result','chat_open','community_read',
    'notification_open','preference_set','feedback'
  ];
begin
  if v_farmer is null then
    raise exception 'Behaviour is recorded for an identified farmer only.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_signal_type is null or not (p_signal_type = any (v_types)) then
    raise exception 'Unknown signal type: %', coalesce(p_signal_type, '(null)')
      using errcode = 'check_violation';
  end if;

  if p_source is null or p_source not in
     ('ui_interaction','search','scan','chat','community_read','notification_open') then
    raise exception 'Unknown signal source: %', coalesce(p_source, '(null)')
      using errcode = 'check_violation';
  end if;

  if p_context is not null and octet_length(p_context::text) > 2048 then
    raise exception 'Behaviour context is too large; send slugs, not documents.'
      using errcode = 'check_violation';
  end if;

  if p_occurred_at < now() - interval '90 days' or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'Event time is outside the accepted window.'
      using errcode = 'check_violation';
  end if;

  v_key := nullif(btrim(p_event_key), '');
  if v_key is null or length(v_key) > 100 then
    raise exception 'An event key of at most 100 characters is required.'
      using errcode = 'check_violation';
  end if;

  -- A client may name a subject only as a slug. Free text is refused here rather
  -- than cleaned later: a query can carry a name or a phone number.
  if p_subject is not null and p_subject !~ '^[a-z0-9][a-z0-9:_-]{0,79}$' then
    raise exception 'Subject must be a lowercase slug.'
      using errcode = 'check_violation';
  end if;

  if p_weight_hint is not null and (p_weight_hint < 0 or p_weight_hint > 1) then
    raise exception 'Weight hint must be between 0 and 1.' using errcode = 'check_violation';
  end if;

  insert into public.behaviour_signals (
    farmer_id, signal_type, crop_id, crop_code, subject, strength, source,
    weight_hint, detail, observed_at, event_key, session_id, occurred_at, context
  ) values (
    v_farmer, p_signal_type, p_crop_id, p_crop_code, p_subject, p_strength, p_source,
    p_weight_hint, '{}'::jsonb, now(), v_key,
    nullif(btrim(p_session_id), ''), p_occurred_at, coalesce(p_context, '{}'::jsonb)
  )
  on conflict (farmer_id, event_key) where event_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.behaviour_signals
     where farmer_id = v_farmer and event_key = v_key;
  end if;

  return v_id;
end;
$$;

comment on function public.record_behaviour_event(text, text, text, text, uuid, text, public.signal_strength, numeric, jsonb, timestamptz, text) is
  'The only behaviour intake. Owner comes from the session, never the body; keys make retries idempotent; subjects are slugs and context is size-capped.';

-- ---------------------------------------------------------------------------
-- Explicit interest (farmer-controlled)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_farmer_interest(
  p_topic     text,
  p_weight    numeric default 0.7,
  p_crop_code text default null,
  p_pinned    boolean default true
)
returns public.farmer_interests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_row    public.farmer_interests;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if p_topic is null or p_topic !~ '^[a-z]+:[a-z0-9_-]{1,60}$' then
    raise exception 'Interest topic must be a namespaced slug.' using errcode = 'check_violation';
  end if;

  insert into public.farmer_interests (farmer_id, topic, crop_code, weight, confidence, source, pinned)
  values (v_farmer, p_topic, p_crop_code, least(1, greatest(0, coalesce(p_weight, 0.7))), 1, 'explicit', coalesce(p_pinned, true))
  on conflict (farmer_id, topic) do update
    set weight      = least(1, greatest(0, coalesce(p_weight, 0.7))),
        crop_code   = coalesce(excluded.crop_code, public.farmer_interests.crop_code),
        source      = 'explicit',
        confidence  = 1,
        pinned      = coalesce(p_pinned, true),
        dismissed_at = null,
        updated_at  = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.upsert_farmer_interest(text, numeric, text, boolean) is
  'An explicit interest. Learning may not overwrite it while pinned; unpinning is how a farmer lets the algorithm take over again.';

-- ---------------------------------------------------------------------------
-- Feedback intake + immediate interest adjustment
-- ---------------------------------------------------------------------------
create or replace function public.record_intelligence_feedback(
  p_idempotency_key  text,
  p_verdict          text,
  p_recommendation_id uuid default null,
  p_insight_ref      text default null,
  p_reason           text default null,
  p_context          jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer   uuid := public.current_farmer_id();
  v_id       uuid;
  v_crop     uuid;
  v_crop_code text;
  v_kind     text;
  v_topic    text;
  v_delta    numeric;
  v_source   text;
begin
  if v_farmer is null then
    raise exception 'Feedback requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  if p_verdict is null or p_verdict not in ('helpful','not_relevant','acted','dismissed','saved') then
    raise exception 'Unknown feedback verdict.' using errcode = 'check_violation';
  end if;

  if p_context is not null and octet_length(p_context::text) > 2048 then
    raise exception 'Feedback context is too large.' using errcode = 'check_violation';
  end if;

  if p_recommendation_id is not null then
    select r.crop_id, r.kind into v_crop, v_kind
      from public.recommendations r
     where r.id = p_recommendation_id and r.farmer_id = v_farmer;
    if not found then
      raise exception 'That recommendation does not belong to this farmer.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  insert into public.intelligence_feedback (
    farmer_id, recommendation_id, insight_ref, verdict, reason, context, idempotency_key
  ) values (
    v_farmer, p_recommendation_id, nullif(btrim(p_insight_ref), ''), p_verdict,
    nullif(btrim(p_reason), ''), coalesce(p_context, '{}'::jsonb),
    nullif(btrim(p_idempotency_key), '')
  )
  on conflict (farmer_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.intelligence_feedback
     where farmer_id = v_farmer
       and idempotency_key = nullif(btrim(p_idempotency_key), '');
    return v_id;
  end if;

  -- Turn the verdict into a small, clamped interest movement. Positive verdicts
  -- raise the topic; negative ones lower a *learned* weight and leave an explicit
  -- preference alone.
  if p_verdict in ('helpful','acted','saved') then
    v_delta := 0.15; v_source := 'feedback';
  else
    v_delta := -0.15; v_source := 'feedback';
  end if;

  if v_crop is not null then
    select ci.crop_code into v_crop_code from public.crop_instances ci where ci.id = v_crop;
  end if;

  v_topic := case
    when v_crop_code is not null then 'crop:' || v_crop_code
    when v_kind is not null then 'topic:' || v_kind
    else null
  end;

  if v_topic is not null then
    insert into public.farmer_interests (farmer_id, topic, crop_code, weight, confidence, source)
    values (v_farmer, v_topic, v_crop_code, least(1, greatest(0, 0.3 + v_delta)), 0.4, v_source)
    on conflict (farmer_id, topic) do update
      set weight = case
            when public.farmer_interests.pinned
              or public.farmer_interests.source = 'explicit'
            then public.farmer_interests.weight
            else least(1, greatest(0, public.farmer_interests.weight + v_delta))
          end,
          last_seen_at = now(),
          updated_at   = now();
  end if;

  perform public.write_audit(
    'intelligence.feedback', 'intelligence_feedback', v_id, null, null, p_verdict,
    jsonb_build_object('recommendation_id', p_recommendation_id, 'topic', v_topic)
  );

  return v_id;
end;
$$;

comment on function public.record_intelligence_feedback(text, text, uuid, text, text, jsonb) is
  'Records one verdict idempotently and applies a clamped interest movement. Explicit/pinned interests are never moved by feedback.';

-- ---------------------------------------------------------------------------
-- Learning: behaviour → interests, decayed by the existing signal_weight()
-- ---------------------------------------------------------------------------
create or replace function public.refresh_farmer_interests(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer    uuid;
  v_halflife numeric;
  v_count     integer := 0;
  v_since     timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 365)));
begin
  select coalesce((value #>> '{}')::numeric, 30)
    into v_halflife
    from public.intelligence_config where key = 'decay_half_life_days';

  v_halflife := coalesce(v_halflife, 30);

  for v_farmer in
    select distinct s.farmer_id
      from public.behaviour_signals s
     where s.occurred_at is not null
       and coalesce(s.occurred_at, s.observed_at) > v_since
  loop
    insert into public.farmer_interests (farmer_id, topic, crop_code, weight, confidence, source, last_seen_at)
    select
      v_farmer,
      t.topic,
      max(t.crop_code),
      sum(t.w) / (1 + sum(t.w)),
      least(1, sum(t.w) / 3),
      'behaviour',
      now()
    from (
      select
        case
          when s.subject is not null and s.subject like '%:%' then s.subject
          when s.subject is not null then 'topic:' || s.subject
          else 'crop:' || s.crop_code
        end as topic,
        s.crop_code,
        coalesce(s.weight_hint, 1.0)
          * public.signal_weight(coalesce(s.occurred_at, s.observed_at), s.strength)
          * exp(-ln(2) * extract(epoch from (now() - coalesce(s.occurred_at, s.observed_at))) / 86400 / v_halflife) as w
      from public.behaviour_signals s
      where s.farmer_id = v_farmer
        and coalesce(s.occurred_at, s.observed_at) > v_since
        and (s.subject is not null or s.crop_code is not null)
    ) t
    where t.topic ~ '^[a-z]+:[a-z0-9_-]{1,60}$'
    group by t.topic
    on conflict (farmer_id, topic) do update
      set weight      = case
                          when public.farmer_interests.pinned
                            or public.farmer_interests.source = 'explicit'
                          then public.farmer_interests.weight
                          else excluded.weight
                        end,
          confidence  = excluded.confidence,
          source      = case
                          when public.farmer_interests.pinned
                            or public.farmer_interests.source = 'explicit'
                          then public.farmer_interests.source
                          else 'behaviour'
                        end,
          last_seen_at = now(),
          updated_at   = now()
      where public.farmer_interests.dismissed_at is null;

    insert into public.farmer_intelligence_profiles (
      farmer_id, signals_count, engagement_level, computed_at, interest_summary
    )
    select
      v_farmer,
      count(*),
      case
        when max(coalesce(s.occurred_at, s.observed_at)) < now() - interval '30 days' then 'dormant'
        when count(*) < 5 then 'exploring'
        else 'engaged'
      end,
      now(),
      coalesce((
        select jsonb_object_agg(i.topic, round(i.weight, 3))
          from public.farmer_interests i
         where i.farmer_id = v_farmer and i.dismissed_at is null
      ), '{}'::jsonb)
    from public.behaviour_signals s
    where s.farmer_id = v_farmer
    on conflict (farmer_id) do update
      set signals_count    = excluded.signals_count,
          engagement_level = excluded.engagement_level,
          computed_at      = excluded.computed_at,
          interest_summary = excluded.interest_summary,
          updated_at       = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.refresh_farmer_interests(integer) is
  'Derives interest weights from decayed behaviour and refreshes the snapshot. Explicit and pinned interests keep their weight; dismissed topics are not resurrected.';

-- ---------------------------------------------------------------------------
-- Context: one object for UI, AI and scoring
-- ---------------------------------------------------------------------------
create or replace function public.farmer_intelligence_context(p_farmer_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := coalesce(p_farmer_id, public.current_farmer_id());
  v_profile public.farmer_intelligence_profiles;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if p_farmer_id is not null
     and p_farmer_id <> public.current_farmer_id()
     and not public.has_capability('admin') then
    raise exception 'A farmer may read only their own context.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_profile from public.farmer_intelligence_profiles where farmer_id = v_farmer;

  return jsonb_build_object(
    'farmer_id', v_farmer,
    'language', coalesce(
      (select value #>> '{}' from public.farmer_preferences where farmer_id = v_farmer and key = 'language'),
      v_profile.language,
      'en'
    ),
    'district', v_profile.district,
    'engagement_level', coalesce(v_profile.engagement_level, 'new'),
    'primary_crop', (
      select jsonb_build_object('crop_id', ci.id, 'crop_code', ci.crop_code, 'stage', ci.stage)
        from public.crop_instances ci
       where ci.farmer_id = v_farmer and ci.is_primary and ci.closed_at is null
       limit 1
    ),
    'crops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'crop_id', ci.id, 'crop_code', ci.crop_code, 'stage', ci.stage, 'primary', ci.is_primary
      ) order by ci.is_primary desc, ci.created_at)
        from public.crop_instances ci
       where ci.farmer_id = v_farmer and ci.closed_at is null
    ), '[]'::jsonb),
    'location', (
      select jsonb_build_object('label', fp.default_location_label, 'area_id', fp.default_area_id)
        from public.farmer_profiles fp where fp.party_id = v_farmer
    ),
    'interests', coalesce((
      select jsonb_agg(jsonb_build_object('topic', i.topic, 'weight', round(i.weight, 3))
                       order by i.weight desc)
        from (
          select topic, weight from public.farmer_interests
           where farmer_id = v_farmer and dismissed_at is null
           order by weight desc limit 10
        ) i
    ), '[]'::jsonb),
    'preferences', coalesce((
      select jsonb_object_agg(p.key, p.value)
        from public.farmer_preferences p where p.farmer_id = v_farmer
    ), '{}'::jsonb),
    'recent_signals', (
      select count(*) from public.behaviour_signals s
       where s.farmer_id = v_farmer
         and coalesce(s.occurred_at, s.observed_at) > now() - interval '30 days'
    ),
    'scoring_version', coalesce(
      (select (value #>> '{}')::integer from public.intelligence_config where key = 'scoring_version'),
      1
    )
  );
end;
$$;

comment on function public.farmer_intelligence_context(uuid) is
  'The shared context object: crops, main crop, location label, top interests, preferences and signal counts. Never coordinates or contact details.';

-- ---------------------------------------------------------------------------
-- Ranked feed: transparent scoring over the canonical recommendation rows
-- ---------------------------------------------------------------------------
create or replace function public.intelligence_recommendation_feed(p_limit integer default 20)
returns table (
  recommendation_id uuid,
  crop_id           uuid,
  kind              text,
  title             text,
  body              text,
  source            public.recommendation_source,
  confidence        numeric,
  priority          integer,
  score             numeric,
  components        jsonb,
  valid_until       timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with mine as (
    select public.current_farmer_id() as farmer_id
  ),
  cfg as (
    select
      coalesce(max(case when key = 'confidence_weight' then (value #>> '{}')::numeric end), 0.2) as confidence_weight,
      coalesce(max(case when key = 'interest_weight' then (value #>> '{}')::numeric end), 0.5) as interest_weight,
      coalesce(max(case when key = 'max_interest_boost' then (value #>> '{}')::numeric end), 0.25) as max_interest_boost,
      coalesce(max(case when key = 'negative_feedback_penalty' then (value #>> '{}')::numeric end), 0.15) as negative_feedback_penalty,
      coalesce(max(case when key = 'negative_penalty_cap' then (value #>> '{}')::numeric end), 0.45) as negative_penalty_cap,
      coalesce(max(case when key = 'negative_window_days' then (value #>> '{}')::integer end), 30) as negative_window_days
    from public.intelligence_config
  ),
  rule as (
    select code, weight from public.intelligence_rules where is_active
  ),
  live as (
    select r.id, r.crop_id, r.kind, r.title, r.body, r.source, r.confidence,
           r.priority, r.valid_until, r.created_at,
           coalesce(ci.is_primary, false) as is_primary,
           ci.crop_code
      from public.recommendations r
      left join public.crop_instances ci on ci.id = r.crop_id
     where r.farmer_id = (select farmer_id from mine)
       and r.withdrawn_at is null
       and (r.valid_until is null or r.valid_until > now())
  ),
  interest as (
    select coalesce(sum(i.weight), 0) as weight
      from public.farmer_interests i
     where i.farmer_id = (select farmer_id from mine)
       and i.dismissed_at is null
  ),
  negative as (
    select f.recommendation_id, count(*)::numeric as n
      from public.intelligence_feedback f, cfg c
     where f.farmer_id = (select farmer_id from mine)
       and f.verdict in ('not_relevant', 'dismissed')
       and f.created_at > now() - make_interval(days => c.negative_window_days)
     group by f.recommendation_id
  ),
  scored as (
    select
      l.*,
      c.confidence_weight,
      c.interest_weight,
      c.max_interest_boost,
      c.negative_feedback_penalty,
      c.negative_penalty_cap,
      coalesce((select weight from rule where code = 'primary_crop_match'), 0) as primary_weight,
      coalesce((select weight from rule where code = 'negative_feedback_penalty'), -1) as negative_rule,
      coalesce(n.n, 0) as negative_count,
      -- The matching interest is the strongest live interest on this crop or kind.
      greatest(
        coalesce((select i.weight from public.farmer_interests i
                   where i.farmer_id = (select farmer_id from mine)
                     and i.dismissed_at is null
                     and i.topic = 'crop:' || coalesce(l.crop_code, '')
                   order by i.weight desc limit 1), 0),
        coalesce((select i.weight from public.farmer_interests i
                   where i.farmer_id = (select farmer_id from mine)
                     and i.dismissed_at is null
                     and i.topic = 'topic:' || l.kind
                   order by i.weight desc limit 1), 0)
      ) as matched_interest
    from live l
    cross join cfg c
    left join negative n on n.recommendation_id = l.id
  )
  select
    s.id,
    s.crop_id,
    s.kind,
    s.title,
    s.body,
    s.source,
    s.confidence,
    s.priority,
    round(greatest(0, least(1,
      ((100 - least(s.priority, 100))::numeric / 100) * 0.4
      + coalesce(s.confidence, 0.5) * s.confidence_weight
      + least(s.max_interest_boost, s.interest_weight * s.matched_interest)
      + case when s.is_primary then s.primary_weight else 0 end
      + case when s.negative_count > 0
             then -1 * least(s.negative_penalty_cap, s.negative_count * s.negative_feedback_penalty)
             else 0 end
    )), 4) as score,
    jsonb_build_object(
      'base_priority', round(((100 - least(s.priority, 100))::numeric / 100) * 0.4, 4),
      'confidence', round(coalesce(s.confidence, 0.5) * s.confidence_weight, 4),
      'interest', round(least(s.max_interest_boost, s.interest_weight * s.matched_interest), 4),
      'primary_crop', case when s.is_primary then s.primary_weight else 0 end,
      'negative_feedback', round(
        -1 * least(s.negative_penalty_cap, s.negative_count * s.negative_feedback_penalty), 4
      )
    ) as components,
    s.valid_until
  from scored s
  order by score desc, s.priority, s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

comment on function public.intelligence_recommendation_feed(integer) is
  'Ranks the existing canonical recommendations. Returns score components so a ranking can be explained; it never re-derives advice text and never invents rows.';

-- ---------------------------------------------------------------------------
-- Maintenance entrypoint
-- ---------------------------------------------------------------------------
create or replace function public.job_refresh_farmer_intelligence(p_days integer default 90)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.refresh_farmer_interests(p_days);
$$;

comment on function public.job_refresh_farmer_intelligence(integer) is
  'Scheduled wrapper so the learning step can be run by a cron job without granting the scheduler anything else.';

-- ---------------------------------------------------------------------------
-- Execution grants
-- ---------------------------------------------------------------------------
grant execute on function public.record_behaviour_event(text, text, text, text, uuid, text, public.signal_strength, numeric, jsonb, timestamptz, text) to authenticated;
grant execute on function public.upsert_farmer_interest(text, numeric, text, boolean) to authenticated;
grant execute on function public.record_intelligence_feedback(text, text, uuid, text, text, jsonb) to authenticated;
grant execute on function public.farmer_intelligence_context(uuid) to authenticated;
grant execute on function public.intelligence_recommendation_feed(integer) to authenticated;
revoke execute on function public.refresh_farmer_interests(integer) from public, authenticated, anon;
revoke execute on function public.job_refresh_farmer_intelligence(integer) from public, authenticated, anon;

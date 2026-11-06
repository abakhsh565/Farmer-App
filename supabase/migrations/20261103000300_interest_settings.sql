-- Phase 2B: farmer-facing interest settings.
--
-- The foundation exposed and wrote interests, but not in a shape a settings
-- screen could trust: the context omitted provenance and pin state, and there was
-- no operation that unpinned without also rewriting the learned weight. This
-- migration adds the missing read and mutation contract.
--
-- Semantics:
--   · pinned is the protection. An explicit unpinned interest keeps its
--     provenance (source = explicit) but its weight may learn again.
--   · pinning changes only pinned/updated_at; it never rewrites weight or source.
--   · removal is a soft dismissal; no interest row is deleted.
--   · every function derives the farmer from the session, never from a parameter.
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
  'Records one verdict idempotently and applies a clamped interest movement. Pinned interests are never moved; unpinned explicit interests keep their provenance but learn again.';

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
  'Derives interest weights from decayed behaviour and refreshes the snapshot. Pinned interests keep their weight; dismissed topics are not resurrected.';

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
      select jsonb_agg(jsonb_build_object(
        'topic', i.topic,
        'weight', round(i.weight, 3),
        'source', i.source,
        'pinned', i.pinned,
        'crop_code', i.crop_code
      ) order by i.pinned desc, i.weight desc)
        from (
          select topic, weight, source, pinned, crop_code from public.farmer_interests
           where farmer_id = v_farmer and dismissed_at is null
           order by pinned desc, weight desc limit 10
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
  'The shared context object: crops, main crop, location label, top interests with provenance and pin state, preferences and signal counts. Never coordinates or contact details.';

-- All non-dismissed interests, for the settings screen. The context deliberately
-- stays small (top 10) for the AI gateway; this read is the farmer's full list.
create or replace function public.farmer_interest_settings()
returns table (
  topic       text,
  crop_code   text,
  weight      numeric,
  confidence  numeric,
  source      text,
  pinned      boolean,
  updated_at  timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select i.topic, i.crop_code, i.weight, i.confidence, i.source, i.pinned, i.updated_at
    from public.farmer_interests i
   where i.farmer_id = public.current_farmer_id()
     and i.dismissed_at is null
   order by i.pinned desc, i.weight desc, i.topic;
$$;

comment on function public.farmer_interest_settings() is
  'The current farmer''s full interest list, including provenance and pin state. Own rows only; no weight arithmetic in the client.';

create or replace function public.set_farmer_interest_pin(
  p_topic  text,
  p_pinned boolean
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
  if p_pinned is null then
    raise exception 'A pin state is required.' using errcode = 'check_violation';
  end if;

  update public.farmer_interests
     set pinned = p_pinned,
         updated_at = now()
   where farmer_id = v_farmer
     and topic = p_topic
     and dismissed_at is null
  returning * into v_row;

  if not found then
    raise exception 'Interest not found.' using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

comment on function public.set_farmer_interest_pin(text, boolean) is
  'Pins or unpins one of the current farmer''s interests. Never rewrites weight or source; unpinning lets the algorithm learn again.';

create or replace function public.dismiss_farmer_interest(p_topic text)
returns boolean
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

  update public.farmer_interests
     set dismissed_at = now(),
         updated_at = now()
   where farmer_id = v_farmer
     and topic = p_topic
     and dismissed_at is null
  returning * into v_row;

  if not found then
    raise exception 'Interest not found.' using errcode = 'no_data_found';
  end if;

  return true;
end;
$$;

comment on function public.dismiss_farmer_interest(text) is
  'Soft-removes one of the current farmer''s interests. The row is retained for learning history; no delete is exposed.';

revoke execute on function public.farmer_interest_settings() from public, anon;
revoke execute on function public.set_farmer_interest_pin(text, boolean) from public, anon;
revoke execute on function public.dismiss_farmer_interest(text) from public, anon;

grant execute on function public.farmer_interest_settings() to authenticated;
grant execute on function public.set_farmer_interest_pin(text, boolean) to authenticated;
grant execute on function public.dismiss_farmer_interest(text) to authenticated;

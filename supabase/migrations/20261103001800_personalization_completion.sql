-- Phase 6 completion: explicit crop/topic personalization.
--
-- Phase 6A added recommendation-type muting. This migration closes the remaining
-- backend gap: a farmer can explicitly prioritise or suppress a crop or topic,
-- including a topic that has not appeared in learned behaviour yet.
--
-- Reused, not duplicated:
--   · farmer_interests is still the single interest store.
--   · source='explicit', pinned=true and dismissed_at are the existing state.
--   · intelligence_recommendation_feed() is still the one ranked feed.
--
-- Semantics:
--   · A prioritised crop/topic is source='explicit', pinned=true and has a
--     bounded weight (normal 0.65, high 1.00). Learning and feedback never move
--     a pinned weight. A clear removes the explicit row so ordinary learning can
--     take over again.
--   · A suppressed crop/topic is source='explicit', pinned=true, weight 0 and
--     dismissed_at set. The feed excludes matching recommendations, but the
--     canonical recommendation rows and their feedback history remain.
--   · The old dismiss RPC still removes a learned interest; for an explicit row
--     it now clears the explicit preference instead of leaving a suppression
--     behind. Suppression is therefore always an intentional, named operation.
--   · Alert categories remain governed by the separate `alerts` preference.
--     Suppression filters the recommendation feed, not alert delivery.

create or replace function public.farmer_interest_preferences()
returns table (
  topic       text,
  crop_code   text,
  weight      numeric,
  pinned      boolean,
  suppressed  boolean,
  updated_at  timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    i.topic,
    i.crop_code,
    i.weight,
    i.pinned,
    (i.dismissed_at is not null),
    i.updated_at
  from public.farmer_interests i
  where i.farmer_id = public.current_farmer_id()
    and i.source = 'explicit'
  order by (i.dismissed_at is not null), i.topic;
$$;

comment on function public.farmer_interest_preferences() is
  'The caller''s explicit crop/topic choices, including suppressed rows. Learned interests are intentionally excluded.';

create or replace function public.set_farmer_interest_preference(
  p_topic    text,
  p_priority text default 'normal'
)
returns public.farmer_interests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer    uuid := public.current_farmer_id();
  v_topic     text := lower(btrim(coalesce(p_topic, '')));
  v_priority  text := lower(btrim(coalesce(p_priority, 'normal')));
  v_crop_code text;
  v_weight    numeric;
  v_row       public.farmer_interests;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if v_topic !~ '^(crop|topic):[a-z0-9_-]{1,60}$' then
    raise exception 'Interest topic must be crop:<code> or topic:<slug>.'
      using errcode = 'check_violation';
  end if;

  if v_priority not in ('normal', 'high') then
    raise exception 'Interest priority must be normal or high.'
      using errcode = 'check_violation';
  end if;

  if v_topic like 'crop:%' then
    v_crop_code := split_part(v_topic, ':', 2);
    if not exists (
      select 1 from public.crop_catalog c
       where c.code = v_crop_code and c.is_active
    ) then
      raise exception 'Unknown or inactive crop.' using errcode = 'check_violation';
    end if;
  end if;

  v_weight := case when v_priority = 'high' then 1.00 else 0.65 end;

  insert into public.farmer_interests (
    farmer_id, topic, crop_code, weight, confidence, source, pinned, dismissed_at, last_seen_at
  ) values (
    v_farmer, v_topic, v_crop_code, v_weight, 1, 'explicit', true, null, now()
  )
  on conflict (farmer_id, topic) do update
    set crop_code    = excluded.crop_code,
        weight       = excluded.weight,
        confidence   = 1,
        source       = 'explicit',
        pinned       = true,
        dismissed_at = null,
        last_seen_at = now(),
        updated_at   = now()
  returning * into v_row;

  perform public.write_audit(
    'intelligence.interest_preference_set',
    'farmer_interests',
    v_row.id,
    v_topic,
    null,
    v_row::text,
    jsonb_build_object(
      'priority', v_priority,
      'crop_code', v_crop_code,
      'weight', v_weight
    )
  );

  return v_row;
end;
$$;

comment on function public.set_farmer_interest_preference(text, text) is
  'Creates or replaces an explicit crop/topic priority. Normal weight is 0.65, high is 1.00; both are pinned against learning.';

create or replace function public.suppress_farmer_interest(
  p_topic  text,
  p_reason text default null
)
returns public.farmer_interests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer    uuid := public.current_farmer_id();
  v_topic     text := lower(btrim(coalesce(p_topic, '')));
  v_reason    text := nullif(btrim(p_reason), '');
  v_crop_code text;
  v_row       public.farmer_interests;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if v_topic !~ '^(crop|topic):[a-z0-9_-]{1,60}$' then
    raise exception 'Interest topic must be crop:<code> or topic:<slug>.'
      using errcode = 'check_violation';
  end if;

  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'Suppression reason is too long.' using errcode = 'check_violation';
  end if;

  if v_topic like 'crop:%' then
    v_crop_code := split_part(v_topic, ':', 2);
    if not exists (
      select 1 from public.crop_catalog c
       where c.code = v_crop_code and c.is_active
    ) then
      raise exception 'Unknown or inactive crop.' using errcode = 'check_violation';
    end if;
  end if;

  insert into public.farmer_interests (
    farmer_id, topic, crop_code, weight, confidence, source, pinned, dismissed_at, last_seen_at
  ) values (
    v_farmer, v_topic, v_crop_code, 0, 1, 'explicit', true, now(), now()
  )
  on conflict (farmer_id, topic) do update
    set crop_code    = excluded.crop_code,
        weight       = 0,
        confidence   = 1,
        source       = 'explicit',
        pinned       = true,
        dismissed_at = now(),
        last_seen_at = now(),
        updated_at   = now()
  returning * into v_row;

  perform public.write_audit(
    'intelligence.interest_preference_suppressed',
    'farmer_interests',
    v_row.id,
    v_topic,
    null,
    v_row::text,
    jsonb_build_object('reason', v_reason, 'crop_code', v_crop_code)
  );

  return v_row;
end;
$$;

comment on function public.suppress_farmer_interest(text, text) is
  'Creates an explicit suppression for a crop or topic, even when no learned interest exists. The feed excludes matching recommendations.';

create or replace function public.clear_farmer_interest_preference(p_topic text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_topic  text := lower(btrim(coalesce(p_topic, '')));
  v_row    public.farmer_interests;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if v_topic !~ '^(crop|topic):[a-z0-9_-]{1,60}$' then
    raise exception 'Interest topic must be crop:<code> or topic:<slug>.'
      using errcode = 'check_violation';
  end if;

  delete from public.farmer_interests
   where farmer_id = v_farmer
     and topic = v_topic
     and source = 'explicit'
  returning * into v_row;

  if not found then
    return false;
  end if;

  perform public.write_audit(
    'intelligence.interest_preference_cleared',
    'farmer_interests',
    v_row.id,
    v_topic,
    v_row::text,
    null,
    jsonb_build_object('crop_code', v_row.crop_code)
  );

  return true;
end;
$$;

comment on function public.clear_farmer_interest_preference(text) is
  'Removes only the caller''s explicit crop/topic row, restoring ordinary learning. Idempotent: false when no explicit row exists.';

-- Existing farmers may have used the old removal RPC on an explicit row. Make
-- the meaning consistent: removing an explicit choice clears it; only the named
-- suppression RPC leaves a suppressing row.
create or replace function public.dismiss_farmer_interest(p_topic text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_topic  text := lower(btrim(coalesce(p_topic, '')));
  v_row    public.farmer_interests;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if v_topic !~ '^(crop|topic):[a-z0-9_-]{1,60}$' then
    raise exception 'Interest topic must be crop:<code> or topic:<slug>.'
      using errcode = 'check_violation';
  end if;

  select * into v_row
    from public.farmer_interests
   where farmer_id = v_farmer
     and topic = v_topic
     and dismissed_at is null
   for update;

  if not found then
    raise exception 'Interest not found.' using errcode = 'no_data_found';
  end if;

  if v_row.source = 'explicit' then
    delete from public.farmer_interests where id = v_row.id;

    perform public.write_audit(
      'intelligence.interest_preference_cleared',
      'farmer_interests',
      v_row.id,
      v_topic,
      v_row::text,
      null,
      jsonb_build_object('via', 'dismiss_farmer_interest')
    );
  else
    update public.farmer_interests
       set dismissed_at = now(),
           updated_at = now()
     where id = v_row.id;

    perform public.write_audit(
      'intelligence.interest_dismissed',
      'farmer_interests',
      v_row.id,
      v_topic,
      v_row::text,
      null,
      jsonb_build_object('via', 'dismiss_farmer_interest')
    );
  end if;

  return true;
end;
$$;

comment on function public.dismiss_farmer_interest(text) is
  'Removes a learned interest softly; clears an explicit preference outright so it cannot become an unintended suppression.';

create or replace function public.clear_farmer_recommendation_preferences()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_value  jsonb;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  delete from public.farmer_preferences
   where farmer_id = v_farmer
     and key = 'recommendations'
  returning value into v_value;

  if not found then
    return false;
  end if;

  perform public.write_audit(
    'intelligence.recommendation_preferences_cleared',
    'farmer_preferences',
    v_farmer,
    'recommendations',
    v_value::text,
    null,
    jsonb_build_object('cleared', true)
  );

  return true;
end;
$$;

comment on function public.clear_farmer_recommendation_preferences() is
  'Deletes the caller''s explicit recommendation-type row, restoring the all-types-enabled default. Idempotent.';

-- Extend the existing feed wrapper with crop/topic suppression. The internal
-- scorer remains unchanged; this is still a serving filter over canonical rows.
create or replace function public.intelligence_recommendation_feed(p_limit integer default 20)
returns table (
  recommendation_id uuid,
  crop_id           uuid,
  crop_code         text,
  kind              text,
  title             text,
  title_ur          text,
  body              text,
  body_ur           text,
  source            public.recommendation_source,
  source_label      text,
  source_url        text,
  evidence_tier     text,
  confidence        numeric,
  priority          integer,
  score             numeric,
  components        jsonb,
  reason_code       text,
  reason_context    jsonb,
  rule_version      integer,
  valid_until       timestamptz,
  created_at        timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select public.current_farmer_id() as farmer_id
  ),
  muted as (
    select coalesce(array_agg(distinct muted_value order by muted_value), '{}'::text[]) as kinds
      from public.farmer_preferences p
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(p.value->'muted_kinds') = 'array'
          then p.value->'muted_kinds'
          else '[]'::jsonb
        end
      ) muted_value
     where p.farmer_id = (select farmer_id from mine)
       and p.key = 'recommendations'
  ),
  suppressed as (
    select
      coalesce(array_agg(distinct split_part(i.topic, ':', 2))
        filter (where i.topic like 'crop:%'), '{}'::text[]) as crops,
      coalesce(array_agg(distinct split_part(i.topic, ':', 2))
        filter (where i.topic like 'topic:%'), '{}'::text[]) as topics
      from public.farmer_interests i
     where i.farmer_id = (select farmer_id from mine)
       and i.source = 'explicit'
       and i.dismissed_at is not null
  )
  select b.*
    from public.intelligence_recommendation_feed_base(50) b
   where b.kind <> all(coalesce((select kinds from muted), '{}'::text[]))
     and not (
       coalesce(b.crop_code, '') = any(
         coalesce((select crops from suppressed), '{}'::text[])
       )
       or coalesce(b.kind, '') = any(
         coalesce((select topics from suppressed), '{}'::text[])
       )
       or coalesce(b.reason_context->>'topic', '') = any(
         coalesce((select topics from suppressed), '{}'::text[])
       )
     )
   order by b.score desc, b.priority, b.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.intelligence_recommendation_feed(integer) is
  'Ranks canonical recommendations, then removes explicitly muted types and explicitly suppressed crops/topics. Missing preferences mean no filtering.';

revoke execute on function public.farmer_interest_preferences() from public, anon;
revoke execute on function public.set_farmer_interest_preference(text, text) from public, anon;
revoke execute on function public.suppress_farmer_interest(text, text) from public, anon;
revoke execute on function public.clear_farmer_interest_preference(text) from public, anon;
revoke execute on function public.clear_farmer_recommendation_preferences() from public, anon;

grant execute on function public.farmer_interest_preferences() to authenticated;
grant execute on function public.set_farmer_interest_preference(text, text) to authenticated;
grant execute on function public.suppress_farmer_interest(text, text) to authenticated;
grant execute on function public.clear_farmer_interest_preference(text) to authenticated;
grant execute on function public.clear_farmer_recommendation_preferences() to authenticated;

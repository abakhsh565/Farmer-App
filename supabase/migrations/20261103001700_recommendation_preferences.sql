-- Phase 6: farmer-controlled recommendation types.
--
-- The foundation already has `farmer_preferences` for explicit choices and a
-- single ranked recommendation feed. What was missing was a write/read contract
-- for recommendation types and any effect on the feed. This migration adds only
-- that: a bounded mute list, stored as `farmer_preferences.key = 'recommendations'`.
--
-- Deliberate limits:
--   · This is explicit state. Learning and feedback never write this row.
--   · The canonical recommendation rows are retained; muting is a serving
--     filter, so unmuting restores existing advice without regenerating it.
--   · Interests continue to control ranking. They are not copied into this
--     preference and this preference does not rewrite an interest weight.
--   · Alerts keep their existing separate `alerts` preference. Muting a
--     recommendation type does not silently change alert categories.

create or replace function public.farmer_recommendation_preferences()
returns table (
  muted_kinds text[],
  updated_at  timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with me as (
    select public.current_farmer_id() as farmer_id
  )
  select
    coalesce((
      select array_agg(muted_value order by muted_value)
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(p.value->'muted_kinds') = 'array'
            then p.value->'muted_kinds'
            else '[]'::jsonb
          end
        ) muted_value
    ), '{}'::text[]),
    p.updated_at
  from me
  left join public.farmer_preferences p
    on p.farmer_id = me.farmer_id
   and p.key = 'recommendations'
  where me.farmer_id is not null;
$$;

comment on function public.farmer_recommendation_preferences() is
  'The caller''s explicit recommendation-type mute list. An absent row means every type is enabled.';

create or replace function public.set_farmer_recommendation_preferences(
  p_muted_kinds text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_kinds  text[];
  v_value  jsonb;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if p_muted_kinds is null then
    raise exception 'A recommendation type list is required.' using errcode = 'check_violation';
  end if;

  if cardinality(p_muted_kinds) > 32 then
    raise exception 'Too many recommendation types.' using errcode = 'check_violation';
  end if;

  -- Only the kinds the existing producers actually emit are accepted. This
  -- keeps a typo from silently muting nothing.
  if exists (
    select 1
      from unnest(p_muted_kinds) muted_value
     where muted_value is null
        or muted_value <> btrim(muted_value)
        or muted_value not in (
          'pest', 'disease', 'weather', 'market', 'crop_stage', 'general'
        )
  ) then
    raise exception 'Unknown recommendation type.' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(distinct muted_value order by muted_value), '{}'::text[])
    into v_kinds
    from unnest(p_muted_kinds) muted_value;

  v_value := jsonb_build_object('muted_kinds', to_jsonb(v_kinds));

  insert into public.farmer_preferences (farmer_id, key, value)
  values (v_farmer, 'recommendations', v_value)
  on conflict (farmer_id, key) do update
    set value = excluded.value,
        updated_at = now();

  perform public.write_audit(
    'intelligence.recommendation_preferences_updated',
    'farmer_preferences',
    v_farmer,
    'recommendations',
    null,
    v_value::text,
    jsonb_build_object('muted_kinds', v_kinds)
  );

  return v_value;
end;
$$;

comment on function public.set_farmer_recommendation_preferences(text[]) is
  'Replaces the caller''s explicit recommendation-type mute list. The farmer is derived from the session; duplicate types are removed.';

-- The ranked feed remains the single scorer. Keep it as an internal base and
-- apply the explicit mute filter in a thin wrapper, so muting does not fork the
-- scoring engine or require copying its SQL.
alter function public.intelligence_recommendation_feed(integer)
  rename to intelligence_recommendation_feed_base;

comment on function public.intelligence_recommendation_feed_base(integer) is
  'Internal ranked feed. Apply the authenticated intelligence_recommendation_feed() wrapper so explicit type preferences are respected.';

revoke execute on function public.intelligence_recommendation_feed_base(integer)
  from public, anon, authenticated;
grant execute on function public.intelligence_recommendation_feed_base(integer)
  to service_role;

create function public.intelligence_recommendation_feed(p_limit integer default 20)
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
  )
  select b.*
    from public.intelligence_recommendation_feed_base(50) b
   where b.kind <> all(coalesce((select kinds from muted), '{}'::text[]))
   order by b.score desc, b.priority, b.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.intelligence_recommendation_feed(integer) is
  'Ranks canonical recommendations through the existing scorer, then removes the caller''s explicitly muted types. Missing preference means no filtering.';

revoke execute on function public.intelligence_recommendation_feed(integer)
  from public, anon;
grant execute on function public.intelligence_recommendation_feed(integer)
  to authenticated;

revoke execute on function public.farmer_recommendation_preferences()
  from public, anon;
revoke execute on function public.set_farmer_recommendation_preferences(text[])
  from public, anon;
grant execute on function public.farmer_recommendation_preferences()
  to authenticated;
grant execute on function public.set_farmer_recommendation_preferences(text[])
  to authenticated;

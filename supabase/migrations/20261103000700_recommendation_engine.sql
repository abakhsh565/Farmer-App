-- Phase 4 · Personalized recommendation engine
--
-- The foundation already had the canonical recommendation object and a scored
-- feed. This migration supplies the missing producer and the missing context
-- bridge:
--
--   * the app's local crop list is synchronized into the existing crop_instances;
--   * published, evidence-tiered knowledge becomes recommendation rows, with
--     English/Urdu copy, a traceable reason and source metadata;
--   * only verified and supplementary knowledge can become advice — community
--     observations are never promoted to authoritative guidance;
--   * the ranked feed adds stage, crop, regional, evidence, recency and feedback
--     components to the existing score, and suppresses dismissed/irrelevant rows;
--   * a per-farmer cooldown prevents every feed read from recomputing.
--
-- Nothing here duplicates recommendations, crops, knowledge or scoring. The
-- existing `recommendations`, `emit_recommendation()`, `crop_instances`,
-- `agri_knowledge_entries`, `intelligence_recommendation_feed()` and feedback
-- RPCs remain the one system.

-- ---------------------------------------------------------------------------
-- Metadata the canonical object needs to explain itself
-- ---------------------------------------------------------------------------
alter table public.recommendations
  add column title_ur      text,
  add column body_ur       text,
  add column action_label_ur text,
  add column evidence_tier text
    check (evidence_tier is null or evidence_tier in ('verified', 'supplementary', 'community')),
  add column source_url    text
    check (source_url is null or source_url ~ '^https://'),
  add column reason_code   text,
  add column reason_context jsonb not null default '{}'::jsonb,
  add column rule_version  integer;

comment on column public.recommendations.evidence_tier is
  'The published knowledge tier behind this advice. Community rows are not eligible for generation.';
comment on column public.recommendations.reason_code is
  'Why this row was generated, as a stable code for the UI to translate.';
comment on column public.recommendations.reason_context is
  'Bounded slugs (crop, stage, topic, region) supporting the reason. No farmer identity or free text.';
comment on column public.recommendations.rule_version is
  'Generator/scoring version at emission time, so an old recommendation is explainable.';

-- `app_synced` lets the app replace its own crop context without closing crops
-- created by an agronomist, dealer or import.
alter table public.crop_instances
  add column app_synced boolean not null default false;

create index crop_instances_app_synced_idx
  on public.crop_instances (farmer_id, crop_code)
  where app_synced and closed_at is null;

comment on column public.crop_instances.app_synced is
  'True when this open instance was synchronized from the farmer app. The sync RPC closes only its own stale rows.';

alter table public.farmer_intelligence_profiles
  add column recommendations_refreshed_at timestamptz;

comment on column public.farmer_intelligence_profiles.recommendations_refreshed_at is
  'Last time the recommendation producer ran for this farmer. Bounds repeated recomputation.';

-- ---------------------------------------------------------------------------
-- Tunables and rules
-- ---------------------------------------------------------------------------
insert into public.intelligence_config (key, value, description) values
  ('scoring_version', '2'::jsonb,
   'Version of the Phase 4 ranking formula.'),
  ('recommendation_rule_version', '1'::jsonb,
   'Version of the knowledge-to-recommendation generator.'),
  ('max_recommendations_per_farmer', '12'::jsonb,
   'Hard cap on generated live recommendations per farmer.'),
  ('recommendation_ttl_days', '21'::jsonb,
   'Default validity window for a generated knowledge recommendation.'),
  ('recommendation_refresh_minutes', '15'::jsonb,
   'Minimum time between authenticated feed refreshes for one farmer.'),
  ('helpful_feedback_boost', '0.05'::jsonb,
   'Ranking boost for each helpful verdict in the feedback window.'),
  ('helpful_boost_cap', '0.10'::jsonb,
   'Maximum helpful-feedback contribution to one recommendation.'),
  ('max_interest_boost', '0.25'::jsonb,
   'Ceiling on the total interest contribution, so one enthusiasm cannot dominate the feed.')
on conflict (key) do update
  set value = excluded.value,
      version = public.intelligence_config.version + 1,
      description = excluded.description,
      updated_at = now();

insert into public.intelligence_rules (code, description, scope, condition, weight, priority) values
  ('crop_stage_match', 'Boost advice whose stage rule matches the crop''s current stage.', 'recommendation',
   '{"match":"crop_stage"}'::jsonb, 0.10, 15),
  ('verified_source', 'Boost advice from a verified source over supplementary material.', 'recommendation',
   '{"match":"verified_source"}'::jsonb, 0.12, 25),
  ('helpful_feedback', 'Boost advice this farmer previously marked helpful.', 'recommendation',
   '{"match":"helpful_feedback"}'::jsonb, 0.05, 35)
on conflict (code) do update
  set description = excluded.description,
      scope = excluded.scope,
      condition = excluded.condition,
      weight = excluded.weight,
      priority = excluded.priority,
      is_active = true,
      version = public.intelligence_rules.version + 1,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Crop context synchronization
-- ---------------------------------------------------------------------------
-- The farmer app's crop document is local-first. This RPC is the one validated
-- bridge into the canonical server crop table, so recommendation generation sees
-- the same crops the farmer sees. It accepts only catalog codes and enum stages,
-- derives the owner from the JWT, and closes only rows it previously created.
create or replace function public.sync_my_crops(p_crops jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer         uuid := public.current_farmer_id();
  v_item           jsonb;
  v_code           text;
  v_stage_text     text;
  v_stage          public.crop_stage;
  v_primary        boolean;
  v_primary_code   text;
  v_current_primary text;
  v_id             uuid;
  v_row            public.crop_instances;
  v_codes          text[] := '{}'::text[];
  v_changed        boolean := false;
  v_count          integer := 0;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  if p_crops is null or jsonb_typeof(p_crops) <> 'array' then
    raise exception 'Crop context must be a JSON array.' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(p_crops) > 12 then
    raise exception 'At most 12 active crops may be synchronized.' using errcode = 'check_violation';
  end if;

  -- Stage corrections are validated by the existing trigger. The sync path gives
  -- it an explicit reason, so a correction is traceable to the app's update.
  perform set_config('app.stage_correction_reason', 'active crop list synchronized from the app', true);

  -- Capture this before the loop clears primary flags while updating rows. Reading
  -- it afterwards would always produce NULL and falsely invalidate the cache.
  select crop_code into v_current_primary
    from public.crop_instances
   where farmer_id = v_farmer
     and closed_at is null
     and is_primary
   limit 1;

  for v_item in select value from jsonb_array_elements(p_crops) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each crop must be an object.' using errcode = 'check_violation';
    end if;

    v_code := nullif(btrim(v_item->>'crop_code'), '');
    if v_code is null or v_code !~ '^[a-z][a-z0-9_]{1,40}$'
       or not exists (select 1 from public.crop_catalog c where c.code = v_code and c.is_active) then
      raise exception 'Unknown crop code: %', coalesce(v_code, '(null)') using errcode = 'check_violation';
    end if;

    if v_code = any (v_codes) then
      raise exception 'Crop % appears more than once in the context.', v_code using errcode = 'check_violation';
    end if;
    v_codes := array_append(v_codes, v_code);

    v_stage_text := coalesce(nullif(btrim(v_item->>'stage'), ''), 'planned');
    if v_stage_text not in
       ('planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested','failed') then
      raise exception 'Unknown crop stage: %', v_stage_text using errcode = 'check_violation';
    end if;
    v_stage := v_stage_text::public.crop_stage;

    v_primary := case
      when jsonb_typeof(v_item->'primary') = 'boolean' then (v_item->>'primary')::boolean
      else false
    end;
    if v_primary then
      if v_primary_code is not null then
        raise exception 'Only one crop may be primary.' using errcode = 'check_violation';
      end if;
      v_primary_code := v_code;
    end if;

    select * into v_row
      from public.crop_instances
     where farmer_id = v_farmer
       and crop_code = v_code
       and closed_at is null
     order by created_at, id
     limit 1;

    if found then
      if v_row.stage is distinct from v_stage or not v_row.app_synced then
        v_changed := true;
      end if;
      update public.crop_instances
         set stage = v_stage,
             app_synced = true,
             is_primary = false
       where id = v_row.id;
    else
      insert into public.crop_instances (farmer_id, crop_code, stage, is_primary, app_synced)
      values (v_farmer, v_code, v_stage, false, true)
      returning * into v_row;
      v_changed := true;
    end if;

    v_count := v_count + 1;
  end loop;

  -- Close only app-owned crops that disappeared from the local list. A crop
  -- entered by an agronomist/import is never closed by this path.
  if exists (
    select 1 from public.crop_instances c
     where c.farmer_id = v_farmer
       and c.app_synced
       and c.closed_at is null
       and not (c.crop_code = any (v_codes))
  ) then
    v_changed := true;
    update public.crop_instances
       set closed_at = now(), is_primary = false
     where farmer_id = v_farmer
       and app_synced
       and closed_at is null
       and not (crop_code = any (v_codes));
  end if;

  if v_primary_code is null and array_length(v_codes, 1) is not null then
    v_primary_code := v_codes[1];
  end if;

  if v_current_primary is distinct from v_primary_code then
    v_changed := true;
  end if;

  if array_length(v_codes, 1) is not null then
    update public.crop_instances
       set is_primary = false
     where farmer_id = v_farmer
       and closed_at is null
       and is_primary;

    update public.crop_instances
       set is_primary = true
     where farmer_id = v_farmer
       and crop_code = v_primary_code
       and closed_at is null;
  end if;

  insert into public.farmer_intelligence_profiles (
    farmer_id, primary_crop_code, recommendations_refreshed_at
  ) values (
    v_farmer, v_primary_code, null
  )
  on conflict (farmer_id) do update
    set primary_crop_code = excluded.primary_crop_code,
        recommendations_refreshed_at = case
          when v_changed then null
          else public.farmer_intelligence_profiles.recommendations_refreshed_at
        end,
        updated_at = now();

  return v_count;
end;
$$;

comment on function public.sync_my_crops(jsonb) is
  'Validated, JWT-owned synchronization of the app crop list into the canonical crop table. Closes only app-owned stale rows and can invalidate the recommendation cache.';

-- ---------------------------------------------------------------------------
-- Generator: published knowledge + live weather -> canonical recommendations
-- ---------------------------------------------------------------------------
create or replace function public.refresh_farmer_recommendations(p_farmer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ttl         integer := 21;
  v_rule        integer := 1;
  v_max         integer := 12;
  v_count       integer := 0;
  v_weather     record;
  v_weather_body text;
  v_weather_body_ur text;
begin
  if p_farmer_id is null then
    raise exception 'A farmer is required.' using errcode = 'invalid_parameter_value';
  end if;

  select coalesce((value #>> '{}')::integer, 21) into v_ttl
    from public.intelligence_config where key = 'recommendation_ttl_days';
  select coalesce((value #>> '{}')::integer, 1) into v_rule
    from public.intelligence_config where key = 'recommendation_rule_version';
  select coalesce((value #>> '{}')::integer, 12) into v_max
    from public.intelligence_config where key = 'max_recommendations_per_farmer';

  with crops as (
    select c.id, c.crop_code, c.stage, c.is_primary
      from public.crop_instances c
     where c.farmer_id = p_farmer_id
       and c.closed_at is null
  ),
  profile as (
    select f.district, f.primary_crop_code
      from public.farmer_intelligence_profiles f
     where f.farmer_id = p_farmer_id
  ),
  crop_matches as (
    select
      c.id as crop_id,
      c.crop_code,
      c.stage::text as stage,
      c.is_primary,
      e.id as entry_id,
      e.slug,
      e.version,
      e.title_en,
      e.title_ur,
      e.body_en,
      e.body_ur,
      e.topic,
      e.problem_type,
      e.evidence_tier,
      e.source_code,
      e.source_url,
      e.provenance,
      (e.applies_to_stages is not null and c.stage = any (e.applies_to_stages)) as stage_match,
      coalesce(i.weight, 0) as interest_weight,
      coalesce(i.pinned, false) as interest_pinned,
      (
        e.regions is null
        or cardinality(e.regions) = 0
        or 'Punjab' = any (e.regions)
        or exists (
          select 1 from profile p
           where p.district is not null and p.district = any (e.regions)
        )
      ) as region_match
    from crops c
    join public.agri_knowledge_entries e
      on e.crop_code = c.crop_code
     and e.is_published
     and e.evidence_tier in ('verified', 'supplementary')
     and (e.applies_to_stages is null or c.stage = any (e.applies_to_stages))
    left join lateral (
      select max(fi.weight) as weight, bool_or(fi.pinned) as pinned
        from public.farmer_interests fi
       where fi.farmer_id = p_farmer_id
         and fi.dismissed_at is null
         and (
           fi.topic = 'crop:' || c.crop_code
           or fi.topic = 'topic:' || e.topic
         )
    ) i on true
  ),
  general_matches as (
    select
      null::uuid as crop_id,
      null::text as crop_code,
      null::text as stage,
      false as is_primary,
      e.id as entry_id,
      e.slug,
      e.version,
      e.title_en,
      e.title_ur,
      e.body_en,
      e.body_ur,
      e.topic,
      e.problem_type,
      e.evidence_tier,
      e.source_code,
      e.source_url,
      e.provenance,
      false as stage_match,
      coalesce(i.weight, 0) as interest_weight,
      coalesce(i.pinned, false) as interest_pinned,
      (
        e.regions is null
        or cardinality(e.regions) = 0
        or 'Punjab' = any (e.regions)
        or exists (
          select 1 from profile p
           where p.district is not null and p.district = any (e.regions)
        )
      ) as region_match
    from public.agri_knowledge_entries e
    left join lateral (
      select max(fi.weight) as weight, bool_or(fi.pinned) as pinned
        from public.farmer_interests fi
       where fi.farmer_id = p_farmer_id
         and fi.dismissed_at is null
         and fi.topic = 'topic:' || e.topic
    ) i on true
    where e.crop_code is null
      and e.is_published
      and e.evidence_tier in ('verified', 'supplementary')
      and i.weight is not null
  ),
  matches as (
    select * from crop_matches
    union all
    select * from general_matches
  ),
  shaped as (
    select
      m.*,
      case
        when m.topic = 'pest' or m.problem_type = 'pest' then 'pest'
        when m.topic = 'disease' or m.problem_type = 'disease' then 'disease'
        when m.topic in ('weather', 'rain') then 'weather'
        when m.topic = 'market' then 'market'
        when m.topic in ('irrigation', 'water', 'nutrition', 'agronomy') then 'crop_stage'
        else 'general'
      end as kind,
      case
        when m.interest_pinned then 'pinned_interest'
        when m.stage_match then 'crop_stage'
        when m.crop_id is not null then 'crop'
        else 'interest'
      end as reason_code,
      case
        when m.evidence_tier = 'verified' then 0.95
        else 0.65
      end as confidence,
      case
        when m.evidence_tier = 'verified' then 10
        else 25
      end
      + case
          when m.topic in ('pest', 'disease') then 0
          when m.topic in ('irrigation', 'water', 'nutrition', 'agronomy') then 5
          else 15
        end as priority
    from matches m
  )
  insert into public.recommendations (
    farmer_id, crop_id, kind, title, title_ur, body, body_ur,
    action_label, action_label_ur, action_kind, action_ref,
    source, source_ref, source_label, source_url,
    confidence, knowledge_version, valid_until, priority, dedupe_key,
    evidence_tier, reason_code, reason_context, rule_version
  )
  select
    p_farmer_id,
    s.crop_id,
    s.kind,
    s.title_en,
    s.title_ur,
    s.body_en,
    s.body_ur,
    case s.kind
      when 'pest' then 'Scan the crop'
      when 'disease' then 'Scan the crop'
      when 'weather' then 'Check weather'
      else 'Open crop'
    end,
    case s.kind
      when 'pest' then 'فصل اسکین کریں'
      when 'disease' then 'فصل اسکین کریں'
      when 'weather' then 'موسم دیکھیں'
      else 'فصل کھولیں'
    end,
    case s.kind
      when 'pest' then 'open_scan'
      when 'disease' then 'open_scan'
      when 'weather' then 'open_weather'
      else 'open_crop'
    end,
    s.slug,
    'knowledge_base'::public.recommendation_source,
    s.slug,
    coalesce(src.publisher, src.name, s.provenance, 'Farmer App editorial notes'),
    coalesce(s.source_url, src.url),
    s.confidence,
    s.version,
    now() + make_interval(days => greatest(1, least(v_ttl, 90))),
    s.priority,
    'rec:knowledge:' || s.slug || ':v' || s.version || ':' || coalesce(s.crop_code, 'general'),
    s.evidence_tier,
    s.reason_code,
    jsonb_strip_nulls(jsonb_build_object(
      'crop_code', s.crop_code,
      'stage', s.stage,
      'topic', s.topic,
      'region_match', s.region_match
    )),
    v_rule
  from shaped s
  left join public.agri_knowledge_sources src on src.code = s.source_code
  order by s.priority, s.slug
  limit greatest(1, least(v_max, 30))
  on conflict (farmer_id, dedupe_key) where withdrawn_at is null do update
    set crop_id = excluded.crop_id,
        kind = excluded.kind,
        title = excluded.title,
        title_ur = excluded.title_ur,
        body = excluded.body,
        body_ur = excluded.body_ur,
        action_label = excluded.action_label,
        action_label_ur = excluded.action_label_ur,
        action_kind = excluded.action_kind,
        action_ref = excluded.action_ref,
        source_label = excluded.source_label,
        source_url = excluded.source_url,
        confidence = excluded.confidence,
        knowledge_version = excluded.knowledge_version,
        valid_until = excluded.valid_until,
        priority = excluded.priority,
        evidence_tier = excluded.evidence_tier,
        reason_code = excluded.reason_code,
        reason_context = excluded.reason_context,
        rule_version = excluded.rule_version;

  get diagnostics v_count = row_count;

  -- Weather advice is grounded in the existing, freshness-gated weather read.
  -- If there is no usable reading for the farmer's saved coordinates, no weather
  -- recommendation is invented.
  select w.* into v_weather
    from public.farmer_profiles fp
    cross join lateral public.latest_weather(fp.default_lat, fp.default_lon) w
   where fp.default_lat is not null
     and fp.default_lon is not null
     and fp.party_id = p_farmer_id
     and w.is_usable
   order by w.observed_at desc
   limit 1;

  if found and v_weather.is_usable then
    v_weather_body := concat_ws(
      ' ',
      'Current reading:',
      case when v_weather.temp_c is not null then round(v_weather.temp_c)::text || '°C.' else null end,
      case when v_weather.humidity_pct is not null then 'Humidity ' || v_weather.humidity_pct || '%.' else null end,
      case when v_weather.wind_kph is not null then 'Wind ' || round(v_weather.wind_kph)::text || ' km/h.' else null end,
      'Check the weather card before spraying or irrigating.'
    );
    v_weather_body_ur := concat_ws(
      ' ',
      'موجودہ پڑھائی:',
      case when v_weather.temp_c is not null then round(v_weather.temp_c)::text || ' ڈگری۔' else null end,
      case when v_weather.humidity_pct is not null then 'نمی ' || v_weather.humidity_pct || '٪۔' else null end,
      case when v_weather.wind_kph is not null then 'ہوا ' || round(v_weather.wind_kph)::text || ' کلومیٹر فی گھنٹہ۔' else null end,
      'سپرے یا آبپاشی سے پہلے موسم کا کارڈ دیکھیں۔'
    );

    insert into public.recommendations (
      farmer_id, kind, title, title_ur, body, body_ur, action_label, action_label_ur,
      action_kind, source, source_ref, source_label, confidence, valid_until, priority,
      dedupe_key, reason_code, reason_context, rule_version
    ) values (
      p_farmer_id,
      'weather',
      'Check the weather before field work',
      'کھیت کے کام سے پہلے موسم دیکھیں',
      v_weather_body,
      v_weather_body_ur,
      'Check weather',
      'موسم دیکھیں',
      'open_weather',
      'weather',
      'weather:' || v_weather.provider_code,
      v_weather.provider_name,
      0.85,
      now() + interval '6 hours',
      5,
      'rec:weather:' || v_weather.provider_code || ':' || to_char(v_weather.observed_at, 'YYYYMMDD'),
      'weather_now',
      jsonb_build_object('observed_at', v_weather.observed_at, 'freshness', v_weather.freshness),
      v_rule
    )
    on conflict (farmer_id, dedupe_key) where withdrawn_at is null do update
      set title = excluded.title,
          title_ur = excluded.title_ur,
          body = excluded.body,
          body_ur = excluded.body_ur,
          source_label = excluded.source_label,
          confidence = excluded.confidence,
          valid_until = excluded.valid_until,
          reason_context = excluded.reason_context,
          rule_version = excluded.rule_version;

    v_count := v_count + 1;
  end if;

  return v_count;
end;
$$;

comment on function public.refresh_farmer_recommendations(uuid) is
  'Generates canonical recommendations from published evidence-tiered knowledge and a fresh weather reading. It never creates community/unsourced advice and is service-role only.';

-- ---------------------------------------------------------------------------
-- Authenticated preparation: sync + bounded refresh
-- ---------------------------------------------------------------------------
create or replace function public.prepare_my_recommendations(p_crops jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer    uuid := public.current_farmer_id();
  v_minutes   integer := 15;
  v_last      timestamptz;
  v_count     integer := 0;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  perform public.sync_my_crops(p_crops);

  select coalesce((value #>> '{}')::integer, 15) into v_minutes
    from public.intelligence_config where key = 'recommendation_refresh_minutes';
  select recommendations_refreshed_at into v_last
    from public.farmer_intelligence_profiles
   where farmer_id = v_farmer;

  if v_last is not null and v_last > now() - make_interval(mins => greatest(1, least(v_minutes, 360))) then
    return 0;
  end if;

  v_count := public.refresh_farmer_recommendations(v_farmer);

  update public.farmer_intelligence_profiles
     set recommendations_refreshed_at = now()
   where farmer_id = v_farmer;

  return v_count;
end;
$$;

comment on function public.prepare_my_recommendations(jsonb) is
  'The authenticated feed preparation seam: syncs the caller''s crop list, then refreshes recommendations at most once per configured cooldown.';

-- Service-only batch wrapper for a scheduler. It is deliberately not granted to
-- clients; the authenticated path is prepare_my_recommendations().
create or replace function public.job_refresh_all_recommendations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid;
  v_count integer := 0;
  v_total integer := 0;
begin
  for v_farmer in
    select distinct f.party_id
      from public.farmer_profiles f
     where exists (select 1 from public.crop_instances c where c.farmer_id = f.party_id and c.closed_at is null)
        or exists (select 1 from public.farmer_interests i where i.farmer_id = f.party_id and i.dismissed_at is null)
  loop
    v_count := public.refresh_farmer_recommendations(v_farmer);
    v_total := v_total + v_count;
    update public.farmer_intelligence_profiles
       set recommendations_refreshed_at = now()
     where farmer_id = v_farmer;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ranked feed v2
-- ---------------------------------------------------------------------------
drop function if exists public.intelligence_recommendation_feed(integer);

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
  cfg as (
    select
      coalesce(max(case when key = 'confidence_weight' then (value #>> '{}')::numeric end), 0.15) as confidence_weight,
      coalesce(max(case when key = 'interest_weight' then (value #>> '{}')::numeric end), 0.5) as interest_weight,
      coalesce(max(case when key = 'max_interest_boost' then (value #>> '{}')::numeric end), 0.25) as max_interest_boost,
      coalesce(max(case when key = 'negative_feedback_penalty' then (value #>> '{}')::numeric end), 0.15) as negative_feedback_penalty,
      coalesce(max(case when key = 'negative_penalty_cap' then (value #>> '{}')::numeric end), 0.45) as negative_penalty_cap,
      coalesce(max(case when key = 'negative_window_days' then (value #>> '{}')::integer end), 30) as negative_window_days,
      coalesce(max(case when key = 'helpful_feedback_boost' then (value #>> '{}')::numeric end), 0.05) as helpful_feedback_boost,
      coalesce(max(case when key = 'helpful_boost_cap' then (value #>> '{}')::numeric end), 0.10) as helpful_boost_cap,
      coalesce(max(case when key = 'scoring_version' then (value #>> '{}')::integer end), 2) as scoring_version
    from public.intelligence_config
  ),
  rule as (
    select code, weight from public.intelligence_rules where is_active
  ),
  live as (
    select
      r.id, r.crop_id, ci.crop_code, r.kind, r.title, r.title_ur, r.body, r.body_ur,
      r.source, r.source_label, r.source_url, r.evidence_tier, r.confidence, r.priority,
      r.valid_until, r.created_at, r.dedupe_key, r.source_ref, r.reason_code, r.reason_context, r.rule_version,
      coalesce(ci.is_primary, false) as is_primary,
      coalesce((r.reason_context->>'region_match')::boolean, false) as region_match
    from public.recommendations r
    left join public.crop_instances ci on ci.id = r.crop_id
    where r.farmer_id = (select farmer_id from mine)
      and r.withdrawn_at is null
      and (r.valid_until is null or r.valid_until > now())
      and (r.crop_id is null or ci.closed_at is null)
      and not exists (
        select 1 from public.intelligence_feedback f
         where f.recommendation_id = r.id
           and f.farmer_id = (select farmer_id from mine)
           and f.verdict = 'dismissed'
           and f.created_at > now() - interval '90 days'
      )
      and (
        select count(*) from public.intelligence_feedback f, cfg c
         where f.recommendation_id = r.id
           and f.farmer_id = (select farmer_id from mine)
           and f.verdict = 'not_relevant'
           and f.created_at > now() - make_interval(days => c.negative_window_days)
      ) < 2
  ),
  negative as (
    select f.recommendation_id, count(*)::numeric as n
      from public.intelligence_feedback f, cfg c
     where f.farmer_id = (select farmer_id from mine)
       and f.verdict in ('not_relevant', 'dismissed')
       and f.created_at > now() - make_interval(days => c.negative_window_days)
     group by f.recommendation_id
  ),
  helpful as (
    select f.recommendation_id, count(*)::numeric as n
      from public.intelligence_feedback f, cfg c
     where f.farmer_id = (select farmer_id from mine)
       and f.verdict in ('helpful', 'acted', 'saved')
       and f.created_at > now() - make_interval(days => c.negative_window_days)
     group by f.recommendation_id
  ),
  scored as (
    select
      l.*,
      c.confidence_weight, c.interest_weight, c.max_interest_boost,
      c.negative_feedback_penalty, c.negative_penalty_cap,
      c.helpful_feedback_boost, c.helpful_boost_cap, c.scoring_version,
      coalesce((select weight from rule where code = 'primary_crop_match'), 0.10) as primary_weight,
      coalesce((select weight from rule where code = 'crop_stage_match'), 0.10) as stage_weight,
      coalesce((select weight from rule where code = 'verified_source'), 0.12) as verified_weight,
      coalesce(n.n, 0) as negative_count,
      coalesce(h.n, 0) as helpful_count,
      greatest(
        coalesce((
          select i.weight from public.farmer_interests i
           where i.farmer_id = (select farmer_id from mine)
             and i.dismissed_at is null
             and i.topic = 'crop:' || coalesce(l.crop_code, '')
           order by i.weight desc limit 1
        ), 0),
        coalesce((
          select i.weight from public.farmer_interests i
           where i.farmer_id = (select farmer_id from mine)
             and i.dismissed_at is null
             and i.topic = 'topic:' || l.kind
           order by i.weight desc limit 1
        ), 0),
        coalesce((
          select i.weight from public.farmer_interests i
           where i.farmer_id = (select farmer_id from mine)
             and i.dismissed_at is null
             and i.topic = 'topic:' || coalesce(l.reason_context->>'topic', '')
           order by i.weight desc limit 1
        ), 0)
      ) as matched_interest,
      exists (
        select 1 from public.farmer_interests i
         where i.farmer_id = (select farmer_id from mine)
           and i.dismissed_at is null
           and i.pinned
           and (
             i.topic = 'crop:' || coalesce(l.crop_code, '')
             or i.topic = 'topic:' || l.kind
             or i.topic = 'topic:' || coalesce(l.reason_context->>'topic', '')
           )
      ) as pinned_interest,
      case
        when l.evidence_tier = 'verified'
          then coalesce((select weight from rule where code = 'verified_source'), 0.12)
        when l.evidence_tier = 'supplementary'
          then coalesce((select weight from rule where code = 'verified_source'), 0.12) * 0.5
        when l.evidence_tier = 'community' then 0
        else coalesce((select weight from rule where code = 'verified_source'), 0.12) * 0.25
      end as evidence_boost
    from live l
    cross join cfg c
    left join negative n on n.recommendation_id = l.id
    left join helpful h on h.recommendation_id = l.id
  ),
  ranked as (
    select
      s.*,
      round(greatest(0, least(1,
        ((100 - least(s.priority, 100))::numeric / 100) * 0.20
        + coalesce(s.confidence, 0.5) * s.confidence_weight
        + least(s.max_interest_boost, s.interest_weight * s.matched_interest)
        + case when s.is_primary then s.primary_weight else 0 end
        + case when s.crop_id is not null then 0.08 else 0 end
        + case when s.reason_code = 'crop_stage' then s.stage_weight else 0 end
        + s.evidence_boost
        + case when s.region_match then 0.04 else 0 end
        + greatest(0, 1 - extract(epoch from (now() - s.created_at)) / 86400 / 14) * 0.04
        + case when s.pinned_interest then 0.08 else 0 end
        + least(s.helpful_boost_cap, s.helpful_count * s.helpful_feedback_boost)
        - least(s.negative_penalty_cap, s.negative_count * s.negative_feedback_penalty)
      )), 4) as score,
      jsonb_build_object(
        'base_priority', round(((100 - least(s.priority, 100))::numeric / 100) * 0.20, 4),
        'confidence', round(coalesce(s.confidence, 0.5) * s.confidence_weight, 4),
        'interest', round(least(s.max_interest_boost, s.interest_weight * s.matched_interest), 4),
        'primary_crop', case when s.is_primary then s.primary_weight else 0 end,
        'crop_match', case when s.crop_id is not null then 0.08 else 0 end,
        'stage_match', case when s.reason_code = 'crop_stage' then s.stage_weight else 0 end,
        'evidence', round(s.evidence_boost, 4),
        'region', case when s.region_match then 0.04 else 0 end,
        'recency', round(greatest(0, 1 - extract(epoch from (now() - s.created_at)) / 86400 / 14) * 0.04, 4),
        'pinned_interest', case when s.pinned_interest then 0.08 else 0 end,
        'helpful_feedback', round(least(s.helpful_boost_cap, s.helpful_count * s.helpful_feedback_boost), 4),
        'negative_feedback', round(-1 * least(s.negative_penalty_cap, s.negative_count * s.negative_feedback_penalty), 4),
        'matched_interest', round(s.matched_interest, 4),
        'rule_version', s.rule_version,
        'scoring_version', s.scoring_version
      ) as components,
      row_number() over (
        partition by coalesce(s.crop_id, s.id), coalesce(s.source_ref, s.dedupe_key)
        order by s.created_at desc
      ) as duplicate_rank
    from scored s
  )
  select
    r.id,
    r.crop_id,
    r.crop_code,
    r.kind,
    r.title,
    r.title_ur,
    r.body,
    r.body_ur,
    r.source,
    r.source_label,
    r.source_url,
    r.evidence_tier,
    r.confidence,
    r.priority,
    r.score,
    r.components,
    r.reason_code,
    r.reason_context,
    r.rule_version,
    r.valid_until,
    r.created_at
  from ranked r
  where r.duplicate_rank = 1
  order by r.score desc, r.priority, r.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.intelligence_recommendation_feed(integer) is
  'Ranks canonical recommendations with crop, stage, interest, evidence, region, recency and feedback components. Suppresses dismissed and repeatedly irrelevant rows; never invents advice.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.sync_my_crops(jsonb) from public, anon;
grant execute on function public.sync_my_crops(jsonb) to authenticated;

revoke execute on function public.prepare_my_recommendations(jsonb) from public, anon;
grant execute on function public.prepare_my_recommendations(jsonb) to authenticated;

revoke execute on function public.refresh_farmer_recommendations(uuid) from public, anon, authenticated;
grant execute on function public.refresh_farmer_recommendations(uuid) to service_role;

revoke execute on function public.job_refresh_all_recommendations() from public, anon, authenticated;
grant execute on function public.job_refresh_all_recommendations() to service_role;

revoke execute on function public.intelligence_recommendation_feed(integer) from public, anon;
grant execute on function public.intelligence_recommendation_feed(integer) to authenticated;

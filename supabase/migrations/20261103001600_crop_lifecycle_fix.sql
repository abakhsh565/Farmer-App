-- Phase 5.3 fix · stage-gated recommendation CTE
--
-- Migration 015 is already applied to staging with a column-order mismatch in
-- the crop_matches/general_matches UNION. This replaces the function with the
-- corrected definition. Fresh installs apply 015 and then this; both are safe.

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
  v_min_conf    numeric := 0.7;
begin
  if p_farmer_id is null then
    raise exception 'A farmer is required.' using errcode = 'invalid_parameter_value';
  end if;

  select coalesce((value #>> '{}')::integer, 21) into v_ttl
    from public.intelligence_config where key = 'recommendation_ttl_days';
  select coalesce((value #>> '{}')::integer, 1) into v_rule
    from public.intelligence_config where key = 'recommendation_rule_version';
  select coalesce((value #>> '{}')::numeric, 0.7) into v_min_conf
    from public.intelligence_config where key = 'stage_confidence_min_for_advice';
  select coalesce((value #>> '{}')::integer, 12) into v_max
    from public.intelligence_config where key = 'max_recommendations_per_farmer';

  with crops as (
    select c.id, c.crop_code, c.stage, c.is_primary, c.stage_source, c.stage_confidence
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
      public.agri_stage_matches(c.stage_source, c.stage_confidence, c.stage, e.applies_to_stages, v_min_conf) as stage_match,
      c.stage_source,
      c.stage_confidence,
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
     and (e.applies_to_stages is null or cardinality(e.applies_to_stages) = 0
          or public.agri_stage_matches(c.stage_source, c.stage_confidence, c.stage, e.applies_to_stages, v_min_conf))
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
      null::text as stage_source,
      null::numeric as stage_confidence,
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
  'Generates canonical recommendations from published evidence-tiered knowledge and a fresh weather reading. Stage-specific entries additionally require a confirmed stage or an estimate at or above the configured confidence floor.';

revoke execute on function public.refresh_farmer_recommendations(uuid) from public, anon, authenticated;

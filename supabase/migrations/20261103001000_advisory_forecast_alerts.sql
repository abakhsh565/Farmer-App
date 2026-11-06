-- Farmer App · migration 0042 · Phase 5.1 advisory and forecast-risk alerts
--
-- This migration extends the Phase 5 producer; it does not add a second alert
-- engine, notification table or Home surface. An alert remains a canonical
-- `recommendations` row with an `alert_level`, announced through the existing
-- `notification_events` pointer.
--
-- Two evidence boundaries are made explicit here:
--
--   · An advisory is not official because a row exists. It is official only
--     after an administrator verifies the source, URL, region and validity
--     window. Unverified and rejected rows are not readable by clients and the
--     producer cannot see them.
--   · A forecast risk is not an observation and is not an outbreak. It can reach
--     the producer only from an active, reviewed rule whose cited knowledge is
--     published and verified, and only for a matching district, crop and stage.
--
-- No advisory and no active threshold is inserted by this migration.

-- ---------------------------------------------------------------------------
-- Advisory verification state
-- ---------------------------------------------------------------------------
alter table public.agri_advisories
  add column if not exists verification_status text not null default 'unverified',
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.parties (id) on delete set null,
  add column if not exists verification_note text,
  add column if not exists alert_level text,
  add column if not exists title_ur text,
  add column if not exists summary_ur text;

alter table public.agri_advisories
  drop constraint if exists agri_advisories_verification_status_check,
  drop constraint if exists agri_advisories_alert_level_check,
  drop constraint if exists agri_advisories_source_url_https,
  drop constraint if exists agri_advisories_verified_evidence;

alter table public.agri_advisories
  add constraint agri_advisories_verification_status_check
    check (verification_status in ('unverified', 'verified', 'rejected')),
  add constraint agri_advisories_alert_level_check
    check (alert_level is null or alert_level in ('info', 'watch', 'urgent')),
  add constraint agri_advisories_source_url_https
    check (source_url is null or source_url ~ '^https://[^[:space:]]+$'),
  add constraint agri_advisories_verified_evidence
    check (
      verification_status <> 'verified'
      or (
        verified_at is not null
        and verified_by is not null
        and source_url is not null
        and district is not null
        and valid_until is not null
        and alert_level is not null
        and title_ur is not null
        and summary_ur is not null
      )
    );

comment on column public.agri_advisories.verification_status is
  'Unverified by default. Only an administrator can set verified or rejected through verify_official_advisory; import alone never makes a row official.';
comment on column public.agri_advisories.verified_by is
  'The person who checked the source document and its region/validity window. Null on every unverified row.';
comment on column public.agri_advisories.title_ur is
  'Urdu wording only when it is part of the checked source material; the alert falls back to the English title rather than machine-translating an official quotation.';

create index if not exists agri_advisories_verified_lookup_idx
  on public.agri_advisories (district, valid_until)
  where is_active and verification_status = 'verified';

-- Direct client reads no longer expose an advisory just because its importer
-- set `is_active`: verification is now part of the row's public eligibility.
drop policy if exists agri_advisories_read on public.agri_advisories;
create policy agri_advisories_verified_read on public.agri_advisories
  for select to anon, authenticated
  using (
    is_active
    and verification_status = 'verified'
    and valid_until is not null
    and valid_until > now()
  );

-- ---------------------------------------------------------------------------
-- The explicit review act
-- ---------------------------------------------------------------------------
create or replace function public.verify_official_advisory(
  p_advisory_id uuid,
  p_status      text,
  p_alert_level text default null,
  p_note        text default null
)
returns public.agri_advisories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_advisory public.agri_advisories;
  v_source   public.intel_sources;
  v_actor    uuid := public.current_party_id();
begin
  if not public.has_capability('admin') then
    raise exception 'Verifying an official advisory requires the admin capability.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('verified', 'rejected') then
    raise exception 'Advisory review status must be verified or rejected.' using errcode = 'check_violation';
  end if;

  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Advisory review requires a note recording what was checked.' using errcode = 'check_violation';
  end if;

  select * into v_advisory
    from public.agri_advisories
   where id = p_advisory_id
   for update;
  if not found then
    raise exception 'Advisory % not found.', p_advisory_id using errcode = 'no_data_found';
  end if;

  if p_status = 'verified' then
    if p_alert_level is null or p_alert_level not in ('info', 'watch', 'urgent') then
      raise exception 'A verified advisory needs an alert level: info, watch or urgent.'
        using errcode = 'check_violation';
    end if;

    if v_advisory.source_url is null
       or v_advisory.source_url !~ '^https://[^[:space:]]+$' then
      raise exception 'A verified advisory needs a direct HTTPS source URL.' using errcode = 'check_violation';
    end if;

    if v_advisory.district is null or btrim(v_advisory.district) = '' then
      raise exception 'A verified advisory needs an affected district.' using errcode = 'check_violation';
    end if;

    if v_advisory.valid_until is null or v_advisory.valid_until <= now() then
      raise exception 'A verified advisory needs a future validity window.' using errcode = 'check_violation';
    end if;

    if v_advisory.published_at > now() then
      raise exception 'An advisory published in the future cannot be verified as current.' using errcode = 'check_violation';
    end if;

    if v_advisory.title_ur is null or v_advisory.summary_ur is null then
      raise exception 'Verified advisory text needs Urdu title and summary, or the importer must supply the checked translation.'
        using errcode = 'check_violation';
    end if;

    select * into v_source
      from public.intel_sources
     where code = v_advisory.source_code;
    if not found or not v_source.is_active or v_source.kind <> 'official_advisory' then
      raise exception 'The advisory source must be an active official_advisory source.'
        using errcode = 'check_violation';
    end if;

    update public.agri_advisories
       set verification_status = 'verified',
           verified_at = now(),
           verified_by = v_actor,
           verification_note = btrim(p_note),
           alert_level = p_alert_level,
           is_active = true
     where id = p_advisory_id
    returning * into v_advisory;

    perform public.write_audit(
      'intel.advisory_verified', 'agri_advisories', p_advisory_id, v_advisory.source_code,
      'unverified', 'verified',
      jsonb_build_object(
        'source_url', v_advisory.source_url,
        'source_ref', v_advisory.source_ref,
        'district', v_advisory.district,
        'valid_until', v_advisory.valid_until,
        'alert_level', p_alert_level
      ),
      v_actor, 'admin'
    );
  else
    update public.agri_advisories
       set verification_status = 'rejected',
           verified_at = now(),
           verified_by = v_actor,
           verification_note = btrim(p_note),
           alert_level = null,
           is_active = false
     where id = p_advisory_id
    returning * into v_advisory;

    perform public.write_audit(
      'intel.advisory_rejected', 'agri_advisories', p_advisory_id, v_advisory.source_code,
      'unverified', 'rejected',
      jsonb_build_object('source_url', v_advisory.source_url, 'note', btrim(p_note)),
      v_actor, 'admin'
    );
  end if;

  return v_advisory;
end;
$$;

comment on function public.verify_official_advisory(uuid, text, text, text) is
  'Admin-only review of one imported advisory. Requires a direct HTTPS source, district, future validity window and Urdu copy before it can become official. Rejection deactivates the row and is recorded.';

revoke execute on function public.verify_official_advisory(uuid, text, text, text) from public, anon;
grant execute on function public.verify_official_advisory(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- A threshold may only be turned on with verified, published evidence
-- ---------------------------------------------------------------------------
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

  -- Phase 5.1: a published entry is not automatically verified. The stricter
  -- tier is the review requirement, not an optional label.
  if v_entry.evidence_tier <> 'verified' then
    raise exception 'Rule % cites % evidence, not verified published knowledge. It cannot be activated.',
      p_code, v_entry.evidence_tier
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.intel_sources s
     where s.code = v_rule.source_code
       and s.kind = 'forecast_risk'
       and s.is_active
  ) then
    raise exception 'Rule % cites an inactive or non-forecast source.', p_code using errcode = 'check_violation';
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
    jsonb_build_object(
      'threshold', v_rule.threshold,
      'metric', v_rule.metric,
      'citation', v_entry.slug,
      'evidence_tier', v_entry.evidence_tier
    ),
    v_actor, 'admin'
  );

  return v_rule;
end;
$$;

comment on function public.activate_forecast_risk_rule(text, text) is
  'Admin-only. Requires a note, a published entry at evidence_tier=verified and an active forecast source. An interpretation with supplementary evidence cannot be activated.';

-- Optional model confidence, never inferred from a threshold. A producer that
-- knows the provider's confidence can store it; otherwise it remains NULL and
-- the alert does not invent one.
alter table public.forecast_risks
  add column if not exists confidence numeric
    check (confidence is null or (confidence between 0 and 1));

comment on column public.forecast_risks.confidence is
  'Optional provider/model confidence in this risk. NULL means the provider did not give one; the alert does not substitute a made-up number.';

-- ---------------------------------------------------------------------------
-- Canonical alert provenance
-- ---------------------------------------------------------------------------
alter table public.recommendations
  add column if not exists alert_source_kind text;

update public.recommendations
   set alert_source_kind = case
     when source = 'weather' then 'weather_observation'
     else 'knowledge'
   end
 where alert_level is not null
   and alert_source_kind is null;

alter table public.recommendations
  drop constraint if exists recommendations_alert_provenance_check;

alter table public.recommendations
  add constraint recommendations_alert_provenance_check
    check (
      (alert_level is null and alert_source_kind is null)
      or (
        alert_level is not null
        and alert_source_kind in ('weather_observation', 'knowledge', 'official_advisory', 'forecast_risk')
      )
    );

comment on column public.recommendations.alert_source_kind is
  'What kind of evidence produced this alert. Distinguishes an observed weather reading, curated knowledge, a verified official advisory and a modelled forecast risk even when they share the recommendation table and notification pointer.';

-- ---------------------------------------------------------------------------
-- The Phase 5 producer, extended in place
-- ---------------------------------------------------------------------------
create or replace function public.refresh_farmer_alerts(p_farmer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pair       uuid;
  v_pref       jsonb := '{}'::jsonb;
  v_in_app     boolean := true;
  v_push       boolean := false;
  v_categories text[];
  v_lat        double precision;
  v_lon        double precision;
  v_area       text;
  v_district   text;
  v_crop       record;
  v_weather    record;
  v_rule       public.alert_rules%rowtype;
  v_match      record;
  v_adv        record;
  v_risk       record;
  v_rec        uuid;
  v_count      integer := 0;
  v_live       integer := 0;
  v_max        integer := 3;
  v_refresh    integer := 15;
  v_rule_ver   integer := 1;
  v_last       timestamptz;
  v_code       integer;
  v_dedupe     text;
  v_body_en    text;
  v_body_ur    text;
  v_title_en   text;
  v_title_ur   text;
  v_kind       text;
  v_source_url text;
  v_source_label text;
  v_valid_until timestamptz;
  v_source_kind text;
  v_risk_confidence numeric;
begin
  if p_farmer_id is null then
    raise exception 'A farmer is required.' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('alerts:' || p_farmer_id::text, 0));

  select coalesce((value #>> '{}')::integer, 3) into v_max
    from public.intelligence_config where key = 'alert_max_per_farmer';
  select coalesce((value #>> '{}')::integer, 15) into v_refresh
    from public.intelligence_config where key = 'alert_refresh_minutes';
  select coalesce((value #>> '{}')::integer, 1) into v_rule_ver
    from public.intelligence_config where key = 'alert_rule_version';

  select value into v_pref
    from public.farmer_preferences
   where farmer_id = p_farmer_id and key = 'alerts';
  if v_pref is null or jsonb_typeof(v_pref) <> 'object' then
    v_pref := '{}'::jsonb;
  end if;

  v_in_app := coalesce((v_pref->>'in_app')::boolean, true);
  v_push := coalesce((v_pref->>'push')::boolean, false);
  if not v_in_app and not v_push then
    return 0;
  end if;

  if jsonb_typeof(v_pref->'categories') = 'array' then
    select coalesce(array_agg(value), array[]::text[])
      into v_categories
      from jsonb_array_elements_text(v_pref->'categories') value
     where value in ('weather', 'pest', 'disease', 'crop_stage');
  else
    v_categories := array['weather', 'pest', 'disease', 'crop_stage']::text[];
  end if;
  if cardinality(v_categories) = 0 then
    return 0;
  end if;

  select default_lat, default_lon, default_location_label
    into v_lat, v_lon, v_area
    from public.farmer_profiles
   where party_id = p_farmer_id;

  if v_lat is null or v_lon is null then
    return 0;
  end if;

  -- A district is the region unit both official advisories and forecast risks
  -- use. Prefer the explicit profile value; fall back to the saved area label so
  -- a farmer whose district has not been separately captured is not silently
  -- treated as regionless.
  select nullif(btrim(ip.district), '')
    into v_district
    from public.farmer_intelligence_profiles ip
   where ip.farmer_id = p_farmer_id;

  if v_district is null and v_area is not null then
    select d.name_en
      into v_district
      from public.districts d
     where d.is_active
       and (
         v_area ilike '%' || d.name_en || '%'
         or v_area ilike '%' || d.name_ur || '%'
       )
     order by length(d.name_en) desc
     limit 1;
  end if;

  select id, crop_code, stage
    into v_crop
    from public.crop_instances
   where farmer_id = p_farmer_id and closed_at is null
   order by is_primary desc, created_at
   limit 1;

  if not found then
    return 0;
  end if;

  select alerts_refreshed_at into v_last
    from public.farmer_intelligence_profiles
   where farmer_id = p_farmer_id;
  if v_last is not null and v_last > now() - make_interval(mins => greatest(1, least(v_refresh, 360))) then
    return 0;
  end if;

  -- Retire this farmer's expired alerts before counting the live cap. A stale
  -- row must not keep a new observation out through the unique dedupe index.
  update public.recommendations
     set withdrawn_at = now(),
         withdraw_reason = 'alert validity window passed'
   where farmer_id = p_farmer_id
     and alert_level is not null
     and withdrawn_at is null
     and valid_until is not null
     and valid_until <= now();

  select count(*) into v_live
    from public.recommendations
   where farmer_id = p_farmer_id
     and alert_level is not null
     and withdrawn_at is null
     and (valid_until is null or valid_until > now());

  -- Direct observed weather. This is a WMO condition, not an inferred pest
  -- outbreak and not a threshold claimed to be agronomic advice.
  select w.*, wr.condition_code
    into v_weather
    from public.farmer_profiles fp
    cross join lateral public.latest_weather(fp.default_lat, fp.default_lon) w
    join public.weather_readings wr
      on wr.provider_code = w.provider_code
     and wr.observed_at = w.observed_at
     and wr.lat_cell = round(fp.default_lat::numeric, 3)
     and wr.lon_cell = round(fp.default_lon::numeric, 3)
   where fp.party_id = p_farmer_id
     and w.is_usable
     and wr.condition_code ~ '^[0-9]{1,3}$'
   order by wr.observed_at desc
   limit 1;

  if found and v_live < v_max then
    v_code := v_weather.condition_code::integer;

    select * into v_rule
      from public.alert_rules r
     where r.is_active
       and r.source_kind = 'weather_observation'
       and r.category = any (v_categories)
       and exists (
         select 1
           from jsonb_array_elements_text(r.condition->'condition_codes') elem
          where elem::integer = v_code
       )
     order by r.priority
     limit 1;

    if found then
      v_dedupe := 'alert:weather:' || v_rule.code || ':' || v_weather.provider_code || ':'
        || v_code::text || ':' || to_char(v_weather.observed_at at time zone 'Asia/Karachi', 'YYYYMMDDHH24');

      if not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.alert_rule_code = v_rule.code
           and r.withdrawn_at is null
           and (r.valid_until is null or r.valid_until > now())
      ) and not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.alert_rule_code = v_rule.code
           and r.alert_at > now() - make_interval(mins => v_rule.cooldown_minutes)
      ) and (
        select count(*) from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.alert_rule_code = v_rule.code
           and r.alert_at > now() - interval '24 hours'
      ) < v_rule.daily_cap then
        v_title_en := v_rule.title_en;
        v_title_ur := v_rule.title_ur;
        v_body_en := format(v_rule.body_en, coalesce(v_weather.condition_text, 'Weather'), to_char(v_weather.observed_at at time zone 'Asia/Karachi', 'DD/MM HH24:MI'));
        v_body_ur := format(v_rule.body_ur, coalesce(v_weather.condition_text, 'موسم'), to_char(v_weather.observed_at at time zone 'Asia/Karachi', 'DD/MM HH24:MI'));
        v_valid_until := now() + make_interval(mins => v_rule.valid_for_minutes);

        v_rec := null;
        insert into public.recommendations (
          farmer_id, crop_id, kind, title, title_ur, body, body_ur,
          action_label, action_label_ur, action_kind,
          source, source_ref, source_label, source_url,
          confidence, valid_until, priority, dedupe_key,
          evidence_tier, reason_code, reason_context, rule_version,
          alert_level, alert_at, alert_rule_code, alert_source_kind
        ) values (
          p_farmer_id, v_crop.id, 'weather', v_title_en, v_title_ur, v_body_en, v_body_ur,
          'Check weather', 'موسم دیکھیں', 'open_weather',
          'weather', 'weather:' || v_weather.provider_code, v_weather.provider_name, null,
          0.95, v_valid_until, v_rule.priority, v_dedupe,
          null, 'weather_observation',
          jsonb_strip_nulls(jsonb_build_object(
            'crop_code', v_crop.crop_code,
            'stage', v_crop.stage,
            'condition_code', v_code,
            'observed_at', v_weather.observed_at,
            'area_label', left(coalesce(v_area, ''), 120)
          )),
          v_rule_ver, v_rule.level, now(), v_rule.code, 'weather_observation'
        )
        on conflict (farmer_id, dedupe_key) where withdrawn_at is null do nothing
        returning id into v_rec;

        if v_rec is not null then
          v_count := v_count + 1;
          v_live := v_live + 1;
          if v_in_app then
            insert into public.notification_events (
              party_id, kind, recommendation_id, delivered_channels
            ) values (
              p_farmer_id, 'weather_alert', v_rec, array['in_app']::text[]
            )
            on conflict do nothing;
          end if;
          perform public.write_audit(
            'alert.generated', 'recommendations', v_rec, v_rule.code,
            null, v_rule.level,
            jsonb_build_object('source', 'weather_observation', 'condition_code', v_code)
          );
        end if;
      end if;
    end if;
  end if;

  -- Time-bound, reviewed knowledge campaigns. This loop can only see a rule a
  -- reviewer created with a start and end; a published entry alone never fires.
  if v_live < v_max then
    for v_match in
      select
        r.code as rule_code,
        r.level,
        r.category,
        r.priority,
        r.valid_for_minutes,
        r.cooldown_minutes,
        r.daily_cap,
        r.ends_at,
        r.version as rule_version,
        e.slug,
        e.version as entry_version,
        e.title_en,
        e.title_ur,
        e.body_en,
        e.body_ur,
        e.topic,
        e.problem_type,
        e.evidence_tier,
        e.regions,
        c.id as crop_id,
        c.crop_code,
        c.stage,
        e.source_url as entry_source_url,
        src.publisher,
        src.name as source_name,
        src.url as source_url
      from public.alert_rules r
      join public.agri_knowledge_entries e on e.id = r.knowledge_entry_id
      join public.crop_instances c
        on c.farmer_id = p_farmer_id
       and c.closed_at is null
       and (r.crop_code is null or r.crop_code = c.crop_code)
       and c.stage = r.stage
      left join public.agri_knowledge_sources src on src.code = e.source_code
     where r.is_active
       and r.source_kind = 'knowledge'
       and r.starts_at <= now()
       and r.ends_at > now()
       and r.category = any (v_categories)
       and e.is_published
       and e.evidence_tier = 'verified'
       and (
         e.regions is null
         or cardinality(e.regions) = 0
         or 'Punjab' = any (e.regions)
         or exists (
           select 1 from public.farmer_intelligence_profiles ip
            where ip.farmer_id = p_farmer_id
              and ip.district is not null
              and ip.district = any (e.regions)
         )
       )
     order by r.priority, e.slug, c.id
    loop
      exit when v_live >= v_max;

      if not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.alert_rule_code = v_match.rule_code
           and r.withdrawn_at is null
           and (r.valid_until is null or r.valid_until > now())
      ) and not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.alert_rule_code = v_match.rule_code
           and r.alert_at > now() - make_interval(mins => v_match.cooldown_minutes)
      ) then
        -- The curated rule's category is authoritative for feed filtering and
        -- for the action we offer; the knowledge topic is supporting context.
        v_kind := case v_match.category
          when 'pest' then 'pest'
          when 'disease' then 'disease'
          when 'weather' then 'weather'
          else 'crop_stage'
        end;

        v_dedupe := 'alert:knowledge:' || v_match.rule_code || ':' || v_match.crop_id::text
          || ':v' || v_match.rule_version::text;
        v_source_url := case
          when coalesce(v_match.entry_source_url, v_match.source_url) ~ '^https://'
            then coalesce(v_match.entry_source_url, v_match.source_url)
          else null
        end;
        v_source_label := coalesce(v_match.publisher, v_match.source_name, 'Farmer App editorial notes');
        v_valid_until := least(v_match.ends_at, now() + make_interval(mins => v_match.valid_for_minutes));

        v_rec := null;
        insert into public.recommendations (
          farmer_id, crop_id, kind, title, title_ur, body, body_ur,
          action_label, action_label_ur, action_kind,
          source, source_ref, source_label, source_url,
          confidence, knowledge_version, valid_until, priority, dedupe_key,
          evidence_tier, reason_code, reason_context, rule_version,
          alert_level, alert_at, alert_rule_code, alert_source_kind
        ) values (
          p_farmer_id, v_match.crop_id, v_kind, v_match.title_en, v_match.title_ur,
          v_match.body_en, v_match.body_ur,
          case when v_kind in ('pest', 'disease') then 'Scan the crop' else 'Open crop' end,
          case when v_kind in ('pest', 'disease') then 'فصل اسکین کریں' else 'فصل کھولیں' end,
          case when v_kind in ('pest', 'disease') then 'open_scan' else 'open_crop' end,
          'knowledge_base', v_match.slug, v_source_label, v_source_url,
          0.95, v_match.entry_version, v_valid_until, v_match.priority, v_dedupe,
          v_match.evidence_tier, 'crop_stage',
          jsonb_strip_nulls(jsonb_build_object(
            'crop_code', v_match.crop_code,
            'stage', v_match.stage,
            'topic', v_match.topic,
            'rule', v_match.rule_code
          )),
          v_match.rule_version, v_match.level, now(), v_match.rule_code, 'knowledge'
        )
        on conflict (farmer_id, dedupe_key) where withdrawn_at is null do nothing
        returning id into v_rec;

        if v_rec is not null then
          v_count := v_count + 1;
          v_live := v_live + 1;
          if v_in_app then
            insert into public.notification_events (
              party_id, kind, recommendation_id, delivered_channels
            ) values (
              p_farmer_id, 'recommendation', v_rec, array['in_app']::text[]
            )
            on conflict do nothing;
          end if;
          perform public.write_audit(
            'alert.generated', 'recommendations', v_rec, v_match.rule_code,
            null, v_match.level,
            jsonb_build_object('source', 'knowledge', 'slug', v_match.slug)
          );
        end if;
      end if;
    end loop;
  end if;

  -- Verified official advisories. Unverified rows are invisible at the table
  -- read policy and are filtered here again; the review act is admin-only and
  -- requires the source URL, district and future validity window.
  if v_district is not null and v_live < v_max then
    for v_adv in
      select
        a.id as advisory_id,
        a.title,
        a.title_ur,
        a.summary,
        a.summary_ur,
        a.topic,
        a.alert_level,
        a.source_code,
        a.source_ref,
        a.source_url,
        a.published_at,
        a.valid_until,
        c.id as crop_id,
        c.crop_code,
        c.stage,
        src.name as source_name
      from public.agri_advisories a
      join public.intel_sources src
        on src.code = a.source_code
       and src.is_active
       and src.kind = 'official_advisory'
      join public.crop_instances c
        on c.farmer_id = p_farmer_id
       and c.closed_at is null
       and (a.crop_code is null or a.crop_code = c.crop_code)
     where a.is_active
       and a.verification_status = 'verified'
       and a.published_at <= now()
       and a.valid_until is not null
       and a.valid_until > now()
       and a.district is not null
       and lower(btrim(a.district)) = lower(btrim(v_district))
       and a.alert_level is not null
       and (case a.topic
         when 'pest' then 'pest'
         when 'disease' then 'disease'
         when 'weather_damage' then 'weather'
         when 'water' then 'weather'
         else 'crop_stage'
       end) = any (v_categories)
     order by
       case a.alert_level when 'urgent' then 0 when 'watch' then 1 else 2 end,
       a.published_at desc,
       c.id
    loop
      exit when v_live >= v_max;

      v_dedupe := 'alert:advisory:' || v_adv.advisory_id::text || ':' || v_adv.crop_id::text;

      if not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.dedupe_key = v_dedupe
      ) then
        v_kind := case v_adv.topic
          when 'pest' then 'pest'
          when 'disease' then 'disease'
          when 'weather_damage' then 'weather'
          when 'water' then 'weather'
          else 'crop_stage'
        end;
        v_source_url := case
          when v_adv.source_url ~ '^https://[^[:space:]]+$' then v_adv.source_url
          else null
        end;
        v_source_label := v_adv.source_name;
        v_valid_until := v_adv.valid_until;

        v_rec := null;
        insert into public.recommendations (
          farmer_id, crop_id, kind, title, title_ur, body, body_ur,
          action_label, action_label_ur, action_kind,
          source, source_ref, source_label, source_url,
          confidence, valid_until, priority, dedupe_key,
          evidence_tier, reason_code, reason_context, rule_version,
          alert_level, alert_at, alert_rule_code, alert_source_kind
        ) values (
          p_farmer_id, v_adv.crop_id, v_kind, v_adv.title, coalesce(v_adv.title_ur, v_adv.title),
          v_adv.summary, coalesce(v_adv.summary_ur, v_adv.summary),
          'Open crop', 'فصل کھولیں', 'open_crop',
          'knowledge_base', 'official_advisory:' || v_adv.advisory_id::text,
          v_source_label, v_source_url,
          null, v_valid_until, 10, v_dedupe,
          'verified', 'official_advisory',
          jsonb_strip_nulls(jsonb_build_object(
            'crop_code', v_adv.crop_code,
            'stage', v_adv.stage,
            'topic', v_adv.topic,
            'district', v_district,
            'source_code', v_adv.source_code,
            'source_ref', v_adv.source_ref,
            'published_at', v_adv.published_at,
            'advisory_id', v_adv.advisory_id
          )),
          v_rule_ver, v_adv.alert_level, now(),
          'advisory:' || v_adv.advisory_id::text, 'official_advisory'
        )
        on conflict (farmer_id, dedupe_key) where withdrawn_at is null do nothing
        returning id into v_rec;

        if v_rec is not null then
          v_count := v_count + 1;
          v_live := v_live + 1;
          if v_in_app then
            insert into public.notification_events (
              party_id, kind, recommendation_id, delivered_channels
            ) values (
              p_farmer_id, 'recommendation', v_rec, array['in_app']::text[]
            )
            on conflict do nothing;
          end if;
          perform public.write_audit(
            'alert.generated', 'recommendations', v_rec,
            'advisory:' || v_adv.advisory_id::text,
            null, v_adv.alert_level,
            jsonb_build_object(
              'source', 'official_advisory',
              'source_code', v_adv.source_code,
              'advisory_id', v_adv.advisory_id,
              'district', v_district
            )
          );
        end if;
      end if;
    end loop;
  end if;

  -- Model-derived risks. A row is eligible only when its rule is active, the
  -- rule's cited knowledge is published and verified, the source is an active
  -- forecast source, and district/crop/stage match this farmer. An inactive rule
  -- (the only state this repository ships) cannot produce an alert even if a
  -- stale risk row exists.
  if v_district is not null and v_live < v_max then
    for v_risk in
      select
        k.id as risk_id,
        k.rule_code,
        k.topic,
        k.title,
        k.title_ur,
        k.summary,
        k.summary_ur,
        k.risk_on,
        k.issued_on,
        k.expires_at,
        k.confidence,
        k.metric,
        k.operator,
        k.threshold,
        k.observed_value,
        k.basis,
        k.district_code,
        r.source_code,
        e.slug as entry_slug,
        e.evidence_tier,
        e.applies_to_stages,
        e.source_url as entry_source_url,
        src.name as source_name,
        src.endpoint_url as source_endpoint_url,
        d.name_en as district_name,
        c.id as crop_id,
        c.crop_code,
        c.stage
      from public.forecast_risks k
      join public.forecast_risk_rules r
        on r.code = k.rule_code
       and r.is_active
      join public.agri_knowledge_entries e
        on e.id = r.knowledge_entry_id
       and e.is_published
       and e.evidence_tier = 'verified'
      join public.intel_sources src
        on src.code = r.source_code
       and src.is_active
       and src.kind = 'forecast_risk'
      join public.districts d
        on d.code = k.district_code
       and d.is_active
      join public.crop_instances c
        on c.farmer_id = p_farmer_id
       and c.closed_at is null
       and (k.crop_code is null or k.crop_code = c.crop_code)
       and (
         e.applies_to_stages is null
         or cardinality(e.applies_to_stages) = 0
         or c.stage = any (e.applies_to_stages)
       )
     where k.expires_at > now()
       and k.observed_at <= now()
       and (
         lower(d.name_en) = lower(btrim(v_district))
         or lower(d.name_ur) = lower(btrim(v_district))
       )
       and (case k.topic
         when 'pest' then 'pest'
         when 'disease' then 'disease'
         when 'weather_damage' then 'weather'
         when 'water' then 'weather'
         else 'crop_stage'
       end) = any (v_categories)
     order by k.risk_on, k.expires_at, c.id
    loop
      exit when v_live >= v_max;

      v_dedupe := 'alert:forecast:' || v_risk.risk_id::text;

      if not exists (
        select 1 from public.recommendations r
         where r.farmer_id = p_farmer_id
           and r.dedupe_key = v_dedupe
      ) then
        v_kind := case v_risk.topic
          when 'pest' then 'pest'
          when 'disease' then 'disease'
          when 'weather_damage' then 'weather'
          when 'water' then 'weather'
          else 'crop_stage'
        end;
        v_source_url := case
          when v_risk.entry_source_url ~ '^https://[^[:space:]]+$' then v_risk.entry_source_url
          when v_risk.source_endpoint_url ~ '^https://[^[:space:]]+$' then v_risk.source_endpoint_url
          else null
        end;
        v_source_label := v_risk.source_name;
        v_valid_until := v_risk.expires_at;
        v_risk_confidence := v_risk.confidence;
        v_title_en := v_risk.title;
        v_title_ur := coalesce(v_risk.title_ur, v_risk.title);
        v_body_en := v_risk.summary;
        v_body_ur := coalesce(v_risk.summary_ur, v_risk.summary);

        v_rec := null;
        insert into public.recommendations (
          farmer_id, crop_id, kind, title, title_ur, body, body_ur,
          action_label, action_label_ur, action_kind,
          source, source_ref, source_label, source_url,
          confidence, valid_until, priority, dedupe_key,
          evidence_tier, reason_code, reason_context, rule_version,
          alert_level, alert_at, alert_rule_code, alert_source_kind
        ) values (
          p_farmer_id, v_risk.crop_id, v_kind, v_title_en, v_title_ur, v_body_en, v_body_ur,
          case when v_kind = 'weather' then 'Check weather' else 'Open crop' end,
          case when v_kind = 'weather' then 'موسم دیکھیں' else 'فصل کھولیں' end,
          case when v_kind = 'weather' then 'open_weather' else 'open_crop' end,
          'weather', 'forecast_risk:' || v_risk.rule_code,
          v_source_label, v_source_url,
          v_risk_confidence, v_valid_until, 20, v_dedupe,
          null, 'forecast_risk',
          jsonb_strip_nulls(jsonb_build_object(
            'crop_code', v_risk.crop_code,
            'stage', v_risk.stage,
            'topic', v_risk.topic,
            'district_code', v_risk.district_code,
            'district', v_risk.district_name,
            'risk_on', v_risk.risk_on,
            'issued_on', v_risk.issued_on,
            'metric', v_risk.metric,
            'operator', v_risk.operator,
            'threshold', v_risk.threshold,
            'observed_value', v_risk.observed_value,
            'basis', v_risk.basis,
            'rule', v_risk.rule_code,
            'knowledge', v_risk.entry_slug
          )),
          v_rule_ver, 'watch', now(),
          'forecast:' || v_risk.rule_code, 'forecast_risk'
        )
        on conflict (farmer_id, dedupe_key) where withdrawn_at is null do nothing
        returning id into v_rec;

        if v_rec is not null then
          v_count := v_count + 1;
          v_live := v_live + 1;
          if v_in_app then
            insert into public.notification_events (
              party_id, kind, recommendation_id, delivered_channels
            ) values (
              p_farmer_id, 'recommendation', v_rec, array['in_app']::text[]
            )
            on conflict do nothing;
          end if;
          perform public.write_audit(
            'alert.generated', 'recommendations', v_rec,
            'forecast:' || v_risk.rule_code,
            null, 'watch',
            jsonb_build_object(
              'source', 'forecast_risk',
              'risk_id', v_risk.risk_id,
              'district_code', v_risk.district_code,
              'knowledge', v_risk.entry_slug
            )
          );
        end if;
      end if;
    end loop;
  end if;

  insert into public.farmer_intelligence_profiles (farmer_id, alerts_refreshed_at)
  values (p_farmer_id, now())
  on conflict (farmer_id) do update
    set alerts_refreshed_at = excluded.alerts_refreshed_at,
        updated_at = now();

  perform public.write_audit(
    'alerts.refreshed', 'farmer_intelligence_profiles', p_farmer_id, null,
    null, v_count::text,
    jsonb_build_object('generated', v_count, 'live', v_live, 'rule_version', v_rule_ver)
  );

  return v_count;
end;
$$;

comment on function public.refresh_farmer_alerts(uuid) is
  'Service-only canonical alert producer. Uses direct WMO observations, reviewed knowledge campaigns, verified official advisories and active forecast risks whose cited knowledge is published and verified. All paths are bounded by cooldown/daily caps, dedupe and live-alert caps. A forecast risk is never labelled an observation or outbreak.';

revoke execute on function public.refresh_farmer_alerts(uuid) from public, anon, authenticated;
grant execute on function public.refresh_farmer_alerts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The existing alert read model, now carrying provenance
-- ---------------------------------------------------------------------------
drop function if exists public.intelligence_alert_feed(integer);

create function public.intelligence_alert_feed(p_limit integer default 20)
returns table (
  notification_id  uuid,
  recommendation_id uuid,
  crop_id          uuid,
  crop_code        text,
  kind             text,
  title            text,
  title_ur         text,
  body             text,
  body_ur          text,
  source           public.recommendation_source,
  source_label     text,
  source_url       text,
  evidence_tier    text,
  confidence       numeric,
  alert_level      text,
  alert_at         timestamptz,
  valid_until      timestamptz,
  is_read          boolean,
  read_at          timestamptz,
  created_at       timestamptz,
  reason_code      text,
  reason_context   jsonb,
  action_kind      text,
  action_label     text,
  action_label_ur  text,
  alert_source_kind text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select
      public.current_farmer_id() as farmer_id,
      public.current_party_id() as party_id
  ),
  pref as (
    select p.value
      from public.farmer_preferences p, mine
     where p.farmer_id = mine.farmer_id and p.key = 'alerts'
  )
  select
    n.id,
    r.id,
    r.crop_id,
    ci.crop_code,
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
    r.alert_level,
    r.alert_at,
    r.valid_until,
    (n.read_at is not null),
    n.read_at,
    r.created_at,
    r.reason_code,
    r.reason_context,
    r.action_kind,
    r.action_label,
    r.action_label_ur,
    r.alert_source_kind
  from public.recommendations r
  join public.notification_events n
    on n.recommendation_id = r.id
   and n.party_id = (select party_id from mine)
  left join public.crop_instances ci on ci.id = r.crop_id
  left join pref p on true
  where r.farmer_id = (select farmer_id from mine)
    and r.alert_level is not null
    and r.withdrawn_at is null
    and (r.valid_until is null or r.valid_until > now())
    and n.dismissed_at is null
    and (r.crop_id is null or ci.closed_at is null)
    and coalesce((p.value->>'in_app')::boolean, true)
    and (
      p.value is null
      or jsonb_typeof(p.value->'categories') <> 'array'
      or p.value->'categories' ? case
        when r.kind in ('weather', 'pest', 'disease', 'crop_stage') then r.kind
        else 'crop_stage'
      end
    )
  order by
    case r.alert_level when 'urgent' then 0 when 'watch' then 1 else 2 end,
    r.alert_at desc,
    r.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 20));
$$;

comment on function public.intelligence_alert_feed(integer) is
  'The caller''s own live alerts, joined to the existing notification pointer and carrying alert_source_kind so weather observations, curated knowledge, verified official advisories and forecast risks cannot be confused.';

revoke execute on function public.intelligence_alert_feed(integer) from public, anon;
grant execute on function public.intelligence_alert_feed(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- The public intelligence feed must not turn an unverified row into an official
-- advisory, or serve a risk whose rule is not active with verified evidence.
-- ---------------------------------------------------------------------------
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
      a.published_at as sort_at, a.title_ur, a.summary_ur, 1 as dup_rank
    from public.agri_advisories a
    join public.intel_sources src
      on src.code = a.source_code
     and src.is_active
     and src.kind = 'official_advisory'
    where a.is_active
      and a.verification_status = 'verified'
      and a.published_at <= now()
      and a.valid_until is not null
      and a.valid_until > now()
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
      r.source_code, null::uuid as cluster_id,
      k.observed_at as sort_at, k.title_ur, k.summary_ur, 1 as dup_rank
    from public.forecast_risks k
    join public.forecast_risk_rules r
      on r.code = k.rule_code
     and r.is_active
    join public.agri_knowledge_entries e
      on e.id = r.knowledge_entry_id
     and e.is_published
     and e.evidence_tier = 'verified'
    join public.intel_sources src
      on src.code = r.source_code
     and src.is_active
     and src.kind = 'forecast_risk'
    join public.districts d on d.code = k.district_code and d.is_active
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
  'Dynamic-radius local intelligence: reports, verified official advisories and active forecast risks. Returns evidence on every row and no coordinates. Unverified advisories and risks without active, verified evidence are not served.';

revoke all on function public.intel_feed(double precision, double precision, double precision, text, text, integer) from public;
grant execute on function public.intel_feed(double precision, double precision, double precision, text, text, integer) to anon, authenticated, service_role;

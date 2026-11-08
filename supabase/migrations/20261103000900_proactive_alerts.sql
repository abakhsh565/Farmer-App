-- Phase 5 · Proactive crop intelligence and alerts
--
-- This migration deliberately does not create a second advice object. An alert
-- is a canonical `recommendations` row with an `alert_level`; its announcement is
-- the existing pointer-only `notification_events` row. Home, the bell and the
-- alert feed all read the same recommendation.
--
-- Two alert sources are implemented:
--
--   1. A direct severe-weather observation from `weather_readings`. The rule is
--      a WMO condition code, not an invented agronomic threshold, and the copy
--      says it is an observation rather than a pest or disease forecast.
--   2. A time-bound, admin-curated rule that cites a published verified
--      knowledge entry and a crop/stage. No static knowledge entry is promoted
--      to an alert merely because it exists.
--
-- The later `agri_advisories`/forecast-risk chain is not applied in the staging
-- database, so this migration cannot depend on it. When those tables are applied
-- they can add rules without changing the canonical alert shape.
--
-- The generator is service-only and idempotent. The client can only read its own
-- alert feed and mark/dismiss its own announcement. Alert delivery remains
-- in-app: no push sender is configured, and the preference API reports that
-- honestly instead of pretending a device token means delivered push.

-- ---------------------------------------------------------------------------
-- The canonical recommendation gains alert metadata
-- ---------------------------------------------------------------------------
alter table public.recommendations
  add column alert_level text
    check (alert_level is null or alert_level in ('info', 'watch', 'urgent')),
  add column alert_at timestamptz,
  add column alert_rule_code text;

alter table public.recommendations
  add constraint recommendations_alert_complete check (
    (alert_level is null and alert_at is null and alert_rule_code is null)
    or (alert_level is not null and alert_at is not null and alert_rule_code is not null)
  );

create index recommendations_alert_idx
  on public.recommendations (farmer_id, alert_at desc)
  where alert_level is not null and withdrawn_at is null;

comment on column public.recommendations.alert_level is
  'Non-null means this canonical recommendation is an alert. There is no separate alert table; Home, the inbox and the detail view all reference this row.';
comment on column public.recommendations.alert_at is
  'When the alert was raised. Kept separate from created_at so an older recommendation promoted by a time-bound rule can still be explained.';
comment on column public.recommendations.alert_rule_code is
  'The configurable alert rule that raised this row. The rule and its version remain readable for audit.';

alter table public.farmer_intelligence_profiles
  add column alerts_refreshed_at timestamptz;

comment on column public.farmer_intelligence_profiles.alerts_refreshed_at is
  'Last time the alert producer ran for this farmer. Bounds repeated generation independently of the recommendation refresh.';

-- ---------------------------------------------------------------------------
-- Alert rules: code, source, level and bounded delivery
-- ---------------------------------------------------------------------------
create table public.alert_rules (
  code               text primary key check (code ~ '^[a-z][a-z0-9_-]{1,60}$'),
  source_kind        text not null check (source_kind in ('weather_observation', 'knowledge')),
  level              text not null check (level in ('info', 'watch', 'urgent')),
  category           text not null check (category in ('weather', 'pest', 'disease', 'crop_stage')),
  crop_code          text references public.crop_catalog (code),
  stage              public.crop_stage,
  knowledge_entry_id uuid references public.agri_knowledge_entries (id) on delete cascade,
  -- For weather_observation, condition_codes is a JSON array of WMO codes.
  -- For knowledge, it is {} and the rule's crop/stage/window is the condition.
  condition          jsonb not null default '{}'::jsonb,
  title_en           text,
  title_ur           text,
  body_en            text,
  body_ur            text,
  priority           integer not null default 20 check (priority between 1 and 100),
  valid_for_minutes  integer not null default 90 check (valid_for_minutes between 15 and 10080),
  cooldown_minutes   integer not null default 180 check (cooldown_minutes between 15 and 10080),
  daily_cap          integer not null default 2 check (daily_cap between 1 and 10),
  starts_at          timestamptz,
  ends_at            timestamptz,
  is_active          boolean not null default false,
  version            integer not null default 1 check (version > 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint alert_rules_shape check (
    (
      source_kind = 'weather_observation'
      and knowledge_entry_id is null
      and crop_code is null
      and stage is null
      and starts_at is null
      and ends_at is null
      and title_en is not null
      and title_ur is not null
      and body_en is not null
      and body_ur is not null
      and condition ? 'condition_codes'
      and jsonb_typeof(condition->'condition_codes') = 'array'
    )
    or
    (
      source_kind = 'knowledge'
      and knowledge_entry_id is not null
      and stage is not null
      and starts_at is not null
      and ends_at is not null
      and ends_at > starts_at
    )
  )
);

create trigger alert_rules_touch
  before update on public.alert_rules
  for each row execute function public.touch_updated_at();

comment on table public.alert_rules is
  'Configurable alert causes. Weather rules use a direct WMO condition code; knowledge rules are time-bound campaigns that must cite a published entry and a crop stage. Inert until active.';

insert into public.alert_rules (
  code, source_kind, level, category, condition, title_en, title_ur,
  body_en, body_ur, priority, valid_for_minutes, cooldown_minutes, daily_cap,
  is_active, version
) values
  (
    'weather-thunderstorm', 'weather_observation', 'urgent', 'weather',
    '{"condition_codes":[95,96,99]}'::jsonb,
    'Thunderstorm reported near your farm',
    'آپ کے کھیت کے قریب آندھی اور گرج کی اطلاع',
    'The weather service reported %s at %s for your saved area. Avoid spraying now and check low areas for standing water. This is an observed weather warning, not a pest or disease forecast.',
    'موسم کی خدمت نے آپ کے محفوظ علاقے کے لیے %s کی اطلاع %s پر دی ہے۔ ابھی سپرے نہ کریں اور نشیبی حصوں میں پانی جمع ہونے کی جانچ کریں۔ یہ موسم کا مشاہدہ ہے، کیڑے یا بیماری کی پیش گوئی نہیں۔',
    1, 90, 180, 3, true, 1
  ),
  (
    'weather-heavy-rain', 'weather_observation', 'watch', 'weather',
    '{"condition_codes":[65,67,82]}'::jsonb,
    'Heavy rain reported near your farm',
    'آپ کے کھیت کے قریب تیز بارش کی اطلاع',
    'The weather service reported %s at %s for your saved area. Avoid spraying now and check low areas for standing water. This is an observed weather warning, not a pest or disease forecast.',
    'موسم کی خدمت نے آپ کے محفوظ علاقے کے لیے %s کی اطلاع %s پر دی ہے۔ ابھی سپرے نہ کریں اور نشیبی حصوں میں پانی جمع ہونے کی جانچ کریں۔ یہ موسم کا مشاہدہ ہے، کیڑے یا بیماری کی پیش گوئی نہیں۔',
    5, 180, 240, 2, true, 1
  ),
  (
    'weather-heavy-snow', 'weather_observation', 'watch', 'weather',
    '{"condition_codes":[75,86]}'::jsonb,
    'Heavy snow reported near your farm',
    'آپ کے کھیت کے قریب بھاری برف باری کی اطلاع',
    'The weather service reported %s at %s for your saved area. Check the crop and avoid field work until conditions improve. This is an observed weather warning, not a pest or disease forecast.',
    'موسم کی خدمت نے آپ کے محفوظ علاقے کے لیے %s کی اطلاع %s پر دی ہے۔ فصل دیکھیں اور حالات بہتر ہونے تک کھیت کا کام روکیں۔ یہ موسم کا مشاہدہ ہے، کیڑے یا بیماری کی پیش گوئی نہیں۔',
    5, 180, 360, 1, true, 1
  )
on conflict (code) do nothing;

alter table public.alert_rules enable row level security;

create policy alert_rules_read on public.alert_rules
  for select to authenticated
  using (is_active or public.has_capability('admin'));

grant select on public.alert_rules to authenticated;
revoke insert, update, delete on public.alert_rules from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
insert into public.intelligence_config (key, value, description) values
  ('alert_rule_version', '1'::jsonb,
   'Version of the Phase 5 alert producer.'),
  ('alert_refresh_minutes', '15'::jsonb,
   'Minimum time between alert production attempts for one farmer.'),
  ('alert_max_per_farmer', '3'::jsonb,
   'Hard ceiling on live alerts for one farmer.'),
  ('alert_push_available', 'false'::jsonb,
   'Whether a push sender is configured. The app reports this honestly and does not claim push delivery while false.')
on conflict (key) do update
  set value = excluded.value,
      version = public.intelligence_config.version + 1,
      description = excluded.description,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Preferences: one explicit alerts object in the existing preferences table
-- ---------------------------------------------------------------------------
create or replace function public.farmer_alert_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_value jsonb;
  v_push_available boolean := false;
begin
  if v_farmer is null then
    raise exception 'Alert preferences require an identified farmer.'
      using errcode = 'insufficient_privilege';
  end if;

  select value into v_value
    from public.farmer_preferences
   where farmer_id = v_farmer and key = 'alerts';

  if v_value is null or jsonb_typeof(v_value) <> 'object' then
    v_value := '{}'::jsonb;
  end if;

  select coalesce((value #>> '{}')::boolean, false)
    into v_push_available
    from public.intelligence_config
   where key = 'alert_push_available';

  return jsonb_build_object(
    'in_app', coalesce((v_value->>'in_app')::boolean, true),
    'push', coalesce((v_value->>'push')::boolean, false),
    'categories', coalesce(v_value->'categories',
      '["weather","pest","disease","crop_stage"]'::jsonb),
    'consent_version', coalesce((v_value->>'consent_version')::integer, 0),
    'consent_at', v_value->'consent_at',
    'push_available', coalesce(v_push_available, false)
  );
end;
$$;

comment on function public.farmer_alert_preferences() is
  'The caller''s own alert choices. Defaults are explicit in the response; push is reported unavailable unless a sender is configured.';

create or replace function public.set_farmer_alert_preferences(
  p_in_app        boolean,
  p_push          boolean default false,
  p_categories    text[] default array['weather','pest','disease','crop_stage']::text[],
  p_consent_version integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
  v_categories text[];
  v_existing jsonb;
  v_push_available boolean := false;
  v_consent_at timestamptz;
begin
  if v_farmer is null then
    raise exception 'Alert preferences require an identified farmer.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array(
    select distinct trim(value)
      from unnest(coalesce(p_categories, array['weather','pest','disease','crop_stage']::text[])) value
     where trim(value) <> ''
  ), array[]::text[])
    into v_categories;

  if exists (
    select 1 from unnest(v_categories) value
     where value not in ('weather', 'pest', 'disease', 'crop_stage')
  ) then
    raise exception 'Unknown alert category.' using errcode = 'check_violation';
  end if;

  if coalesce(p_in_app, true) and cardinality(v_categories) = 0 then
    raise exception 'Choose at least one alert category while in-app alerts are on.'
      using errcode = 'check_violation';
  end if;

  select coalesce((value #>> '{}')::boolean, false)
    into v_push_available
    from public.intelligence_config
   where key = 'alert_push_available';

  if p_push and not coalesce(v_push_available, false) then
    raise exception 'Push delivery is not configured in this build.'
      using errcode = 'check_violation';
  end if;

  if p_push and coalesce(p_consent_version, 0) < 1 then
    raise exception 'Push alerts require explicit consent.' using errcode = 'check_violation';
  end if;

  select value into v_existing
    from public.farmer_preferences
   where farmer_id = v_farmer and key = 'alerts';
  if v_existing is not null and jsonb_typeof(v_existing) = 'object' then
    v_consent_at := nullif(v_existing->>'consent_at', '')::timestamptz;
  end if;
  if coalesce(p_consent_version, 0) > 0 then
    v_consent_at := coalesce(v_consent_at, now());
  end if;

  insert into public.farmer_preferences (farmer_id, key, value)
  values (
    v_farmer,
    'alerts',
    jsonb_build_object(
      'in_app', coalesce(p_in_app, true),
      'push', coalesce(p_push, false),
      'categories', to_jsonb(v_categories),
      'consent_version', greatest(0, coalesce(p_consent_version, 0)),
      'consent_at', v_consent_at
    )
  )
  on conflict (farmer_id, key) do update
    set value = excluded.value,
        updated_at = now();

  update public.farmer_intelligence_profiles
     set alerts_refreshed_at = null,
         updated_at = now()
   where farmer_id = v_farmer;

  perform public.write_audit(
    'alerts.preferences_updated', 'farmer_preferences', v_farmer, 'alerts',
    null, null,
    jsonb_build_object(
      'in_app', coalesce(p_in_app, true),
      'push', coalesce(p_push, false),
      'categories', v_categories
    )
  );

  return public.farmer_alert_preferences();
end;
$$;

comment on function public.set_farmer_alert_preferences(boolean, boolean, text[], integer) is
  'Writes the caller''s alert choices to the existing preferences table. Rejects unknown categories and any push opt-in while no sender is configured.';

-- ---------------------------------------------------------------------------
-- Generation
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
  v_crop       record;
  v_weather    record;
  v_rule       public.alert_rules%rowtype;
  v_match      record;
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
          alert_level, alert_at, alert_rule_code
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
          v_rule_ver, v_rule.level, now(), v_rule.code
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
          alert_level, alert_at, alert_rule_code
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
          v_match.rule_version, v_match.level, now(), v_match.rule_code
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
  'Service-only alert producer. Uses direct WMO observations and time-bound reviewed knowledge rules, bounded by cooldown, daily cap and live-alert cap. Never creates an outbreak claim from static guidance.';

-- ---------------------------------------------------------------------------
-- Authenticated preparation and read model
-- ---------------------------------------------------------------------------
create or replace function public.prepare_my_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid := public.current_farmer_id();
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;
  return public.refresh_farmer_alerts(v_farmer);
end;
$$;

comment on function public.prepare_my_alerts() is
  'Authenticated seam for alert preparation. The farmer comes from the JWT; no client-supplied id is accepted.';

create or replace function public.intelligence_alert_feed(p_limit integer default 20)
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
  action_label_ur  text
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
    r.action_label_ur
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
  'The caller''s own live alerts, joined to the existing notification pointer. Respects in-app and category preferences, dismissal and validity; no farmer id is accepted.';

create or replace function public.mark_alert_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
  v_farmer uuid := public.current_farmer_id();
begin
  if v_party is null or v_farmer is null or p_notification_id is null then
    return false;
  end if;

  update public.notification_events n
     set read_at = coalesce(n.read_at, now())
   where n.id = p_notification_id
     and n.party_id = v_party
     and n.dismissed_at is null
     and exists (
       select 1 from public.recommendations r
        where r.id = n.recommendation_id
          and r.farmer_id = v_farmer
          and r.alert_level is not null
     );
  return found;
end;
$$;

create or replace function public.dismiss_alert(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
  v_farmer uuid := public.current_farmer_id();
  v_recommendation uuid;
begin
  if v_party is null or v_farmer is null or p_notification_id is null then
    return false;
  end if;

  select n.recommendation_id into v_recommendation
    from public.notification_events n
    join public.recommendations r on r.id = n.recommendation_id
   where n.id = p_notification_id
     and n.party_id = v_party
     and n.dismissed_at is null
     and r.farmer_id = v_farmer
     and r.alert_level is not null;

  if not found then
    return false;
  end if;

  update public.notification_events
     set dismissed_at = now(),
         read_at = coalesce(read_at, now())
   where id = p_notification_id;

  begin
    perform public.record_intelligence_feedback(
      'alert-dismiss:' || p_notification_id::text,
      'dismissed',
      v_recommendation,
      null,
      null,
      jsonb_build_object('screen', 'alerts')
    );
  exception when others then
    -- The dismissal is the farmer's action and must not be undone by a ranking
    -- side-effect failure. The event remains the source of truth.
    perform public.write_audit(
      'alert.feedback_failed', 'notification_events', p_notification_id, null,
      null, sqlerrm, jsonb_build_object('recommendation_id', v_recommendation)
    );
  end;

  perform public.write_audit(
    'alert.dismissed', 'notification_events', p_notification_id, null,
    null, 'dismissed', jsonb_build_object('recommendation_id', v_recommendation)
  );

  return true;
end;
$$;

create or replace function public.mark_all_alerts_read()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party uuid := public.current_party_id();
  v_farmer uuid := public.current_farmer_id();
  v_count integer := 0;
begin
  if v_party is null or v_farmer is null then
    return 0;
  end if;

  with marked as (
    update public.notification_events n
       set read_at = now()
     where n.party_id = v_party
       and n.read_at is null
       and n.dismissed_at is null
       and exists (
         select 1 from public.recommendations r
          where r.id = n.recommendation_id
            and r.farmer_id = v_farmer
            and r.alert_level is not null
       )
    returning 1
  )
  select count(*) into v_count from marked;

  return v_count;
end;
$$;

create or replace function public.job_refresh_all_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer uuid;
  v_total integer := 0;
begin
  for v_farmer in
    select fp.party_id
      from public.farmer_profiles fp
     where fp.default_lat is not null
       and fp.default_lon is not null
       and exists (
         select 1 from public.crop_instances c
          where c.farmer_id = fp.party_id and c.closed_at is null
       )
  loop
    v_total := v_total + public.refresh_farmer_alerts(v_farmer);
  end loop;
  return v_total;
end;
$$;

comment on function public.job_refresh_all_alerts() is
  'Service-only scheduler wrapper. It does not widen the authenticated path and is bounded by each farmer''s own cooldown.';

-- ---------------------------------------------------------------------------
-- Grants and notification write lock
-- ---------------------------------------------------------------------------
revoke update on public.notification_events from authenticated;
drop policy if exists notification_events_mark_read on public.notification_events;

revoke execute on function public.refresh_farmer_alerts(uuid) from public, anon, authenticated;
grant execute on function public.refresh_farmer_alerts(uuid) to service_role;

revoke execute on function public.job_refresh_all_alerts() from public, anon, authenticated;
grant execute on function public.job_refresh_all_alerts() to service_role;

revoke execute on function public.prepare_my_alerts() from public, anon;
grant execute on function public.prepare_my_alerts() to authenticated;

revoke execute on function public.intelligence_alert_feed(integer) from public, anon;
grant execute on function public.intelligence_alert_feed(integer) to authenticated;

revoke execute on function public.mark_alert_read(uuid) from public, anon;
grant execute on function public.mark_alert_read(uuid) to authenticated;

revoke execute on function public.dismiss_alert(uuid) from public, anon;
grant execute on function public.dismiss_alert(uuid) to authenticated;

revoke execute on function public.mark_all_alerts_read() from public, anon;
grant execute on function public.mark_all_alerts_read() to authenticated;

revoke execute on function public.farmer_alert_preferences() from public, anon;
grant execute on function public.farmer_alert_preferences() to authenticated;

revoke execute on function public.set_farmer_alert_preferences(boolean, boolean, text[], integer) from public, anon;
grant execute on function public.set_farmer_alert_preferences(boolean, boolean, text[], integer) to authenticated;

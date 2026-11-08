-- Phase 5.3 · Crop lifecycle intelligence
--
-- The platform already stores a stage on every crop instance and records every
-- transition in crop_stage_history. What it could not answer was: who says so,
-- how sure are they, from which rule version, and may advice rely on it?
--
-- This migration adds that evidence layer without creating a second crop or
-- stage system:
--
--   * `crop_instances` keeps its one canonical stage, now with source,
--     confidence, rule version and evidence;
--   * `stage_source = 'unknown'` is the explicit unknown state. The enum is not
--     extended, so existing consumers keep working and nobody can mistake an
--     unknown stage for `planned`;
--   * calendars live in `crop_lifecycle_calendars` and must be validated before
--     they can be used. No crop calendar is seeded: unsupported crops stay
--     unknown rather than receiving invented durations;
--   * estimation is deterministic and idempotent. It never overwrites a
--     farmer-confirmed stage and records every transition with its evidence;
--   * stage-sensitive recommendations and alerts only qualify when the stage is
--     confirmed or estimated above the configured confidence floor.

-- ---------------------------------------------------------------------------
-- Lifecycle provenance on the existing crop instance
-- ---------------------------------------------------------------------------
alter table public.crop_instances
  add column variety             text,
  add column stage_source        text not null default 'unknown',
  add column stage_confidence    numeric,
  add column stage_estimated_at  timestamptz,
  add column stage_confirmed_at  timestamptz,
  add column stage_confirmed_by  uuid references public.parties (id),
  add column stage_rule_version  integer,
  add column stage_evidence      jsonb not null default '{}'::jsonb,
  add column stage_inputs_hash   text,
  add column stage_calculated_at timestamptz;

alter table public.crop_instances
  add constraint crop_instances_stage_source_check
    check (stage_source in ('unknown', 'estimated', 'farmer_confirmed', 'agronomist_confirmed')),
  add constraint crop_instances_stage_confidence_check
    check (stage_confidence is null or (stage_confidence >= 0 and stage_confidence <= 1)),
  add constraint crop_instances_variety_check
    check (variety is null or (variety = btrim(variety) and length(variety) between 1 and 80));

comment on column public.crop_instances.stage_source is
  'unknown | estimated | farmer_confirmed | agronomist_confirmed. An estimated stage is never presented as confirmed.';
comment on column public.crop_instances.stage_confidence is
  'Confidence of the current estimate, 0..1. Always 1 for a confirmed stage; null when unknown.';
comment on column public.crop_instances.stage_evidence is
  'Bounded evidence for the current stage: calendar id/version, inputs actually matched, days since sowing and weather context. No coordinates.';

-- App-synced rows came from a stage the farmer chose in the app. Every other
-- legacy row is treated as unknown until it is confirmed or estimated. Guessing
-- `farmer_confirmed` from a non-app row would violate the separation this
-- migration exists to enforce.
update public.crop_instances
   set stage_source = case when app_synced then 'farmer_confirmed' else 'unknown' end,
       stage_confidence = case when app_synced then 1 else null end,
       stage_confirmed_at = case when app_synced then updated_at else null end;

alter table public.crop_stage_history
  add column stage_source text,
  add column confidence   numeric,
  add column rule_version integer,
  add column evidence     jsonb;

comment on column public.crop_stage_history.stage_source is
  'How the value was reached: farmer_confirmed, agronomist_confirmed, estimated or unknown (withdrawal).';

-- ---------------------------------------------------------------------------
-- Calendars: configurable, versioned, and inert until validated
-- ---------------------------------------------------------------------------
-- A calendar is an ordered list of inclusive day windows from sowing:
--   [{"stage":"sown","start_day":0,"end_day":7}, ...]
-- The validator checks structure and lifecycle order only. It deliberately does
-- not judge whether the durations are agronomically right; that is what
-- validated_by / validated_at / source_url record.
create or replace function public.agri_validate_stage_calendar(p_stages jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_order constant text[] := array[
    'planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested'
  ];
  v_item      jsonb;
  v_stage     text;
  v_start     integer;
  v_end       integer;
  v_prev_end  integer := -1;
  v_prev_idx  integer := -1;
  v_idx       integer;
  v_first     boolean := true;
begin
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then
    return 'stages must be a non-empty array';
  end if;

  for v_item in select value from jsonb_array_elements(p_stages) loop
    if jsonb_typeof(v_item) <> 'object' then
      return 'each stage must be an object';
    end if;

    v_stage := v_item->>'stage';
    v_idx := array_position(v_order, v_stage);
    if v_stage is null or v_idx is null then
      return 'unknown or unsupported calendar stage: ' || coalesce(v_stage, '(null)');
    end if;

    begin
      v_start := (v_item->>'start_day')::integer;
    exception when others then
      return 'start_day must be an integer';
    end;
    begin
      v_end := (v_item->>'end_day')::integer;
    exception when others then
      return 'end_day must be an integer or null';
    end;

    if v_start is null or v_start < 0 then
      return 'start_day must be >= 0';
    end if;
    if v_end is not null and v_end < v_start then
      return 'end_day must be >= start_day';
    end if;
    if v_first and v_start <> 0 then
      return 'the first stage must start at day 0';
    end if;
    if v_start <> v_prev_end + 1 then
      return 'stage windows must be contiguous';
    end if;
    if v_idx <= v_prev_idx then
      return 'stages must follow lifecycle order and may not repeat';
    end if;

    v_prev_end := coalesce(v_end, 100000);
    v_prev_idx := v_idx;
    v_first := false;
  end loop;

  if v_prev_end < 20 then
    return 'calendar must cover at least 20 days or leave the final window open';
  end if;

  return null;
end;
$$;

comment on function public.agri_validate_stage_calendar(jsonb) is
  'Structural and lifecycle-order validation for a calendar. Returns null when valid, otherwise the reason. It does not invent or judge agronomic durations.';

create table public.crop_lifecycle_calendars (
  id            uuid primary key default gen_random_uuid(),
  crop_code     text not null references public.crop_catalog (code),
  -- Null means "any variety" or "any district". A more specific row always wins.
  variety       text,
  district      text,
  rule_version  integer not null check (rule_version > 0),
  stages        jsonb not null,
  source_code   text,
  source_url    text check (source_url is null or source_url ~ '^https://[^[:space:]]+$'),
  is_validated  boolean not null default false,
  validated_by  uuid references public.parties (id),
  validated_at  timestamptz,
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint crop_lifecycle_calendar_shape
    check (public.agri_validate_stage_calendar(stages) is null),
  constraint crop_lifecycle_calendar_variety
    check (variety is null or (variety = btrim(variety) and length(variety) between 1 and 80)),
  constraint crop_lifecycle_calendar_district
    check (district is null or (district = btrim(district) and length(district) between 1 and 80)),
  constraint crop_lifecycle_calendar_validation
    check (not is_validated or (validated_by is not null and validated_at is not null and source_url is not null))
);

comment on table public.crop_lifecycle_calendars is
  'Versioned crop stage calendars. Only is_validated rows are used for estimation. No row is seeded by this migration: a crop without a validated calendar remains stage_unknown.';

create unique index crop_lifecycle_calendars_unique_idx
  on public.crop_lifecycle_calendars (crop_code, coalesce(variety, ''), coalesce(district, ''), rule_version);

create index crop_lifecycle_calendars_lookup_idx
  on public.crop_lifecycle_calendars (crop_code, variety, district)
  where is_active and is_validated;

create trigger crop_lifecycle_calendars_touch
  before update on public.crop_lifecycle_calendars
  for each row execute function public.touch_updated_at();

alter table public.crop_lifecycle_calendars enable row level security;

create policy crop_lifecycle_calendars_admin_read
  on public.crop_lifecycle_calendars for select to authenticated
  using (public.has_capability('admin'));

revoke insert, update, delete on public.crop_lifecycle_calendars from anon, authenticated;
grant select on public.crop_lifecycle_calendars to authenticated;

-- ---------------------------------------------------------------------------
-- One eligibility predicate, used by every stage-sensitive producer
-- ---------------------------------------------------------------------------
create or replace function public.agri_stage_matches(
  p_source         text,
  p_confidence     numeric,
  p_stage          public.crop_stage,
  p_required       public.crop_stage[],
  p_min_confidence numeric default 0.7
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_required is null or cardinality(p_required) = 0 then true
    when p_stage is null then false
    when p_source in ('farmer_confirmed', 'agronomist_confirmed') then p_stage = any (p_required)
    when p_source = 'estimated'
      and p_confidence is not null
      and p_confidence >= greatest(0::numeric, least(1::numeric, coalesce(p_min_confidence, 0.7)))
      then p_stage = any (p_required)
    else false
  end;
$$;

comment on function public.agri_stage_matches(text, numeric, public.crop_stage, public.crop_stage[], numeric) is
  'The stage gate: confirmed stages always qualify; estimates only above the confidence floor; unknown never qualifies for stage-specific advice.';

insert into public.intelligence_config (key, value, description) values
  ('stage_rule_version', '1'::jsonb,
   'Version of the deterministic lifecycle estimator.'),
  ('stage_confidence_min_for_advice', '0.7'::jsonb,
   'Minimum estimate confidence before stage-specific advice may rely on it.'),
  ('stage_recalc_min_hours', '12'::jsonb,
   'Minimum interval before an unchanged estimate is recalculated.')
on conflict (key) do update
  set value = excluded.value,
      version = public.intelligence_config.version + 1,
      description = excluded.description,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- The existing history trigger now records provenance as well as the stage
-- ---------------------------------------------------------------------------
create or replace function public.enforce_crop_stage_progress()
returns trigger
language plpgsql
as $$
declare
  v_order constant text[] := array[
    'planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested'
  ];
  v_from_idx integer;
  v_to_idx   integer;
begin
  if new.stage is distinct from old.stage then
    if new.stage = 'failed' then
      null;
    else
      v_from_idx := array_position(v_order, old.stage::text);
      v_to_idx   := array_position(v_order, new.stage::text);

      if v_from_idx is not null and v_to_idx is not null and v_to_idx < v_from_idx then
        if coalesce(btrim(current_setting('app.stage_correction_reason', true)), '') = '' then
          raise exception
            'Moving a crop from % back to % is a correction and requires a reason.',
            old.stage, new.stage
            using errcode = 'check_violation';
        end if;
      end if;
    end if;

    insert into public.crop_stage_history (
      crop_id, from_stage, to_stage, changed_by, reason,
      stage_source, confidence, rule_version, evidence
    ) values (
      new.id,
      old.stage,
      new.stage,
      public.current_party_id(),
      nullif(btrim(current_setting('app.stage_correction_reason', true)), ''),
      new.stage_source,
      new.stage_confidence,
      new.stage_rule_version,
      new.stage_evidence
    );
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deterministic stage recalculation
-- ---------------------------------------------------------------------------
-- The estimator reads only existing inputs: the crop instance, live confirmed
-- facts, the farmer's district and the richest validated calendar. Weather is
-- recorded as context, never used to shift a stage because no validated
-- weather-to-stage thresholds exist in this repository.
create or replace function public.agri_recalculate_crop_stage(
  p_crop_id uuid,
  p_now     timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_crop             public.crop_instances;
  v_district         text;
  v_variety          text;
  v_sown_on          date;
  v_days             integer;
  v_cal              public.crop_lifecycle_calendars;
  v_stage            public.crop_stage;
  v_stage_text       text;
  v_confidence       numeric;
  v_reason           text;
  v_evidence         jsonb;
  v_hash             text;
  v_min_hours        integer := 12;
  v_old_stage        public.crop_stage;
  v_old_source       text;
  v_weather          record;
  v_weather_json     jsonb := '{}'::jsonb;
  v_matched_variety  boolean := false;
  v_matched_district boolean := false;
  v_rule_version     integer;
  v_calendar_id      uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('crop-stage:' || p_crop_id::text, 0));

  select * into v_crop from public.crop_instances where id = p_crop_id;
  if not found then
    raise exception 'Crop % not found.', p_crop_id using errcode = 'no_data_found';
  end if;
  if v_crop.closed_at is not null then
    return jsonb_build_object('status', 'closed', 'crop_id', p_crop_id);
  end if;

  -- A confirmed stage is never silently replaced by an estimate.
  if v_crop.stage_source in ('farmer_confirmed', 'agronomist_confirmed') then
    return jsonb_build_object(
      'status', 'confirmed',
      'crop_id', p_crop_id,
      'stage', v_crop.stage,
      'stage_source', v_crop.stage_source
    );
  end if;

  select coalesce((value #>> '{}')::integer, 12) into v_min_hours
    from public.intelligence_config where key = 'stage_recalc_min_hours';

  select district into v_district
    from public.farmer_intelligence_profiles where farmer_id = v_crop.farmer_id;

  v_variety := nullif(btrim(coalesce(
    v_crop.variety,
    (select f.value_text from public.crop_facts f
      where f.crop_id = v_crop.id and f.fact_key = 'variety' and f.superseded_at is null
      order by f.stated_at desc limit 1)
  )), '');

  v_sown_on := coalesce(
    v_crop.sown_on,
    (select f.value_date from public.crop_facts f
      where f.crop_id = v_crop.id and f.fact_key = 'sown_on'
        and f.superseded_at is null and f.value_date is not null
      order by f.stated_at desc limit 1)
  );

  if v_sown_on is null then
    v_reason := 'sowing_date_missing';
  elsif v_sown_on > p_now::date then
    v_reason := 'sowing_date_future';
  elsif p_now::date - v_sown_on > 1500 then
    v_reason := 'sowing_date_too_old';
  end if;

  if v_reason is null then
    select * into v_cal
      from public.crop_lifecycle_calendars c
     where c.crop_code = v_crop.crop_code
       and c.is_active
       and c.is_validated
       and (c.variety is null or c.variety = v_variety)
       and (c.district is null or c.district = v_district)
     order by (c.variety is not null) desc,
              (c.district is not null) desc,
              c.rule_version desc,
              c.created_at desc
     limit 1;

    if not found then
      v_reason := 'calendar_unavailable';
    else
      v_rule_version := v_cal.rule_version;
      v_calendar_id := v_cal.id;
    end if;
  end if;

  if v_reason is null then
    v_days := p_now::date - v_sown_on;

    select s->>'stage' into v_stage_text
      from jsonb_array_elements(v_cal.stages) s
     where v_days >= (s->>'start_day')::integer
       and (s->>'end_day' is null or v_days <= (s->>'end_day')::integer)
     limit 1;

    if v_stage_text is null then
      v_reason := 'outside_calendar';
    else
      v_stage := v_stage_text::public.crop_stage;
    end if;
  end if;

  if v_reason is null then
    v_matched_variety := v_cal.variety is not null;
    v_matched_district := v_cal.district is not null;

    v_confidence := case
      when v_matched_variety and v_matched_district then 0.90
      when v_matched_variety then 0.80
      when v_matched_district then 0.75
      else 0.60
    end;
    if v_variety is not null and not v_matched_variety then
      v_confidence := v_confidence - 0.05;
    end if;
    if v_district is not null and not v_matched_district then
      v_confidence := v_confidence - 0.05;
    end if;
    v_confidence := round(greatest(0.40, least(0.95, v_confidence)), 2);
  end if;

  -- Weather is recorded as evidence of conditions, not used as a stage rule.
  select * into v_weather
    from public.farmer_profiles fp
    cross join lateral public.latest_weather(fp.default_lat, fp.default_lon) w
   where fp.party_id = v_crop.farmer_id
     and fp.default_lat is not null
     and fp.default_lon is not null
   order by w.observed_at desc
   limit 1;

  if found then
    v_weather_json := jsonb_strip_nulls(jsonb_build_object(
      'provider', v_weather.provider_code,
      'observed_at', v_weather.observed_at,
      'usable', v_weather.is_usable,
      'temp_c', v_weather.temp_c
    ));
  end if;

  v_hash := md5(concat_ws('|',
    v_crop.id::text,
    v_crop.crop_code,
    coalesce(v_variety, ''),
    coalesce(v_sown_on::text, ''),
    coalesce(v_district, ''),
    coalesce(v_calendar_id::text, ''),
    coalesce(v_rule_version::text, ''),
    coalesce(v_reason, '')
  ));

  if v_hash = v_crop.stage_inputs_hash
     and v_crop.stage_calculated_at is not null
     and v_crop.stage_calculated_at > p_now - make_interval(hours => greatest(1, least(v_min_hours, 168))) then
    return jsonb_build_object(
      'status', 'unchanged',
      'crop_id', p_crop_id,
      'stage', v_crop.stage,
      'stage_source', v_crop.stage_source,
      'confidence', v_crop.stage_confidence
    );
  end if;

  v_old_stage := v_crop.stage;
  v_old_source := v_crop.stage_source;

  if v_reason is not null then
    v_evidence := jsonb_strip_nulls(jsonb_build_object(
      'reason', v_reason,
      'sown_on', v_sown_on,
      'variety', v_variety,
      'district', v_district,
      'weather', v_weather_json,
      'calculated_at', p_now
    ));

    update public.crop_instances
       set stage_source = 'unknown',
           stage_confidence = null,
           stage_estimated_at = null,
           stage_rule_version = null,
           stage_evidence = v_evidence,
           stage_inputs_hash = v_hash,
           stage_calculated_at = p_now
     where id = v_crop.id;

    if v_old_source is distinct from 'unknown' then
      insert into public.crop_stage_history (
        crop_id, from_stage, to_stage, changed_by, reason,
        stage_source, evidence
      ) values (
        v_crop.id, v_old_stage, v_old_stage, null,
        'stage estimate withdrawn: ' || v_reason,
        'unknown', v_evidence
      );
    end if;

    perform public.write_audit(
      'crop.stage_unknown', 'crop_instances', v_crop.id, v_crop.crop_code,
      v_old_stage::text, 'unknown',
      jsonb_build_object('reason', v_reason, 'rule_version', v_rule_version),
      null, 'system'
    );

    return jsonb_build_object(
      'status', 'unknown',
      'crop_id', p_crop_id,
      'reason', v_reason,
      'stage', 'stage_unknown',
      'stage_source', 'unknown',
      'evidence', v_evidence
    );
  end if;

  v_evidence := jsonb_strip_nulls(jsonb_build_object(
    'reason', 'calendar_match',
    'calendar_id', v_cal.id,
    'calendar_version', v_cal.rule_version,
    'sown_on', v_sown_on,
    'days_since_sowing', v_days,
    'variety', v_variety,
    'district', v_district,
    'variety_matched', v_matched_variety,
    'district_matched', v_matched_district,
    'weather', v_weather_json,
    'calculated_at', p_now
  ));

  if v_stage is distinct from v_old_stage then
    perform set_config(
      'app.stage_correction_reason',
      'stage estimated from lifecycle calendar ' || v_cal.rule_version::text,
      true
    );

    update public.crop_instances
       set stage = v_stage,
           stage_source = 'estimated',
           stage_confidence = v_confidence,
           stage_estimated_at = p_now,
           stage_rule_version = v_cal.rule_version,
           stage_evidence = v_evidence,
           stage_inputs_hash = v_hash,
           stage_calculated_at = p_now
     where id = v_crop.id;
  else
    update public.crop_instances
       set stage_source = 'estimated',
           stage_confidence = v_confidence,
           stage_estimated_at = p_now,
           stage_rule_version = v_cal.rule_version,
           stage_evidence = v_evidence,
           stage_inputs_hash = v_hash,
           stage_calculated_at = p_now
     where id = v_crop.id;

    -- The row changed from unknown to estimated without changing stage, so the
    -- before-update trigger had nothing to record. Keep that provenance edge.
    if v_old_source is distinct from 'estimated' then
      insert into public.crop_stage_history (
        crop_id, from_stage, to_stage, changed_by, reason,
        stage_source, confidence, rule_version, evidence
      ) values (
        v_crop.id, v_old_stage, v_stage, null,
        'stage estimate recorded from lifecycle calendar ' || v_cal.rule_version::text,
        'estimated', v_confidence, v_cal.rule_version, v_evidence
      );
    end if;
  end if;

  insert into public.crop_inferences (
    crop_id, inference_key, value_text, derived_from, confidence, evidence, expires_at
  ) values (
    v_crop.id, 'growth_stage', v_stage::text, 'crop_lifecycle_calendar', v_confidence,
    v_evidence, p_now + interval '30 days'
  );

  perform public.write_audit(
    'crop.stage_estimated', 'crop_instances', v_crop.id, v_crop.crop_code,
    v_old_stage::text, v_stage::text,
    jsonb_build_object(
      'confidence', v_confidence,
      'rule_version', v_cal.rule_version,
      'calendar_id', v_cal.id
    ),
    null, 'system'
  );

  return jsonb_build_object(
    'status', 'estimated',
    'crop_id', p_crop_id,
    'stage', v_stage,
    'stage_source', 'estimated',
    'confidence', v_confidence,
    'rule_version', v_cal.rule_version,
    'evidence', v_evidence
  );
end;
$$;

comment on function public.agri_recalculate_crop_stage(uuid, timestamptz) is
  'Deterministic, idempotent stage estimation. Refuses to touch a confirmed stage; writes unknown when inputs or a validated calendar are missing; records rule version and evidence.';

create or replace function public.recalculate_my_crop_stage(p_crop_id uuid)
returns jsonb
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
  if not exists (
    select 1 from public.crop_instances
     where id = p_crop_id and farmer_id = v_farmer
  ) then
    raise exception 'Crop % not found for this farmer.', p_crop_id using errcode = 'insufficient_privilege';
  end if;
  return public.agri_recalculate_crop_stage(p_crop_id);
end;
$$;

comment on function public.recalculate_my_crop_stage(uuid) is
  'Authenticated recalculation for the caller''s own crop. The farmer id always comes from the JWT.';

-- ---------------------------------------------------------------------------
-- Farmer confirmation and correction
-- ---------------------------------------------------------------------------
create or replace function public.confirm_crop_stage(
  p_crop_id uuid,
  p_stage   public.crop_stage,
  p_reason  text default null
)
returns public.crop_instances
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer    uuid := public.current_farmer_id();
  v_row       public.crop_instances;
  v_old_stage public.crop_stage;
  v_evidence  jsonb;
begin
  if v_farmer is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;
  if p_stage is null then
    raise exception 'A stage is required.' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row
    from public.crop_instances
   where id = p_crop_id and farmer_id = v_farmer
   for update;

  if not found then
    raise exception 'Crop % not found for this farmer.', p_crop_id using errcode = 'insufficient_privilege';
  end if;
  if v_row.closed_at is not null then
    raise exception 'A closed crop cannot be confirmed.' using errcode = 'check_violation';
  end if;

  v_old_stage := v_row.stage;

  if p_stage is distinct from v_old_stage
     and p_stage <> 'failed'
     and array_position(
           array['planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested'],
           p_stage::text
         ) < array_position(
           array['planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested'],
           v_old_stage::text
         )
     and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A backward stage change requires a reason.' using errcode = 'check_violation';
  end if;

  perform set_config(
    'app.stage_correction_reason',
    coalesce(nullif(btrim(p_reason), ''), 'farmer confirmed stage'),
    true
  );

  v_evidence := jsonb_strip_nulls(jsonb_build_object(
    'reason', 'farmer_confirmation',
    'confirmed_via', 'authenticated_farmer',
    'note', nullif(btrim(p_reason), ''),
    'confirmed_at', now()
  ));

  update public.crop_instances
     set stage = p_stage,
         stage_source = 'farmer_confirmed',
         stage_confidence = 1,
         stage_confirmed_at = now(),
         stage_confirmed_by = public.current_party_id(),
         stage_estimated_at = null,
         stage_rule_version = null,
         stage_evidence = v_evidence,
         stage_inputs_hash = null,
         stage_calculated_at = null
   where id = p_crop_id
   returning * into v_row;

  -- A confirmation of the same stage is still a provenance change; the stage
  -- trigger correctly stays silent, so record the confirmation here.
  if v_old_stage = p_stage then
    insert into public.crop_stage_history (
      crop_id, from_stage, to_stage, changed_by, reason,
      stage_source, confidence, evidence
    ) values (
      p_crop_id, v_old_stage, p_stage, public.current_party_id(),
      coalesce(nullif(btrim(p_reason), ''), 'farmer confirmed stage'),
      'farmer_confirmed', 1, v_evidence
    );
  end if;

  perform public.write_audit(
    'crop.stage_confirmed', 'crop_instances', p_crop_id, v_row.crop_code,
    v_old_stage::text, p_stage::text,
    jsonb_build_object('source', 'farmer', 'reason', nullif(btrim(p_reason), '')),
    public.current_party_id(), 'farmer'
  );

  return v_row;
end;
$$;

comment on function public.confirm_crop_stage(uuid, public.crop_stage, text) is
  'Farmer-confirmed stage. Always overwrites an estimate, never the reverse; history and audit record the actor and reason.';

create or replace function public.correct_crop_stage(
  p_crop_id uuid,
  p_stage   public.crop_stage,
  p_reason  text
)
returns public.crop_instances
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A stage correction requires a reason.' using errcode = 'check_violation';
  end if;
  return public.confirm_crop_stage(p_crop_id, p_stage, p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Input-change triggers and the scheduled batch seam
-- ---------------------------------------------------------------------------
create or replace function public.agri_crop_inputs_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.agri_recalculate_crop_stage(new.id);
  return null;
end;
$$;

create trigger crop_instances_lifecycle_inputs
  after update of sown_on, variety on public.crop_instances
  for each row when (new.closed_at is null)
  execute function public.agri_crop_inputs_changed();

create or replace function public.agri_crop_fact_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.fact_key in ('sown_on', 'variety') then
    perform public.agri_recalculate_crop_stage(new.crop_id);
  end if;
  return null;
end;
$$;

create trigger crop_facts_lifecycle_inputs
  after insert or update of fact_key, value_text, value_date on public.crop_facts
  for each row when (new.superseded_at is null)
  execute function public.agri_crop_fact_changed();

-- Superseding a live sowing date or variety must also recalculate, because the
-- estimator may need to fall back to another live fact or to unknown.
create trigger crop_facts_lifecycle_superseded
  after update of superseded_at on public.crop_facts
  for each row when (new.superseded_at is not null and old.superseded_at is null)
  execute function public.agri_crop_fact_changed();

create or replace function public.job_refresh_crop_stages()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id    uuid;
  v_count integer := 0;
  v_res   jsonb;
begin
  for v_id in
    select c.id
      from public.crop_instances c
     where c.closed_at is null
       and c.stage_source not in ('farmer_confirmed', 'agronomist_confirmed')
       and (
         c.sown_on is not null
         or exists (
           select 1 from public.crop_facts f
            where f.crop_id = c.id
              and f.fact_key = 'sown_on'
              and f.superseded_at is null
         )
       )
     order by c.id
  loop
    v_res := public.agri_recalculate_crop_stage(v_id);
    if v_res->>'status' = 'estimated' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function public.job_refresh_crop_stages() is
  'Service-only daily seam for recalculating open unconfirmed crops. The estimator is idempotent, so running it more often is safe.';

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
      select jsonb_build_object(
        'crop_id', ci.id,
        'crop_code', ci.crop_code,
        'stage', case when ci.stage_source = 'unknown' then 'stage_unknown' else ci.stage::text end,
        'stage_source', ci.stage_source,
        'stage_confidence', ci.stage_confidence,
        'stage_is_unknown', (ci.stage_source = 'unknown'),
        'stage_estimated_at', ci.stage_estimated_at,
        'stage_confirmed_at', ci.stage_confirmed_at,
        'stage_rule_version', ci.stage_rule_version
      )
        from public.crop_instances ci
       where ci.farmer_id = v_farmer and ci.is_primary and ci.closed_at is null
       limit 1
    ),
    'crops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'crop_id', ci.id,
        'crop_code', ci.crop_code,
        'stage', case when ci.stage_source = 'unknown' then 'stage_unknown' else ci.stage::text end,
        'stage_source', ci.stage_source,
        'stage_confidence', ci.stage_confidence,
        'stage_is_unknown', (ci.stage_source = 'unknown'),
        'stage_estimated_at', ci.stage_estimated_at,
        'stage_confirmed_at', ci.stage_confirmed_at,
        'stage_rule_version', ci.stage_rule_version,
        'primary', ci.is_primary
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
  v_min_conf   numeric := 0.7;
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
  select coalesce((value #>> '{}')::numeric, 0.7) into v_min_conf
    from public.intelligence_config where key = 'stage_confidence_min_for_advice';

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
       and public.agri_stage_matches(c.stage_source, c.stage_confidence, c.stage, array[r.stage], v_min_conf)
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
         or public.agri_stage_matches(c.stage_source, c.stage_confidence, c.stage, e.applies_to_stages, v_min_conf)
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

-- Synchronization now carries sowing date, variety and provenance
-- ---------------------------------------------------------------------------
create or replace function public.sync_my_crops(p_crops jsonb default '[]'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farmer          uuid := public.current_farmer_id();
  v_item            jsonb;
  v_code            text;
  v_stage_text      text;
  v_stage           public.crop_stage;
  v_stage_given     boolean;
  v_primary         boolean;
  v_primary_code    text;
  v_current_primary text;
  v_row             public.crop_instances;
  v_codes           text[] := '{}'::text[];
  v_changed         boolean := false;
  v_count           integer := 0;
  v_sown_on         date;
  v_variety         text;
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

  perform set_config('app.stage_correction_reason', 'active crop list synchronized from the app', true);

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

    v_stage_text := nullif(btrim(v_item->>'stage'), '');
    v_stage_given := v_stage_text is not null;
    if v_stage_given then
      if v_stage_text not in
         ('planned','sown','germinating','vegetative','flowering','fruiting','maturity','harvested','failed') then
        raise exception 'Unknown crop stage: %', v_stage_text using errcode = 'check_violation';
      end if;
      v_stage := v_stage_text::public.crop_stage;
    else
      v_stage := null;
    end if;

    v_sown_on := null;
    if nullif(btrim(v_item->>'sown_on'), '') is not null then
      begin
        v_sown_on := (v_item->>'sown_on')::date;
      exception when others then
        raise exception 'sown_on must be an ISO date.' using errcode = 'check_violation';
      end;
      if v_sown_on > current_date then
        raise exception 'sown_on may not be in the future.' using errcode = 'check_violation';
      end if;
      if v_sown_on < current_date - 1500 then
        raise exception 'sown_on is too far in the past.' using errcode = 'check_violation';
      end if;
    end if;

    v_variety := nullif(btrim(v_item->>'variety'), '');
    if v_variety is not null and length(v_variety) > 80 then
      raise exception 'variety must be 80 characters or fewer.' using errcode = 'check_violation';
    end if;

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
      if v_row.stage is distinct from coalesce(v_stage, v_row.stage)
         or v_row.sown_on is distinct from coalesce(v_sown_on, v_row.sown_on)
         or v_row.variety is distinct from coalesce(v_variety, v_row.variety)
         or not v_row.app_synced then
        v_changed := true;
      end if;

      update public.crop_instances
         set stage = coalesce(v_stage, stage),
             stage_source = case when v_stage_given then 'farmer_confirmed' else stage_source end,
             stage_confidence = case when v_stage_given then 1 else stage_confidence end,
             stage_confirmed_at = case when v_stage_given then now() else stage_confirmed_at end,
             stage_confirmed_by = case when v_stage_given then public.current_party_id() else stage_confirmed_by end,
             sown_on = coalesce(v_sown_on, sown_on),
             variety = coalesce(v_variety, variety),
             app_synced = true,
             is_primary = false
       where id = v_row.id;
    else
      insert into public.crop_instances (
        farmer_id, crop_code, stage, stage_source, stage_confidence,
        stage_confirmed_at, stage_confirmed_by, sown_on, variety,
        is_primary, app_synced
      ) values (
        v_farmer, v_code, coalesce(v_stage, 'planned'),
        case when v_stage_given then 'farmer_confirmed' else 'unknown' end,
        case when v_stage_given then 1 else null end,
        case when v_stage_given then now() else null end,
        case when v_stage_given then public.current_party_id() else null end,
        v_sown_on, v_variety, false, true
      ) returning * into v_row;
      v_changed := true;
    end if;

    v_count := v_count + 1;
  end loop;

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
  'Validated, JWT-owned synchronization of the app crop list into the canonical crop table. A supplied stage is a farmer confirmation; an omitted stage is never invented. Carries sowing date and variety, and closes only app-owned stale rows.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.agri_recalculate_crop_stage(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.job_refresh_crop_stages() from public, anon, authenticated;
revoke execute on function public.agri_crop_inputs_changed() from public, anon, authenticated;
revoke execute on function public.agri_crop_fact_changed() from public, anon, authenticated;

revoke execute on function public.recalculate_my_crop_stage(uuid) from public, anon;
revoke execute on function public.confirm_crop_stage(uuid, public.crop_stage, text) from public, anon;
revoke execute on function public.correct_crop_stage(uuid, public.crop_stage, text) from public, anon;
revoke execute on function public.sync_my_crops(jsonb) from public, anon;

grant execute on function public.recalculate_my_crop_stage(uuid) to authenticated;
grant execute on function public.confirm_crop_stage(uuid, public.crop_stage, text) to authenticated;
grant execute on function public.correct_crop_stage(uuid, public.crop_stage, text) to authenticated;
grant execute on function public.sync_my_crops(jsonb) to authenticated;
grant execute on function public.agri_stage_matches(text, numeric, public.crop_stage, public.crop_stage[], numeric) to authenticated;

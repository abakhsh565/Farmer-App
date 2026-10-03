-- Farmer App · migration 0003 · crops, facts and signals
--
-- PRD requirements being made structural here:
--
--   * Several active crop instances per farmer, not one "current crop".
--   * Confirmed facts and inferred signals are separate concepts.
--   * An inference may never silently overwrite a confirmed crop fact.
--   * Whose behaviour produced a signal, when, and how strongly it still counts.
--
-- The third rule is not enforced by convention. `crop_facts.source_kind` has a
-- CHECK constraint that makes an inferred value literally unrepresentable in
-- the facts table, so no future code path can promote one by accident.

-- ---------------------------------------------------------------------------
-- Crop catalog
-- ---------------------------------------------------------------------------

create table public.crop_catalog (
  code            text primary key,
  name_en         text not null,
  name_ur         text not null,
  -- Additional regional names live in jsonb so adding Saraiki/Sindhi/Pashto is
  -- a data change, not a migration.
  names_local     jsonb not null default '{}'::jsonb,
  seasons         public.crop_season[] not null,
  -- Typical days from sowing to harvest, used to sanity-check farmer input and
  -- to place a crop on its lifecycle without asking again.
  cycle_days      integer check (cycle_days between 20 and 1500),
  is_active       boolean not null default true
);

insert into public.crop_catalog (code, name_en, name_ur, seasons, cycle_days) values
  ('cotton',     'Cotton',     'کپاس',      '{kharif}',            180),
  ('wheat',      'Wheat',      'گندم',      '{rabi}',              150),
  ('rice',       'Rice',       'چاول',      '{kharif}',            130),
  ('maize',      'Maize',      'مکئی',      '{kharif,rabi,zaid}',  105),
  ('sugarcane',  'Sugarcane',  'گنا',       '{kharif,perennial}',  365),
  ('gram',       'Gram',       'چنا',       '{rabi}',              120),
  ('potato',     'Potato',     'آلو',       '{rabi}',               95),
  ('mustard',    'Mustard',    'سرسوں',     '{rabi}',              110),
  ('mungbean',   'Mung bean',  'ماش',       '{kharif,zaid}',        75),
  ('onion',      'Onion',      'پیاز',      '{rabi,kharif}',       150);

-- ---------------------------------------------------------------------------
-- Crop instances
-- ---------------------------------------------------------------------------

create table public.crop_instances (
  id             uuid primary key default gen_random_uuid(),
  farmer_id      uuid not null references public.farmer_profiles (party_id) on delete cascade,
  crop_code      text not null references public.crop_catalog (code),
  label          text,
  season         public.crop_season,
  stage          public.crop_stage not null default 'planned',
  area_acres     numeric check (area_acres > 0 and area_acres < 10000),
  sown_on        date,
  expected_harvest_on date,
  closed_at      timestamptz,
  -- The instance the home screen leads with. PRD: one primary, others active.
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index crop_instances_farmer_idx on public.crop_instances (farmer_id, closed_at);
create trigger crop_instances_touch before update on public.crop_instances
  for each row execute function public.touch_updated_at();

-- Exactly one primary crop per farmer at a time, among open instances.
create unique index crop_instances_one_primary_idx
  on public.crop_instances (farmer_id)
  where is_primary and closed_at is null;

comment on table public.crop_instances is
  'One planting. A farmer may hold several active instances; the unique partial index keeps exactly one marked primary, so "my main crop" is a fact about the data rather than a UI convention.';

-- Stage changes are recorded, including corrections. The PRD wants the
-- lifecycle respected, and respect is only checkable if history exists.
create table public.crop_stage_history (
  id            bigserial primary key,
  crop_id       uuid not null references public.crop_instances (id) on delete cascade,
  from_stage    public.crop_stage,
  to_stage      public.crop_stage not null,
  changed_by    uuid references public.parties (id),
  reason        text,
  created_at    timestamptz not null default now()
);

create index crop_stage_history_crop_idx on public.crop_stage_history (crop_id, created_at desc);

-- The lifecycle may move forward freely; going backwards is a correction and
-- must say why. Enforced here rather than in the client.
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
      -- Failure is always recordable, from anywhere.
      null;
    else
      v_from_idx := array_position(v_order, old.stage::text);
      v_to_idx   := array_position(v_order, new.stage::text);

      if v_from_idx is not null and v_to_idx is not null and v_to_idx < v_from_idx then
        -- A correction. Permitted, but it must leave a trail with a reason.
        if coalesce(btrim(current_setting('app.stage_correction_reason', true)), '') = '' then
          raise exception
            'Moving a crop from % back to % is a correction and requires a reason.',
            old.stage, new.stage
            using errcode = 'check_violation';
        end if;
      end if;
    end if;

    insert into public.crop_stage_history (crop_id, from_stage, to_stage, changed_by, reason)
    values (
      new.id,
      old.stage,
      new.stage,
      public.current_party_id(),
      nullif(btrim(current_setting('app.stage_correction_reason', true)), '')
    );
  end if;

  return new;
end;
$$;

create trigger crop_instances_stage_progress
  before update on public.crop_instances
  for each row execute function public.enforce_crop_stage_progress();

-- RPC that a correction must travel through, so the reason is always supplied.
create or replace function public.correct_crop_stage(
  p_crop_id  uuid,
  p_stage    public.crop_stage,
  p_reason   text
)
returns public.crop_instances
language plpgsql
security invoker
as $$
declare
  v_row public.crop_instances;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A stage correction requires a reason.' using errcode = 'check_violation';
  end if;

  perform set_config('app.stage_correction_reason', p_reason, true);

  update public.crop_instances
     set stage = p_stage
   where id = p_crop_id
  returning * into v_row;

  if not found then
    raise exception 'Crop % not found.', p_crop_id using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirmed facts
-- ---------------------------------------------------------------------------

create table public.crop_facts (
  id             uuid primary key default gen_random_uuid(),
  crop_id        uuid not null references public.crop_instances (id) on delete cascade,
  fact_key       text not null,
  value_text     text,
  value_number   numeric,
  value_date     date,
  value_json     jsonb,
  -- Only these three may appear. `inferred` is absent on purpose: the facts
  -- table cannot hold a guess.
  source_kind    text not null check (source_kind in ('farmer_stated', 'dealer_stated', 'imported')),
  source_ref     text,
  stated_by      uuid references public.parties (id),
  stated_at      timestamptz not null default now(),
  -- Superseded rather than deleted, so a corrected fact keeps its history.
  superseded_at  timestamptz,
  superseded_by  uuid references public.crop_facts (id),
  created_at     timestamptz not null default now(),
  constraint crop_facts_one_value check (
    (value_text is not null)::int + (value_number is not null)::int
    + (value_date is not null)::int + (value_json is not null)::int = 1
  )
);

-- One live confirmed value per key. Superseded rows are excluded, so history
-- accumulates while "the current fact" stays unambiguous.
create unique index crop_facts_live_idx
  on public.crop_facts (crop_id, fact_key)
  where superseded_at is null;

create index crop_facts_crop_idx on public.crop_facts (crop_id, stated_at desc);

comment on table public.crop_facts is
  'Confirmed facts only. Because source_kind has no `inferred` member, an inferred value cannot be stored here even by direct SQL — promoting an inference to a fact requires a human act through confirm_inference_as_fact().';

-- ---------------------------------------------------------------------------
-- Inferred signals
-- ---------------------------------------------------------------------------

create table public.crop_inferences (
  id             uuid primary key default gen_random_uuid(),
  crop_id        uuid not null references public.crop_instances (id) on delete cascade,
  inference_key  text not null,
  value_text     text,
  value_number   numeric,
  value_json     jsonb,
  -- How the guess was reached. The PRD wants a source for every inference.
  derived_from   text not null,
  confidence     numeric not null check (confidence >= 0 and confidence <= 1),
  -- Supporting evidence, so the UI can answer "why do you think that?".
  evidence       jsonb not null default '{}'::jsonb,
  observed_at    timestamptz not null default now(),
  expires_at     timestamptz,
  -- Set when a human confirmed this inference, linking the fact it became.
  promoted_fact_id uuid references public.crop_facts (id),
  dismissed_at   timestamptz,
  dismissed_by   uuid references public.parties (id),
  created_at     timestamptz not null default now(),
  constraint crop_inferences_expiry check (expires_at is null or expires_at > observed_at)
);

create index crop_inferences_live_idx
  on public.crop_inferences (crop_id, inference_key, observed_at desc)
  where promoted_fact_id is null and dismissed_at is null;

comment on table public.crop_inferences is
  'Guesses, with source, confidence and evidence. Never authoritative: the only route into crop_facts is the explicit confirm RPC below.';

-- The single, auditable promotion path.
create or replace function public.confirm_inference_as_fact(
  p_inference_id uuid,
  p_fact_key     text default null
)
returns public.crop_facts
language plpgsql
security invoker
as $$
declare
  v_inf  public.crop_inferences;
  v_fact public.crop_facts;
  v_key  text;
begin
  select * into v_inf from public.crop_inferences where id = p_inference_id for update;

  if not found then
    raise exception 'Inference % not found.', p_inference_id using errcode = 'no_data_found';
  end if;

  if v_inf.promoted_fact_id is not null then
    raise exception 'Inference % was already confirmed.', p_inference_id using errcode = 'unique_violation';
  end if;

  if v_inf.dismissed_at is not null then
    raise exception 'Inference % was dismissed and cannot be confirmed.', p_inference_id using errcode = 'check_violation';
  end if;

  v_key := coalesce(p_fact_key, v_inf.inference_key);

  -- Supersede the previous live value, preserving it.
  update public.crop_facts
     set superseded_at = now()
   where crop_id = v_inf.crop_id
     and fact_key = v_key
     and superseded_at is null;

  insert into public.crop_facts (
    crop_id, fact_key, value_text, value_number, value_date, value_json,
    source_kind, source_ref, stated_by
  ) values (
    v_inf.crop_id, v_key, v_inf.value_text, v_inf.value_number, null, v_inf.value_json,
    'farmer_stated',
    'confirmed_inference:' || v_inf.id::text,
    public.current_party_id()
  )
  returning * into v_fact;

  update public.crop_inferences
     set promoted_fact_id = v_fact.id
   where id = v_inf.id;

  perform public.write_audit(
    'crop.inference_confirmed',
    'crop_inferences',
    v_inf.id,
    v_key,
    'inferred',
    'confirmed',
    jsonb_build_object('confidence', v_inf.confidence, 'derived_from', v_inf.derived_from, 'fact_id', v_fact.id)
  );

  return v_fact;
end;
$$;

comment on function public.confirm_inference_as_fact(uuid, text) is
  'The only path from inference to fact. Records who promoted it and what the confidence was, so a wrong guess is traceable to its source.';

-- ---------------------------------------------------------------------------
-- Behavioural signals
-- ---------------------------------------------------------------------------

-- Behaviour informs relevance. It is never a confirmed farmer fact, so it lives
-- here with a source, a time, and a strength that decays.
create table public.behaviour_signals (
  id             bigserial primary key,
  farmer_id      uuid not null references public.farmer_profiles (party_id) on delete cascade,
  signal_type    text not null,
  -- The crop or context the behaviour relates to, so relevance is scoped.
  crop_id        uuid references public.crop_instances (id) on delete set null,
  crop_code      text references public.crop_catalog (code),
  subject        text,
  strength       public.signal_strength not null default 'moderate',
  source         text not null check (source in ('ui_interaction', 'search', 'scan', 'chat', 'community_read', 'notification_open')),
  weight_hint    numeric check (weight_hint >= 0 and weight_hint <= 1),
  detail         jsonb not null default '{}'::jsonb,
  observed_at    timestamptz not null default now()
);

create index behaviour_signals_farmer_idx on public.behaviour_signals (farmer_id, observed_at desc);
create index behaviour_signals_crop_idx   on public.behaviour_signals (crop_code, observed_at desc);

comment on table public.behaviour_signals is
  'Behaviour, not truth. Never copied into crop_facts and never allowed to trigger a notification on its own — it only reorders relevance.';

-- Relevance score for a subject, decaying with age.
create or replace function public.signal_relevance(
  p_farmer_id uuid,
  p_subject   text
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(
    coalesce(s.weight_hint, 1.0) * public.signal_weight(s.observed_at, s.strength)
  ), 0)::numeric
  from public.behaviour_signals s
  where s.farmer_id = p_farmer_id
    and (p_subject is null or s.subject = p_subject or s.crop_code = p_subject);
$$;

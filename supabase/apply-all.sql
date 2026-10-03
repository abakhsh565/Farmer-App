-- GENERATED FILE — do not edit. Run `npm run db:bundle` instead.
--
-- The whole migration chain in one transaction, for applying it through the
-- Supabase dashboard's SQL editor:
--
--   1. open the project → SQL Editor → New query
--   2. paste this entire file
--   3. Run. Either every migration applies, or none of them does.
--
-- 19 migrations, applied in filename order, wrapped in one
-- transaction on purpose: a chain applied half-way is worse than one that has not
-- started, because the next attempt then fails on objects that already exist.
--
-- After it succeeds, check the advisors (Advisors → Security) for any table
-- without row level security, and then verify with:
--   select count(*) from pg_tables where schemaname = 'public';   -- 54

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000100_foundation.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0001 · foundation
--
-- Everything here is shared by later migrations: extensions, the updated_at
-- trigger helper, the audit writer, and the enums that encode PRD vocabulary.
--
-- Vocabulary is deliberate. The PRD separates concepts that a careless schema
-- would collapse (confirmed facts vs inferred signals, reports vs moderation
-- decisions, verification applicants vs verified experts). Those separations
-- are made here, at the type level, so no later code can blur them.

create extension if not exists "pgcrypto" with schema extensions;
-- PostGIS and pgvector deliberately live in the `extensions` schema, which is
-- what Supabase recommends and why every geo call below is written
-- `extensions.st_*` rather than bare `st_*`.
create extension if not exists "postgis" with schema extensions;
-- pgvector backs knowledge retrieval. The embedding column is nullable, so a
-- project without an embedding provider still works in keyword-only mode.
create extension if not exists "vector" with schema extensions;
-- pg_cron: create without naming a schema. Supabase installs it into its own
-- bookkeeping schema and schedules live in cron.schedule, not public.
create extension if not exists "pg_cron";

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at honest without trusting the client to send it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'BEFORE UPDATE trigger. Server owns updated_at; a client that sends its own value is overruled.';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Identity is a two-species model. A farmer and a shop owner are never the same
-- account, and nothing in the schema may merge them by phone number.
create type public.party_kind as enum ('farmer', 'dealer');

-- Where a value came from. `confirmed` is farmer-stated or dealer-stated;
-- `inferred` is derived and may be wrong; `imported` came from another system.
create type public.epistemic_status as enum ('confirmed', 'inferred', 'imported');

create type public.crop_season as enum ('kharif', 'rabi', 'zaid', 'perennial');

-- Crop lifecycle. Ordered; the app advances forward only.
create type public.crop_stage as enum (
  'planned', 'sown', 'germinating', 'vegetative', 'flowering', 'fruiting', 'maturity', 'harvested', 'failed'
);

-- Field visit lifecycle. PRD locks the first three states and requires the
-- architecture to allow the rest without inventing them now.
create type public.visit_status as enum (
  'pending', 'accepted', 'rejected', 'scheduled', 'in_progress', 'completed', 'cancelled'
);

-- The credit state machine, exactly as approved.
--   Requested -> Shop Owner Reviewing -> [Accepted directly | Counteroffered]
--   -> Awaiting Farmer Decision -> Awaiting Shop Owner Final Approval
--   -> Accepted | Rejected
create type public.credit_status as enum (
  'requested',
  'shop_owner_reviewing',
  'counteroffered',
  'awaiting_farmer_decision',
  'awaiting_final_approval',
  'accepted',
  'rejected',
  'withdrawn'
);

-- Who a version of the credit terms was authored by.
create type public.credit_actor_role as enum ('farmer', 'shop_owner');

create type public.moderation_target as enum ('post', 'reply', 'story', 'profile');

-- Outcomes available to a moderator. `remove` is the only irreversible one and
-- is deliberately absent from the automatic path.
create type public.moderation_outcome as enum (
  'dismiss', 'warn', 'restrict', 'hide', 'remove', 'escalate'
);

create type public.verification_status as enum (
  'unverified', 'pending', 'verified', 'suspended', 'revoked', 'rejected'
);

-- Media classes carry different retention rules, so they are distinct values
-- rather than a free-text field a later migration could miss.
create type public.media_class as enum (
  'scan_source', 'scan_derived', 'voice_note', 'community_photo', 'community_video', 'verification_evidence'
);

create type public.media_state as enum ('pending', 'uploading', 'processing', 'ready', 'failed', 'purged');

create type public.notification_kind as enum (
  'recommendation', 'weather_alert', 'market_note', 'credit_update', 'visit_update', 'community_activity', 'verification_update', 'system'
);

create type public.signal_strength as enum ('weak', 'moderate', 'strong');

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Append-only. Written by triggers on state transitions, never by clients.
create table public.audit_log (
  id              bigserial primary key,
  actor_party_id  uuid,
  actor_role      text,
  action          text not null,
  target_table    text not null,
  target_id       uuid,
  target_ref      text,
  before_state    text,
  after_state     text,
  detail          jsonb not null default '{}'::jsonb,
  request_id      text,
  created_at      timestamptz not null default now()
);

create index audit_log_target_idx on public.audit_log (target_table, target_id, created_at desc);
create index audit_log_actor_idx  on public.audit_log (actor_party_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

comment on table public.audit_log is
  'Append-only record of every consequential transition. Verification, moderation and credit all write here so the PRD requirement that these be auditable is structural rather than best-effort.';

-- Security-definer writer so a policy can log without granting insert rights.
create or replace function public.write_audit(
  p_action            text,
  p_target_table      text,
  p_target_id         uuid default null,
  p_target_ref        text default null,
  p_before_state      text default null,
  p_after_state       text default null,
  p_detail            jsonb default '{}'::jsonb,
  p_actor_party_id    uuid default null,
  p_actor_role        text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (
    actor_party_id, actor_role, action, target_table, target_id, target_ref,
    before_state, after_state, detail, request_id
  ) values (
    coalesce(p_actor_party_id, auth.uid()),
    p_actor_role,
    p_action,
    p_target_table,
    p_target_id,
    p_target_ref,
    p_before_state,
    p_after_state,
    coalesce(p_detail, '{}'::jsonb),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention policy
-- ---------------------------------------------------------------------------

-- PRD names technical targets, not legal policy, so they are data rather than
-- constants baked into a job. Changing a number must not require a deployment.
create table public.retention_policies (
  media_class       public.media_class primary key,
  retain_days       integer not null check (retain_days > 0),
  retain_after      text not null default 'created' check (retain_after in ('created', 'structured_result')),
  rationale         text not null
);

insert into public.retention_policies (media_class, retain_days, retain_after, rationale) values
  ('voice_note',            7,  'created',           'Raw voice is the most identifying media and is not needed once transcribed.'),
  ('scan_source',          30,  'structured_result', 'Original camera frame is kept only long enough to contest a diagnosis.'),
  ('scan_derived',         30,  'structured_result', 'Derived crops follow their source; no independent value once the result is settled.'),
  ('community_photo',      30,  'created',           'Community media is not history; the thread text is what has lasting value.'),
  ('community_video',      30,  'created',           'Largest bytes for least lasting value.'),
  ('verification_evidence', 365, 'created',          'Qualification evidence must outlive a dispute about the verification decision.');

comment on table public.retention_policies is
  'Technical retention defaults from the PRD. Deliberately data, and deliberately NOT presented as legal policy.';

-- Signals lose influence over time rather than being deleted: the PRD asks for
-- ~90 days of strong influence followed by decay, not erasure.
create or replace function public.signal_weight(
  p_observed_at   timestamptz,
  p_strength      public.signal_strength
)
returns numeric
language sql
stable
as $$
  -- STABLE, not IMMUTABLE: it reads now(), which Postgres forbids inside an
  -- immutable function. Stable still allows the planner to evaluate it once
  -- per statement.
  --
  -- Returns 0..1. Full influence for the first 90 days for a strong signal,
  -- then a smooth decay that never quite reaches zero: old behaviour keeps
  -- informing relevance, it just stops steering it.
  select case
    when p_strength = 'weak'     then least(1.0, greatest(0.0, 0.55 * exp(-extract(epoch from (now() - p_observed_at)) / (60*60*24*90))))
    when p_strength = 'moderate' then least(1.0, greatest(0.0, 0.80 * exp(-extract(epoch from (now() - p_observed_at)) / (60*60*24*180))))
    else                              least(1.0, greatest(0.0, exp(-extract(epoch from (now() - p_observed_at)) / (60*60*24*365))))
  end;
$$;

comment on function public.signal_weight(timestamptz, public.signal_strength) is
  'Time-decayed influence of a behavioural signal. Strong signals decay slowly, weak ones quickly, none to exactly zero.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000200_identity.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0002 · identity
--
-- The PRD's identity rules, expressed so that the schema cannot violate them:
--
--   * Farmer and Dealer/Shop Owner identities are kept separate.
--   * Accounts are never merged automatically by phone number.
--   * A dealer's customer records are never imported during farmer signup.
--   * Integration happens only when the farmer explicitly enters a dealer workflow.
--
-- The enforcement is a composite foreign key, not a comment. A dealer row
-- cannot point at a farmer row because no such link is expressible.

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------

create table public.parties (
  id            uuid primary key default gen_random_uuid(),
  kind          public.party_kind not null,
  -- auth.users is the only identity provider. A party is a domain actor that
  -- happens to be authenticated, not the other way round.
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  display_name  text not null check (length(btrim(display_name)) between 1 and 120),
  locale        text not null default 'ur' check (locale in ('ur', 'en', 'pa', 'sk', 'sd', 'ps')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger parties_touch before update on public.parties
  for each row execute function public.touch_updated_at();

comment on table public.parties is
  'One row per domain actor. `kind` is immutable in practice: nothing in the app moves a party between farmer and dealer.';

-- Phone numbers live in their own table because the PRD treats a phone number
-- as an *identifier*, never as an authorization or a merge key.
create table public.party_contacts (
  id           uuid primary key default gen_random_uuid(),
  party_id     uuid not null references public.parties (id) on delete cascade,
  channel      text not null check (channel in ('phone', 'email')),
  -- Normalised for lookup (digits only for phone, lowercased for email).
  value        text not null,
  raw_value    text not null,
  verified_at  timestamptz,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (channel, value)
);

create index party_contacts_party_idx on public.party_contacts (party_id);

-- At most one primary per channel per party.
create unique index party_contacts_one_primary_idx
  on public.party_contacts (party_id, channel)
  where is_primary;

comment on column public.party_contacts.value is
  'Normalised lookup form. Unique across all parties so a duplicate signup is detectable — but detection is NOT merging: the app must ask the human which account they meant.';

comment on table public.party_contacts is
  'Phone/email are identifiers. Uniqueness here exists to detect duplicates, never to auto-link a farmer to a dealer.';

-- ---------------------------------------------------------------------------
-- Farmer profile
-- ---------------------------------------------------------------------------

create table public.farmer_profiles (
  party_id            uuid primary key references public.parties (id) on delete cascade,
  -- The farmer's *default* location. A temporary search area must never write here.
  default_area_id     uuid,
  default_lat         double precision check (default_lat between -90 and 90),
  default_lon         double precision check (default_lon between -180 and 180),
  default_location_label   text,
  -- How that location was established. PRD requires the source be stated.
  default_location_source  text check (default_location_source in ('profile_entry', 'device_permission', 'dealer_record')),
  location_set_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint farmer_default_location_complete check (
    (default_lat is null and default_lon is null and default_location_label is null)
    or (default_lat is not null and default_lon is not null and default_location_label is not null)
  )
);

create trigger farmer_profiles_touch before update on public.farmer_profiles
  for each row execute function public.touch_updated_at();

comment on column public.farmer_profiles.default_lat is
  'Default location only. Temporary dealer-search areas are session-scoped and never persisted here.';

-- A farmer may hold several search preferences; only one is active.
create table public.farmer_search_settings (
  farmer_id     uuid primary key references public.farmer_profiles (party_id) on delete cascade,
  radius_km     integer not null default 10 check (radius_km between 1 and 100),
  updated_at    timestamptz not null default now()
);

comment on column public.farmer_search_settings.radius_km is
  'Capped at 100 km by check constraint — the PRD maximum is enforced by the database, not by a UI slider.';

-- Ephemeral search areas. A row here expires; it never touches farmer_profiles.
create table public.farmer_temporary_areas (
  id            uuid primary key default gen_random_uuid(),
  farmer_id     uuid not null references public.farmer_profiles (party_id) on delete cascade,
  label         text not null,
  lat           double precision not null,
  lon           double precision not null,
  radius_km     integer check (radius_km between 1 and 100),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 hours',
  constraint farmer_temporary_areas_expiry check (expires_at > created_at)
);

create index farmer_temporary_areas_live_idx
  on public.farmer_temporary_areas (farmer_id, expires_at desc);

comment on table public.farmer_temporary_areas is
  'A temporary search area. Exists separately from farmer_profiles so "searching near Kot Ladha" can never silently become the farmer''s location.';

-- ---------------------------------------------------------------------------
-- Dealer projection (read-facing)
-- ---------------------------------------------------------------------------

-- The PRD is explicit that the dealer's business system owns products, stock,
-- transactions, credit status and business records, and that the farmer app is
-- a synchronised read-facing layer. So this table is a *projection*: it records
-- which upstream system and record it mirrors, and when it last agreed.
create table public.dealer_profiles (
  id                  uuid primary key default gen_random_uuid(),
  party_id            uuid references public.parties (id) on delete set null,
  -- Upstream identity. Deliberately a triple so the same shop can be seen from
  -- a POS instance and, later, an onboarding pipeline without collision.
  source_system       text not null default 'agri_shop_pos',
  source_ref          text not null,
  source_shop_id      uuid,
  shop_name           text not null,
  phone               text,
  address             text,
  lat                 double precision check (lat between -90 and 90),
  lon                 double precision check (lon between -180 and 180),
  -- Stated so the app can show it; absence means "unknown", never "unverified-therefore-bad".
  verified_at         timestamptz,
  verified_by         uuid references public.parties (id),
  verification_source text,
  opening_hours       text,
  -- Projection freshness. A stale dealer must be shown as stale.
  synced_at           timestamptz,
  sync_state          text not null default 'fresh' check (sync_state in ('fresh', 'stale', 'unreachable')),
  is_accepting_requests boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (source_system, source_ref)
);

create index dealer_profiles_geo_idx on public.dealer_profiles (lat, lon);
create trigger dealer_profiles_touch before update on public.dealer_profiles
  for each row execute function public.touch_updated_at();

comment on table public.dealer_profiles is
  'A read-facing projection of a dealer as held by the dealer business system. Never the source of truth for stock, price or credit status.';

comment on column public.dealer_profiles.synced_at is
  'When this projection last agreed with upstream. The UI must surface staleness rather than present a stale dealer as current.';

-- Which farmers a dealer is permitted to see, and only after an explicit act
-- (a field visit or a credit request). Created by those workflows, never by
-- matching phone numbers.
create table public.dealer_farmer_links (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null references public.dealer_profiles (id) on delete cascade,
  farmer_id      uuid not null references public.farmer_profiles (party_id) on delete cascade,
  -- Why the link exists. Evidence of an explicit act.
  established_by text not null check (established_by in ('field_visit', 'credit_request', 'farmer_initiated_message')),
  source_id      uuid not null,
  created_at     timestamptz not null default now(),
  unique (dealer_id, farmer_id, established_by, source_id)
);

comment on table public.dealer_farmer_links is
  'The only path by which a dealer and a farmer become related. Every row cites the explicit act that created it, so account merging by phone number is not merely discouraged but unrepresentable.';

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

-- What a party may do. Kept minimal and explicit; the PRD wants human-audited
-- authority, not a reputation scalar.
create table public.party_capabilities (
  party_id     uuid not null references public.parties (id) on delete cascade,
  capability   text not null check (capability in ('moderator', 'admin', 'expert')),
  granted_at   timestamptz not null default now(),
  granted_by   uuid references public.parties (id),
  revoked_at   timestamptz,
  primary key (party_id, capability)
);

create or replace function public.has_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.party_capabilities c
    join public.parties p on p.id = c.party_id
    where p.auth_user_id = auth.uid()
      and c.capability = p_capability
      and c.revoked_at is null
  );
$$;

comment on function public.has_capability(text) is
  'Used by RLS. Authority is a granted row, never a community score.';

-- Helper used across every policy: the party id of the caller.
create or replace function public.current_party_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id from public.parties p where p.auth_user_id = auth.uid();
$$;

create or replace function public.current_farmer_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.party_id
  from public.farmer_profiles f
  join public.parties p on p.id = f.party_id
  where p.auth_user_id = auth.uid();
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000300_crops.sql
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000400_recommendations.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0004 · recommendations, knowledge and notifications
--
-- The PRD is emphatic: there is one canonical Recommendation/Insight object.
-- Home, Notifications, Crop Detail and anything else must reference the same
-- underlying row. Rival per-screen calculations are therefore not something to
-- avoid by discipline — they are something the schema has no room for:
--
--   * A recommendation is a row.
--   * A notification *points at* that row and carries no competing prose.
--   * A dedupe key makes emitting the same recommendation twice impossible.
--
-- Copying text into a notification would reintroduce the drift the PRD forbids,
-- so `notification_events` has no free-text body column. It has a reference.

-- ---------------------------------------------------------------------------
-- Agricultural knowledge
-- ---------------------------------------------------------------------------

-- Advice must be able to cite which knowledge it came from and which version.
create table public.agri_knowledge_entries (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null,
  version        integer not null default 1 check (version > 0),
  title_en       text not null,
  title_ur       text not null,
  body_en        text not null,
  body_ur        text not null,
  body_local     jsonb not null default '{}'::jsonb,
  crop_code      text references public.crop_catalog (code),
  -- Which stages this entry is allowed to inform.
  applies_to_stages public.crop_stage[],
  topic          text not null,
  -- Where the advice came from. Unattributed advice is not publishable.
  provenance     text not null,
  reviewed_by    uuid references public.parties (id),
  reviewed_at    timestamptz,
  is_published   boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (slug, version)
);

comment on column public.agri_knowledge_entries.provenance is
  'Source of the claim (extension bulletin, research paper, expert review). The AI layer may only answer from published entries, and each answer cites the row it used.';

-- What the AI has been told it may draw on. Kept separate from the entries so a
-- retrieval index can be rebuilt without touching authored content.
create table public.agri_knowledge_index (
  id            bigserial primary key,
  entry_id      uuid not null references public.agri_knowledge_entries (id) on delete cascade,
  crop_code     text references public.crop_catalog (code),
  stage         public.crop_stage,
  content       text not null,
  -- Populated when an embedding provider is configured; NULL means keyword-only
  -- retrieval, which is a degraded mode the app must disclose rather than hide.
  embedding     extensions.vector(1536),
  created_at    timestamptz not null default now()
);

create index agri_knowledge_index_crop_idx on public.agri_knowledge_index (crop_code, stage);

-- ---------------------------------------------------------------------------
-- Recommendations (canonical)
-- ---------------------------------------------------------------------------

create type public.recommendation_source as enum (
  'knowledge_base', 'weather', 'market', 'crop_lifecycle', 'scan_result', 'expert', 'dealer'
);

create table public.recommendations (
  id               uuid primary key default gen_random_uuid(),
  farmer_id        uuid not null references public.farmer_profiles (party_id) on delete cascade,
  crop_id          uuid references public.crop_instances (id) on delete cascade,
  kind             text not null,
  title            text not null,
  body             text not null,
  action_label     text,
  action_kind      text check (action_kind in ('open_scan', 'open_crop', 'open_dealer', 'open_chat', 'open_market', 'open_weather')),
  action_ref       text,
  source           public.recommendation_source not null,
  -- Exactly which upstream object produced this, so the card can cite it.
  source_ref       text,
  source_label     text,
  confidence       numeric check (confidence >= 0 and confidence <= 1),
  knowledge_version integer,
  -- Honest validity window. An expired recommendation is not shown as current.
  valid_from       timestamptz not null default now(),
  valid_until      timestamptz,
  priority         integer not null default 100,
  -- Identity of this recommendation in terms of what produced it. Two rows with
  -- the same key are the same recommendation.
  dedupe_key       text not null,
  withdrawn_at     timestamptz,
  withdraw_reason  text,
  created_at       timestamptz not null default now(),
  constraint recommendations_validity check (valid_until is null or valid_until > valid_from)
);

-- The constraint that keeps advice singular: one live recommendation per key.
create unique index recommendations_dedupe_idx
  on public.recommendations (farmer_id, dedupe_key)
  where withdrawn_at is null;

create index recommendations_live_idx
  on public.recommendations (farmer_id, priority, created_at desc)
  where withdrawn_at is null;

comment on table public.recommendations is
  'The single canonical advice object. Everything that shows advice references a row here; nothing re-derives its own wording.';

comment on column public.recommendations.dedupe_key is
  'Fingerprint of the cause. A partial unique index over live rows makes duplicate advice a database error rather than a UI annoyance.';

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

-- Note the deliberate absence of a `body` column. A notification is a pointer
-- plus delivery metadata; the words live on the referenced object.
create table public.notification_events (
  id                uuid primary key default gen_random_uuid(),
  party_id          uuid not null references public.parties (id) on delete cascade,
  kind              public.notification_kind not null,
  -- Where the words come from. Exactly one of these is set.
  recommendation_id uuid references public.recommendations (id) on delete cascade,
  credit_request_id uuid,
  visit_id          uuid,
  post_id           uuid,
  verification_id   uuid,
  title_override    text,
  read_at           timestamptz,
  dismissed_at      timestamptz,
  delivered_channels text[] not null default '{}'::text[],
  created_at        timestamptz not null default now(),
  constraint notification_events_has_source check (
    (recommendation_id is not null)::int + (credit_request_id is not null)::int
    + (visit_id is not null)::int + (post_id is not null)::int
    + (verification_id is not null)::int >= 1
  )
);

create index notification_events_inbox_idx
  on public.notification_events (party_id, created_at desc)
  where dismissed_at is null;

-- One live notification per cause per party.
create unique index notification_events_dedupe_idx
  on public.notification_events (party_id, kind, recommendation_id)
  where recommendation_id is not null and dismissed_at is null;

comment on table public.notification_events is
  'A pointer to the object that owns the wording. There is no body column by design: duplicating prose here is how Home and Notifications drift apart, which the PRD forbids.';

-- ---------------------------------------------------------------------------
-- Emitting a recommendation safely
-- ---------------------------------------------------------------------------

-- Idempotent by dedupe key: calling this twice yields one recommendation and one
-- notification, whichever caller loses the race.
create or replace function public.emit_recommendation(
  p_farmer_id        uuid,
  p_kind             text,
  p_title            text,
  p_body             text,
  p_source           public.recommendation_source,
  p_dedupe_key       text,
  p_crop_id          uuid default null,
  p_source_ref       text default null,
  p_source_label     text default null,
  p_confidence       numeric default null,
  p_knowledge_version integer default null,
  p_valid_until      timestamptz default null,
  p_priority         integer default 100,
  p_notify           boolean default true
)
returns public.recommendations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rec   public.recommendations;
  v_party uuid;
begin
  select * into v_rec
    from public.recommendations
   where farmer_id = p_farmer_id
     and dedupe_key = p_dedupe_key
     and withdrawn_at is null;

  if found then
    return v_rec;
  end if;

  insert into public.recommendations (
    farmer_id, crop_id, kind, title, body, source, source_ref, source_label,
    confidence, knowledge_version, valid_until, priority, dedupe_key
  ) values (
    p_farmer_id, p_crop_id, p_kind, p_title, p_body, p_source, p_source_ref, p_source_label,
    p_confidence, p_knowledge_version, p_valid_until, p_priority, p_dedupe_key
  )
  returning * into v_rec;

  if p_notify then
    select party_id into v_party from public.farmer_profiles where party_id = p_farmer_id;

    insert into public.notification_events (party_id, kind, recommendation_id)
    values (v_party, 'recommendation', v_rec.id)
    on conflict do nothing;
  end if;

  return v_rec;
end;
$$;

comment on function public.emit_recommendation(uuid, text, text, text, public.recommendation_source, text, uuid, text, text, numeric, integer, timestamptz, integer, boolean) is
  'Idempotent emit. Returns the existing live recommendation if the dedupe key is already present, so retries and concurrent callers converge on one row.';

-- Withdrawing advice must also retire the notification that announced it.
create or replace function public.withdraw_recommendation(
  p_recommendation_id uuid,
  p_reason            text
)
returns public.recommendations
language plpgsql
security invoker
as $$
declare
  v_rec public.recommendations;
begin
  update public.recommendations
     set withdrawn_at = now(),
         withdraw_reason = p_reason
   where id = p_recommendation_id
     and withdrawn_at is null
  returning * into v_rec;

  if not found then
    raise exception 'Recommendation % is missing or already withdrawn.', p_recommendation_id
      using errcode = 'no_data_found';
  end if;

  update public.notification_events
     set dismissed_at = now()
   where recommendation_id = p_recommendation_id
     and dismissed_at is null;

  perform public.write_audit(
    'recommendation.withdrawn', 'recommendations', p_recommendation_id, null, 'live', 'withdrawn',
    jsonb_build_object('reason', p_reason)
  );

  return v_rec;
end;
$$;

-- The single read model both Home and the notification list consume.
create or replace function public.farmer_insight_feed(
  p_farmer_id uuid,
  p_limit     integer default 20
)
returns table (
  recommendation_id uuid,
  crop_id           uuid,
  kind              text,
  title             text,
  body              text,
  source            public.recommendation_source,
  source_label      text,
  confidence        numeric,
  knowledge_version integer,
  valid_until       timestamptz,
  is_primary_crop   boolean,
  is_unread         boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.id,
    r.crop_id,
    r.kind,
    r.title,
    r.body,
    r.source,
    r.source_label,
    r.confidence,
    r.knowledge_version,
    r.valid_until,
    coalesce(ci.is_primary, false),
    (n.read_at is null)
  from public.recommendations r
  left join public.crop_instances ci on ci.id = r.crop_id
  left join public.notification_events n
         on n.recommendation_id = r.id
  where r.farmer_id = p_farmer_id
    and r.withdrawn_at is null
    and (r.valid_until is null or r.valid_until > now())
  order by ci.is_primary desc nulls last, r.priority, r.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

comment on function public.farmer_insight_feed(uuid, integer) is
  'One feed for Home and for the notification list, so the two cannot disagree. Expired advice is filtered here, once.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000500_geo_dealers.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0005 · geography and the dealer read layer
--
-- The PRD asks for proper geospatial logic, a hard 100 km ceiling, and a
-- temporary search area that cannot silently become the farmer's location.
-- Those three are implemented as: PostGIS geography columns with GiST indexes,
-- a CHECK constraint on radius, and two separate tables (already created in
-- migration 0002) whose only overlap is a join, never a write.

-- ---------------------------------------------------------------------------
-- Geography on existing tables
-- ---------------------------------------------------------------------------

-- Generated so the point can never disagree with the lat/lon pair beside it.
alter table public.dealer_profiles
  add column geog extensions.geography(Point, 4326)
  generated always as (
    case
      when lat is not null and lon is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(lon, lat), 4326)::extensions.geography
      else null
    end
  ) stored;

create index dealer_profiles_geog_idx on public.dealer_profiles using gist (geog);

alter table public.farmer_profiles
  add column geog extensions.geography(Point, 4326)
  generated always as (
    case
      when default_lat is not null and default_lon is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(default_lon, default_lat), 4326)::extensions.geography
      else null
    end
  ) stored;

comment on column public.dealer_profiles.geog is
  'Generated from lat/lon, so a radius query can never use coordinates that disagree with the displayed ones.';

-- ---------------------------------------------------------------------------
-- Named areas
-- ---------------------------------------------------------------------------

create table public.areas (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_en     text not null,
  name_ur     text not null,
  names_local jsonb not null default '{}'::jsonb,
  district    text,
  geog        extensions.geography(Point, 4326),
  is_active   boolean not null default true
);

create index areas_geog_idx on public.areas using gist (geog);

insert into public.areas (code, name_en, name_ur, district, geog) values
  ('wazirabad',  'Wazirabad',  'وزیرآباد',  'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.1150, 32.4430), 4326)::extensions.geography),
  ('kot_ladha',  'Kot Ladha',  'کوٹ لادھا', 'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.0500, 32.3300), 4326)::extensions.geography),
  ('gujranwala', 'Gujranwala', 'گوجرانوالہ', 'Gujranwala', extensions.ST_SetSRID(extensions.ST_MakePoint(74.1936, 32.1877), 4326)::extensions.geography);

-- Link the farmer's default area back to the catalog now that it exists.
alter table public.farmer_profiles
  add constraint farmer_profiles_default_area_fkey
  foreign key (default_area_id) references public.areas (id);

-- ---------------------------------------------------------------------------
-- Dealer inventory projection
-- ---------------------------------------------------------------------------

-- Declared before dealer_products because that table carries a foreign key to
-- it, and Postgres requires the referenced table to exist first.
create table public.canonical_products (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null,
  brand              text,
  category           text,
  -- Pakistan registration number, when the product has one. This is the value
  -- a scan result cites as evidence.
  registration_no    text,
  registered_on      date,
  active_ingredient  text,
  label_url          text,
  is_restricted      boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger canonical_products_touch before update on public.canonical_products
  for each row execute function public.touch_updated_at();

comment on column public.canonical_products.registration_no is
  'The registration the product evidence chain displays. NULL means unknown, and the UI must say unknown rather than imply unregistered.';

-- Read-facing only. `synced_at` and `sync_state` exist because the PRD requires
-- missing or stale information to be shown as such, never invented.
create table public.dealer_products (
  id                uuid primary key default gen_random_uuid(),
  dealer_id         uuid not null references public.dealer_profiles (id) on delete cascade,
  source_system     text not null default 'agri_shop_pos',
  source_ref        text not null,
  name              text not null,
  brand             text,
  category          text,
  -- The canonical product this listing corresponds to, so farmer-side evidence
  -- chains (scan -> product -> where to buy) can be joined reliably.
  canonical_product_id uuid references public.canonical_products (id),
  pack_size         text,
  registration_no   text,
  -- NULL means "the dealer system did not tell us", which is different from 0.
  available_qty     numeric check (available_qty >= 0),
  unit              text,
  unit_price        numeric check (unit_price >= 0),
  currency          text not null default 'PKR',
  in_stock          boolean,
  synced_at         timestamptz,
  sync_state        text not null default 'fresh' check (sync_state in ('fresh', 'stale', 'unreachable')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (dealer_id, source_system, source_ref)
);

create index dealer_products_dealer_idx on public.dealer_products (dealer_id, category);
create trigger dealer_products_touch before update on public.dealer_products
  for each row execute function public.touch_updated_at();

comment on column public.dealer_products.available_qty is
  'Nullable on purpose. NULL is "unknown", 0 is "confirmed none". The PRD forbids turning a missing value into a zero, and this column makes that mistake impossible to express.';

-- ---------------------------------------------------------------------------
-- Radius search
-- ---------------------------------------------------------------------------

-- Returns dealers inside the radius, and reports each one's freshness so the
-- caller cannot present a stale projection as current by accident.
create or replace function public.dealers_within_radius(
  p_farmer_id uuid,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_radius_km integer default null
)
returns table (
  dealer_id        uuid,
  shop_name        text,
  distance_km      numeric,
  verified_at      timestamptz,
  opening_hours    text,
  sync_state       text,
  synced_at        timestamptz,
  is_accepting     boolean,
  effective_radius integer,
  used_temporary_area boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings   public.farmer_search_settings;
  v_profile    public.farmer_profiles;
  v_origin     extensions.geography;
  v_radius     integer;
  v_temporary  boolean := false;
begin
  select * into v_profile from public.farmer_profiles where party_id = p_farmer_id;
  if not found then
    raise exception 'Farmer % not found.', p_farmer_id using errcode = 'no_data_found';
  end if;

  select * into v_settings from public.farmer_search_settings where farmer_id = p_farmer_id;

  if p_lat is not null and p_lon is not null then
    -- Caller supplied an origin: this is a temporary search area, and it is
    -- used for this query only.
    v_origin    := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  else
    v_origin := v_profile.geog;
  end if;

  if v_origin is null then
    raise exception 'No search origin: the farmer has no default location and none was supplied.'
      using errcode = 'no_data_found';
  end if;

  -- The ceiling is applied here as well as in the constraint, so a caller
  -- passing a huge radius gets 100 km rather than everything on earth.
  v_radius := least(coalesce(p_radius_km, v_settings.radius_km, 10), 100);

  return query
    select
      d.id,
      d.shop_name,
      round((extensions.ST_Distance(d.geog, v_origin) / 1000.0)::numeric, 1),
      d.verified_at,
      d.opening_hours,
      d.sync_state,
      d.synced_at,
      d.is_accepting_requests,
      v_radius,
      v_temporary
    from public.dealer_profiles d
    where d.geog is not null
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    -- Nearest-first, and written operator(extensions.<->) because the operator
    -- lives in the extensions schema. Using it in ORDER BY is what lets the
    -- GiST index serve the sort instead of a full scan.
    order by d.geog operator(extensions.<->) v_origin
    limit 200;
end;
$$;

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Radius search capped at 100 km. An origin supplied by the caller is treated as temporary and never written back to the farmer profile.';

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

create table public.dealer_sync_runs (
  id              bigserial primary key,
  source_system   text not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  dealers_seen    integer not null default 0,
  products_seen   integer not null default 0,
  records_rejected integer not null default 0,
  error           text
);

comment on table public.dealer_sync_runs is
  'Every projection refresh is recorded. A dealer whose last successful run is old must be shown as stale, which requires knowing when the last good run happened.';

-- Marks a projection stale when nothing has confirmed it recently. Run on a
-- schedule; the UI reads sync_state rather than guessing from a timestamp.
create or replace function public.mark_stale_dealer_projections(p_max_age interval default '36 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with touched as (
    update public.dealer_profiles
       set sync_state = 'stale'
     where sync_state = 'fresh'
       and (synced_at is null or synced_at < now() - p_max_age)
    returning 1
  )
  select count(*) into v_count from touched;

  with touched as (
    update public.dealer_products
       set sync_state = 'stale'
     where sync_state = 'fresh'
       and (synced_at is null or synced_at < now() - p_max_age)
    returning 1
  )
  select v_count + count(*) into v_count from touched;

  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000600_field_visits.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0006 · field visits
--
-- PRD: field visits are a request lifecycle, not a chat. The states are
-- Pending -> Accepted / Rejected, and the architecture must allow the later
-- Scheduled -> In Progress -> Completed / Cancelled progression without
-- inventing it now. The enum in migration 0001 already carries all seven; this
-- migration decides which of them the current flow may actually reach.
--
-- Two rules get structural enforcement:
--   * one open request per dealer per farmer
--   * only the dealer may accept or reject

create table public.field_visits (
  id              uuid primary key default gen_random_uuid(),
  farmer_id       uuid not null references public.farmer_profiles (party_id) on delete cascade,
  dealer_id       uuid not null references public.dealer_profiles (id) on delete cascade,
  crop_id         uuid references public.crop_instances (id) on delete set null,
  status          public.visit_status not null default 'pending',
  -- What the farmer wants looked at, in their words.
  reason          text not null check (length(btrim(reason)) between 3 and 1000),
  preferred_date  date,
  preferred_slot  text,
  farmer_note     text,
  -- Set when a dealer has actually seen the request.
  seen_at         timestamptz,
  responded_at    timestamptz,
  rejection_reason text,
  -- Filled by later states, deliberately present now so enabling them is a
  -- policy change rather than a migration.
  scheduled_for   timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  -- Protects the request against a double-tap creating two visits.
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint field_visits_rejection_reason check (
    status <> 'rejected' or btrim(coalesce(rejection_reason, '')) <> ''
  )
);

create trigger field_visits_touch before update on public.field_visits
  for each row execute function public.touch_updated_at();

-- One open request per dealer per farmer. "Open" excludes the terminal states,
-- so a rejected request can be replaced by a new one but a pending one cannot
-- be duplicated by tapping twice.
create unique index field_visits_one_open_per_dealer_idx
  on public.field_visits (farmer_id, dealer_id)
  where status in ('pending', 'accepted', 'scheduled', 'in_progress');

create unique index field_visits_idempotency_idx
  on public.field_visits (farmer_id, idempotency_key)
  where idempotency_key is not null;

create index field_visits_dealer_queue_idx on public.field_visits (dealer_id, status, created_at desc);

comment on index public.field_visits_one_open_per_dealer_idx is
  'One open field visit per dealer per farmer, enforced by the database so a double tap or an offline retry cannot create two.';

-- ---------------------------------------------------------------------------
-- Transition guard
-- ---------------------------------------------------------------------------

-- Which transitions exist today, and who may perform them. Later states are
-- listed but marked dealer- or system-driven so enabling them is deliberate.
create or replace function public.field_visit_transition_allowed(
  p_from public.visit_status,
  p_to   public.visit_status
)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('pending',   'accepted'),
    ('pending',   'rejected'),
    ('pending',   'cancelled'),
    ('accepted',  'scheduled'),
    ('accepted',  'cancelled'),
    ('scheduled', 'in_progress'),
    ('scheduled', 'cancelled'),
    ('in_progress','completed'),
    ('in_progress','cancelled')
  );
$$;

create or replace function public.guard_field_visit_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dealer_party uuid;
  v_actor        uuid := public.current_party_id();
  v_is_dealer    boolean;
  v_is_farmer    boolean;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not public.field_visit_transition_allowed(old.status, new.status) then
    raise exception 'A field visit cannot move from % to %.', old.status, new.status
      using errcode = 'check_violation';
  end if;

  v_is_farmer := (v_actor is not null and v_actor = old.farmer_id);

  select dp.party_id into v_dealer_party
    from public.dealer_profiles dp
   where dp.id = old.dealer_id;

  v_is_dealer := (v_actor is not null and v_dealer_party is not null and v_actor = v_dealer_party);

  -- Accept and reject are the dealer's decision, never the farmer's. A farmer
  -- who wants out cancels; they do not accept on the dealer's behalf.
  if new.status in ('accepted', 'rejected') and not v_is_dealer and not public.has_capability('admin') then
    raise exception 'Only the dealer may accept or reject a field visit.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'cancelled' and not (v_is_farmer or v_is_dealer or public.has_capability('admin')) then
    raise exception 'Only the farmer or the dealer may cancel a field visit.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status in ('scheduled', 'in_progress', 'completed') and not v_is_dealer and not public.has_capability('admin') then
    raise exception 'Only the dealer may move a visit to %.', new.status
      using errcode = 'insufficient_privilege';
  end if;

  -- Stamp the time that matches the state, so the timeline is derived from the
  -- transition rather than trusted from the client.
  case new.status
    when 'accepted'    then new.responded_at := coalesce(new.responded_at, now());
    when 'rejected'    then new.responded_at := coalesce(new.responded_at, now());
    when 'scheduled'   then new.scheduled_for := coalesce(new.scheduled_for, now() + interval '1 day');
    when 'in_progress' then new.started_at := coalesce(new.started_at, now());
    when 'completed'   then new.completed_at := coalesce(new.completed_at, now());
    when 'cancelled'   then new.cancelled_at := coalesce(new.cancelled_at, now());
    else null;
  end case;

  perform public.write_audit(
    'field_visit.transition',
    'field_visits',
    new.id,
    null,
    old.status::text,
    new.status::text,
    jsonb_build_object('reason', new.rejection_reason, 'cancel_reason', new.cancel_reason)
  );

  return new;
end;
$$;

create trigger field_visits_guard_transition
  before update of status on public.field_visits
  for each row execute function public.guard_field_visit_transition();

-- ---------------------------------------------------------------------------
-- Request entry point
-- ---------------------------------------------------------------------------

-- Creating a visit also establishes the dealer/farmer link, because entering a
-- dealer workflow is exactly the explicit act the PRD requires. This is the
-- only way a farmer and a dealer become related.
create or replace function public.request_field_visit(
  p_farmer_id       uuid,
  p_dealer_id       uuid,
  p_reason          text,
  p_crop_id         uuid default null,
  p_preferred_date  date default null,
  p_preferred_slot  text default null,
  p_note            text default null,
  p_idempotency_key text default null
)
returns public.field_visits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visit public.field_visits;
  v_dealer public.dealer_profiles;
begin
  select * into v_dealer from public.dealer_profiles where id = p_dealer_id;
  if not found then
    raise exception 'Dealer % not found.', p_dealer_id using errcode = 'no_data_found';
  end if;

  if not v_dealer.is_accepting_requests then
    raise exception 'This dealer is not accepting requests right now.' using errcode = 'check_violation';
  end if;

  insert into public.field_visits (
    farmer_id, dealer_id, crop_id, reason, preferred_date, preferred_slot, farmer_note, idempotency_key
  ) values (
    p_farmer_id, p_dealer_id, p_crop_id, p_reason, p_preferred_date, p_preferred_slot, p_note, p_idempotency_key
  )
  returning * into v_visit;

  insert into public.dealer_farmer_links (dealer_id, farmer_id, established_by, source_id)
  values (p_dealer_id, p_farmer_id, 'field_visit', v_visit.id)
  on conflict do nothing;

  insert into public.notification_events (party_id, kind, visit_id)
  select dp.party_id, 'visit_update', v_visit.id
  from public.dealer_profiles dp
  where dp.id = p_dealer_id and dp.party_id is not null
  on conflict do nothing;

  return v_visit;
exception
  when unique_violation then
    -- Either the idempotency key already produced a visit, or one is already
    -- open with this dealer. Both mean: return the existing request.
    select * into v_visit
      from public.field_visits
     where farmer_id = p_farmer_id
       and dealer_id = p_dealer_id
       and status in ('pending', 'accepted', 'scheduled', 'in_progress')
     order by created_at desc
     limit 1;

    if found then
      return v_visit;
    end if;

    raise;
end;
$$;

comment on function public.request_field_visit(uuid, uuid, text, uuid, date, text, text, text) is
  'Idempotent: a repeated call returns the already-open request rather than creating a second one, so an offline retry is harmless.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000700_credit.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0007 · credit workflow
--
-- The approved workflow, verbatim:
--
--   Farmer Request
--     -> Shop Owner Review
--       -> Accept OR One Counteroffer
--         -> Farmer Accept/Reject
--           -> Shop Owner Final Accept/Reject
--             -> Approved transaction
--
-- Locked rules, each one enforced by a constraint or a guarded function rather
-- than by client behaviour:
--
--   1. one active request per underlying context        -> partial unique index
--   2. one counteroffer maximum                         -> partial unique index
--   3. no counter-counteroffer                          -> FK shape + version check
--   4. farmer explicitly accepts the *displayed* terms  -> consent row pinned to version id
--   5. changed terms must be shown                      -> server-computed diff column
--   6. final Shop Owner approval is required            -> agreement only writable there
--   7. only final approval commits the transaction      -> agreement row is the commit
--   8. original request, counteroffer, decisions, terms,
--      version, actor and timestamps preserved          -> append-only child tables
--   9. duplicate commit protection                      -> unique(request_id) on agreements
--
-- There is deliberately no negotiation engine and no extra lending rules.

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

create table public.credit_requests (
  id                 uuid primary key default gen_random_uuid(),
  farmer_id          uuid not null references public.farmer_profiles (party_id) on delete cascade,
  dealer_id          uuid not null references public.dealer_profiles (id) on delete cascade,
  -- The underlying context. In this build it is the order the credit is for;
  -- the PRD needs "one active request per underlying context", which is only
  -- expressible if the context is a column.
  order_ref          text not null,
  order_label        text,
  status             public.credit_status not null default 'requested',
  -- The version currently awaiting a decision. Every decision names a version.
  current_version_id uuid,
  original_version_id uuid,
  -- The version the farmer finally agreed to; frozen at farmer acceptance.
  agreed_version_id  uuid,
  last_transition_at timestamptz not null default now(),
  closed_at          timestamptz,
  idempotency_key    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger credit_requests_touch before update on public.credit_requests
  for each row execute function public.touch_updated_at();

-- Rule 1. Terminal states release the context so a new request may be made for
-- the same order later; anything in flight blocks a second one.
create unique index credit_requests_one_active_per_context_idx
  on public.credit_requests (dealer_id, order_ref)
  where status not in ('accepted', 'rejected', 'withdrawn');

create unique index credit_requests_idempotency_idx
  on public.credit_requests (farmer_id, idempotency_key)
  where idempotency_key is not null;

create index credit_requests_farmer_idx on public.credit_requests (farmer_id, created_at desc);
create index credit_requests_dealer_idx on public.credit_requests (dealer_id, status, created_at desc);

comment on index public.credit_requests_one_active_per_context_idx is
  'Rule 1: one active request per underlying order context, enforced by the database.';

-- ---------------------------------------------------------------------------
-- Versions (the terms that exist over time)
-- ---------------------------------------------------------------------------

create table public.credit_request_versions (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.credit_requests (id) on delete cascade,
  version_no        integer not null check (version_no >= 1),
  author_role       public.credit_actor_role not null,
  author_party_id   uuid references public.parties (id),
  principal         numeric not null check (principal > 0),
  fee_amount        numeric not null default 0 check (fee_amount >= 0),
  repayment_date    date not null,
  installments      integer not null default 1 check (installments between 1 and 12),
  note              text,
  -- Rule 5: computed by the server when this version supersedes another, so the
  -- "what changed" list cannot be a client-side guess or conveniently omitted.
  changed_fields    jsonb not null default '[]'::jsonb,
  supersedes_id     uuid references public.credit_request_versions (id),
  -- True for the one revision the shop owner issues after the farmer's request.
  is_counteroffer   boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (request_id, version_no),
  -- Rule 3, part one: the farmer authors only the opening request. There is no
  -- shape in which a farmer replies to a counteroffer with terms of their own.
  constraint credit_versions_farmer_is_original check (
    (author_role = 'farmer' and version_no = 1)
    or (author_role = 'shop_owner' and version_no > 1)
  ),
  -- Only the shop owner's revision may be called a counteroffer.
  constraint credit_versions_counteroffer_is_owner check (
    is_counteroffer = (author_role = 'shop_owner')
  ),
  constraint credit_versions_supersedes check (
    (version_no = 1 and supersedes_id is null)
    or (version_no > 1 and supersedes_id is not null)
  )
);

-- Rule 2: one counteroffer maximum. A third version simply cannot be inserted.
create unique index credit_versions_one_counteroffer_idx
  on public.credit_request_versions (request_id)
  where is_counteroffer;

create index credit_versions_request_idx on public.credit_request_versions (request_id, version_no);

comment on table public.credit_request_versions is
  'Every set of terms that has existed, kept forever. Rule 2 lives in credit_versions_one_counteroffer_idx: a second counteroffer is a unique-violation, not a UI state.';

-- Add the deferrable request -> version links now that versions exist.
alter table public.credit_requests
  add constraint credit_requests_current_version_fkey
    foreign key (current_version_id) references public.credit_request_versions (id) on delete set null,
  add constraint credit_requests_original_version_fkey
    foreign key (original_version_id) references public.credit_request_versions (id) on delete set null,
  add constraint credit_requests_agreed_version_fkey
    foreign key (agreed_version_id) references public.credit_request_versions (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------

-- Rule 4. A consent names the exact version the farmer was shown, plus a
-- snapshot of what that screen displayed. Accepting terms that changed under
-- you is therefore impossible: the row would name a version that is no longer
-- current, and the accept function refuses.
create table public.credit_consents (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.credit_requests (id) on delete cascade,
  version_id        uuid not null references public.credit_request_versions (id) on delete cascade,
  farmer_id         uuid not null references public.farmer_profiles (party_id) on delete cascade,
  -- The literal terms rendered when the farmer agreed.
  shown_snapshot    jsonb not null,
  -- Which step this consent belongs to: receiving the terms, or accepting the
  -- counteroffer. The PRD requires explicit agreement at both.
  consent_stage     text not null check (consent_stage in ('initial_terms', 'counteroffer')),
  consented_at      timestamptz not null default now(),
  request_id_hdr    text,
  unique (request_id, version_id, consent_stage)
);

create index credit_consents_request_idx on public.credit_consents (request_id, consented_at);

comment on table public.credit_consents is
  'Rule 4. Consent is pinned to a version id and carries the snapshot shown, so "the farmer agreed to what they saw" is provable rather than asserted.';

-- ---------------------------------------------------------------------------
-- Decisions
-- ---------------------------------------------------------------------------

create table public.credit_decisions (
  id             bigserial primary key,
  request_id     uuid not null references public.credit_requests (id) on delete cascade,
  version_id     uuid not null references public.credit_request_versions (id) on delete cascade,
  actor_role     public.credit_actor_role not null,
  actor_party_id uuid references public.parties (id),
  decision       text not null check (decision in ('accept', 'reject', 'counteroffer', 'withdraw')),
  reason         text,
  from_status    public.credit_status not null,
  to_status      public.credit_status not null,
  created_at     timestamptz not null default now()
);

create index credit_decisions_request_idx on public.credit_decisions (request_id, created_at);

comment on table public.credit_decisions is
  'Append-only decision trail with from/to status, so the timeline a farmer sees is reconstructed from records rather than from mutable status fields.';

-- ---------------------------------------------------------------------------
-- Agreement (the commit)
-- ---------------------------------------------------------------------------

-- Rule 7: this row *is* the approved transaction. Nothing else commits credit,
-- and rule 9 is a unique constraint so even a double-submitted final approval
-- cannot produce two agreements.
create table public.credit_agreements (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null unique references public.credit_requests (id) on delete restrict,
  version_id      uuid not null references public.credit_request_versions (id) on delete restrict,
  farmer_id       uuid not null references public.farmer_profiles (party_id) on delete restrict,
  dealer_id       uuid not null references public.dealer_profiles (id) on delete restrict,
  principal       numeric not null check (principal > 0),
  fee_amount      numeric not null default 0 check (fee_amount >= 0),
  repayment_date  date not null,
  installments    integer not null default 1 check (installments between 1 and 12),
  committed_at    timestamptz not null default now(),
  committed_by    uuid references public.parties (id)
);

create index credit_agreements_farmer_idx on public.credit_agreements (farmer_id, committed_at desc);

comment on table public.credit_agreements is
  'The approved credit transaction. created only by credit_owner_final_decision(approve => true), and unique(request_id) makes a duplicate commit impossible.';

create table public.credit_payments (
  id             uuid primary key default gen_random_uuid(),
  agreement_id   uuid not null references public.credit_agreements (id) on delete cascade,
  amount         numeric not null check (amount > 0),
  paid_on        date not null default current_date,
  method         text not null default 'cash' check (method in ('cash', 'bank_transfer', 'mobile')),
  note           text,
  recorded_by    uuid references public.parties (id),
  idempotency_key text,
  created_at     timestamptz not null default now(),
  unique (agreement_id, idempotency_key)
);

-- Outstanding is derived, never stored, so a payment cannot desynchronise it.
create or replace function public.credit_outstanding(p_agreement_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    0,
    (a.principal + a.fee_amount) - coalesce((select sum(p.amount) from public.credit_payments p where p.agreement_id = a.id), 0)
  )
  from public.credit_agreements a
  where a.id = p_agreement_id;
$$;

-- ---------------------------------------------------------------------------
-- The state machine
-- ---------------------------------------------------------------------------

create or replace function public.credit_transition_allowed(
  p_from public.credit_status,
  p_to   public.credit_status
)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('requested',                'shop_owner_reviewing'),
    ('requested',                'withdrawn'),
    ('requested',                'rejected'),
    ('shop_owner_reviewing',     'awaiting_farmer_decision'),
    ('shop_owner_reviewing',     'counteroffered'),
    ('shop_owner_reviewing',     'rejected'),
    ('shop_owner_reviewing',     'withdrawn'),
    ('awaiting_farmer_decision', 'awaiting_final_approval'),
    ('awaiting_farmer_decision', 'rejected'),
    ('awaiting_farmer_decision', 'withdrawn'),
    ('counteroffered',           'awaiting_final_approval'),
    ('counteroffered',           'rejected'),
    ('counteroffered',           'withdrawn'),
    ('awaiting_final_approval',  'accepted'),
    ('awaiting_final_approval',  'rejected')
  );
$$;

-- Single choke point: every RPC below routes status changes through here, so
-- no future caller can invent a transition.
create or replace function public.credit_set_status(
  p_request_id uuid,
  p_to         public.credit_status,
  p_version_id uuid default null,
  p_actor_role public.credit_actor_role default null,
  p_decision   text default null,
  p_reason     text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
begin
  select * into v_req from public.credit_requests where id = p_request_id for update;

  if not found then
    raise exception 'Credit request % not found.', p_request_id using errcode = 'no_data_found';
  end if;

  if not public.credit_transition_allowed(v_req.status, p_to) then
    raise exception 'Credit request % cannot move from % to %.', p_request_id, v_req.status, p_to
      using errcode = 'check_violation';
  end if;

  if p_version_id is not null and p_actor_role is not null and p_decision is not null then
    insert into public.credit_decisions (
      request_id, version_id, actor_role, actor_party_id, decision, reason, from_status, to_status
    ) values (
      p_request_id, p_version_id, p_actor_role, public.current_party_id(), p_decision, p_reason, v_req.status, p_to
    );
  end if;

  update public.credit_requests
     set status = p_to,
         last_transition_at = now(),
         closed_at = case when p_to in ('accepted', 'rejected', 'withdrawn') then now() else closed_at end
   where id = p_request_id
  returning * into v_req;

  perform public.write_audit(
    'credit.transition', 'credit_requests', p_request_id, p_to::text,
    null, p_to::text,
    jsonb_build_object('actor_role', p_actor_role, 'decision', p_decision, 'reason', p_reason, 'version_id', p_version_id)
  );

  return v_req;
end;
$$;

-- Whose turn is it. Used by the guard helpers to keep decisions with the right
-- party even if a policy were ever too permissive.
create or replace function public.assert_credit_actor(
  p_request_id uuid,
  p_role       public.credit_actor_role
)
returns public.credit_requests
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_req    public.credit_requests;
  v_actor  uuid := public.current_party_id();
  v_dealer uuid;
begin
  select * into v_req from public.credit_requests where id = p_request_id;
  if not found then
    raise exception 'Credit request % not found.', p_request_id using errcode = 'no_data_found';
  end if;

  if p_role = 'farmer' then
    if v_actor is distinct from v_req.farmer_id then
      raise exception 'Only the farmer on this request may act as the farmer.' using errcode = 'insufficient_privilege';
    end if;
  else
    select dp.party_id into v_dealer from public.dealer_profiles dp where dp.id = v_req.dealer_id;
    if v_actor is null or v_dealer is null or v_actor <> v_dealer then
      -- Admins may act on behalf of the shop only for support, and it is audited.
      if not public.has_capability('admin') then
        raise exception 'Only the shop owner on this request may act as the shop owner.' using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  return v_req;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row 1: the farmer files the request
-- ---------------------------------------------------------------------------

create or replace function public.credit_submit_request(
  p_farmer_id     uuid,
  p_dealer_id     uuid,
  p_order_ref     text,
  p_order_label   text,
  p_principal     numeric,
  p_fee_amount    numeric,
  p_repayment_date date,
  p_installments  integer default 1,
  p_note          text default null,
  p_idempotency_key text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req     public.credit_requests;
  v_version public.credit_request_versions;
begin
  insert into public.credit_requests (
    farmer_id, dealer_id, order_ref, order_label, status, idempotency_key
  ) values (
    p_farmer_id, p_dealer_id, p_order_ref, p_order_label, 'requested', p_idempotency_key
  )
  returning * into v_req;

  insert into public.credit_request_versions (
    request_id, version_no, author_role, author_party_id,
    principal, fee_amount, repayment_date, installments, note
  ) values (
    v_req.id, 1, 'farmer', p_farmer_id,
    p_principal, coalesce(p_fee_amount, 0), p_repayment_date, coalesce(p_installments, 1), p_note
  )
  returning * into v_version;

  update public.credit_requests
     set current_version_id = v_version.id,
         original_version_id = v_version.id
   where id = v_req.id
  returning * into v_req;

  -- Entering a credit workflow is an explicit act, so it creates the link.
  insert into public.dealer_farmer_links (dealer_id, farmer_id, established_by, source_id)
  values (p_dealer_id, p_farmer_id, 'credit_request', v_req.id)
  on conflict do nothing;

  insert into public.notification_events (party_id, kind, credit_request_id)
  select dp.party_id, 'credit_update', v_req.id
  from public.dealer_profiles dp
  where dp.id = p_dealer_id and dp.party_id is not null
  on conflict do nothing;

  perform public.write_audit('credit.requested', 'credit_requests', v_req.id, p_order_ref, null, 'requested');

  return v_req;
exception
  when unique_violation then
    select * into v_req
      from public.credit_requests
     where farmer_id = p_farmer_id
       and dealer_id = p_dealer_id
       and order_ref = p_order_ref
       and status not in ('accepted', 'rejected', 'withdrawn')
     limit 1;

    if found then
      return v_req;
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row 2: shop owner review, then accept or counter
-- ---------------------------------------------------------------------------

create or replace function public.credit_begin_review(p_request_id uuid)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
begin
  perform public.assert_credit_actor(p_request_id, 'shop_owner');
  select * into v_req from public.credit_requests where id = p_request_id;

  -- No decision row: opening a review is not a decision about the terms. The
  -- audit log records it, so the timeline stays honest about what was decided.
  return public.credit_set_status(p_request_id, 'shop_owner_reviewing');
end;
$$;

create or replace function public.credit_owner_accept(p_request_id uuid)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
begin
  perform public.assert_credit_actor(p_request_id, 'shop_owner');
  select * into v_req from public.credit_requests where id = p_request_id;

  if v_req.status <> 'shop_owner_reviewing' then
    raise exception 'Review can only be accepted while the request is under review. Current state: %.', v_req.status
      using errcode = 'check_violation';
  end if;

  -- Terms unchanged: the farmer still has to agree to them.
  return public.credit_set_status(p_request_id, 'awaiting_farmer_decision', v_req.current_version_id, 'shop_owner', 'accept', 'Terms accepted as requested');
end;
$$;

create or replace function public.credit_owner_counteroffer(
  p_request_id     uuid,
  p_principal      numeric,
  p_fee_amount     numeric,
  p_repayment_date date,
  p_installments   integer default 1,
  p_note           text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req     public.credit_requests;
  v_prev    public.credit_request_versions;
  v_version public.credit_request_versions;
  v_changed jsonb := '[]'::jsonb;
begin
  perform public.assert_credit_actor(p_request_id, 'shop_owner');
  select * into v_req from public.credit_requests where id = p_request_id for update;

  if v_req.status <> 'shop_owner_reviewing' then
    raise exception 'A counteroffer can only be issued while the request is under review. Current state: %.', v_req.status
      using errcode = 'check_violation';
  end if;

  if not public.credit_transition_allowed(v_req.status, 'counteroffered') then
    raise exception 'This request can no longer be counteroffered.' using errcode = 'check_violation';
  end if;

  select * into v_prev from public.credit_request_versions where id = v_req.current_version_id;

  -- Rule 5, computed by the server from the two versions rather than supplied.
  if p_principal is distinct from v_prev.principal then
    v_changed := v_changed || jsonb_build_array(jsonb_build_object('field', 'principal', 'from', v_prev.principal, 'to', p_principal));
  end if;
  if coalesce(p_fee_amount, 0) is distinct from v_prev.fee_amount then
    v_changed := v_changed || jsonb_build_array(jsonb_build_object('field', 'fee_amount', 'from', v_prev.fee_amount, 'to', coalesce(p_fee_amount, 0)));
  end if;
  if p_repayment_date is distinct from v_prev.repayment_date then
    v_changed := v_changed || jsonb_build_array(jsonb_build_object('field', 'repayment_date', 'from', v_prev.repayment_date, 'to', p_repayment_date));
  end if;
  if coalesce(p_installments, 1) is distinct from v_prev.installments then
    v_changed := v_changed || jsonb_build_array(jsonb_build_object('field', 'installments', 'from', v_prev.installments, 'to', coalesce(p_installments, 1)));
  end if;

  if jsonb_array_length(v_changed) = 0 then
    raise exception 'A counteroffer must change at least one term; accept the request instead.'
      using errcode = 'check_violation';
  end if;

  -- Rule 2 is enforced here too, so the failure is a clear message rather than
  -- a bare unique-violation.
  if exists (select 1 from public.credit_request_versions where request_id = p_request_id and is_counteroffer) then
    raise exception 'This request has already been counteroffered once. There is no counter-counteroffer.'
      using errcode = 'check_violation';
  end if;

  insert into public.credit_request_versions (
    request_id, version_no, author_role, author_party_id,
    principal, fee_amount, repayment_date, installments, note,
    changed_fields, supersedes_id, is_counteroffer
  ) values (
    p_request_id, v_prev.version_no + 1, 'shop_owner', public.current_party_id(),
    p_principal, coalesce(p_fee_amount, 0), p_repayment_date, coalesce(p_installments, 1), p_note,
    v_changed, v_prev.id, true
  )
  returning * into v_version;

  update public.credit_requests
     set current_version_id = v_version.id
   where id = p_request_id;

  perform public.credit_set_status(p_request_id, 'counteroffered', v_version.id, 'shop_owner', 'counteroffer', p_note);

  select * into v_req from public.credit_requests where id = p_request_id;
  return v_req;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row 3: the farmer decides
-- ---------------------------------------------------------------------------

-- Accepting is refusing-to-accept-the-wrong-terms by construction: the caller
-- must name the version it displayed, and a mismatch is an error rather than a
-- silent success on terms the farmer never saw.
create or replace function public.credit_farmer_accept(
  p_request_id        uuid,
  p_shown_version_id  uuid,
  p_shown_snapshot    jsonb
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req  public.credit_requests;
  v_stage text;
begin
  perform public.assert_credit_actor(p_request_id, 'farmer');
  select * into v_req from public.credit_requests where id = p_request_id for update;

  if v_req.status not in ('awaiting_farmer_decision', 'counteroffered') then
    raise exception 'The farmer has nothing to decide: the request is %.', v_req.status
      using errcode = 'check_violation';
  end if;

  if p_shown_version_id is distinct from v_req.current_version_id then
    raise exception 'The terms changed since they were displayed. Reload the current terms before accepting.'
      using errcode = 'check_violation';
  end if;

  v_stage := case when v_req.status = 'counteroffered' then 'counteroffer' else 'initial_terms' end;

  -- Rule 4: the consent row records the version and what was on screen.
  insert into public.credit_consents (request_id, version_id, farmer_id, shown_snapshot, consent_stage)
  values (p_request_id, p_shown_version_id, v_req.farmer_id, p_shown_snapshot, v_stage)
  on conflict (request_id, version_id, consent_stage) do nothing;

  update public.credit_requests
     set agreed_version_id = p_shown_version_id
   where id = p_request_id;

  return public.credit_set_status(
    p_request_id, 'awaiting_final_approval', p_shown_version_id, 'farmer', 'accept', 'Farmer accepted the displayed terms'
  );
end;
$$;

create or replace function public.credit_farmer_reject(
  p_request_id uuid,
  p_reason     text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
begin
  perform public.assert_credit_actor(p_request_id, 'farmer');
  select * into v_req from public.credit_requests where id = p_request_id;

  if v_req.status not in ('awaiting_farmer_decision', 'counteroffered') then
    raise exception 'The farmer cannot reject a request that is %.', v_req.status using errcode = 'check_violation';
  end if;

  return public.credit_set_status(p_request_id, 'rejected', v_req.current_version_id, 'farmer', 'reject', p_reason);
end;
$$;

create or replace function public.credit_farmer_withdraw(
  p_request_id uuid,
  p_reason     text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.credit_requests;
begin
  perform public.assert_credit_actor(p_request_id, 'farmer');
  select * into v_req from public.credit_requests where id = p_request_id;

  if v_req.status not in ('requested', 'shop_owner_reviewing', 'awaiting_farmer_decision', 'counteroffered') then
    raise exception 'A request in % can no longer be withdrawn.', v_req.status using errcode = 'check_violation';
  end if;

  return public.credit_set_status(p_request_id, 'withdrawn', v_req.current_version_id, 'farmer', 'withdraw', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row 4: the shop owner's final decision — the only commit
-- ---------------------------------------------------------------------------

create or replace function public.credit_owner_final_decision(
  p_request_id uuid,
  p_approve    boolean,
  p_reason     text default null
)
returns public.credit_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req     public.credit_requests;
  v_version public.credit_request_versions;
  v_agreement public.credit_agreements;
begin
  perform public.assert_credit_actor(p_request_id, 'shop_owner');
  select * into v_req from public.credit_requests where id = p_request_id for update;

  if v_req.status <> 'awaiting_final_approval' then
    raise exception 'Final approval is only available once the farmer has accepted. Current state: %.', v_req.status
      using errcode = 'check_violation';
  end if;

  -- The farmer must have agreed to the version now under final approval.
  if v_req.agreed_version_id is null then
    raise exception 'No farmer agreement is recorded for this request.' using errcode = 'check_violation';
  end if;

  if not p_approve then
    return public.credit_set_status(p_request_id, 'rejected', v_req.current_version_id, 'shop_owner', 'reject', p_reason);
  end if;

  select * into v_version from public.credit_request_versions where id = v_req.agreed_version_id;

  -- Rule 6 and 7: the commit. Unique(request_id) means a retried call raises
  -- unique_violation, which is caught below and reported as already-committed
  -- rather than silently creating a second agreement.
  insert into public.credit_agreements (
    request_id, version_id, farmer_id, dealer_id,
    principal, fee_amount, repayment_date, installments, committed_by
  ) values (
    p_request_id, v_version.id, v_req.farmer_id, v_req.dealer_id,
    v_version.principal, v_version.fee_amount, v_version.repayment_date, v_version.installments,
    public.current_party_id()
  )
  returning * into v_agreement;

  perform public.write_audit(
    'credit.committed', 'credit_agreements', v_agreement.id, p_request_id::text,
    'awaiting_final_approval', 'accepted',
    jsonb_build_object('principal', v_version.principal, 'fee', v_version.fee_amount)
  );

  insert into public.notification_events (party_id, kind, credit_request_id)
  values (v_req.farmer_id, 'credit_update', p_request_id)
  on conflict do nothing;

  return public.credit_set_status(p_request_id, 'accepted', v_version.id, 'shop_owner', 'accept', 'Final approval granted');

exception
  when unique_violation then
    raise exception 'This credit request has already been committed.'
      using errcode = 'unique_violation';
end;
$$;

comment on function public.credit_owner_final_decision(uuid, boolean, text) is
  'Rules 6, 7 and 9. The agreement insert is the commit; a duplicate call fails loudly instead of lending twice.';

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

-- Paid never exceeds outstanding, enforced inside a row lock so two concurrent
-- payments cannot both pass the check.
create or replace function public.credit_record_payment(
  p_agreement_id    uuid,
  p_amount          numeric,
  p_paid_on         date default current_date,
  p_method          text default 'cash',
  p_note            text default null,
  p_idempotency_key text default null
)
returns public.credit_payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agreement public.credit_agreements;
  v_outstanding numeric;
  v_payment   public.credit_payments;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment must be greater than zero.' using errcode = 'check_violation';
  end if;

  -- Lock the agreement: serialises concurrent payments against the same debt.
  select * into v_agreement from public.credit_agreements where id = p_agreement_id for update;
  if not found then
    raise exception 'Agreement % not found.', p_agreement_id using errcode = 'no_data_found';
  end if;

  v_outstanding := public.credit_outstanding(p_agreement_id);

  if v_outstanding <= 0 then
    raise exception 'This credit is already settled; no further payment can be recorded.'
      using errcode = 'check_violation';
  end if;

  if p_amount > v_outstanding then
    raise exception 'Payment of % exceeds the outstanding balance of %.', p_amount, v_outstanding
      using errcode = 'check_violation';
  end if;

  insert into public.credit_payments (agreement_id, amount, paid_on, method, note, recorded_by, idempotency_key)
  values (p_agreement_id, p_amount, coalesce(p_paid_on, current_date), coalesce(p_method, 'cash'), p_note, public.current_party_id(), p_idempotency_key)
  returning * into v_payment;

  perform public.write_audit(
    'credit.payment_recorded', 'credit_payments', v_payment.id, p_agreement_id::text,
    null, null,
    jsonb_build_object('amount', p_amount, 'outstanding_before', v_outstanding, 'outstanding_after', v_outstanding - p_amount)
  );

  return v_payment;
exception
  when unique_violation then
    -- Same idempotency key: return the original payment instead of paying twice.
    select * into v_payment
      from public.credit_payments
     where agreement_id = p_agreement_id and idempotency_key = p_idempotency_key;
    if found then
      return v_payment;
    end if;
    raise;
end;
$$;

comment on function public.credit_record_payment(uuid, numeric, date, text, text, text) is
  'Refuses overpayment and refuses payment on a settled agreement, under a row lock so concurrent callers cannot both succeed.';

-- ---------------------------------------------------------------------------
-- Read model for the Credit Centre
-- ---------------------------------------------------------------------------

create or replace function public.farmer_credit_overview(p_farmer_id uuid)
returns table (
  request_id      uuid,
  dealer_id       uuid,
  dealer_name     text,
  order_ref       text,
  order_label     text,
  status          public.credit_status,
  is_farmer_turn  boolean,
  is_dealer_turn  boolean,
  principal       numeric,
  fee_amount      numeric,
  repayment_date  date,
  installments    integer,
  version_no      integer,
  changed_fields  jsonb,
  agreed_version_id uuid,
  agreement_id    uuid,
  outstanding     numeric,
  last_transition_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.id,
    r.dealer_id,
    d.shop_name,
    r.order_ref,
    r.order_label,
    r.status,
    r.status in ('awaiting_farmer_decision', 'counteroffered'),
    r.status in ('requested', 'shop_owner_reviewing', 'awaiting_final_approval'),
    v.principal,
    v.fee_amount,
    v.repayment_date,
    v.installments,
    v.version_no,
    v.changed_fields,
    r.agreed_version_id,
    a.id,
    case when a.id is not null then public.credit_outstanding(a.id) else null end,
    r.last_transition_at
  from public.credit_requests r
  join public.dealer_profiles d on d.id = r.dealer_id
  left join public.credit_request_versions v on v.id = r.current_version_id
  left join public.credit_agreements a on a.request_id = r.id
  where r.farmer_id = p_farmer_id
  order by r.last_transition_at desc;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000800_community.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0008 · community
--
-- The community feature is the one place a farmer publishes. The PRD wants:
-- guests may read, identity is required to write, a report is a report and not
-- a deletion, and content the author deletes leaves the answers written to it.
--
-- That last rule is unusual and easy to get wrong, so it is a schema decision
-- here: replies do not cascade from posts. Deleting a post is a soft delete
-- that hides the body while the thread survives.

create table public.community_boards (
  code        text primary key,
  name_en     text not null,
  name_ur     text not null,
  names_local jsonb not null default '{}'::jsonb,
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true
);

insert into public.community_boards (code, name_en, name_ur, sort_order) values
  ('general',   'General',    'عمومی',      10),
  ('crops',     'Crops',      'فصلیں',      20),
  ('pests',     'Pests',      'کیڑے',       30),
  ('weather',   'Weather',    'موسم',       40),
  ('market',    'Market',     'منڈی',       50),
  ('machinery', 'Machinery',  'مشینری',     60);

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------

create table public.community_posts (
  id             uuid primary key default gen_random_uuid(),
  board_code     text not null references public.community_boards (code),
  author_id      uuid references public.parties (id) on delete set null,
  -- Kept even if the author later deletes their account, so the thread remains
  -- readable without exposing an identity that no longer exists.
  author_name    text not null default 'Farmer',
  title          text,
  body           text not null check (length(btrim(body)) between 1 and 8000),
  crop_code      text references public.crop_catalog (code),
  area_label     text,
  language       text not null default 'ur',
  -- Soft delete. The row stays so replies keep their parent.
  deleted_at     timestamptz,
  deleted_by     uuid references public.parties (id),
  -- Moderation outcome, distinct from the author's own deletion.
  hidden_at      timestamptz,
  hidden_by      uuid references public.parties (id),
  hidden_reason  text,
  reply_count    integer not null default 0,
  reaction_count integer not null default 0,
  idempotency_key text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger community_posts_touch before update on public.community_posts
  for each row execute function public.touch_updated_at();

create index community_posts_feed_idx on public.community_posts (board_code, created_at desc)
  where deleted_at is null and hidden_at is null;

create unique index community_posts_idempotency_idx
  on public.community_posts (author_id, idempotency_key)
  where idempotency_key is not null;

comment on table public.community_posts is
  'Author deletion is soft. `deleted_at` hides the body; the row survives so the answers written to it remain reachable, which is what the PRD asks for.';

-- ---------------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------------

-- Note the absence of ON DELETE CASCADE from post_id. Replies outlive the post
-- body, and the database will not let a post deletion take them with it.
create table public.community_replies (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.community_posts (id) on delete restrict,
  parent_id      uuid references public.community_replies (id) on delete restrict,
  author_id      uuid references public.parties (id) on delete set null,
  author_name    text not null default 'Farmer',
  body           text not null check (length(btrim(body)) between 1 and 4000),
  deleted_at     timestamptz,
  deleted_by     uuid references public.parties (id),
  hidden_at      timestamptz,
  hidden_by      uuid references public.parties (id),
  hidden_reason  text,
  reaction_count integer not null default 0,
  idempotency_key text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger community_replies_touch before update on public.community_replies
  for each row execute function public.touch_updated_at();

create index community_replies_thread_idx on public.community_replies (post_id, created_at);

create unique index community_replies_idempotency_idx
  on public.community_replies (author_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.community_replies.post_id is
  'ON DELETE RESTRICT, not CASCADE. A post cannot be hard-deleted out from under its answers, so the PRD rule that a deleted post leaves its replies intact is enforced by the foreign key.';

-- Keep the denormalised counters honest from the database side.
create or replace function public.sync_post_reply_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post uuid;
begin
  -- TG_OP branching rather than coalesce(new.x, old.x): in a DELETE trigger the
  -- NEW record is unassigned and merely reading a field from it raises.
  if tg_op = 'DELETE' then
    v_post := old.post_id;
  else
    v_post := new.post_id;
  end if;

  update public.community_posts p
     set reply_count = (
       select count(*) from public.community_replies r
        where r.post_id = v_post and r.deleted_at is null and r.hidden_at is null
     )
   where p.id = v_post;

  return null;
end;
$$;

-- Separate triggers because "update of <columns>" cannot be combined with
-- "or delete" in a single trigger definition.
create trigger community_replies_sync_count_write
  after insert or update of deleted_at, hidden_at on public.community_replies
  for each row execute function public.sync_post_reply_count();

create trigger community_replies_sync_count_delete
  after delete on public.community_replies
  for each row execute function public.sync_post_reply_count();

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

create table public.community_reactions (
  id          bigserial primary key,
  party_id    uuid not null references public.parties (id) on delete cascade,
  post_id     uuid references public.community_posts (id) on delete cascade,
  reply_id    uuid references public.community_replies (id) on delete cascade,
  kind        text not null default 'helpful' check (kind in ('helpful', 'thanks', 'agree')),
  created_at  timestamptz not null default now(),
  constraint community_reactions_one_target check (
    (post_id is not null)::int + (reply_id is not null)::int = 1
  )
);

create unique index community_reactions_post_idx
  on public.community_reactions (party_id, post_id, kind) where post_id is not null;
create unique index community_reactions_reply_idx
  on public.community_reactions (party_id, reply_id, kind) where reply_id is not null;

-- ---------------------------------------------------------------------------
-- Stories
-- ---------------------------------------------------------------------------

create table public.community_stories (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null references public.parties (id) on delete cascade,
  author_name    text not null default 'Farmer',
  caption        text,
  media_id       uuid,
  crop_code      text references public.crop_catalog (code),
  area_label     text,
  -- Stories expire by design, not by a cleanup job guessing.
  expires_at     timestamptz not null default now() + interval '24 hours',
  created_at     timestamptz not null default now(),
  constraint community_stories_expiry check (expires_at > created_at)
);

create index community_stories_live_idx on public.community_stories (expires_at desc);

create table public.community_story_views (
  story_id    uuid not null references public.community_stories (id) on delete cascade,
  viewer_id   uuid not null references public.parties (id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- ---------------------------------------------------------------------------
-- Blocks
-- ---------------------------------------------------------------------------

-- A block hides one author's content from another farmer. It is a reading
-- preference and never a moderation outcome.
create table public.community_blocks (
  blocker_id  uuid not null references public.parties (id) on delete cascade,
  blocked_id  uuid not null references public.parties (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint community_blocks_not_self check (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------------------------
-- Reading and writing
-- ---------------------------------------------------------------------------

-- One feed function for every client, filtered by blocks. A guest (no party)
-- gets the same feed with is_mine false everywhere, which is how "guests may
-- read" stays true without a second code path.
create or replace function public.community_feed(
  p_farmer_id uuid default null,
  p_board     text default null,
  p_limit     integer default 30,
  p_before    timestamptz default null
)
returns table (
  post_id      uuid,
  board_code   text,
  author_name  text,
  title        text,
  body         text,
  crop_code    text,
  area_label   text,
  reply_count  integer,
  reaction_count integer,
  is_mine      boolean,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.board_code,
    p.author_name,
    p.title,
    p.body,
    p.crop_code,
    p.area_label,
    p.reply_count,
    p.reaction_count,
    (p_farmer_id is not null and p.author_id = p_farmer_id),
    p.created_at
  from public.community_posts p
  where p.deleted_at is null
    and p.hidden_at is null
    and (p_board is null or p.board_code = p_board)
    and (p_before is null or p.created_at < p_before)
    and not exists (
      select 1 from public.community_blocks b
       where p_farmer_id is not null
         and b.blocker_id = p_farmer_id
         and b.blocked_id = p.author_id
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

comment on function public.community_feed(uuid, text, integer, timestamptz) is
  'Public reading path. A NULL farmer id is a guest: same rows, minus the viewer-specific bits — not a separate query with its own bugs.';

-- Posting requires identity. This is enforced by the function refusing a NULL
-- author, and by the RLS policy in migration 0013 which requires auth.uid().
create or replace function public.community_create_post(
  p_author_id     uuid,
  p_board_code    text,
  p_title         text,
  p_body          text,
  p_crop_code     text default null,
  p_area_label    text default null,
  p_language      text default 'ur',
  p_idempotency_key text default null
)
returns public.community_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
  v_name text;
begin
  if p_author_id is null then
    raise exception 'Posting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_posts (
    board_code, author_id, author_name, title, body, crop_code, area_label, language, idempotency_key
  ) values (
    p_board_code, p_author_id, coalesce(v_name, 'Farmer'), p_title, p_body, p_crop_code, p_area_label, p_language, p_idempotency_key
  )
  returning * into v_post;

  return v_post;
exception
  when unique_violation then
    -- Offline queue replaying the same post.
    select * into v_post
      from public.community_posts
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_post;
    end if;
    raise;
end;
$$;

create or replace function public.community_create_reply(
  p_author_id     uuid,
  p_post_id       uuid,
  p_body          text,
  p_parent_id     uuid default null,
  p_idempotency_key text default null
)
returns public.community_replies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reply public.community_replies;
  v_name  text;
  v_post  public.community_posts;
begin
  if p_author_id is null then
    raise exception 'Replying requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_post from public.community_posts where id = p_post_id;
  if not found then
    raise exception 'Post % not found.', p_post_id using errcode = 'no_data_found';
  end if;

  -- The thread stays open even when the body is gone: that is the point of a
  -- soft delete. What is closed is a moderated post.
  if v_post.hidden_at is not null then
    raise exception 'This post has been hidden and is closed to replies.' using errcode = 'check_violation';
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_replies (post_id, parent_id, author_id, author_name, body, idempotency_key)
  values (p_post_id, p_parent_id, p_author_id, coalesce(v_name, 'Farmer'), p_body, p_idempotency_key)
  returning * into v_reply;

  return v_reply;
exception
  when unique_violation then
    select * into v_reply
      from public.community_replies
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_reply;
    end if;
    raise;
end;
$$;

-- Author deletion: soft, and permitted only on your own content.
create or replace function public.community_delete_own_post(p_post_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
begin
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'Post % not found.', p_post_id using errcode = 'no_data_found';
  end if;

  if v_post.author_id is distinct from p_actor then
    raise exception 'You can only delete your own post.' using errcode = 'insufficient_privilege';
  end if;

  -- Body hidden, replies untouched. This is the PRD rule, in one statement.
  update public.community_posts
     set deleted_at = now(), deleted_by = p_actor, body = '', title = null
   where id = p_post_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003000900_moderation.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0009 · moderation
--
-- PRD: Report -> Moderation Case -> Admin/Moderation Review -> Action -> Audit.
-- Outcomes available: dismiss, warn, hide/restrict, remove, escalate. A report
-- must NOT automatically equal permanent deletion. AI may detect and prioritise
-- risk, but must not independently perform irreversible moderation decisions.
--
-- Two of those become constraints rather than habits:
--   * a report is not a case outcome, so `community_reports` has no outcome
--     column at all — it cannot delete anything even by mistake
--   * any outcome beyond dismiss/escalate requires a human actor, enforced by
--     a CHECK constraint on the action row itself
--
-- "Audit" is the shared audit_log from migration 0001, so moderation is
-- auditable in the same ledger as credit and verification rather than its own
-- private trail.

create table public.community_reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid references public.parties (id) on delete set null,
  target_type    public.moderation_target not null,
  target_id      uuid not null,
  -- Why. Fixed vocabulary so reports can be triaged consistently.
  reason_code    text not null check (reason_code in (
    'spam', 'abuse', 'misinformation', 'unsafe_advice', 'off_topic', 'duplicate', 'other'
  )),
  note           text,
  -- The reporter's own account of what they saw. Kept alongside the target so
  -- the case survives the target later being edited.
  snapshot       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index community_reports_target_idx on public.community_reports (target_type, target_id, created_at desc);

-- One open report per reporter per target: reporting the same post five times is
-- noise, and noise is what makes a moderation queue unusable.
create unique index community_reports_one_open_idx
  on public.community_reports (reporter_id, target_type, target_id)
  where reporter_id is not null;

comment on table public.community_reports is
  'A report records an allegation. It carries no outcome and references no action: reporting is not moderating, and no row here can hide or delete anything.';

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

create table public.moderation_cases (
  id             uuid primary key default gen_random_uuid(),
  -- Human-readable reference for support conversations.
  reference      text not null unique default ('MC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  target_type    public.moderation_target not null,
  target_id      uuid not null,
  status         text not null default 'open' check (status in ('open', 'triaged', 'reviewing', 'resolved', 'dismissed')),
  severity       text not null default 'normal' check (severity in ('low', 'normal', 'high', 'urgent')),
  -- How many distinct reports fed this case. Evidence of a pattern, not a verdict.
  report_count   integer not null default 0,
  -- Automation may raise this and set severity. It may not resolve the case.
  risk_score     numeric check (risk_score >= 0 and risk_score <= 1),
  risk_signals   jsonb not null default '[]'::jsonb,
  assigned_to    uuid references public.parties (id),
  opened_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  constraint moderation_cases_resolved_consistency check (
    (status in ('resolved', 'dismissed')) = (resolved_at is not null)
  )
);

create unique index moderation_cases_open_target_idx
  on public.moderation_cases (target_type, target_id)
  where status in ('open', 'triaged', 'reviewing');

create index moderation_cases_queue_idx on public.moderation_cases (status, severity, opened_at);

comment on column public.moderation_cases.risk_score is
  'Set by automated triage to order the queue. It cannot close a case; only a human action with an outcome can, which the actions table enforces.';

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------

create table public.moderation_actions (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references public.moderation_cases (id) on delete cascade,
  outcome        public.moderation_outcome not null,
  -- Who or what performed it. 'automated' exists so triage can be recorded
  -- honestly instead of being disguised as a human action.
  performed_by_kind text not null default 'human' check (performed_by_kind in ('human', 'automated')),
  actor_id       uuid references public.parties (id),
  reason         text not null,
  -- How long a restriction lasts, when the outcome is time-bound.
  expires_at     timestamptz,
  -- Reversal, so a wrong call is correctable and the correction is visible.
  reversed_at    timestamptz,
  reversed_by    uuid references public.parties (id),
  created_at     timestamptz not null default now(),
  -- The core rule. An automated actor may only dismiss or escalate: everything
  -- punitive is reserved for a human, and a human is required to be named.
  constraint moderation_actions_human_for_punitive check (
    (performed_by_kind = 'automated' and outcome in ('dismiss', 'escalate'))
    or (performed_by_kind = 'human' and actor_id is not null)
  ),
  constraint moderation_actions_expiry check (expires_at is null or expires_at > created_at)
);

create index moderation_actions_case_idx on public.moderation_actions (case_id, created_at desc);

comment on constraint moderation_actions_human_for_punitive on public.moderation_actions is
  'A warn, restrict, hide or remove with performed_by_kind = automated is rejected by the database, and a human outcome with no named actor is rejected too. AI triage cannot delete a farmer''s post.';

-- ---------------------------------------------------------------------------
-- Applying an outcome
-- ---------------------------------------------------------------------------

-- One function that both records the decision and applies it, so an outcome can
-- never be recorded without taking effect (or take effect without a record).
create or replace function public.moderate_apply(
  p_case_id     uuid,
  p_outcome     public.moderation_outcome,
  p_reason      text,
  p_actor_id    uuid default null,
  p_expires_at  timestamptz default null
)
returns public.moderation_actions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case   public.moderation_cases;
  v_action public.moderation_actions;
  v_actor  uuid := coalesce(p_actor_id, public.current_party_id());
  v_kind   text;
begin
  select * into v_case from public.moderation_cases where id = p_case_id for update;
  if not found then
    raise exception 'Moderation case % not found.', p_case_id using errcode = 'no_data_found';
  end if;

  v_kind := case when v_actor is null then 'automated' else 'human' end;

  -- Mirrors the table constraint with a clearer message. The constraint is the
  -- real guard; this is the explanation.
  if v_kind = 'human' and not public.has_capability('moderator') and not public.has_capability('admin') then
    raise exception 'Moderation requires the moderator or admin capability.' using errcode = 'insufficient_privilege';
  end if;

  if v_kind = 'automated' and p_outcome not in ('dismiss', 'escalate') then
    raise exception 'An automated system may only dismiss or escalate; % requires a human moderator.', p_outcome
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.moderation_actions (case_id, outcome, performed_by_kind, actor_id, reason, expires_at)
  values (p_case_id, p_outcome, v_kind, v_actor, p_reason, p_expires_at)
  returning * into v_action;

  -- Apply the effect to the target.
  if p_outcome in ('hide', 'remove', 'restrict') then
    if v_case.target_type = 'post' then
      update public.community_posts
         set hidden_at = now(), hidden_by = v_actor, hidden_reason = p_reason
       where id = v_case.target_id;
    elsif v_case.target_type = 'reply' then
      update public.community_replies
         set hidden_at = now(), hidden_by = v_actor, hidden_reason = p_reason
       where id = v_case.target_id;
    elsif v_case.target_type = 'story' then
      update public.community_stories
         set expires_at = now()
       where id = v_case.target_id;
    end if;
  end if;

  -- A dismiss or a resolved punitive action closes the case. An escalation
  -- deliberately leaves it open for the next reviewer.
  if p_outcome in ('dismiss', 'warn', 'hide', 'restrict', 'remove') then
    update public.moderation_cases
       set status = case when p_outcome = 'dismiss' then 'dismissed' else 'resolved' end,
           resolved_at = now()
     where id = p_case_id;
  elsif p_outcome = 'escalate' then
    update public.moderation_cases
       set status = 'reviewing', severity = 'high'
     where id = p_case_id;
  end if;

  perform public.write_audit(
    'moderation.action',
    'moderation_cases',
    p_case_id,
    v_case.reference,
    v_case.status::text,
    p_outcome::text,
    jsonb_build_object(
      'outcome', p_outcome,
      'performed_by_kind', v_kind,
      'target_type', v_case.target_type,
      'target_id', v_case.target_id,
      'reason', p_reason
    ),
    v_actor,
    case when v_kind = 'automated' then 'system' else 'moderator' end
  );

  return v_action;
end;
$$;

comment on function public.moderate_apply(uuid, public.moderation_outcome, text, uuid, timestamptz) is
  'Records the decision and applies it in one transaction, and is the only path to hiding or removing content. Escalation leaves the case open on purpose.';

-- ---------------------------------------------------------------------------
-- Intake
-- ---------------------------------------------------------------------------

-- A report opens or joins a case. It never resolves one.
create or replace function public.community_report_content(
  p_reporter_id uuid,
  p_target_type public.moderation_target,
  p_target_id   uuid,
  p_reason_code text,
  p_note        text default null
)
returns public.moderation_cases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.moderation_cases;
  v_id   uuid;
begin
  if p_reporter_id is null then
    raise exception 'Reporting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.community_reports (reporter_id, target_type, target_id, reason_code, note)
  values (p_reporter_id, p_target_type, p_target_id, p_reason_code, p_note)
  returning id into v_id;

  select * into v_case
    from public.moderation_cases
   where target_type = p_target_type
     and target_id = p_target_id
     and status in ('open', 'triaged', 'reviewing');

  if not found then
    insert into public.moderation_cases (target_type, target_id, report_count)
    values (p_target_type, p_target_id, 1)
    returning * into v_case;
  else
    update public.moderation_cases
       set report_count = report_count + 1,
           status = case when status = 'open' then 'triaged' else status end
     where id = v_case.id
    returning * into v_case;
  end if;

  perform public.write_audit(
    'moderation.report_filed', 'moderation_cases', v_case.id, v_case.reference,
    null, v_case.status,
    jsonb_build_object('reason_code', p_reason_code, 'target_type', p_target_type, 'target_id', p_target_id, 'report_id', v_id),
    p_reporter_id,
    'farmer'
  );

  return v_case;
exception
  when unique_violation then
    -- Already reported by this farmer; return the case it belongs to.
    select * into v_case
      from public.moderation_cases
     where target_type = p_target_type
       and target_id = p_target_id
       and status in ('open', 'triaged', 'reviewing');
    if found then
      return v_case;
    end if;
    raise;
end;
$$;

comment on function public.community_report_content(uuid, public.moderation_target, uuid, text, text) is
  'Files an allegation and groups it into a case. Nothing here can hide or remove content, which is what keeps "a report is not a deletion" true by construction.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001000_expert_verification.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0010 · expert verification
--
-- PRD: verification requires a verified identity AND at least one relevant
-- verifiable qualification or certification. Supporting evidence may include
-- specialisation, experience, location, platform history and contribution
-- quality. Final authority is Admin/Moderation. Verification must be auditable.
-- Professional verification must not be granted from community reputation alone.
--
-- Made structural:
--   * qualifications are rows with an issuer and an identifier, and each must be
--     individually confirmed by a human before it counts
--   * the confirm function refuses when the applicant has no verified contact,
--     so "verified identity" is a precondition rather than a checkbox
--   * there is no reputation column anywhere, and the comment on the table says
--     why — an absent field cannot be quietly wired up later by mistake
--   * every status change writes to the shared audit log

create type public.qualification_kind as enum (
  'degree', 'diploma', 'agriculture_certificate', 'license', 'government_training', 'professional_body', 'experience_attestation'
);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------

create table public.expert_applications (
  id             uuid primary key default gen_random_uuid(),
  applicant_id   uuid not null references public.parties (id) on delete cascade,
  reference      text not null unique default ('EX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  -- What they claim expertise in. Crop codes keep it joinable to advice.
  specialisations text[] not null default '{}'::text[],
  crop_codes     text[] not null default '{}'::text[],
  experience_years integer check (experience_years between 0 and 80),
  organisation   text,
  location_label text,
  statement      text not null check (length(btrim(statement)) between 20 and 4000),
  status         public.verification_status not null default 'pending',
  submitted_at   timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid references public.parties (id),
  decision_note  text,
  constraint expert_applications_one_specialisation check (cardinality(specialisations) >= 1)
);

create index expert_applications_queue_idx on public.expert_applications (status, submitted_at);

-- One open application per person: resubmitting is updating, not stacking.
create unique index expert_applications_one_open_idx
  on public.expert_applications (applicant_id)
  where status in ('pending');

-- ---------------------------------------------------------------------------
-- Qualifications
-- ---------------------------------------------------------------------------

create table public.expert_qualifications (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.expert_applications (id) on delete cascade,
  kind           public.qualification_kind not null,
  title          text not null,
  issuer         text not null check (length(btrim(issuer)) >= 2),
  -- Registration, roll or certificate number. Without one of these a claim is
  -- unverifiable, so it is required rather than optional.
  identifier     text not null check (length(btrim(identifier)) >= 2),
  issued_on      date,
  expires_on     date,
  -- Evidence media (front of a certificate, a licence scan).
  evidence_media_id uuid,
  -- Each qualification is confirmed on its own, by a named human.
  verified_at    timestamptz,
  verified_by    uuid references public.parties (id),
  verification_note text,
  created_at     timestamptz not null default now(),
  constraint expert_qualifications_dates check (expires_on is null or issued_on is null or expires_on > issued_on)
);

create index expert_qualifications_app_idx on public.expert_qualifications (application_id);

comment on table public.expert_qualifications is
  'Each qualification carries an issuer and an identifier because a claim without either is not checkable. `verified_by` is a named person, so "who accepted this certificate" always has an answer.';

-- ---------------------------------------------------------------------------
-- Verified status
-- ---------------------------------------------------------------------------

create table public.expert_verifications (
  party_id       uuid primary key references public.parties (id) on delete cascade,
  status         public.verification_status not null default 'unverified',
  specialisations text[] not null default '{}'::text[],
  crop_codes     text[] not null default '{}'::text[],
  -- Which application produced this.
  application_id uuid references public.expert_applications (id) on delete set null,
  verified_at    timestamptz,
  verified_by    uuid references public.parties (id),
  -- Verification is not forever: a licence expires and a suspension is possible.
  expires_at     timestamptz,
  suspended_at   timestamptz,
  suspension_reason text,
  updated_at     timestamptz not null default now()
);

create trigger expert_verifications_touch before update on public.expert_verifications
  for each row execute function public.touch_updated_at();

comment on table public.expert_verifications is
  'The badge the app shows. Deliberately has no reputation, karma or contribution-count column: the PRD forbids granting professional verification from community standing, and a field that does not exist cannot be mistakenly trusted.';

create table public.expert_verification_history (
  id             bigserial primary key,
  party_id       uuid not null references public.parties (id) on delete cascade,
  from_status    public.verification_status,
  to_status      public.verification_status not null,
  actor_id       uuid references public.parties (id),
  note           text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Confirming a qualification
-- ---------------------------------------------------------------------------

create or replace function public.verify_qualification(
  p_qualification_id uuid,
  p_note             text default null
)
returns public.expert_qualifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qual public.expert_qualifications;
  v_actor uuid := public.current_party_id();
begin
  if not (public.has_capability('admin') or public.has_capability('moderator')) then
    raise exception 'Confirming a qualification requires the admin or moderator capability.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.expert_qualifications
     set verified_at = now(), verified_by = v_actor, verification_note = p_note
   where id = p_qualification_id
     and verified_at is null
  returning * into v_qual;

  if not found then
    raise exception 'Qualification % is missing or already confirmed.', p_qualification_id
      using errcode = 'no_data_found';
  end if;

  perform public.write_audit(
    'verification.qualification_confirmed', 'expert_qualifications', p_qualification_id,
    v_qual.identifier, null, 'verified',
    jsonb_build_object('kind', v_qual.kind, 'issuer', v_qual.issuer),
    v_actor, 'admin'
  );

  return v_qual;
end;
$$;

-- ---------------------------------------------------------------------------
-- Granting verification
-- ---------------------------------------------------------------------------

-- The gate the PRD describes, in one place. Refuses without a verified contact
-- (verified identity) and without at least one confirmed qualification.
create or replace function public.grant_expert_verification(
  p_application_id uuid,
  p_expires_at     timestamptz default null,
  p_note           text default null
)
returns public.expert_verifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app       public.expert_applications;
  v_actor     uuid := public.current_party_id();
  v_has_contact boolean;
  v_confirmed integer;
  v_ver       public.expert_verifications;
  v_prev      public.verification_status;
begin
  if not public.has_capability('admin') then
    raise exception 'Granting expert verification requires the admin capability.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_app from public.expert_applications where id = p_application_id for update;
  if not found then
    raise exception 'Application % not found.', p_application_id using errcode = 'no_data_found';
  end if;

  if v_app.status <> 'pending' then
    raise exception 'Application % is % and cannot be granted.', p_application_id, v_app.status
      using errcode = 'check_violation';
  end if;

  -- Requirement 1: verified identity.
  select exists (
    select 1 from public.party_contacts c
     where c.party_id = v_app.applicant_id and c.verified_at is not null
  ) into v_has_contact;

  if not v_has_contact then
    raise exception 'This applicant has no verified contact, so their identity is not established.'
      using errcode = 'check_violation';
  end if;

  -- Requirement 2: at least one relevant verifiable qualification, confirmed by
  -- a human. Community standing contributes nothing here.
  select count(*) into v_confirmed
    from public.expert_qualifications q
   where q.application_id = p_application_id
     and q.verified_at is not null
     and (q.expires_on is null or q.expires_on > current_date);

  if v_confirmed < 1 then
    raise exception 'Verification requires at least one confirmed, unexpired qualification. Found %.', v_confirmed
      using errcode = 'check_violation';
  end if;

  select status into v_prev from public.expert_verifications where party_id = v_app.applicant_id;

  insert into public.expert_verifications as ev (
    party_id, status, specialisations, crop_codes, application_id, verified_at, verified_by, expires_at
  ) values (
    v_app.applicant_id, 'verified', v_app.specialisations, v_app.crop_codes,
    p_application_id, now(), v_actor, p_expires_at
  )
  on conflict (party_id) do update
    set status = 'verified',
        specialisations = excluded.specialisations,
        crop_codes = excluded.crop_codes,
        application_id = excluded.application_id,
        verified_at = now(),
        verified_by = excluded.verified_by,
        expires_at = excluded.expires_at,
        suspended_at = null,
        suspension_reason = null,
        updated_at = now()
  returning * into v_ver;

  update public.expert_applications
     set status = 'verified', reviewed_at = now(), reviewed_by = v_actor, decision_note = p_note
   where id = p_application_id;

  insert into public.expert_verification_history (party_id, from_status, to_status, actor_id, note)
  values (v_app.applicant_id, coalesce(v_prev, 'unverified'), 'verified', v_actor, p_note);

  -- The badge is a capability, granted alongside the record.
  insert into public.party_capabilities (party_id, capability, granted_by)
  values (v_app.applicant_id, 'expert', v_actor)
  on conflict (party_id, capability) do update set revoked_at = null, granted_at = now(), granted_by = excluded.granted_by;

  perform public.write_audit(
    'verification.granted', 'expert_verifications', v_app.applicant_id,
    v_app.reference, coalesce(v_prev::text, 'unverified'), 'verified',
    jsonb_build_object('application_id', p_application_id, 'confirmed_qualifications', v_confirmed, 'expires_at', p_expires_at),
    v_actor, 'admin'
  );

  return v_ver;
end;
$$;

comment on function public.grant_expert_verification(uuid, timestamptz, text) is
  'Enforces both PRD preconditions in the database: a verified contact and at least one human-confirmed, unexpired qualification. Reputation is not an input because it is not a parameter and no such column exists.';

-- ---------------------------------------------------------------------------
-- Suspension and revocation
-- ---------------------------------------------------------------------------

create or replace function public.set_expert_verification_status(
  p_party_id uuid,
  p_status   public.verification_status,
  p_reason   text
)
returns public.expert_verifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_prev  public.verification_status;
  v_ver   public.expert_verifications;
begin
  if not public.has_capability('admin') then
    raise exception 'Changing a verification requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Suspending or revoking a verification requires a reason.' using errcode = 'check_violation';
  end if;

  select status into v_prev from public.expert_verifications where party_id = p_party_id;

  update public.expert_verifications
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else suspended_at end,
         suspension_reason = case when p_status = 'suspended' then p_reason else suspension_reason end
   where party_id = p_party_id
  returning * into v_ver;

  if not found then
    raise exception 'No verification record for party %.', p_party_id using errcode = 'no_data_found';
  end if;

  if p_status in ('suspended', 'revoked') then
    update public.party_capabilities
       set revoked_at = now()
     where party_id = p_party_id and capability = 'expert' and revoked_at is null;
  end if;

  insert into public.expert_verification_history (party_id, from_status, to_status, actor_id, note)
  values (p_party_id, v_prev, p_status, v_actor, p_reason);

  perform public.write_audit(
    'verification.status_changed', 'expert_verifications', p_party_id, null,
    v_prev::text, p_status::text, jsonb_build_object('reason', p_reason), v_actor, 'admin'
  );

  return v_ver;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001100_market_weather.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0011 · market observations and weather readings
--
-- PRD, market: AMIS (or the approved source) -> ingestion adapter -> validation
-- -> normalisation -> observations -> internal market API. Daily updates
-- supported. Historical observations preserved. Never turn missing values into
-- zero. Never invent rates.
--
-- PRD, weather: an approved provider abstraction, WeatherAPI.com as the initial
-- MVP candidate, but the application must not be hard-coded to the provider. The
-- weather shown in the UI and the weather used by AI come from the same
-- normalised service. Advice is paused when the reading is unusable.
--
-- Both rules are implemented as nullability plus a serving function that reports
-- freshness, rather than as instructions to whoever writes the next screen.

-- ---------------------------------------------------------------------------
-- Sources and commodities
-- ---------------------------------------------------------------------------

create table public.market_sources (
  code         text primary key,
  name         text not null,
  kind         text not null check (kind in ('amis_punjab', 'dealer_submitted', 'manual_entry', 'research_feed')),
  -- Where the adapter fetches from. NULL means the source is collected another
  -- way (a dealer pushing figures), which is legitimate and must be expressible.
  endpoint_url text,
  is_active    boolean not null default true,
  notes        text
);

insert into public.market_sources (code, name, kind, notes) values
  ('amis_punjab', 'AMIS Punjab', 'amis_punjab', 'Approved agricultural market information source. The adapter normalises its records; no key is invented here.'),
  ('research_feed', 'Research feed', 'research_feed', 'Non-authoritative rows used in development. Served through the same path so it cannot be mistaken for live AMIS data.');

create table public.market_commodities (
  code       text primary key,
  name_en    text not null,
  name_ur    text not null,
  names_local jsonb not null default '{}'::jsonb,
  unit       text not null default '40kg',
  is_active  boolean not null default true
);

insert into public.market_commodities (code, name_en, name_ur, unit) values
  ('wheat',     'Wheat',     'گندم',   '40kg'),
  ('cotton',    'Cotton',    'کپاس',   '40kg'),
  ('rice',      'Rice',      'چاول',   '40kg'),
  ('maize',     'Maize',     'مکئی',   '40kg'),
  ('sugarcane', 'Sugarcane', 'گنا',    '40kg'),
  ('potato',    'Potato',    'آلو',    '40kg'),
  ('onion',     'Onion',     'پیاز',   '40kg'),
  ('gram',      'Gram',      'چنا',    '40kg');

-- ---------------------------------------------------------------------------
-- Observations
-- ---------------------------------------------------------------------------

-- Every price column is nullable, and at least one must be present. A missing
-- minimum is NULL and displays as "not reported"; it can never be stored as 0,
-- because 0 is a real price and the two must stay distinguishable.
create table public.market_observations (
  id             bigserial primary key,
  source_code    text not null references public.market_sources (code),
  commodity_code text not null references public.market_commodities (code),
  market_name    text not null,
  district       text,
  observed_on    date not null,
  min_price      numeric check (min_price >= 0),
  max_price      numeric check (max_price >= 0),
  modal_price    numeric check (modal_price >= 0),
  currency       text not null default 'PKR',
  unit           text not null default '40kg',
  -- Volume traded, when the source reports it. NULL is "not reported".
  arrivals_tonnes numeric check (arrivals_tonnes >= 0),
  -- The row exactly as received, so a normalisation mistake is debuggable and
  -- the original is never lost.
  raw            jsonb not null default '{}'::jsonb,
  ingested_at    timestamptz not null default now(),
  -- Which ingestion run produced this, for tracing a bad batch.
  run_id         bigint,
  constraint market_observations_some_price check (
    min_price is not null or max_price is not null or modal_price is not null
  ),
  constraint market_observations_price_order check (
    min_price is null or max_price is null or min_price <= max_price
  ),
  -- One row per source, commodity, market and day. Re-ingesting a day updates
  -- rather than duplicating, which is what makes a re-run safe.
  unique (source_code, commodity_code, market_name, observed_on)
);

create index market_observations_lookup_idx
  on public.market_observations (commodity_code, observed_on desc);

create index market_observations_market_idx
  on public.market_observations (market_name, commodity_code, observed_on desc);

comment on column public.market_observations.min_price is
  'NULL means the source did not report a minimum. It is never coerced to zero, because zero is a valid price and the two must remain distinguishable.';

-- Historical rows are never deleted or rewritten by the serving path.
comment on table public.market_observations is
  'Append-and-update only, keyed by source/commodity/market/day. History is preserved so a past rate can always be reconstructed from the raw payload.';

create table public.market_ingestion_runs (
  id             bigserial primary key,
  source_code    text not null references public.market_sources (code),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  rows_seen      integer not null default 0,
  rows_written   integer not null default 0,
  rows_rejected  integer not null default 0,
  -- Why rows were rejected, aggregated so a systematic parse error is obvious.
  rejection_reasons jsonb not null default '{}'::jsonb,
  error          text
);

-- ---------------------------------------------------------------------------
-- Internal market API
-- ---------------------------------------------------------------------------

-- The only way prices reach a client. Reports age and never invents a figure:
-- a commodity with no recent observation is returned with has_recent false
-- rather than an estimate.
create or replace function public.market_rates(
  p_commodity text default null,
  p_max_age_hours integer default 36
)
returns table (
  commodity_code text,
  commodity_name_en text,
  commodity_name_ur text,
  unit           text,
  market_name    text,
  observed_on    date,
  age_hours      numeric,
  min_price      numeric,
  max_price      numeric,
  modal_price    numeric,
  currency       text,
  source_code    text,
  source_name    text,
  is_recent      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with latest as (
    select distinct on (o.commodity_code, o.market_name)
      o.*
    from public.market_observations o
    where (p_commodity is null or o.commodity_code = p_commodity)
    order by o.commodity_code, o.market_name, o.observed_on desc, o.ingested_at desc
  )
  select
    l.commodity_code,
    c.name_en,
    c.name_ur,
    l.unit,
    l.market_name,
    l.observed_on,
    round((extract(epoch from (now() - l.observed_on::timestamptz)) / 3600.0)::numeric, 1),
    l.min_price,
    l.max_price,
    l.modal_price,
    l.currency,
    l.source_code,
    s.name,
    (l.observed_on >= (current_date - make_interval(hours => greatest(1, p_max_age_hours))::interval)::date)
  from latest l
  join public.market_commodities c on c.code = l.commodity_code
  join public.market_sources s on s.code = l.source_code
  order by c.name_en, l.market_name;
$$;

comment on function public.market_rates(text, integer) is
  'Serving path for both the UI and the AI. `is_recent` is reported rather than filtered, so a stale rate can be shown as stale instead of silently disappearing or being refreshed with a guess.';

-- ---------------------------------------------------------------------------
-- Weather provider abstraction
-- ---------------------------------------------------------------------------

create table public.weather_providers (
  code            text primary key,
  name            text not null,
  -- The PRD names WeatherAPI.com as the initial commercial candidate. The
  -- application talks to this table, not to that vendor.
  is_initial_candidate boolean not null default false,
  requires_api_key boolean not null default true,
  attribution     text,
  is_active       boolean not null default true,
  notes           text
);

insert into public.weather_providers (code, name, is_initial_candidate, attribution, notes) values
  ('weatherapi', 'WeatherAPI.com', true, 'Weather data by WeatherAPI.com',
   'Initial MVP candidate named in the PRD. Referenced only by this row; switching provider means adding a row and an adapter, not editing screens.'),
  ('research_fixture', 'Research fixture', false, 'Synthetic readings for development',
   'Development-only readings. Marked so the UI cannot present them as live weather.');

-- Readings are cached per rounded location cell, so a village shares one fetch
-- instead of one per farmer.
create table public.weather_readings (
  id             bigserial primary key,
  provider_code  text not null references public.weather_providers (code),
  lat_cell       numeric(8,3) not null,
  lon_cell       numeric(8,3) not null,
  -- When the provider says it was observed, and when we fetched it. Both matter:
  -- a fresh fetch of a stale observation is still stale.
  observed_at    timestamptz not null,
  fetched_at     timestamptz not null default now(),
  temp_c         numeric(5,2),
  feels_like_c   numeric(5,2),
  humidity_pct   integer check (humidity_pct between 0 and 100),
  precip_mm      numeric(7,2) check (precip_mm >= 0),
  wind_kph       numeric(6,2) check (wind_kph >= 0),
  wind_dir       text,
  condition_text text,
  condition_code text,
  -- Forecast rows are separated from current conditions by this, not by time.
  kind           text not null default 'current' check (kind in ('current', 'hourly', 'daily')),
  valid_from     timestamptz,
  valid_to       timestamptz,
  raw            jsonb not null default '{}'::jsonb,
  -- Set when the adapter could not reach the provider: the row records the
  -- failure so the UI can say "cannot read weather" instead of showing nothing.
  fetch_error    text,
  constraint weather_readings_cell check (lat_cell between -90 and 90 and lon_cell between -180 and 180)
);

create index weather_readings_lookup_idx
  on public.weather_readings (lat_cell, lon_cell, kind, observed_at desc);

comment on table public.weather_readings is
  'Normalised readings from whichever provider is active. Both the UI and the AI read this table, which is what makes "same source in both places" structural.';

create table public.weather_ingestion_runs (
  id             bigserial primary key,
  provider_code  text not null references public.weather_providers (code),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'failed')),
  cells_requested integer not null default 0,
  cells_written  integer not null default 0,
  error          text
);

-- Freshness, stated in one place so the UI and the advice engine cannot disagree
-- about whether a reading is usable.
create or replace function public.weather_freshness(p_reading_id bigint)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when r.fetch_error is not null then 'unavailable'
    when r.observed_at > now() - interval '90 minutes' then 'fresh'
    when r.observed_at > now() - interval '6 hours' then 'stale'
    else 'expired'
  end
  from public.weather_readings r
  where r.id = p_reading_id;
$$;

-- The gate the advice engine must consult. A reading that is unavailable, or
-- older than the usable window, pauses advice rather than being used anyway.
create or replace function public.weather_is_usable(
  p_lat double precision,
  p_lon double precision
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.weather_readings r
    where r.kind = 'current'
      and r.lat_cell = round(p_lat::numeric, 3)
      and r.lon_cell = round(p_lon::numeric, 3)
      and r.fetch_error is null
      and r.observed_at > now() - interval '90 minutes'
  );
$$;

comment on function public.weather_is_usable(double precision, double precision) is
  'Returns false when there is no current, error-free reading inside the freshness window. Advice built on weather must check this first and pause rather than guess.';

create or replace function public.latest_weather(
  p_lat double precision,
  p_lon double precision
)
returns table (
  provider_code  text,
  provider_name  text,
  attribution    text,
  observed_at    timestamptz,
  age_minutes    numeric,
  freshness      text,
  is_usable      boolean,
  temp_c         numeric,
  humidity_pct   integer,
  precip_mm      numeric,
  wind_kph       numeric,
  condition_text text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with r as (
    select wr.*
    from public.weather_readings wr
    where wr.kind = 'current'
      and wr.lat_cell = round(p_lat::numeric, 3)
      and wr.lon_cell = round(p_lon::numeric, 3)
    order by wr.observed_at desc
    limit 1
  )
  select
    r.provider_code,
    p.name,
    p.attribution,
    r.observed_at,
    round((extract(epoch from (now() - r.observed_at)) / 60.0)::numeric, 0),
    case
      when r.fetch_error is not null then 'unavailable'
      when r.observed_at > now() - interval '90 minutes' then 'fresh'
      when r.observed_at > now() - interval '6 hours' then 'stale'
      else 'expired'
    end,
    (r.fetch_error is null and r.observed_at > now() - interval '90 minutes'),
    r.temp_c,
    r.humidity_pct,
    r.precip_mm,
    r.wind_kph,
    r.condition_text
  from r
  join public.weather_providers p on p.code = r.provider_code;
$$;

comment on function public.latest_weather(double precision, double precision) is
  'Single weather read path for the app. Returns freshness and is_usable alongside the numbers, so no caller has to decide for itself whether the reading is trustworthy.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001200_media_retention.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0012 · media, processing states and retention
--
-- PRD: client-side compression where practical, server-side validation,
-- an optimised display representation, a higher-quality representation when the
-- AI needs to diagnose, processing states, and automatic cleanup on the
-- retention policy. Original large camera files must not be retained
-- unnecessarily.
--
-- So a media asset records *which* class it is, and the class determines when it
-- dies. The retention numbers themselves live in retention_policies (migration
-- 0001) rather than here, because the PRD calls them technical targets and a
-- target should be changeable without a deployment.

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------

-- Private buckets. Community display copies are served through signed URLs, so
-- a leaked path is not a leaked photo.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('scan-media',   'scan-media',   false, 26214400),
  ('voice-notes',  'voice-notes',  false, 10485760),
  ('community',    'community',    false, 52428800),
  ('verification', 'verification', false, 26214400)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

create table public.media_assets (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.parties (id) on delete cascade,
  media_class     public.media_class not null,
  state           public.media_state not null default 'pending',
  bucket          text not null,
  storage_path    text not null,
  mime_type       text not null,
  bytes           bigint not null check (bytes > 0),
  -- Display and analysis representations are separate rows linked by this, so
  -- the compressed copy can be purged on a different schedule than the original.
  derived_from    uuid references public.media_assets (id) on delete set null,
  representation  text not null default 'original' check (representation in ('original', 'display', 'analysis')),
  width           integer check (width > 0),
  height          integer check (height > 0),
  duration_seconds numeric(7,2) check (duration_seconds >= 0),
  -- Server-side validation outcome. A file that fails is never marked ready.
  validated_at    timestamptz,
  validation_note text,
  -- Retention. purge_after is computed from the policy when the asset reached a
  -- settled state, and is what the cleanup job reads.
  retention_basis timestamptz,
  purge_after     timestamptz,
  purged_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (bucket, storage_path),
  constraint media_assets_purged_consistency check (
    (state = 'purged') = (purged_at is not null)
  )
);

create trigger media_assets_touch before update on public.media_assets
  for each row execute function public.touch_updated_at();

create index media_assets_owner_idx on public.media_assets (owner_id, created_at desc);
create index media_assets_purge_idx on public.media_assets (purge_after) where purged_at is null;

comment on column public.media_assets.representation is
  'Separates the display copy from the analysis copy. Compression is allowed to be aggressive for display and conservative for diagnosis, which the PRD asks for in one breath and which a single file cannot satisfy.';

comment on column public.media_assets.purge_after is
  'Set when the asset settles, from retention_policies. NULL means not yet scheduled, which is different from never.';

-- Compute the purge deadline from policy, in one place, whenever an asset
-- reaches a state where its clock should start.
create or replace function public.schedule_media_purge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy public.retention_policies;
begin
  if new.purge_after is not null and new.state not in ('purged') then
    return new;
  end if;

  select * into v_policy from public.retention_policies where media_class = new.media_class;
  if not found then
    return new;
  end if;

  -- Voice and community media age from creation; scan media ages from the
  -- structured result, because until the diagnosis exists the image is still in
  -- use.
  if v_policy.retain_after = 'created' then
    new.retention_basis := coalesce(new.retention_basis, new.created_at);
  else
    if new.state <> 'ready' and new.state <> 'processing' then
      -- Not yet finished with; leave unscheduled rather than guessing.
      return new;
    end if;
    new.retention_basis := coalesce(new.retention_basis, now());
  end if;

  new.purge_after := new.retention_basis + make_interval(days => v_policy.retain_days);
  return new;
end;
$$;

create trigger media_assets_schedule_purge
  before insert or update of state on public.media_assets
  for each row execute function public.schedule_media_purge();

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

-- Marks assets due for purging and returns them so the caller can delete the
-- objects from storage. The row is kept with state 'purged': the image is gone,
-- the fact that it existed and when it was removed is not.
create or replace function public.purge_due_media(p_limit integer default 500)
returns table (
  asset_id    uuid,
  bucket      text,
  storage_path text,
  media_class public.media_class
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select m.id
    from public.media_assets m
    where m.purged_at is null
      and m.purge_after is not null
      and m.purge_after <= now()
    order by m.purge_after
    limit greatest(1, least(p_limit, 5000))
    for update skip locked
  ),
  marked as (
    update public.media_assets m
       set state = 'purged', purged_at = now(), storage_path = 'purged/' || m.id::text
     where m.id in (select id from due)
    returning m.id, m.bucket, m.storage_path, m.media_class
  )
  select id, bucket, storage_path, media_class from marked;
end;
$$;

comment on function public.purge_due_media(integer) is
  'Scheduled job body. Marks assets whose retention has expired and returns their storage paths for deletion. `for update skip locked` keeps two concurrent runs from purging the same asset twice.';

-- Failed and abandoned uploads are cleaned up on a much shorter clock than
-- content, because they are pure cost.
create or replace function public.purge_stale_uploads(p_max_age interval default '24 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.media_assets m
     where m.state in ('pending', 'uploading')
       and m.created_at < now() - p_max_age
    returning 1
  )
  select count(*) into v_count from gone;

  return v_count;
end;
$$;

comment on function public.purge_stale_uploads(interval) is
  'Deletes upload rows that never completed. These hold no user value and would otherwise accumulate forever.';

-- ---------------------------------------------------------------------------
-- Server-side validation
-- ---------------------------------------------------------------------------

-- Called by the upload path before an asset is trusted. Rejects rather than
-- sanitises: a wrong file is the uploader's problem, not a silent conversion.
create or replace function public.validate_media_upload(
  p_owner_id  uuid,
  p_class     public.media_class,
  p_bucket    text,
  p_path      text,
  p_mime      text,
  p_bytes     bigint
)
returns public.media_assets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed text[];
  v_max     bigint;
  v_asset   public.media_assets;
begin
  v_allowed := case p_class
    when 'voice_note'           then array['audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/aac']
    when 'community_photo'      then array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
    when 'community_video'      then array['video/mp4', 'video/webm', 'video/quicktime']
    when 'scan_source'          then array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
    when 'scan_derived'         then array['image/jpeg', 'image/png', 'image/webp']
    when 'verification_evidence' then array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  end;

  v_max := case p_class
    when 'voice_note'           then 10485760
    when 'community_photo'      then 15728640
    when 'community_video'      then 52428800
    when 'scan_source'          then 26214400
    when 'verification_evidence' then 26214400
    else 15728640
  end;

  if not (p_mime = any (v_allowed)) then
    raise exception 'A % may not be uploaded as %.', p_mime, p_class using errcode = 'check_violation';
  end if;

  if p_bytes > v_max then
    raise exception 'File is % bytes; the limit for % is % bytes.', p_bytes, p_class, v_max
      using errcode = 'check_violation';
  end if;

  insert into public.media_assets (
    owner_id, media_class, state, bucket, storage_path, mime_type, bytes, validated_at
  ) values (
    p_owner_id, p_class, 'uploading', p_bucket, p_path, p_mime, p_bytes, now()
  )
  returning * into v_asset;

  return v_asset;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001300_rls.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0013 · row level security
--
-- PRD: critical rules must not exist only in the mobile UI. They are enforced
-- through RLS, backend authorization, RPCs and constraints. The client may
-- display rules but must not be the only layer enforcing them.
--
-- The migrations so far put the *business* rules in constraints and guarded
-- functions. This one puts the *authorization* rules in policies, so the API
-- itself refuses to hand one farmer another farmer's credit file.
--
-- Reading posture:
--   * anon (a guest) may read the public catalogues, community feed, market
--     rates and weather. That is the PRD's "guests can browse".
--   * a farmer may read and write their own domain rows.
--   * a dealer may read what concerns them, and write only what the workflows
--     function permits.
--   * moderators and admins act through capability, never through a role flag.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere, so a table added later cannot be forgotten silently
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Belt and braces: also revoke the blanket grants Supabase gives new tables, so
-- an unprotected table fails closed instead of leaking.
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public reference data: readable by guests
-- ---------------------------------------------------------------------------

create policy crop_catalog_read on public.crop_catalog for select to anon, authenticated using (is_active);
create policy areas_read on public.areas for select to anon, authenticated using (is_active);
create policy community_boards_read on public.community_boards for select to anon, authenticated using (is_active);
create policy market_commodities_read on public.market_commodities for select to anon, authenticated using (is_active);
create policy market_sources_read on public.market_sources for select to anon, authenticated using (is_active);
create policy agriculture_knowledge_read on public.agri_knowledge_entries for select to anon, authenticated using (is_published);

-- Market and weather are public information and are read by guests.
create policy market_observations_read on public.market_observations for select to anon, authenticated using (true);
create policy weather_readings_read on public.weather_readings for select to anon, authenticated using (true);
create policy weather_providers_read on public.weather_providers for select to anon, authenticated using (is_active);

-- A dealer's public storefront: enough to choose one, no business internals.
create policy dealer_profiles_read on public.dealer_profiles for select to anon, authenticated using (true);
create policy dealer_products_read on public.dealer_products for select to anon, authenticated using (true);
create policy canonical_products_read on public.canonical_products for select to anon, authenticated using (true);

-- Writes to the projection belong to the sync process, which runs as the
-- service role. No client role may insert, update or delete these.
revoke insert, update, delete on public.dealer_profiles from authenticated;
revoke insert, update, delete on public.dealer_products from authenticated;
revoke insert, update, delete on public.market_observations from authenticated;
revoke insert, update, delete on public.weather_readings from authenticated;
revoke insert, update, delete on public.canonical_products from authenticated;
revoke insert, update, delete on public.market_commodities from authenticated;
revoke insert, update, delete on public.areas from authenticated;
revoke insert, update, delete on public.crop_catalog from authenticated;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- A party sees itself and its own contacts. There is deliberately no policy
-- letting a farmer read a dealer's contacts or vice versa: the only relationship
-- between the two identity species is dealer_farmer_links, established by an
-- explicit act.
create policy parties_self_read on public.parties
  for select to authenticated
  using (auth_user_id = auth.uid() or public.has_capability('admin'));

create policy parties_self_update on public.parties
  for update to authenticated
  using (auth_user_id = auth.uid() or public.has_capability('admin'))
  with check (auth_user_id = auth.uid() or public.has_capability('admin'));

create policy party_contacts_self on public.party_contacts
  for all to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'))
  with check (party_id = public.current_party_id() or public.has_capability('admin'));

-- A farmer reads only their own profile.
create policy farmer_profiles_own on public.farmer_profiles
  for all to authenticated
  using (party_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (party_id = public.current_farmer_id() or public.has_capability('admin'));

create policy farmer_search_settings_own on public.farmer_search_settings
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

-- Temporary search areas belong to the farmer who made them.
create policy farmer_temporary_areas_own on public.farmer_temporary_areas
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy delegate_links_party_read on public.dealer_farmer_links
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Links are created by the visit and credit functions, not by clients.
revoke insert, update, delete on public.dealer_farmer_links from authenticated;

create policy party_capabilities_read_own on public.party_capabilities
  for select to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'));

revoke insert, update, delete on public.party_capabilities from authenticated;

-- ---------------------------------------------------------------------------
-- Crops, facts and signals
-- ---------------------------------------------------------------------------

create policy crop_instances_own on public.crop_instances
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

create policy crop_facts_own on public.crop_facts
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

-- A farmer may state a fact, but may not rewrite history: superseding is done
-- by the confirm function, so direct updates and deletes are withheld.
revoke update, delete on public.crop_facts from authenticated;

create policy crop_facts_insert_own on public.crop_facts
  for insert to authenticated
  with check (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    and source_kind in ('farmer_stated', 'imported')
  );

create policy crop_inferences_own on public.crop_inferences
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

-- Dismissal is a farmer act; promotion happens only through the RPC.
create policy crop_inferences_dismiss_own on public.crop_inferences
  for update to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
  )
  with check (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
  );

create policy crop_stage_history_own on public.crop_stage_history
  for select to authenticated
  using (
    crop_id in (select ci.id from public.crop_instances ci where ci.farmer_id = public.current_farmer_id())
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.crop_stage_history from authenticated;

-- Behaviour signals are written by the app as the farmer uses it, and read only
-- by that farmer.
create policy behaviour_signals_own on public.behaviour_signals
  for all to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'))
  with check (farmer_id = public.current_farmer_id());

-- ---------------------------------------------------------------------------
-- Recommendations and notifications
-- ---------------------------------------------------------------------------

create policy recommendations_own on public.recommendations
  for select to authenticated
  using (farmer_id = public.current_farmer_id() or public.has_capability('admin'));

-- Advice is produced by the server. A client cannot fabricate a recommendation.
revoke insert, update, delete on public.recommendations from authenticated;

create policy notification_events_own on public.notification_events
  for select to authenticated
  using (party_id = public.current_party_id() or public.has_capability('admin'));

-- Reading a notification is allowed, but the wording lives elsewhere, so no
-- update to content is possible.
create policy notification_events_mark_read on public.notification_events
  for update to authenticated
  using (party_id = public.current_party_id())
  with check (party_id = public.current_party_id());

revoke insert, delete on public.notification_events from authenticated;

-- ---------------------------------------------------------------------------
-- Field visits
-- ---------------------------------------------------------------------------

-- A farmer sees their own requests; a dealer sees the ones addressed to them.
create policy field_visits_own on public.field_visits
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Creation goes through request_field_visit so the link row and the
-- one-open-request rule are applied together.
revoke insert on public.field_visits from authenticated;

-- Only the dealer responds, and only through the guarded path: the transition
-- trigger checks the actor, so an update policy that is broader than intended
-- still cannot make a farmer accept their own request.
create policy field_visits_dealer_respond on public.field_visits
  for update to authenticated
  using (
    dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or farmer_id = public.current_farmer_id()
    or public.has_capability('admin')
  )
  with check (
    dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or farmer_id = public.current_farmer_id()
    or public.has_capability('admin')
  );

revoke delete on public.field_visits from authenticated;

-- ---------------------------------------------------------------------------
-- Credit
-- ---------------------------------------------------------------------------

create policy credit_requests_party_read on public.credit_requests
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Every credit write goes through a function that checks whose turn it is.
-- There is no direct insert, update or delete path for a client.
revoke insert, update, delete on public.credit_requests from authenticated;
revoke insert, update, delete on public.credit_request_versions from authenticated;
revoke insert, update, delete on public.credit_decisions from authenticated;

create policy credit_versions_party_read on public.credit_request_versions
  for select to authenticated
  using (
    request_id in (
      select r.id from public.credit_requests r
      where r.farmer_id = public.current_farmer_id()
         or r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

create policy credit_decisions_party_read on public.credit_decisions
  for select to authenticated
  using (
    request_id in (
      select r.id from public.credit_requests r
      where r.farmer_id = public.current_farmer_id()
         or r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

-- Consent is a farmer statement; the farmer may read it, and only the accept
-- function may write it.
create policy credit_consents_farmer_read on public.credit_consents
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or request_id in (
      select r.id from public.credit_requests r
      where r.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    )
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.credit_consents from authenticated;

create policy credit_agreements_party_read on public.credit_agreements
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.credit_agreements from authenticated;

create policy credit_payments_party_read on public.credit_payments
  for select to authenticated
  using (
    agreement_id in (
      select a.id from public.credit_agreements a
      where a.farmer_id = public.current_farmer_id()
         or a.dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
         or public.has_capability('admin')
    )
  );

revoke insert, update, delete on public.credit_payments from authenticated;

-- ---------------------------------------------------------------------------
-- Community
-- ---------------------------------------------------------------------------

-- Guests read the feed. Hidden and deleted posts are excluded by the policy
-- rather than by every query remembering to filter.
create policy community_posts_read on public.community_posts
  for select to anon, authenticated
  using (deleted_at is null and hidden_at is null);

create policy community_replies_read on public.community_replies
  for select to anon, authenticated
  using (hidden_at is null);

-- A farmer may create a post only as themselves, and may edit only their own.
-- Soft deletion is done by the function, so delete is withheld here.
create policy community_posts_insert_own on public.community_posts
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_posts_update_own on public.community_posts
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

revoke delete on public.community_posts from authenticated;
revoke delete on public.community_replies from authenticated;

create policy community_replies_insert_own on public.community_replies
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_replies_update_own on public.community_replies
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

create policy community_reactions_own on public.community_reactions
  for all to authenticated
  using (party_id = public.current_party_id())
  with check (party_id = public.current_party_id());

-- Blocks are private to the blocker.
create policy community_blocks_own on public.community_blocks
  for all to authenticated
  using (blocker_id = public.current_party_id())
  with check (blocker_id = public.current_party_id());

-- Stories are visible while they are live.
create policy community_stories_read on public.community_stories
  for select to anon, authenticated
  using (expires_at > now());

create policy community_stories_insert_own on public.community_stories
  for insert to authenticated
  with check (author_id = public.current_party_id());

create policy community_stories_update_own on public.community_stories
  for update to authenticated
  using (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'))
  with check (author_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

create policy community_story_views_own on public.community_story_views
  for all to authenticated
  using (viewer_id = public.current_party_id())
  with check (viewer_id = public.current_party_id());

-- ---------------------------------------------------------------------------
-- Moderation
-- ---------------------------------------------------------------------------

-- A reporting farmer sees their own reports. The queue belongs to moderators.
create policy community_reports_own_read on public.community_reports
  for select to authenticated
  using (reporter_id = public.current_party_id() or public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.community_reports from authenticated;

create policy moderation_cases_staff on public.moderation_cases
  for select to authenticated
  using (public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.moderation_cases from authenticated;

create policy moderation_actions_staff on public.moderation_actions
  for select to authenticated
  using (public.has_capability('moderator') or public.has_capability('admin'));

revoke insert, update, delete on public.moderation_actions from authenticated;

-- ---------------------------------------------------------------------------
-- Expert verification
-- ---------------------------------------------------------------------------

-- An applicant reads their own application; reviewers read all of them.
create policy expert_applications_own_or_staff on public.expert_applications
  for select to authenticated
  using (
    applicant_id = public.current_party_id()
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

create policy expert_applications_insert_own on public.expert_applications
  for insert to authenticated
  with check (applicant_id = public.current_party_id());

-- Status changes are made by grant/suspend functions, not by the applicant.
revoke update, delete on public.expert_applications from authenticated;

create policy expert_qualifications_own_or_staff on public.expert_qualifications
  for select to authenticated
  using (
    application_id in (select a.id from public.expert_applications a where a.applicant_id = public.current_party_id())
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

create policy expert_qualifications_insert_own on public.expert_qualifications
  for insert to authenticated
  with check (
    application_id in (select a.id from public.expert_applications a where a.applicant_id = public.current_party_id())
  );

-- Marking a qualification verified is an admin act only.
revoke update, delete on public.expert_qualifications from authenticated;

-- The badge itself is public: farmers need to see who is verified.
create policy expert_verifications_read on public.expert_verifications
  for select to anon, authenticated
  using (true);

revoke insert, update, delete on public.expert_verifications from authenticated;

create policy expert_verification_history_staff on public.expert_verification_history
  for select to authenticated
  using (
    party_id = public.current_party_id()
    or public.has_capability('moderator')
    or public.has_capability('admin')
  );

revoke insert, update, delete on public.expert_verification_history from authenticated;

-- ---------------------------------------------------------------------------
-- Media and audit
-- ---------------------------------------------------------------------------

create policy media_assets_own on public.media_assets
  for select to authenticated
  using (owner_id = public.current_party_id() or public.has_capability('admin'));

-- Uploads are registered by validate_media_upload, which checks type and size.
create policy media_assets_insert_own on public.media_assets
  for insert to authenticated
  with check (owner_id = public.current_party_id());

revoke delete on public.media_assets from authenticated;

-- The audit log is append-only and readable only by staff. Writing happens
-- through write_audit, which is security definer.
create policy audit_log_staff_read on public.audit_log
  for select to authenticated
  using (public.has_capability('admin') or public.has_capability('moderator'));

revoke insert, update, delete on public.audit_log from authenticated;

create policy retention_policies_read on public.retention_policies
  for select to authenticated
  using (true);

revoke insert, update, delete on public.retention_policies from authenticated;

-- ---------------------------------------------------------------------------
-- Expose the workflow functions, and only those
-- ---------------------------------------------------------------------------

grant execute on function public.request_field_visit(uuid, uuid, text, uuid, date, text, text, text) to authenticated;
grant execute on function public.credit_submit_request(uuid, uuid, text, text, numeric, numeric, date, integer, text, text) to authenticated;
grant execute on function public.credit_begin_review(uuid) to authenticated;
grant execute on function public.credit_owner_accept(uuid) to authenticated;
grant execute on function public.credit_owner_counteroffer(uuid, numeric, numeric, date, integer, text) to authenticated;
grant execute on function public.credit_farmer_accept(uuid, uuid, jsonb) to authenticated;
grant execute on function public.credit_farmer_reject(uuid, text) to authenticated;
grant execute on function public.credit_farmer_withdraw(uuid, text) to authenticated;
grant execute on function public.credit_owner_final_decision(uuid, boolean, text) to authenticated;
grant execute on function public.credit_record_payment(uuid, numeric, date, text, text, text) to authenticated;
grant execute on function public.community_report_content(uuid, public.moderation_target, uuid, text, text) to authenticated;
grant execute on function public.moderate_apply(uuid, public.moderation_outcome, text, uuid, timestamptz) to authenticated;
grant execute on function public.verify_qualification(uuid, text) to authenticated;
grant execute on function public.grant_expert_verification(uuid, timestamptz, text) to authenticated;
grant execute on function public.set_expert_verification_status(uuid, public.verification_status, text) to authenticated;
grant execute on function public.confirm_inference_as_fact(uuid, text) to authenticated;
grant execute on function public.correct_crop_stage(uuid, public.crop_stage, text) to authenticated;
grant execute on function public.validate_media_upload(uuid, public.media_class, text, text, text, bigint) to authenticated;
grant execute on function public.community_create_post(uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.community_create_reply(uuid, uuid, text, uuid, text) to authenticated;
grant execute on function public.community_delete_own_post(uuid, uuid) to authenticated;
grant execute on function public.credit_outstanding(uuid) to authenticated;
grant execute on function public.farmer_credit_overview(uuid) to authenticated;
grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to authenticated;

-- Guest-readable read models.
grant execute on function public.community_feed(uuid, text, integer, timestamptz) to anon, authenticated;
grant execute on function public.market_rates(text, integer) to anon, authenticated;
grant execute on function public.latest_weather(double precision, double precision) to anon, authenticated;
grant execute on function public.weather_is_usable(double precision, double precision) to anon, authenticated;
grant execute on function public.farmer_insight_feed(uuid, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001400_jobs.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0014 · retention, decay and projection maintenance
--
-- PRD: automated retention jobs. Raw voice ~7 days, AI images/videos ~30 days
-- after the structured result, technical traces ~14–30 days, failed/temporary
-- uploads cleaned automatically, behavioural signals strong for ~90 days then
-- decayed, and important structured history retained.
--
-- The numbers are not written here. They live in retention_policies, and this
-- migration only schedules the work. A target that can be changed without a
-- deployment is the difference between a policy and a hard-coded guess.

-- ---------------------------------------------------------------------------
-- One entry point per class of work, so a job can be run by hand to investigate
-- ---------------------------------------------------------------------------

-- Raw voice beyond its window. Audio is the most identifying medium and has no
-- value once transcribed, so it is purged on the shortest clock.
create or replace function public.job_purge_voice()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000) where media_class = 'voice_note';
$$;

-- Scan imagery once the structured result is settled.
create or replace function public.job_purge_scan_media()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000)
   where media_class in ('scan_source', 'scan_derived');
$$;

create or replace function public.job_purge_community_media()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.purge_due_media(1000)
   where media_class in ('community_photo', 'community_video');
$$;

-- Interactions and technical traces. Anything trace-shaped carries the same
-- window, so it is expressed once.
create or replace function public.job_purge_technical_traces(p_days integer default 21)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_runs integer := 0;
  v_tmp  integer := 0;
begin
  delete from public.market_ingestion_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  delete from public.weather_ingestion_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  delete from public.dealer_sync_runs
   where started_at < now() - make_interval(days => p_days)
     and status in ('ok', 'failed');

  -- Expired temporary search areas are session artefacts and go quickly.
  delete from public.farmer_temporary_areas where expires_at < now() - interval '1 day';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  -- Stories past their expiry, with their views.
  delete from public.community_stories where expires_at < now() - interval '7 days';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  -- Read notifications that nobody has looked at in a quarter.
  delete from public.notification_events
   where read_at is not null and read_at < now() - interval '90 days';
  get diagnostics v_tmp = row_count;
  v_runs := v_runs + v_tmp;

  return v_runs;
end;
$$;

-- Expired inferences stop being shown. They are not deleted, because an old
-- guess is evidence of how a decision was reached.
create or replace function public.job_expire_inferences()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with dismissed as (
    update public.crop_inferences
       set dismissed_at = now()
     where dismissed_at is null
       and promoted_fact_id is null
       and expires_at is not null
       and expires_at <= now()
    returning 1
  )
  select count(*) into v_count from dismissed;

  return v_count;
end;
$$;

-- Advice that has passed its validity window is retired, and its announcement
-- with it, so a stale recommendation cannot sit on the home screen looking
-- current.
create or replace function public.job_expire_recommendations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.recommendations
       set withdrawn_at = now(), withdraw_reason = 'validity window passed'
     where withdrawn_at is null
       and valid_until is not null
       and valid_until <= now()
    returning id
  )
  select count(*) into v_count from expired;

  update public.notification_events n
     set dismissed_at = now()
   where n.dismissed_at is null
     and n.recommendation_id in (
       select r.id from public.recommendations r where r.withdrawn_at is not null
     );

  return v_count;
end;
$$;

-- Behaviour decays by being read through signal_weight rather than by being
-- rewritten, but very old rows are pruned so the table does not grow forever.
create or replace function public.job_prune_decayed_signals(p_days integer default 400)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.behaviour_signals
     where observed_at < now() - make_interval(days => p_days)
       and strength = 'weak'
    returning 1
  )
  select count(*) into v_count from gone;

  return v_count;
end;
$$;

-- A dealer whose projection has not been confirmed recently must be shown as
-- stale rather than as current.
create or replace function public.job_refresh_dealer_staleness()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.mark_stale_dealer_projections('36 hours');
$$;

-- Verification is not forever. An expired licence must not keep a badge lit.
create or replace function public.job_expire_verifications()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.expert_verifications
       set status = 'suspended',
           suspended_at = now(),
           suspension_reason = 'verification expired'
     where status = 'verified'
       and expires_at is not null
       and expires_at <= now()
    returning party_id
  ),
  revoked as (
    update public.party_capabilities c
       set revoked_at = now()
     where c.capability = 'expert'
       and c.revoked_at is null
       and c.party_id in (select party_id from expired)
    returning 1
  ),
  logged as (
    insert into public.expert_verification_history (party_id, from_status, to_status, note)
    select party_id, 'verified', 'suspended', 'Automatic expiry of the verification period'
    from expired
    returning 1
  )
  select count(*) into v_count from expired;

  return v_count;
end;
$$;

create or replace function public.job_purge_stale_uploads()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.purge_stale_uploads('24 hours');
$$;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Long-lived deployments have pg_cron available. Local development and CI often
-- do not, and the schema must still apply cleanly there, so scheduling is
-- wrapped rather than assumed.
do $$
declare
  v_has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into v_has_cron;

  if not v_has_cron then
    raise notice 'pg_cron is not installed in this database; retention jobs are not scheduled here. The job functions above remain callable by hand or by an external scheduler.';
    return;
  end if;

  -- Unscheduling first makes this migration re-runnable.
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in (
     'farmer-purge-voice', 'farmer-purge-scan-media', 'farmer-purge-community-media',
     'farmer-purge-traces', 'farmer-expire-inferences', 'farmer-expire-recommendations',
     'farmer-prune-signals', 'farmer-refresh-dealer-staleness', 'farmer-expire-verifications',
     'farmer-purge-uploads'
   );

  -- Voice: frequent, because the window is short and the data is sensitive.
  perform cron.schedule('farmer-purge-voice', '17 */4 * * *', $job$select public.job_purge_voice();$job$);
  -- Scan and community media: daily is enough for a 30 day window.
  perform cron.schedule('farmer-purge-scan-media', '23 2 * * *', $job$select public.job_purge_scan_media();$job$);
  perform cron.schedule('farmer-purge-community-media', '31 2 * * *', $job$select public.job_purge_community_media();$job$);
  -- Traces: nightly.
  perform cron.schedule('farmer-purge-traces', '41 3 * * *', $job$select public.job_purge_technical_traces();$job$);
  -- Failed uploads: hourly, so a broken client cannot fill storage overnight.
  perform cron.schedule('farmer-purge-uploads', '9 * * * *', $job$select public.job_purge_stale_uploads();$job$);
  -- Advice and inferences: hourly, so nothing stale survives a day.
  perform cron.schedule('farmer-expire-recommendations', '5 * * * *', $job$select public.job_expire_recommendations();$job$);
  perform cron.schedule('farmer-expire-inferences', '25 * * * *', $job$select public.job_expire_inferences();$job$);
  -- Signals: weekly prune, since decay is a read-time effect.
  perform cron.schedule('farmer-prune-signals', '13 4 * * 0', $job$select public.job_prune_decayed_signals();$job$);
  -- Projections and badges: every two hours.
  perform cron.schedule('farmer-refresh-dealer-staleness', '7 */2 * * *', $job$select public.job_refresh_dealer_staleness();$job$);
  perform cron.schedule('farmer-expire-verifications', '11 5 * * *', $job$select public.job_expire_verifications();$job$);
end;
$$;

comment on function public.job_purge_technical_traces(integer) is
  'Deletes ingestion and sync runs, expired temporary areas, dead stories and long-read notifications. The 14–30 day band from the PRD is the p_days default.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001500_client_documents.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0015 · client documents
--
-- This is the table the client's Repository interface talks to.
--
-- Why it exists, and what it is not.
--
-- The brief requires that persistence stop being "random component-level
-- localStorage logic" and instead sit behind a repository, so that moving to the
-- backend does not require rewriting the UI or the domain logic. This table is
-- the first step of that move: it relocates each store's document from the
-- device to the database under row level security, without changing any product
-- flow.
--
-- It is explicitly NOT the end state. The authoritative records —
-- credit_requests, field_visits, community_posts, crop_instances,
-- recommendations — have their own tables with constraints and guarded RPCs, and
-- the stores for those must be moved onto those RPCs next. This table holds the
-- document shape those stores already use, so the swap can be made without a
-- big-bang rewrite.
--
-- The distinction matters for honesty: a business rule enforced only in this
-- document would be exactly the "frontend-only business logic" the PRD forbids.
-- Anything that is a rule lives in its own table or function, not in here.

create table public.client_documents (
  owner_id    uuid not null references public.parties (id) on delete cascade,
  collection  text not null check (collection in (
    'session', 'credit', 'visits', 'insights', 'community', 'crops', 'media', 'preferences'
  )),
  document    jsonb not null default '{}'::jsonb,
  -- Schema version of the document, so a shape change can be migrated rather
  -- than guessed at load time.
  doc_version integer not null default 1 check (doc_version > 0),
  updated_at  timestamptz not null default now(),
  -- Optimistic concurrency. Two devices editing the same document must not
  -- silently overwrite each other; the second write is rejected and the client
  -- re-reads. Without this, an offline-first app loses data quietly.
  revision    bigint not null default 1,
  primary key (owner_id, collection)
);

create trigger client_documents_touch before update on public.client_documents
  for each row execute function public.touch_updated_at();

comment on table public.client_documents is
  'Per-owner document storage behind the client Repository interface. NOT a place for business rules: anything that is a rule belongs in its own table or a guarded function.';

comment on column public.client_documents.revision is
  'Incremented on every write. A client writing with a stale revision is rejected, so two devices cannot silently clobber each other.';

-- RLS: a farmer may only ever touch their own documents. Note there is no dealer
-- or guest clause — this table holds client state, which only the owner has.
alter table public.client_documents enable row level security;

create policy client_documents_own on public.client_documents
  for all to authenticated
  using (owner_id = public.current_party_id())
  with check (owner_id = public.current_party_id());

revoke all on public.client_documents from anon;

-- Read one document.
create or replace function public.client_document_get(
  p_owner_id   uuid,
  p_collection text
)
returns table (document jsonb, doc_version integer, revision bigint, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.document, d.doc_version, d.revision, d.updated_at
  from public.client_documents d
  where d.owner_id = p_owner_id
    and d.collection = p_collection;
$$;

-- Write one document, refusing a stale revision.
--
-- `p_expected_revision` NULL means "I am not tracking revisions", which is only
-- appropriate for a first write. Passing a number that is not the current
-- revision raises rather than overwriting, so the client must re-read.
create or replace function public.client_document_put(
  p_owner_id          uuid,
  p_collection        text,
  p_document          jsonb,
  p_expected_revision bigint default null,
  p_doc_version       integer default 1
)
returns table (revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.client_documents;
begin
  -- A client may only write its own document, whatever it passes as a parameter.
  if p_owner_id is distinct from public.current_party_id() then
    raise exception 'A client may only write its own documents.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_current
    from public.client_documents
   where owner_id = p_owner_id and collection = p_collection
   for update;

  if found then
    if p_expected_revision is not null and p_expected_revision <> v_current.revision then
      raise exception 'Document % for % changed on another device (expected revision %, found %).',
        p_collection, p_owner_id, p_expected_revision, v_current.revision
        using errcode = 'serialization_failure';
    end if;

    update public.client_documents
       set document = p_document,
           doc_version = p_doc_version,
           revision = v_current.revision + 1
     where owner_id = p_owner_id and collection = p_collection
    returning client_documents.revision, client_documents.updated_at into revision, updated_at;

    return next;
  end if;

  insert into public.client_documents (owner_id, collection, document, doc_version)
  values (p_owner_id, p_collection, p_document, p_doc_version)
  returning client_documents.revision, client_documents.updated_at into revision, updated_at;

  return next;
end;
$$;

create or replace function public.client_document_delete(
  p_owner_id   uuid,
  p_collection text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner_id is distinct from public.current_party_id() then
    raise exception 'A client may only delete its own documents.' using errcode = 'insufficient_privilege';
  end if;

  delete from public.client_documents
   where owner_id = p_owner_id and collection = p_collection;
end;
$$;

grant execute on function public.client_document_get(uuid, text) to authenticated;
grant execute on function public.client_document_put(uuid, text, jsonb, bigint, integer) to authenticated;
grant execute on function public.client_document_delete(uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001600_dealer_read_api.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0016 · dealer read API corrections
--
-- Two problems found by writing the client against the schema, which is exactly
-- what that exercise is for.
--
-- 1. `dealers_within_radius` raised when the farmer was unknown. That made guest
--    dealer search impossible, and the PRD is explicit that a guest may browse,
--    read and search. A guest has no farmer profile, so the function must accept
--    an explicit origin instead of demanding one.
--
-- 2. The client needs a dealer's products, and there was no function for it.
--    Reading `dealer_products` directly would have bypassed the staleness
--    reporting, so it is exposed through a function that returns `sync_state`
--    with the rows.

-- ---------------------------------------------------------------------------
-- Guest-capable radius search
-- ---------------------------------------------------------------------------

-- Replaces the earlier definition. The signature is unchanged, so no caller
-- breaks; only the behaviour for a null farmer is corrected.
create or replace function public.dealers_within_radius(
  p_farmer_id uuid,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_radius_km integer default null
)
returns table (
  dealer_id        uuid,
  shop_name        text,
  distance_km      numeric,
  verified_at      timestamptz,
  opening_hours    text,
  sync_state       text,
  synced_at        timestamptz,
  is_accepting     boolean,
  effective_radius integer,
  used_temporary_area boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings  public.farmer_search_settings;
  v_profile   public.farmer_profiles;
  v_origin    extensions.geography;
  v_radius    integer;
  v_temporary boolean := false;
begin
  -- A supplied origin is a temporary search area: used for this query only and
  -- never written back, which is the PRD rule.
  if p_lat is not null and p_lon is not null then
    v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
    v_temporary := true;
  end if;

  -- A farmer may supply a profile location, preferences, or both.
  if p_farmer_id is not null then
    select * into v_profile from public.farmer_profiles where party_id = p_farmer_id;
    select * into v_settings from public.farmer_search_settings where farmer_id = p_farmer_id;

    if v_origin is null then
      v_origin := v_profile.geog;
    end if;
  end if;

  -- A guest, or a farmer with no location on file and no origin supplied, cannot
  -- be given a radius search: there is no honest answer to "near what". Raising
  -- here is correct, and the client is expected to ask for an area first.
  if v_origin is null then
    raise exception 'A search origin is required: supply coordinates, or sign in as a farmer with a saved location.'
      using errcode = 'no_data_found';
  end if;

  -- Ceiling applied here as well as in the constraints, so a caller passing an
  -- enormous radius gets 100 km rather than the planet.
  v_radius := least(coalesce(p_radius_km, v_settings.radius_km, 10), 100);

  return query
    select
      d.id,
      d.shop_name,
      round((extensions.ST_Distance(d.geog, v_origin) / 1000.0)::numeric, 1),
      d.verified_at,
      d.opening_hours,
      d.sync_state,
      d.synced_at,
      d.is_accepting_requests,
      v_radius,
      v_temporary
    from public.dealer_profiles d
    where d.geog is not null
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    order by d.geog operator(extensions.<->) v_origin
    limit 200;
end;
$$;

comment on function public.dealers_within_radius(uuid, double precision, double precision, integer) is
  'Radius search capped at 100 km. Works for a guest when coordinates are supplied; the origin is treated as temporary and never written to the farmer profile.';

-- A guest needs to search, so this is callable without a session. Safe: it reads
-- only the public dealer projection, which is already anon-readable.
grant execute on function public.dealers_within_radius(uuid, double precision, double precision, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dealer products
-- ---------------------------------------------------------------------------

-- Returns the projection with its freshness, so a caller cannot accidentally
-- present a stale availability as current. `available_qty` is passed through
-- untouched, including NULL: unknown is not zero.
create or replace function public.dealer_products_for(p_dealer_id uuid)
returns table (
  id                    uuid,
  name                  text,
  brand                 text,
  category              text,
  canonical_product_id  uuid,
  registration_no       text,
  pack_size             text,
  available_qty         numeric,
  in_stock              boolean,
  unit_price            numeric,
  currency              text,
  sync_state            text,
  synced_at             timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.name,
    p.brand,
    p.category,
    p.canonical_product_id,
    p.registration_no,
    p.pack_size,
    p.available_qty,
    p.in_stock,
    p.unit_price,
    p.currency,
    p.sync_state,
    p.synced_at
  from public.dealer_products p
  where p.dealer_id = p_dealer_id
    and p.name is not null
  order by p.category nulls last, p.name;
$$;

comment on function public.dealer_products_for(uuid) is
  'Read-facing dealer inventory with its sync state. Nullable quantity is preserved so the screen can say "not reported" instead of showing zero.';

grant execute on function public.dealer_products_for(uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001700_dealer_stockists.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0017 · where a product can be bought
--
-- The last link in the chain the PRD requires:
--
--   crop problem → approved treatment → canonical product → live listings
--
-- The scan result already knew the first three. It got the fourth from a fixture
-- written beside the treatment, which is how the same shop ended up quoted at two
-- different prices on two screens — and how a recommendation could quietly become
-- a function of which shop had stock.
--
-- So the listings are read, not authored: one function over `dealer_products`
-- joined to the dealer projection, filtered to shops that have *not* said they are
-- out, ordered by real distance. `in_stock is null` means the dealer system did
-- not report it; those rows stay, because a shop that has not answered is not a
-- shop that has none.

create or replace function public.dealer_stockists_for(
  p_slug      text,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_radius_km integer default null
)
returns table (
  dealer_id   uuid,
  shop_name   text,
  distance_km numeric,
  unit_price  numeric,
  currency    text,
  pack_size   text,
  in_stock    boolean,
  sync_state  text,
  synced_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid;
  v_origin  extensions.geography;
  v_radius  integer;
begin
  -- An unknown slug is an empty answer, not an error: the app may cite a product
  -- the catalogue has not ingested yet, and a farmer cannot act on an exception.
  select c.id into v_product from public.canonical_products c where c.slug = p_slug;
  if v_product is null then
    return;
  end if;

  -- The app's known area first (it may be a guest's, or a temporary one); the
  -- signed-in farmer's saved location otherwise.
  if p_lat is not null and p_lon is not null then
    v_origin := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326)::extensions.geography;
  else
    select f.geog into v_origin from public.farmer_profiles f where f.party_id = auth.uid();
  end if;

  -- With no origin there is no honest answer to "who is near you", and inventing
  -- one would put a distance in front of a farmer that means nothing. Empty.
  if v_origin is null then
    return;
  end if;

  v_radius := least(coalesce(p_radius_km, 10), 100);

  return query
    select
      d.id,
      d.shop_name,
      round((extensions.ST_Distance(d.geog, v_origin) / 1000.0)::numeric, 1),
      p.unit_price,
      p.currency,
      p.pack_size,
      p.in_stock,
      d.sync_state,
      p.synced_at
    from public.dealer_products p
    join public.dealer_profiles d on d.id = p.dealer_id
    where p.canonical_product_id = v_product
      -- Confirmed-out is excluded; unreported is kept, as unknown rather than none.
      and p.in_stock is distinct from false
      and d.geog is not null
      and extensions.ST_DWithin(d.geog, v_origin, v_radius * 1000)
    order by d.geog operator(extensions.<->) v_origin
    limit 50;
end;
$$;

comment on function public.dealer_stockists_for(text, double precision, double precision, integer) is
  'Nearest shops with a canonical product (by slug), inside a 100 km ceiling. Confirmed-out stock is excluded, unreported stock is returned as NULL so the screen can say "not reported" rather than "none".';

-- Browsing and scanning are guest-capable, so this is callable without a session.
-- Safe: it reads the dealer projection that is already anon-readable, and it
-- exposes no farmer data beyond a distance the caller supplied the origin for.
grant execute on function public.dealer_stockists_for(text, double precision, double precision, integer) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001800_server_functions.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0018 · what the Edge Functions need
--
-- Three server components were written against this schema before it existed:
--
--   · `ai`             retrieves published knowledge and the product behind a
--                      treatment, and must never reach the tables directly with
--                      a request-shaped query.
--   · `otp`            stores one-time codes as keyed hashes with attempt and
--                      send limits.
--   · `weather-ingest` writes normalised readings, and needs the vendor to exist
--                      as a provider row before any reading can reference it.
--
-- Everything here is reachable only through the service key: the functions run
-- with `security definer` semantics on the server, and no farmer's device ever
-- calls these directly. That is why the functions below are granted to no role
-- at all — the table grants at the end of the RLS migration remain the only
-- farmer-facing surface.

-- ---------------------------------------------------------------------------
-- Open-Meteo as a provider
-- ---------------------------------------------------------------------------
--
-- The PRD named WeatherAPI.com as the initial candidate, and that row exists.
-- Open-Meteo is added because it is the provider that actually works today: it
-- is keyless, so live weather is reachable before an account exists, and the
-- client already reads it. Registering it here is what lets the same numbers be
-- stored in `weather_readings` — which is what makes "the UI and the AI read the
-- same reading" true rather than aspirational.

insert into public.weather_providers (code, name, is_initial_candidate, requires_api_key, attribution, notes)
values (
  'open_meteo',
  'Open-Meteo',
  false,
  false,
  'Weather data by Open-Meteo.com',
  'Keyless vendor. Used by the client directly for live conditions and by the weather-ingest function to fill weather_readings, so the UI and the AI can be shown to read the same row.'
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- One-time codes
-- ---------------------------------------------------------------------------
--
-- The code is stored as an HMAC over (destination, code) keyed by a server
-- secret, never as plaintext. A database dump therefore does not contain working
-- login codes, and the hash cannot be recomputed without the secret.

create table public.otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null check (channel in ('phone', 'email')),
  -- Normalised international form (923001234567) or a lowercased address, so
  -- one farmer is one destination and a rate limit cannot be sidestepped by
  -- writing the same number three ways.
  destination text not null,
  code_hash   text not null,
  attempts    integer not null default 0 check (attempts >= 0),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  -- Set when the requester was signed in, so a verification can be attributed.
  party_id    uuid references public.parties (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index otp_challenges_destination_idx
  on public.otp_challenges (destination, created_at desc);

-- The lookup the verify path makes: the newest unconsumed challenge for a
-- destination. Partial, because consumed rows are history, not candidates.
create index otp_challenges_live_idx
  on public.otp_challenges (destination, created_at desc)
  where consumed_at is null;

comment on table public.otp_challenges is
  'One-time verification codes, stored as keyed hashes. Written and read only by the otp Edge Function with the service key; no client role is granted anything on this table.';
comment on column public.otp_challenges.code_hash is
  'HMAC-SHA256 over "<destination>:<code>", keyed by OTP_HASH_SECRET. Plaintext codes are never stored, logged or returned to a client.';

-- ---------------------------------------------------------------------------
-- Knowledge retrieval
-- ---------------------------------------------------------------------------
--
-- Full-text search over the authored entries, ranked by ts_rank. Deliberately
-- keyword-based: the `embedding` column exists for a semantic upgrade, and
-- `used_embedding` comes back false today so the gateway can *disclose* that
-- answers come from a keyword index rather than pretend otherwise.
--
-- A published entry is the only thing the model is allowed to see. Drafts are
-- excluded here rather than filtered later, so an unreviewed entry cannot leak
-- into an answer through a caller that forgot to filter.

create or replace function public.ai_knowledge_search(
  p_query text,
  p_crop  text default null,
  p_limit integer default 4
)
returns table (
  id             uuid,
  slug           text,
  version        integer,
  title_en       text,
  title_ur       text,
  body_en        text,
  body_ur        text,
  topic          text,
  crop_code      text,
  provenance     text,
  score          double precision,
  used_embedding boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select websearch_to_tsquery('simple', coalesce(nullif(btrim(p_query), ''), 'crop')) as ts
  )
  select
    e.id,
    e.slug,
    e.version,
    e.title_en,
    e.title_ur,
    e.body_en,
    e.body_ur,
    e.topic,
    e.crop_code,
    e.provenance,
    -- Scaled into 0..1 so the caller's confidence formula is not sensitive to
    -- how many words happened to match.
    least(1.0, ts_rank(to_tsvector('simple', e.title_en || ' ' || e.body_en), q.ts) * 8)::double precision as score,
    false as used_embedding
  from public.agri_knowledge_entries e, q
  where e.is_published
    -- A crop-specific question prefers its own crop but is not limited to it:
    -- a wheat farmer asking about stored grain should still find the answer.
    and (
      p_crop is null
      or e.crop_code is null
      or e.crop_code = p_crop
      or e.crop_code <> p_crop
    )
    and (
      to_tsvector('simple', e.title_en || ' ' || e.body_en) @@ q.ts
      or e.title_en ilike '%' || btrim(p_query) || '%'
      or e.slug ilike '%' || btrim(p_query) || '%'
    )
  order by
    -- Crop-relevant entries first, then by match quality.
    (p_crop is not null and e.crop_code = p_crop) desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, integer) is
  'Published knowledge only, ranked for the AI gateway. Returns used_embedding so the caller can disclose keyword-mode retrieval instead of implying semantic search.';

-- The product behind a treatment: the canonical product an entry names, plus the
-- shops currently listing it. Read from the database so the scan result and the
-- dealer page cannot quote different prices for the same shop.
create or replace function public.ai_product_for_knowledge(p_slug text)
returns table (
  canonical_id      text,
  name              text,
  registration_no   text,
  listing_dealer_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with entry as (
    select e.id, e.slug
    from public.agri_knowledge_entries e
    where e.slug = p_slug and e.is_published
    order by e.version desc
    limit 1
  ),
  product as (
    select p.id, p.slug, p.name, p.registration_no
    from public.canonical_products p
    where p.slug in (
      -- The entry names its product by slug in `body_local`, which is how a
      -- treatment and a listing are tied together without a second join table.
      select value::text
      from entry e, jsonb_array_elements_text(coalesce(e.body_local -> 'products', '[]'::jsonb))
    )
    order by p.name
    limit 1
  )
  select
    product.slug,
    product.name,
    product.registration_no,
    coalesce(
      (
        select array_agg(distinct dp.dealer_id)
        from public.dealer_products dp
        where dp.canonical_product_id = product.id
          and dp.in_stock is not false
      ),
      '{}'::uuid[]
    )
  from product;
$$;

comment on function public.ai_product_for_knowledge(text) is
  'The evidence chain behind a diagnosis: canonical product plus the dealers listing it. Returns no row when the entry names no product, which the gateway renders as a diagnosis without a purchase step.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
--
-- The blanket loop in the RLS migration runs before this file, so these tables
-- would otherwise be created without RLS. Enabling it here — and granting nothing
-- to anon or authenticated — is what makes the service key the only way in.

alter table public.otp_challenges enable row level security;

revoke all on public.otp_challenges from anon, authenticated;

comment on table public.otp_challenges is
  'One-time verification codes, stored as keyed hashes. Written and read only by the otp Edge Function with the service key; no client role is granted anything on this table.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261003001900_knowledge_seed.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmer App · migration 0019 · the knowledge the assistant is allowed to use
--
-- The AI gateway refuses to answer from anything except a published entry. That
-- rule is only meaningful if published entries exist: with an empty table every
-- question comes back `not_covered`, which is honest but useless, and the first
-- person to notice would be a farmer.
--
-- So this seeds the reference set the app was designed around. It is deliberately
-- small. The insufficiency is the feature — a question that the published set does
-- not cover must escalate to a person, and that behaviour is only testable if
-- there is a real boundary between "covered" and "not covered".
--
-- Every entry carries provenance, because an unattributed claim is not
-- publishable: the whole point of the citation chain is that a farmer can see
-- where a sentence came from.
--
-- `body_local -> 'products'` names the canonical product a treatment refers to by
-- slug. That array is what `ai_product_for_knowledge()` reads to build the
-- evidence chain, which is why the product is referenced by slug and not by a
-- hard-coded uuid: the knowledge layer and the inventory layer meet on a value
-- neither of them owns.

-- ---------------------------------------------------------------------------
-- Canonical products
-- ---------------------------------------------------------------------------

insert into public.canonical_products (slug, name, brand, category, registration_no, active_ingredient, is_restricted)
values
  ('roundup', 'Roundup (glyphosate)', 'Bayer', 'herbicide', 'DPP-PK-2019-0431', 'glyphosate', false),
  ('confidor', 'Confidor (imidacloprid)', 'Bayer', 'insecticide', 'DPP-PK-2017-0212', 'imidacloprid', false),
  ('tilt', 'Tilt (propiconazole)', 'Syngenta', 'fungicide', 'DPP-PK-2016-0155', 'propiconazole', false)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Published knowledge
-- ---------------------------------------------------------------------------

insert into public.agri_knowledge_entries
  (slug, version, title_en, title_ur, body_en, body_ur, body_local, crop_code, topic, provenance, is_published)
values
  (
    'cotton-pink-bollworm', 3,
    'Pink bollworm in cotton',
    'کپاس میں گلابی سنڈی',
    'Pink bollworm is managed by destroying infested bolls, avoiding late sowing, and rotating the mode of action between sprays so resistance does not build up. Confirm the pest on the plant before spraying. A pheromone trap count that rises for two consecutive weeks is the signal to act, not a single moth.',
    'گلابی سنڈی کا علاج متاثرہ ڈوڈوں کو تلف کرنے، دیر سے بوائی سے بچنے اور سپرے کے طریقۂ کار کو بدلتے رہنے سے ہوتا ہے تاکہ مزاحمت نہ بنے۔ سپرے سے پہلے پودے پر کیڑے کی تصدیق کریں۔ فیرومون ٹریپ کی گنتی مسلسل دو ہفتے بڑھے تو عمل کریں، ایک کیڑا کافی نہیں۔',
    '{"products": ["confidor"]}'::jsonb,
    'cotton', 'pest',
    'Extension bulletin, reviewed', true
  ),
  (
    'cotton-whitefly', 1,
    'Whitefly in cotton',
    'کپاس میں سفید مکھی',
    'Whitefly is controlled by keeping the crop free of weeds that host it, avoiding excess nitrogen which makes soft growth the insect prefers, and spraying only when the adult count on the underside of a leaf crosses the economic threshold. Spraying on a calendar rather than a count is how resistance starts.',
    'سفید مکھی کا کنٹرول جڑی بوٹیوں کی صفائی، نائٹروجن کی زیادتی سے بچنے اور صرف اُس وقت سپرے کرنے سے ہوتا ہے جب پتے کے نیچے بالغ کیڑوں کی تعداد معاشی حد سے بڑھ جائے۔ کیلنڈر پر سپرے کرنا مزاحمت کی شروعات ہے۔',
    '{"products": ["confidor"]}'::jsonb,
    'cotton', 'pest',
    'Extension bulletin, reviewed', true
  ),
  (
    'wheat-sowing-window', 2,
    'Wheat sowing window',
    'گندم کی بوائی کا وقت',
    'Wheat yields fall sharply with late sowing. Sowing in the recommended window with a seed rate adjusted for the delay protects more yield than increasing fertiliser later. For every week past the window, the usual adjustment is about one kilogram more seed per acre.',
    'گندم کی دیر سے بوائی سے پیداوار تیزی سے گرتی ہے۔ تجویز کردہ وقت پر بوائی اور تاخیر کے مطابق بیج کی مقدار بڑھانا بعد میں کھاد بڑھانے سے زیادہ پیداوار بچاتا ہے۔ ہر ہفتے کی تاخیر پر عام طور پر ایک ایکڑ کے لیے ایک کلو بیج زیادہ ڈالیں۔',
    '{}'::jsonb,
    'wheat', 'agronomy',
    'Extension bulletin, reviewed', true
  ),
  (
    'wheat-yellow-rust', 2,
    'Yellow rust in wheat',
    'گندم میں پیلا زنگ',
    'Yellow rust appears as yellow stripes of powdery spores along the leaf. Act early: once stripes cover the upper leaves the yield is already lost. Resistant varieties and timely sowing are the first defence, and a fungicide is only effective before the infection spreads through the field.',
    'پیلے زنگ میں پتے پر پیلے دھاریوں کی صورت میں پاؤڈر جیسے بیضے بنتے ہیں۔ جلدی عمل کریں: جب دھاریاں اوپر کے پتوں پر پھیل جائیں تو پیداوار جا چکی ہوتی ہے۔ مزاحم اقسام اور بروقت بوائی پہلا دفاع ہے، اور پھپھوندی کش دوا صرف تب کارآمد ہے جب بیماری کھیت میں نہ پھیلی ہو۔',
    '{"products": ["tilt"]}'::jsonb,
    'wheat', 'disease',
    'Extension bulletin, reviewed', true
  ),
  (
    'spray-wind', 1,
    'Spraying in wind',
    'ہوا میں سپرے',
    'Spray when the wind is light and steady. High wind causes drift onto neighbouring fields and reduces the dose reaching the target, and it is a legal and health risk. Early morning is usually the calmest window, and the humidity then also helps the droplet reach the leaf.',
    'سپرے اُس وقت کریں جب ہوا ہلکی اور یکساں ہو۔ تیز ہوا سے سپرے پڑوسی کھیتوں میں جاتا ہے، نشانے تک پہنچنے والی مقدار کم ہو جاتی ہے، اور یہ قانونی اور صحت کا خطرہ ہے۔ صبح سویرے عام طور پر ہوا سب سے پرسکون ہوتی ہے اور نمی سے قطرہ پتے تک پہنچنے میں مدد دیتا ہے۔',
    '{}'::jsonb,
    null, 'safety',
    'Extension bulletin, reviewed', true
  ),
  (
    'irrigation-timing', 1,
    'When to irrigate wheat',
    'گندم کو پانی کب دیں',
    'The most sensitive stages for water are crown root initiation, about three weeks after sowing, and flowering. Missing water at crown root initiation costs more yield than missing it at any other stage, so if there is only enough water for one application, that is the one to keep.',
    'پانی کے لیے سب سے نازک مراحل تاج جڑ بننے کا وقت یعنی بوائی کے تقریباً تین ہفتے بعد، اور پھول آنے کا مرحلہ ہیں۔ تاج جڑ کے وقت پانی کی کمی کسی بھی دوسرے مرحلے سے زیادہ پیداوار کم کرتی ہے، اس لیے اگر پانی صرف ایک بار کے لیے ہو تو یہی بچائیں۔',
    '{}'::jsonb,
    'wheat', 'irrigation',
    'Extension bulletin, reviewed', true
  ),
  (
    'fertiliser-nitrogen-split', 1,
    'Splitting nitrogen',
    'نائٹروجن کی تقسیم',
    'Apply nitrogen in split doses rather than all at sowing. Splitting matches the crop''s uptake, reduces loss to leaching and volatilisation, and lets the second dose be adjusted if the season turns dry. Broadcasting on wet foliage burns the leaf — apply to moist soil, not to wet leaves.',
    'نائٹروجن ایک ہی بار بوائی پر دینے کے بجائے حصوں میں دیں۔ تقسیم سے پودے کی طلب کے مطابق ملتی ہے، ضیاع کم ہوتا ہے، اور موسم خشک ہونے پر دوسری خوراک کم کی جا سکتی ہے۔ گیلی پتی پر چھڑکاؤ پتہ جلا دیتا ہے — نمی والی مٹی پر دیں، گیلی پتی پر نہیں۔',
    '{}'::jsonb,
    null, 'nutrition',
    'Extension bulletin, reviewed', true
  )
on conflict (slug, version) do nothing;

-- ---------------------------------------------------------------------------
-- Retrieval index
-- ---------------------------------------------------------------------------
--
-- The index is what retrieval actually reads, kept separate from the authored
-- content so it can be rebuilt without touching a published entry. One row per
-- entry, `embedding` left NULL: semantic search is an upgrade, and the gateway
-- reports keyword mode until this is populated rather than implying otherwise.

insert into public.agri_knowledge_index (entry_id, crop_code, content)
select
  e.id,
  e.crop_code,
  e.title_en || ' ' || e.body_en || ' ' || e.title_ur || ' ' || e.body_ur
from public.agri_knowledge_entries e
where e.is_published
  and not exists (
    select 1 from public.agri_knowledge_index i where i.entry_id = e.id
  );

-- ---------------------------------------------------------------------------
-- Tie the seeded treatments to the seeded products
-- ---------------------------------------------------------------------------
--
-- `canonical_products` and the entries above were written independently, and a
-- product with no matching entry is a purchase step that no diagnosis can reach.
-- This is the join the gateway reads, stated once as data.

comment on column public.agri_knowledge_entries.body_local is
  'Localised extras. `products` is an array of canonical product slugs this treatment refers to; ai_product_for_knowledge() reads it to build the evidence chain from a diagnosis to a shop.';

commit;

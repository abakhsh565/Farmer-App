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

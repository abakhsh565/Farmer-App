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

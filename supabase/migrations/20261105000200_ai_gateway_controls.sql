-- Phase 5: server-side controls for the AI gateway.
--
-- The Edge Function is the only component that calls the model vendor. This
-- migration adds the two things an isolated function cannot do by itself:
--
--   · a per-party request gate, so a retry storm or a compromised client cannot
--     spend the owner's model quota without limit;
--   · an append-only operational record of route, outcome, provider/model,
--     latency and evidence counts.
--
-- Privacy boundary:
--   · No question, image, prompt, farmer profile, crop, district or citation
--     text is stored here. The event references the party id only so the same
--     party can submit feedback for its own answer.
--   · Clients have no table grants. The functions are security definer and derive
--     the party from current_party_id(); a body field cannot claim an identity.
--
-- Deliberate limits:
--   · 20 requests per minute and 300 per day per party. These are server limits,
--     not a client timer, and they are stored so every isolate shares them.
--   · A client request id is optional. When supplied, the unique partial index
--     makes a replayed submission return the existing event instead of charging
--     the rate limit twice.

create table public.ai_request_events (
  id                uuid primary key default gen_random_uuid(),
  party_id          uuid not null references public.parties (id) on delete cascade,
  client_request_id text,
  route             text not null check (route in ('ask', 'diagnose')),
  outcome           text not null default 'started'
                    check (outcome in ('started', 'ok', 'fallback', 'failed', 'rate_limited')),
  provider          text check (provider in ('openai', 'gemini')),
  model             text,
  latency_ms        integer check (latency_ms between 0 and 300000),
  evidence_count    integer not null default 0 check (evidence_count between 0 and 20),
  citation_count    integer not null default 0 check (citation_count between 0 and 40),
  error_code        text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz,
  constraint ai_request_events_client_id_len
    check (client_request_id is null or char_length(client_request_id) between 1 and 80),
  constraint ai_request_events_model_len
    check (model is null or char_length(model) <= 120),
  constraint ai_request_events_error_len
    check (error_code is null or char_length(error_code) <= 80)
);

create unique index ai_request_events_party_request_uidx
  on public.ai_request_events (party_id, client_request_id)
  where client_request_id is not null;

create index ai_request_events_party_created_idx
  on public.ai_request_events (party_id, created_at desc);

alter table public.ai_request_events enable row level security;
revoke all on public.ai_request_events from public, anon, authenticated;

create table public.ai_rate_windows (
  party_id      uuid not null references public.parties (id) on delete cascade,
  window_kind   text not null check (window_kind in ('minute', 'day')),
  window_start  timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (party_id, window_kind, window_start)
);

alter table public.ai_rate_windows enable row level security;
revoke all on public.ai_rate_windows from public, anon, authenticated;

create table public.ai_answer_feedback (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.ai_request_events (id) on delete cascade,
  party_id   uuid not null references public.parties (id) on delete cascade,
  helpful    boolean not null,
  reason     text check (reason in ('incorrect', 'unsafe', 'unclear', 'other')),
  created_at timestamptz not null default now(),
  unique (event_id, party_id)
);

alter table public.ai_answer_feedback enable row level security;
revoke all on public.ai_answer_feedback from public, anon, authenticated;

comment on table public.ai_request_events is
  'Operational AI gateway events: route, outcome, provider/model, latency and evidence counts. No question, prompt, image, profile or citation text is stored.';
comment on table public.ai_rate_windows is
  'Shared per-party AI request counters. The Edge Function cannot keep these in memory because isolates do not share state.';
comment on table public.ai_answer_feedback is
  'A bounded feedback signal for an AI answer. The event belongs to the caller; no free text is accepted.';

-- ---------------------------------------------------------------------------
-- Claim: authenticate, deduplicate, and count in one transaction.
-- ---------------------------------------------------------------------------

create or replace function public.ai_claim_request(
  p_route      text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party       uuid := public.current_party_id();
  v_route       text := lower(btrim(coalesce(p_route, '')));
  v_request_id  text := nullif(btrim(coalesce(p_request_id, '')), '');
  v_event       public.ai_request_events;
  v_minute_start timestamptz := date_trunc('minute', now());
  v_day_start    timestamptz := date_trunc('day', now());
  v_minute_count integer;
  v_day_count    integer;
  v_retry        integer;
begin
  if v_party is null then
    raise exception 'An authenticated party is required.' using errcode = 'insufficient_privilege';
  end if;
  if v_route not in ('ask', 'diagnose') then
    raise exception 'Unknown AI route.' using errcode = 'check_violation';
  end if;
  if v_request_id is not null and char_length(v_request_id) > 80 then
    raise exception 'Request id is too long.' using errcode = 'check_violation';
  end if;

  if v_request_id is not null then
    insert into public.ai_request_events (party_id, client_request_id, route)
    values (v_party, v_request_id, v_route)
    on conflict (party_id, client_request_id) where client_request_id is not null
    do nothing
    returning * into v_event;

    if v_event.id is null then
      select *
        into v_event
        from public.ai_request_events
       where party_id = v_party and client_request_id = v_request_id
       limit 1;
      return jsonb_build_object(
        'allowed', false,
        'duplicate', true,
        'retry_after_seconds', null,
        'event_id', v_event.id
      );
    end if;
  else
    insert into public.ai_request_events (party_id, route)
    values (v_party, v_route)
    returning * into v_event;
  end if;

  -- Keep two days of counters; the gate only reads the current minute and day.
  delete from public.ai_rate_windows
   where window_start < now() - interval '2 days';

  insert into public.ai_rate_windows (party_id, window_kind, window_start, request_count)
  values (v_party, 'minute', v_minute_start, 1)
  on conflict (party_id, window_kind, window_start)
  do update set request_count = public.ai_rate_windows.request_count + 1
  returning request_count into v_minute_count;

  insert into public.ai_rate_windows (party_id, window_kind, window_start, request_count)
  values (v_party, 'day', v_day_start, 1)
  on conflict (party_id, window_kind, window_start)
  do update set request_count = public.ai_rate_windows.request_count + 1
  returning request_count into v_day_count;

  if v_minute_count > 20 or v_day_count > 300 then
    update public.ai_request_events
       set outcome = 'rate_limited',
           error_code = 'rate_limit',
           finished_at = now()
     where id = v_event.id;

    v_retry := case
      when v_minute_count > 20 then
        greatest(1, ceil(extract(epoch from (v_minute_start + interval '1 minute' - now())))::integer)
      else
        greatest(1, ceil(extract(epoch from (v_day_start + interval '1 day' - now())))::integer)
    end;

    return jsonb_build_object(
      'allowed', false,
      'duplicate', false,
      'retry_after_seconds', v_retry,
      'event_id', v_event.id
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'duplicate', false,
    'retry_after_seconds', null,
    'event_id', v_event.id
  );
end;
$$;

comment on function public.ai_claim_request(text, text) is
  'Claims one AI request for the caller, deduplicating an optional client request id and enforcing the shared minute/day limits.';

-- ---------------------------------------------------------------------------
-- Finish: record operational metadata against the caller's own claim.
-- ---------------------------------------------------------------------------

create or replace function public.ai_finish_request(
  p_event_id       uuid,
  p_outcome        text,
  p_provider       text default null,
  p_model          text default null,
  p_latency_ms     integer default null,
  p_evidence_count integer default 0,
  p_citation_count integer default 0,
  p_error_code     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party   uuid := public.current_party_id();
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_provider text := nullif(lower(btrim(coalesce(p_provider, ''))), '');
  v_model   text := nullif(btrim(coalesce(p_model, '')), '');
  v_error   text := nullif(btrim(coalesce(p_error_code, '')), '');
begin
  if v_party is null then
    raise exception 'An authenticated party is required.' using errcode = 'insufficient_privilege';
  end if;
  if p_event_id is null then
    raise exception 'An event id is required.' using errcode = 'check_violation';
  end if;
  if v_outcome not in ('ok', 'fallback', 'failed') then
    raise exception 'Unknown AI outcome.' using errcode = 'check_violation';
  end if;
  if v_provider is not null and v_provider not in ('openai', 'gemini') then
    raise exception 'Unknown AI provider.' using errcode = 'check_violation';
  end if;
  if v_model is not null and char_length(v_model) > 120 then
    raise exception 'Model name is too long.' using errcode = 'check_violation';
  end if;

  update public.ai_request_events
     set outcome = v_outcome,
         provider = v_provider,
         model = v_model,
         latency_ms = greatest(0, least(coalesce(p_latency_ms, 0), 300000)),
         evidence_count = greatest(0, least(coalesce(p_evidence_count, 0), 20)),
         citation_count = greatest(0, least(coalesce(p_citation_count, 0), 40)),
         error_code = left(v_error, 80),
         finished_at = now()
   where id = p_event_id
     and party_id = v_party
     and outcome = 'started';

  return found;
end;
$$;

comment on function public.ai_finish_request(uuid, text, text, text, integer, integer, integer, text) is
  'Completes the caller''s own AI event. It cannot update another party''s event or overturn a rate-limited claim.';

-- ---------------------------------------------------------------------------
-- Feedback: a bounded signal, never free text.
-- ---------------------------------------------------------------------------

create or replace function public.ai_feedback(
  p_request_id text,
  p_helpful    boolean,
  p_reason     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_party      uuid := public.current_party_id();
  v_request_id text := nullif(btrim(coalesce(p_request_id, '')), '');
  v_reason     text := nullif(lower(btrim(coalesce(p_reason, ''))), '');
  v_event_id   uuid;
begin
  if v_party is null then
    raise exception 'An authenticated party is required.' using errcode = 'insufficient_privilege';
  end if;
  if v_request_id is null or char_length(v_request_id) > 80 then
    raise exception 'A valid request id is required.' using errcode = 'check_violation';
  end if;
  if p_helpful is null then
    raise exception 'Feedback must be helpful or not helpful.' using errcode = 'check_violation';
  end if;
  if v_reason is not null and v_reason not in ('incorrect', 'unsafe', 'unclear', 'other') then
    raise exception 'Unknown feedback reason.' using errcode = 'check_violation';
  end if;

  select id
    into v_event_id
    from public.ai_request_events
   where party_id = v_party
     and client_request_id = v_request_id
     and outcome in ('ok', 'fallback')
   order by created_at desc
   limit 1;

  if v_event_id is null then
    raise exception 'No answered request matches that request id.' using errcode = 'no_data_found';
  end if;

  insert into public.ai_answer_feedback (event_id, party_id, helpful, reason)
  values (v_event_id, v_party, p_helpful, v_reason)
  on conflict (event_id, party_id)
  do update set helpful = excluded.helpful,
                reason = excluded.reason,
                created_at = now();

  return true;
end;
$$;

comment on function public.ai_feedback(text, boolean, text) is
  'Records one bounded feedback signal for the caller''s own answered request.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.ai_claim_request(text, text) from public, anon;
revoke execute on function public.ai_finish_request(uuid, text, text, text, integer, integer, integer, text) from public, anon;
revoke execute on function public.ai_feedback(text, boolean, text) from public, anon;

grant execute on function public.ai_claim_request(text, text) to authenticated;
grant execute on function public.ai_finish_request(uuid, text, text, text, integer, integer, integer, text) to authenticated;
grant execute on function public.ai_feedback(text, boolean, text) to authenticated;

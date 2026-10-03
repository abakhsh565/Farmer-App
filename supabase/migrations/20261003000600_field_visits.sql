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

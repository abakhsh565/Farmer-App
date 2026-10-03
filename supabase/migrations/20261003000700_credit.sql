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

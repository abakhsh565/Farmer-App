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

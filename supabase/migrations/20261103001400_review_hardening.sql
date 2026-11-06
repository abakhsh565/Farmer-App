-- Farmer App · migration 0046 · Phase 5.2.1 review operational hardening
--
-- Three gaps left open by Phase 5.2, closed without a second authority model:
--
--   · authority administration is a server-checked, self-escalation-proof act;
--   · expiry of a validity window is a scheduled server act, recorded in the
--     same append-only review ledger as a human expiry;
--   · queue counts are scoped to the caller's actual authority, not global.
--
-- `admin` still only grants authority. It never becomes agronomic approval.

-- ---------------------------------------------------------------------------
-- Authority administration
-- ---------------------------------------------------------------------------
alter table public.agri_review_authorities
  add column if not exists revoked_by uuid references public.parties (id) on delete set null;

comment on column public.agri_review_authorities.revoked_by is
  'The administrator who revoked this authority. Revocation is recorded, never deleted.';

-- Scheduled expiry has no signed-in person. The ledger records it honestly as a
-- system actor rather than attributing the act to a human reviewer.
alter table public.agri_evidence_reviews
  drop constraint if exists agri_evidence_reviews_actor_role_check;
alter table public.agri_evidence_reviews
  add constraint agri_evidence_reviews_actor_role_check
  check (actor_role in ('evidence_reviewer', 'content_manager', 'admin', 'submitter', 'system'));

create or replace function public.grant_agri_review_authority(
  p_party_id        uuid,
  p_authority       text,
  p_scope_crops     text[] default '{}'::text[],
  p_scope_districts text[] default '{}'::text[],
  p_note            text default null
)
returns public.agri_review_authorities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_row public.agri_review_authorities;
begin
  if not public.has_capability('admin') then
    raise exception 'Granting review authority requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if p_authority not in ('evidence_reviewer', 'content_manager') then
    raise exception 'Unknown review authority.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Granting review authority requires a note.' using errcode = 'check_violation';
  end if;
  -- An administrator may appoint someone else, never themselves. Self-grant is
  -- the one path that would let admin silently become agronomic authority.
  if p_party_id = v_actor then
    raise exception 'You cannot grant review authority to yourself.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.parties p where p.id = p_party_id) then
    raise exception 'Party % not found.', p_party_id using errcode = 'no_data_found';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_scope_crops, '{}'::text[])) c
     where not exists (select 1 from public.crop_catalog cc where cc.code = c)
  ) then
    raise exception 'Review scope contains an unknown crop code.' using errcode = 'check_violation';
  end if;

  insert into public.agri_review_authorities (
    party_id, authority, scope_crops, scope_districts, granted_by, note
  ) values (
    p_party_id, p_authority, coalesce(p_scope_crops, '{}'::text[]),
    coalesce(p_scope_districts, '{}'::text[]), v_actor, btrim(p_note)
  )
  on conflict (party_id, authority) do update
    set scope_crops = excluded.scope_crops,
        scope_districts = excluded.scope_districts,
        granted_by = excluded.granted_by,
        granted_at = now(),
        revoked_at = null,
        revoked_by = null,
        note = excluded.note
  returning * into v_row;

  perform public.write_audit(
    'agri.review_authority_granted', 'agri_review_authorities', v_row.id, p_authority,
    null, 'active',
    jsonb_build_object('party_id', p_party_id, 'scopes', jsonb_build_object(
      'crops', v_row.scope_crops, 'districts', v_row.scope_districts
    )),
    v_actor, 'admin'
  );

  return v_row;
end;
$$;

comment on function public.grant_agri_review_authority(uuid, text, text[], text[], text) is
  'Admin-only authority grant. Self-grant is refused: an administrator may appoint another person, never themselves. The grant is a recorded human decision and does not seed agronomic expertise.';

create or replace function public.revoke_agri_review_authority(
  p_party_id  uuid,
  p_authority text,
  p_note      text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
begin
  if not public.has_capability('admin') then
    raise exception 'Revoking review authority requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Revoking review authority requires a note.' using errcode = 'check_violation';
  end if;

  update public.agri_review_authorities
     set revoked_at = now(), revoked_by = v_actor, note = btrim(p_note)
   where party_id = p_party_id and authority = p_authority and revoked_at is null;
  if not found then return false; end if;

  perform public.write_audit(
    'agri.review_authority_revoked', 'agri_review_authorities', null, p_authority,
    'active', 'revoked', jsonb_build_object('party_id', p_party_id, 'note', btrim(p_note)),
    v_actor, 'admin'
  );
  return true;
end;
$$;

create or replace function public.agri_review_authorities_list()
returns table (
  party_id        uuid,
  display_name    text,
  authority       text,
  scope_crops     text[],
  scope_districts text[],
  granted_at      timestamptz,
  granted_by      uuid,
  granted_by_name text,
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoked_by_name text,
  note            text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_capability('admin') then
    raise exception 'Inspecting review authorities requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;

  return query
  select a.party_id,
         coalesce(p.display_name, 'Account ' || left(a.party_id::text, 8)),
         a.authority,
         a.scope_crops,
         a.scope_districts,
         a.granted_at,
         a.granted_by,
         (select g.display_name from public.parties g where g.id = a.granted_by),
         a.revoked_at,
         a.revoked_by,
         (select r.display_name from public.parties r where r.id = a.revoked_by),
         a.note
    from public.agri_review_authorities a
    left join public.parties p on p.id = a.party_id
   order by (a.revoked_at is null) desc, a.granted_at desc;
end;
$$;

create or replace function public.agri_review_authority_candidates(p_search text default null)
returns table (
  party_id     uuid,
  display_name text,
  has_reviewer boolean,
  has_manager  boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_capability('admin') then
    raise exception 'Inspecting review candidates requires the admin capability.' using errcode = 'insufficient_privilege';
  end if;

  return query
  select p.id,
         coalesce(p.display_name, 'Account ' || left(p.id::text, 8)),
         exists (
           select 1 from public.agri_review_authorities a
            where a.party_id = p.id and a.authority = 'evidence_reviewer' and a.revoked_at is null
         ),
         exists (
           select 1 from public.agri_review_authorities a
            where a.party_id = p.id and a.authority = 'content_manager' and a.revoked_at is null
         )
    from public.parties p
   where p.auth_user_id is not null
     and (
       p_search is null
       or btrim(p_search) = ''
       or coalesce(p.display_name, '') ilike '%' || btrim(p_search) || '%'
     )
   order by p.display_name nulls last, p.created_at
   limit 20;
end;
$$;

comment on function public.agri_review_authority_candidates(text) is
  'Admin-only roster search for appointing a named person. It returns only accounts with a sign-in identity and never a phone number.';

-- ---------------------------------------------------------------------------
-- Scoped counts
-- ---------------------------------------------------------------------------
create or replace function public.agri_review_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.current_party_id();
  v_review boolean;
  v_manage boolean;
begin
  if v_actor is null then
    raise exception 'An identified account is required.' using errcode = 'insufficient_privilege';
  end if;

  v_review := public.agri_has_authority_role('evidence_reviewer');
  v_manage := public.agri_has_authority_role('content_manager');

  return jsonb_build_object(
    'party_id', v_actor,
    'can_review', v_review,
    'can_manage', v_manage,
    'can_grant', public.has_capability('admin'),
    'authorities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'authority', a.authority,
        'scope_crops', a.scope_crops,
        'scope_districts', a.scope_districts,
        'granted_at', a.granted_at
      ) order by a.authority)
      from public.agri_review_authorities a
      where a.party_id = v_actor and a.revoked_at is null
    ), '[]'::jsonb),
    -- Counts are what this person may act on, not the national total. An
    -- all-scope authority sees everything; a wheat-only reviewer sees wheat.
    'counts', case
      when v_review or v_manage then (
        select jsonb_build_object(
          'submitted', count(*) filter (where i.status = 'submitted'),
          'under_review', count(*) filter (where i.status = 'under_review'),
          'correction_requested', count(*) filter (where i.status = 'correction_requested'),
          'approved', count(*) filter (where i.status = 'approved'),
          'published', count(*) filter (where i.status = 'published'),
          'rejected', count(*) filter (where i.status = 'rejected'),
          'closed', count(*) filter (where i.status in ('expired', 'superseded'))
        )
        from public.agri_evidence_items i
        where (v_review and public.agri_has_authority('evidence_reviewer', i.crop_code, i.districts))
           or (v_manage and public.agri_has_authority('content_manager', i.crop_code, i.districts))
      )
      else '{}'::jsonb
    end
  );
end;
$$;

comment on function public.agri_review_context() is
  'The signed-in person''s review roles, scopes and counts scoped to the evidence their authority actually covers. It never exposes a role inferred from admin.';

-- ---------------------------------------------------------------------------
-- Scheduled expiry
-- ---------------------------------------------------------------------------
create or replace function public.agri_expire_due_evidence(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_count integer := 0;
  v_ids uuid[] := '{}'::uuid[];
begin
  -- Only a live approved/published dossier can expire. A second run finds
  -- nothing, so the schedule is idempotent by construction.
  for v_row in
    select *
      from public.agri_evidence_items
     where status in ('approved', 'published')
       and valid_until is not null
       and valid_until <= p_now
     order by valid_until
     for update
  loop
    -- Withdraw the content first: the target becomes unusable for new
    -- recommendations, advisory verification or rule activation in the same
    -- transaction that expires its evidence.
    if v_row.status = 'published' then
      if v_row.target_kind = 'knowledge_entry' then
        update public.agri_knowledge_entries
           set is_published = false
         where id = v_row.target_ref::uuid;
      elsif v_row.target_kind = 'official_advisory' then
        update public.agri_advisories
           set is_active = false
         where id = v_row.target_ref::uuid;
      else
        update public.forecast_risk_rules
           set is_active = false,
               deactivated_at = p_now,
               deactivation_note = 'Evidence validity window ended'
         where code = v_row.target_ref;
      end if;
    end if;

    update public.agri_evidence_items
       set status = 'expired',
           expired_at = p_now,
           review_note = 'Validity window ended'
     where id = v_row.id;

    perform public.agri_log_evidence_event(
      v_row.id, 'expire', v_row.status, 'expired', 'Validity window ended',
      jsonb_build_object('automatic', true, 'valid_until', v_row.valid_until, 'expired_at', p_now),
      'system'
    );

    v_count := v_count + 1;
    v_ids := v_ids || v_row.id;
  end loop;

  return jsonb_build_object('expired', v_count, 'evidence_ids', to_jsonb(v_ids));
end;
$$;

comment on function public.agri_expire_due_evidence(timestamptz) is
  'Scheduled expiry of dossiers whose validity window has ended. It withdraws the linked target, writes the existing append-only ledger as a system actor and is idempotent: a repeated run expires nothing.';

revoke execute on function public.agri_expire_due_evidence(timestamptz) from public, anon, authenticated;

-- Hourly at :07. The function is the mechanism; pg_cron is only the clock. A
-- local replay without pg_cron still has the function, and the DO block simply
-- does not schedule it there.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'agri_evidence_expiry') then
      perform cron.unschedule('agri_evidence_expiry');
    end if;
    perform cron.schedule(
      'agri_evidence_expiry',
      '7 * * * *',
      'select public.agri_expire_due_evidence();'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants for the two new admin reads
-- ---------------------------------------------------------------------------
revoke execute on function public.agri_review_authorities_list() from public, anon;
revoke execute on function public.agri_review_authority_candidates(text) from public, anon;
grant execute on function public.agri_review_authorities_list() to authenticated;
grant execute on function public.agri_review_authority_candidates(text) to authenticated;

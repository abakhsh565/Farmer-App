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

-- Farmer App · migration 0023 · client document isolation and chat
--
-- Two corrections to the client-document layer (migration 0015), both found
-- while reproducing a real cross-user leak on a shared phone.
--
-- 1. `client_document_get` was `security definer` and granted to every signed-in
--    user, but it never checked that the caller *was* the owner it was asking
--    about. Any authenticated client could read any party's document by passing
--    a different `p_owner_id` — the read side of the leak. `put` and `delete`
--    already refuse a foreign owner; `get` now refuses it the same way.
--
-- 2. `chat` was missing from the collection check, which the stores have been
--    writing since conversations moved behind the repository. Every chat write
--    was rejected by the constraint, so dealer messages never reached the
--    backend at all — the queue just kept retrying. It is added here.
--
-- Nothing about the document shapes changes; this is a permission and a
-- constraint, applied on the side that must be able to enforce them.

-- 1. The read is the caller's own document or nothing.
create or replace function public.client_document_get(
  p_owner_id   uuid,
  p_collection text
)
returns table (document jsonb, doc_version integer, revision bigint, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- A client may only ever read its own document, whatever it passes as a
  -- parameter. Without this, the function is an oracle for every party's
  -- private documents to anyone who can guess a uuid.
  if p_owner_id is distinct from public.current_party_id() then
    raise exception 'A client may only read its own documents.' using errcode = 'insufficient_privilege';
  end if;

  return query
    select d.document, d.doc_version, d.revision, d.updated_at
    from public.client_documents d
    where d.owner_id = p_owner_id
      and d.collection = p_collection;
end;
$$;

-- 2. The collections the client actually owns. `chat` was missing.
alter table public.client_documents
  drop constraint if exists client_documents_collection_check;

alter table public.client_documents
  add constraint client_documents_collection_check check (collection in (
    'session', 'credit', 'visits', 'insights', 'community', 'chat', 'crops', 'media', 'preferences'
  ));

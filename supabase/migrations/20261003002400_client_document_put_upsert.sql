-- Farmer App · migration 0024 · the document write path, made to actually update
--
-- WHAT WAS WRONG
--
-- `client_document_put` (migration 0015) tried to be an upsert by hand:
--
--     select * into v_current ... for update;
--     if found then <update>; return next; end if;
--     insert ... ;
--
-- `RETURN NEXT` is not `RETURN`. In a set-returning function it *appends a row
-- and continues executing*, which is what it is for — and here it meant the
-- update branch ran, emitted its row, and then fell straight through into the
-- insert below it. That insert used the same primary key the update had just
-- written, so the whole statement failed:
--
--     409  duplicate key value violates unique constraint "client_documents_pkey"
--
-- and the transaction rolled back, taking the update with it. `revision` never
-- advanced past 1 and `updated_at` never moved: cloud sync was write-once per
-- collection, per farmer. The client's queue read the 409 as a transient
-- failure and retried forever, so a signed-in farmer saw a permanent "waiting to
-- save" badge while their server copy stayed frozen at its first version.
--
-- Proven, not inferred. Reproduced against a local PostgreSQL 17 with this
-- repository's own SQL bytes: an instrumented build of the 0015 function prints
-- `found=t`, then `taking the UPDATE branch`, then `taking the INSERT branch`,
-- and finally the duplicate key. The production behaviour was identical,
-- including the SQLSTATE — which also settles that the deployed function *is*
-- the 0015 body rather than a hand-edited variant.
--
-- WHAT THIS DOES INSTEAD
--
-- The same operation, expressed so that no branch can be skipped and there is
-- exactly one exit: an UPDATE first, an INSERT only when the UPDATE matched
-- nothing, and a single `return next` at the very end — never one that has to
-- stop the function, because it cannot. Both statements use FOUND, which
-- PostgreSQL defines for UPDATE and for INSERT, and the caller's
-- optimistic-concurrency token is part of the UPDATE's own predicate rather
-- than a check that has to be reached.
--
--   · row exists, revision accepted   → UPDATE, revision + 1
--   · row exists, revision refused    → UPDATE matches nothing, the INSERT is
--                                       refused by the primary key, and the
--                                       caller is told the document changed
--                                       (SQLSTATE 40001, which the client can
--                                       tell apart from a network failure)
--   · row does not exist              → INSERT, revision 1
--
-- `updated_at` is set by the existing `client_documents_touch` trigger on
-- UPDATE and by the column default on INSERT, so this function does not touch
-- it — one writer for one column.
--
-- The ownership guard is unchanged and still first: a client may only ever
-- write its own document, whatever it passes as a parameter. Everything else
-- about the table — the collection list, RLS, the grants — is untouched.

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
  v_revision   bigint;
  v_updated_at timestamptz;
begin
  -- A client may only write its own document, whatever it passes as a parameter.
  if p_owner_id is distinct from public.current_party_id() then
    raise exception 'A client may only write its own documents.' using errcode = 'insufficient_privilege';
  end if;

  /*
   * The expected revision is a predicate, not a check.
   *
   * `p_expected_revision is null` means "I am not tracking a revision" — the
   * stores are single-device today, which is why the client sends null. A
   * caller that *is* tracking one gets a real compare-and-set.
   */
  update public.client_documents
     set document    = p_document,
         doc_version = p_doc_version,
         revision    = client_documents.revision + 1
   where owner_id = p_owner_id
     and collection = p_collection
     and (p_expected_revision is null or client_documents.revision = p_expected_revision)
  returning client_documents.revision, client_documents.updated_at
       into v_revision, v_updated_at;

  if not found then
    /*
     * Nothing was updated. Two reasons, and the primary key tells them apart:
     * the document does not exist yet (insert it), or it exists and the
     * caller's revision was stale (the insert below is refused, and we say so).
     */
    insert into public.client_documents (owner_id, collection, document, doc_version)
    values (p_owner_id, p_collection, p_document, p_doc_version)
    on conflict (owner_id, collection) do nothing
    returning client_documents.revision, client_documents.updated_at
         into v_revision, v_updated_at;

    if not found then
      /*
       * The document exists and the caller's revision is not the current one —
       * or another device inserted it between the two statements. Either way
       * the write is refused rather than silently clobbering, and the caller
       * is told which case by the word "changed": it re-reads and writes again
       * with the revision it just learned.
       */
      raise exception 'Document % for % changed on another device.', p_collection, p_owner_id
        using errcode = 'serialization_failure';
    end if;
  end if;

  revision := v_revision;
  updated_at := v_updated_at;
  return next;
end;
$$;

comment on function public.client_document_put(uuid, text, jsonb, bigint, integer) is
  'Writes one client document and advances its revision. A stale p_expected_revision is refused with SQLSTATE 40001 rather than overwriting another device.';

grant execute on function public.client_document_put(uuid, text, jsonb, bigint, integer) to authenticated;

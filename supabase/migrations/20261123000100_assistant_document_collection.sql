-- Lets the assistant keep its conversation in `client_documents`.
--
-- The assistant's transcript is a client document like every other store's: it is
-- written to the phone first and to the backend through the same queue, so a
-- farmer who signs in on a second phone finds the questions they already asked.
-- That needs one thing this table did not allow — a collection named `assistant`.
--
-- The constraint is replaced rather than relaxed: `client_documents` must keep
-- refusing a collection name the client does not own, because the name is the
-- only thing separating one store's document from another's. `chat` was added the
-- same way in 20261003002300, for the same reason, and this is the second time a
-- store has needed a name of its own — which is why the list is here, in the
-- chain, and not in a validator somewhere that a migration cannot see.
--
-- `preferences` stays although no client writes it today: it is a name older
-- documents may carry, and dropping it would make those rows unreadable rather
-- than unused.

alter table public.client_documents
  drop constraint if exists client_documents_collection_check;

alter table public.client_documents
  add constraint client_documents_collection_check check (collection in (
    'session', 'credit', 'visits', 'insights', 'community', 'chat',
    'crops', 'media', 'preferences', 'assistant'
  ));

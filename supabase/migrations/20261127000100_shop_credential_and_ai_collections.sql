-- Two collections the app writes and the constraint never allowed.
--
-- `shop-credential` is the dealer connection kept on the farmer's account, so a
-- phone, a browser and a replacement phone all open the same shops without the
-- six-character code being typed again. The whole point of the collection is that
-- it is per-account and guarded by row level security; without this entry every
-- write was refused with `client_documents_collection_check`, which the app
-- reported as "could not save" rather than losing the connection silently.
--
-- `ai` is the assistant's own document. The app has written `ai` since the
-- assistant shipped, while 20261123000100 added `assistant` — so the assistant's
-- state was never persisted on a project that had the newer constraint, and the
-- profile screen kept a failed write waiting to sync. Both names are allowed here
-- rather than renaming one: a rename would strand the rows an older build wrote.
alter table public.client_documents
  drop constraint if exists client_documents_collection_check;

alter table public.client_documents
  add constraint client_documents_collection_check check (collection in (
    'session', 'credit', 'visits', 'insights', 'community', 'chat',
    'crops', 'media', 'preferences', 'assistant', 'ai', 'shop-credential'
  ));

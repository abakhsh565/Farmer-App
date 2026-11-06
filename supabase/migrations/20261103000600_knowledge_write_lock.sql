-- Phase 3 · knowledge write lock
--
-- The knowledge tables are read by clients but authored only by the service
-- role. The blanket grant migration historically left INSERT/UPDATE/DELETE on
-- `agri_knowledge_entries` with `authenticated`; RLS denied those operations
-- because no write policy existed, but an unused write grant is not a boundary
-- worth keeping. Make the grant agree with the policy: clients may read
-- published entries, and may not write knowledge or source metadata at all.

revoke insert, update, delete on public.agri_knowledge_entries from anon, authenticated;
revoke insert, update, delete on public.agri_knowledge_index from anon, authenticated;
revoke all on public.agri_knowledge_sources from anon, authenticated;

comment on table public.agri_knowledge_entries is
  'Published agricultural knowledge. Clients read published rows under RLS; only the service role may author or revise entries.';

comment on table public.agri_knowledge_index is
  'Retrieval projection for the AI gateway. Clients have no read or write grant; the gateway uses the service role.';
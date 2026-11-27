-- Realtime for the catalogue this app keeps.
--
-- `dealer_profiles` and `dealer_products` are the two tables a screen re-reads
-- when a shop, a branch or a listing changes. Publishing them lets an open screen
-- hear about the change instead of waiting for its next poll; the poll stays as
-- the fallback for the dealer platform's own catalogue, which is a different
-- project and is read live on every call.
--
-- Both tables already grant read to anon and authenticated (`*_read` using
-- `true`), so the events a client receives are exactly the rows it may already
-- read. Nothing is added to `supabase_realtime` twice.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dealer_profiles'
  ) then
    alter publication supabase_realtime add table public.dealer_profiles;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dealer_products'
  ) then
    alter publication supabase_realtime add table public.dealer_products;
  end if;
end
$$;

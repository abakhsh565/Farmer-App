-- Phase 8 launch hardening: withdraw recommendations when their source is unpublished.
--
-- `agri_expire_due_evidence()` already unpublishes an expired knowledge target,
-- but an already-issued recommendation is a snapshot: it has its own validity
-- window and does not re-read the source. Without this trigger, a recommendation
-- made from a verified entry could remain in the feed for up to its TTL after the
-- source was withdrawn. That is an active-advice integrity failure, not merely a
-- stale cache.
--
-- The trigger is deliberately narrow:
--   · only knowledge-base recommendations are affected;
--   · only the version that was unpublished is withdrawn;
--   · already-withdrawn rows are left untouched; and
--   · re-publishing the same version does not revive an old row — the generator
--     creates a fresh canonical row, so the history remains auditable.
--
-- Advisory and forecast-risk recommendations have their own activation and
-- expiry paths. This migration does not change their semantics.

create or replace function public.agri_withdraw_unpublished_knowledge_recommendations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.is_published and not new.is_published then
    update public.recommendations r
       set withdrawn_at = now(),
           withdraw_reason = 'knowledge source unpublished'
     where r.source = 'knowledge_base'
       and r.source_ref = new.slug
       and coalesce(r.knowledge_version, new.version) = new.version
       and r.withdrawn_at is null;
  end if;

  return null;
end;
$$;

comment on function public.agri_withdraw_unpublished_knowledge_recommendations() is
  'Withdraws live recommendations generated from the exact knowledge version that was unpublished. A withdrawn row is never silently revived; regeneration creates a new row.';

drop trigger if exists agri_knowledge_withdraw_recommendations
  on public.agri_knowledge_entries;

create trigger agri_knowledge_withdraw_recommendations
  after update of is_published on public.agri_knowledge_entries
  for each row
  when (old.is_published is distinct from new.is_published)
  execute function public.agri_withdraw_unpublished_knowledge_recommendations();

-- The function is trigger-only. Do not expose it as a callable RPC.
revoke execute on function public.agri_withdraw_unpublished_knowledge_recommendations()
  from public, anon, authenticated;

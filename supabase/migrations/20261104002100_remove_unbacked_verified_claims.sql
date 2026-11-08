-- Phase 8 evidence integrity: do not serve a legacy "verified" claim without a dossier.
--
-- The Phase 5.2 publication guard requires a published evidence dossier before a
-- knowledge entry may be published. One seeded entry predates that guard and is
-- still marked verified with evidence_item_id NULL. The recommendation trace
-- exposed the contradiction honestly (`verified_guidance: false`), but the feed
-- still labelled the advice as verified. That is exactly the claim this platform
-- must not make without evidence.
--
-- This migration unpublishes only verified entries that lack a published,
-- authoritative dossier. Supplementary editorial entries are left alone; they
-- are already labelled as supplementary and are not represented as verified.
-- The existing knowledge withdrawal trigger then withdraws any active
-- recommendation generated from the affected version.
--
-- This is a content correction, not a new verification. No dossier is invented,
-- no reviewer is fabricated, and the entry is not relabelled. It can be
-- published again only through the normal evidence workflow after real review.

update public.agri_knowledge_entries e
   set is_published = false
 where e.is_published
   and e.evidence_tier = 'verified'
   and not exists (
     select 1
       from public.agri_evidence_items i
      where i.id = e.evidence_item_id
        and i.status = 'published'
        and i.target_kind = 'knowledge_entry'
        and i.target_ref = e.id::text
        and i.classification in (
          'official_government', 'peer_reviewed_research', 'qualified_expert'
        )
        and i.source_check_status = 'authentic'
        and i.applicability_status = 'applicable'
        and i.agronomic_status = 'approved'
   );

comment on table public.agri_knowledge_entries is
  'Published verified entries require a published, authoritative evidence dossier. Legacy verified rows without one are unpublished rather than presented as verified; supplementary editorial rows remain separately labelled.';

-- ---------------------------------------------------------------------------
-- Forward-only correction: the source-permission retrieval gate.
--
-- Version 20261105000100 was recorded in the staging ledger without this gate
-- and the matching recommendation-feed filter. It was prepared as a correction
-- to that version, but an applied migration is never rewritten or replayed, so
-- those two function bodies are carried here under a new version and applied on
-- top. `20261105000100` in this repository is restored to the state staging
-- recorded; this file is the only source of the gate.
--
-- Effect: trusted retrieval requires a recorded source permission
-- (`granted`/`not_required`) and a licence name, and a `verified` entry needs a
-- published, human-reviewed, still-valid dossier. A source whose permission is
-- `unknown` or `needs_permission` stays out of retrieval and out of the ranked
-- knowledge feed. No source permission, licence, reviewer or agricultural claim
-- is seeded here; this migration only narrows what may be served.
-- ---------------------------------------------------------------------------
drop function if exists public.ai_knowledge_search(text, text, text, integer);

create or replace function public.ai_knowledge_search(
  p_query    text,
  p_crop     text default null,
  p_district text default null,
  p_limit    integer default 4,
  p_stage    text default null
)
returns table (
  id                  uuid,
  slug                text,
  version             integer,
  title_en            text,
  title_ur            text,
  body_en             text,
  body_ur             text,
  topic               text,
  problem_type        text,
  symptoms            text[],
  regions             text[],
  crop_code           text,
  provenance          text,
  evidence_tier       text,
  source_code         text,
  source_name         text,
  source_url          text,
  source_published_on date,
  source_updated_on   date,
  source_accessed_on  date,
  stages              text[],
  districts           text[],
  source_publisher    text,
  source_license      text,
  stale               boolean,
  score               double precision,
  used_embedding      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with content as (
    select regexp_replace(
      lower(left(coalesce(nullif(btrim(p_query), ''), ''), 500)),
      '\m(how|what|when|where|why|who|which|do|does|did|i|we|you|they|he|she|it|the|a|an|and|or|in|on|of|to|for|from|at|by|with|about|as|is|are|was|were|be|been|being|can|could|should|would|will|shall|may|might|must|please|tell|me|my|our|your|their|his|her|its|this|that|these|those|there|if|after|before|more|most|much|many|any|all|not|no|so|than|then|also|just|very|but|into|over|under|use|using|has|have|had)\M',
      ' ', 'gi'
    ) as terms
  ), q as (
    select
      websearch_to_tsquery('simple', coalesce(nullif(btrim(content.terms), ''), 'crop')) as strict,
      websearch_to_tsquery(
        'simple',
        coalesce(
          nullif(regexp_replace(btrim(content.terms), '[[:space:]]+', ' OR ', 'g'), ''),
          'crop'
        )
      ) as broad
      from content
  ), documents as (
    select e.*,
           ev.status as evidence_status,
           ev.stages as evidence_stages,
           ev.districts as evidence_districts,
           ev.accessed_at as evidence_accessed_at,
           ev.valid_until as evidence_valid_until,
           ev.source_organization as evidence_publisher,
           coalesce(ev.license_name, s.license_name) as source_license,
           s.freshness_days,
           coalesce(ev.source_organization, s.publisher, s.name) as source_publisher,
           to_tsvector(
             'simple',
             coalesce(e.title_en, '') || ' ' || coalesce(e.title_ur, '') || ' ' ||
             coalesce(e.body_en, '') || ' ' || coalesce(e.body_ur, '') || ' ' ||
             coalesce(e.topic, '') || ' ' || coalesce(e.problem_type, '') || ' ' ||
             coalesce(array_to_string(e.symptoms, ' '), '') || ' ' || coalesce(e.slug, '')
           ) as document
      from public.agri_knowledge_entries e
      left join public.agri_evidence_items ev on ev.id = e.evidence_item_id
      left join public.agri_knowledge_sources s on s.code = coalesce(ev.source_code, e.source_code)
     where e.is_published
       and e.withdrawn_at is null
       and (e.evidence_item_id is null or ev.status = 'published')
       and (ev.valid_until is null or ev.valid_until > now())
       -- Trusted retrieval requires a recorded source permission and licence.
       -- A legacy verified row without a published dossier is not trusted just
       -- because its tier says verified; it must have a human-reviewed dossier.
       and s.permission_status in ('granted', 'not_required')
       and s.license_name is not null
       and (
         e.evidence_tier <> 'verified'
         or (
           ev.id is not null
           and ev.status = 'published'
           and ev.reviewer_id is not null
           and ev.valid_until is not null
         )
       )
  )
  select
    e.id, e.slug, e.version, e.title_en, e.title_ur, e.body_en, e.body_ur,
    e.topic, e.problem_type, e.symptoms, e.regions, e.crop_code, e.provenance,
    e.evidence_tier, e.source_code, s.name, e.source_url,
    e.source_published_on, e.source_updated_on, e.source_accessed_on,
    coalesce(e.applies_to_stages::text[], '{}'::text[]),
    coalesce(e.evidence_districts, '{}'::text[]),
    e.source_publisher,
    e.source_license,
    coalesce(
      (e.freshness_days is not null
        and e.evidence_accessed_at < now() - make_interval(days => e.freshness_days))
      or (e.evidence_valid_until is not null and e.evidence_valid_until <= now()),
      false
    ),
    least(
      1.0,
      ts_rank(e.document, q.strict) * 8
      + ts_rank(e.document, q.broad) * 3
      + case e.evidence_tier when 'verified' then 0.12 when 'supplementary' then 0.05 else 0 end
    )::double precision as score,
    false as used_embedding
  from documents e
  cross join q
  left join public.agri_knowledge_sources s on s.code = e.source_code
  where
    (
      e.document @@ q.strict
      or e.document @@ q.broad
      or (
        btrim(coalesce(p_query, '')) <> ''
        and (
          e.title_en ilike '%' || left(btrim(p_query), 80) || '%'
          or e.title_ur ilike '%' || left(btrim(p_query), 80) || '%'
          or e.slug ilike '%' || left(btrim(p_query), 80) || '%'
        )
      )
    )
    and (
      p_district is null
      or cardinality(coalesce(e.evidence_districts, '{}'::text[])) = 0
      or p_district = any (coalesce(e.evidence_districts, '{}'::text[]))
    )
    and (
      p_stage is null
      or cardinality(coalesce(e.applies_to_stages, '{}'::public.crop_stage[])) = 0
      or p_stage::public.crop_stage = any (e.applies_to_stages)
    )
  order by
    (p_crop is not null and e.crop_code = p_crop) desc,
    (
      p_stage is not null
      and cardinality(coalesce(e.applies_to_stages, '{}'::public.crop_stage[])) > 0
      and p_stage::public.crop_stage = any (e.applies_to_stages)
    ) desc,
    (
      p_district is not null
      and cardinality(coalesce(e.evidence_districts, '{}'::text[])) > 0
      and p_district = any (coalesce(e.evidence_districts, '{}'::text[]))
    ) desc,
    case e.evidence_tier when 'verified' then 3 when 'supplementary' then 2 else 1 end desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, text, integer, text) is
  'Published, non-withdrawn, source-labelled knowledge only. Crop match ranks first, then stage applicability, explicit district applicability, evidence tier and text score. Excludes rows whose evidence is not published and returns licence/publisher freshness metadata.';

revoke execute on function public.ai_knowledge_search(text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.ai_knowledge_search(text, text, text, integer, text)
  to service_role;

-- The ranked feed is the serving surface for canonical recommendations. Keep
-- its existing mute/suppression behavior, but hide a knowledge recommendation
-- when its exact entry version is no longer trusted. Other recommendation
-- sources (weather, advisories, forecast risks) keep their own evidence gates.
create or replace function public.intelligence_recommendation_feed(p_limit integer default 20)
returns table (
  recommendation_id uuid,
  crop_id           uuid,
  crop_code         text,
  kind              text,
  title             text,
  title_ur          text,
  body              text,
  body_ur           text,
  source            public.recommendation_source,
  source_label      text,
  source_url        text,
  evidence_tier     text,
  confidence        numeric,
  priority          integer,
  score             numeric,
  components        jsonb,
  reason_code       text,
  reason_context    jsonb,
  rule_version      integer,
  valid_until       timestamptz,
  created_at        timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select public.current_farmer_id() as farmer_id
  ),
  muted as (
    select coalesce(array_agg(distinct muted_value order by muted_value), '{}'::text[]) as kinds
      from public.farmer_preferences p
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(p.value->'muted_kinds') = 'array'
          then p.value->'muted_kinds'
          else '[]'::jsonb
        end
      ) muted_value
     where p.farmer_id = (select farmer_id from mine)
       and p.key = 'recommendations'
  ),
  suppressed as (
    select
      coalesce(array_agg(distinct split_part(i.topic, ':', 2))
        filter (where i.topic like 'crop:%'), '{}'::text[]) as crops,
      coalesce(array_agg(distinct split_part(i.topic, ':', 2))
        filter (where i.topic like 'topic:%'), '{}'::text[]) as topics
      from public.farmer_interests i
     where i.farmer_id = (select farmer_id from mine)
       and i.source = 'explicit'
       and i.dismissed_at is not null
  )
  select b.*
    from public.intelligence_recommendation_feed_base(50) b
   where b.kind <> all(coalesce((select kinds from muted), '{}'::text[]))
     and (
       b.source <> 'knowledge_base'::public.recommendation_source
       or exists (
         select 1
           from public.recommendations r
           join public.agri_knowledge_entries e
             on e.slug = r.source_ref
            and e.version = r.knowledge_version
           left join public.agri_evidence_items ev on ev.id = e.evidence_item_id
           join public.agri_knowledge_sources s
             on s.code = coalesce(ev.source_code, e.source_code)
          where r.id = b.recommendation_id
            and e.is_published
            and e.withdrawn_at is null
            and s.permission_status in ('granted', 'not_required')
            and s.license_name is not null
            and (e.evidence_item_id is null or ev.status = 'published')
            and (ev.valid_until is null or ev.valid_until > now())
            and (
              e.evidence_tier <> 'verified'
              or (
                ev.id is not null
                and ev.status = 'published'
                and ev.reviewer_id is not null
                and ev.valid_until is not null
              )
            )
       )
     )
     and not (
       coalesce(b.crop_code, '') = any(
         coalesce((select crops from suppressed), '{}'::text[])
       )
       or coalesce(b.kind, '') = any(
         coalesce((select topics from suppressed), '{}'::text[])
       )
       or coalesce(b.reason_context->>'topic', '') = any(
         coalesce((select topics from suppressed), '{}'::text[])
       )
     )
   order by b.score desc, b.priority, b.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

comment on function public.intelligence_recommendation_feed(integer) is
  'Ranks canonical recommendations, then removes explicitly muted types, explicitly suppressed crops/topics, and knowledge recommendations whose source permission or evidence dossier is not trusted.';

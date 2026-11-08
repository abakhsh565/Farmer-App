-- Phase 3 · retrieval relevance correction
--
-- The first broad-OR query treated every English function word as evidence, so
-- "Who won the cricket match?" matched entries merely because they contained
-- "the" or "in". This correction strips a bounded English stopword list before
-- building the broad query. The strict query uses the same content terms, which
-- keeps a phrase such as "pink bollworm cotton" precise while still allowing a
-- natural question to fall back to OR terms.
--
-- `NULLS LAST` is also deliberate: a crop-less entry has a NULL crop-bonus
-- expression, and PostgreSQL's DESC default puts NULLs first. That made general
-- safety entries outrank the selected crop.

create or replace function public.ai_knowledge_search(
  p_query    text,
  p_crop     text default null,
  p_district text default null,
  p_limit    integer default 4
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
  ),
  q as (
    select
      websearch_to_tsquery('simple', nullif(btrim(content.terms), '')) as strict,
      websearch_to_tsquery(
        'simple',
        nullif(regexp_replace(btrim(content.terms), '[[:space:]]+', ' OR ', 'g'), '')
      ) as broad
      from content
  ),
  documents as (
    select e.*,
           to_tsvector(
             'simple',
             coalesce(e.title_en, '') || ' ' || coalesce(e.title_ur, '') || ' ' ||
             coalesce(e.body_en, '') || ' ' || coalesce(e.body_ur, '') || ' ' ||
             coalesce(e.topic, '') || ' ' || coalesce(e.problem_type, '') || ' ' ||
             coalesce(array_to_string(e.symptoms, ' '), '') || ' ' || coalesce(e.slug, '')
           ) as document
      from public.agri_knowledge_entries e
     where e.is_published
  )
  select
    e.id, e.slug, e.version, e.title_en, e.title_ur, e.body_en, e.body_ur,
    e.topic, e.problem_type, e.symptoms, e.regions, e.crop_code, e.provenance,
    e.evidence_tier, e.source_code, s.name, e.source_url,
    e.source_published_on, e.source_updated_on, e.source_accessed_on,
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
      or e.title_en ilike '%' || left(btrim(p_query), 80) || '%'
      or e.title_ur ilike '%' || left(btrim(p_query), 80) || '%'
      or e.slug ilike '%' || left(btrim(p_query), 80) || '%'
    )
  order by
    (p_crop is not null and e.crop_code = p_crop) desc nulls last,
    case e.evidence_tier when 'verified' then 3 when 'supplementary' then 2 else 1 end desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, text, integer) is
  'Published, source-labelled knowledge only. Natural-language stopwords are excluded before the bounded OR fallback; selected-crop matches rank first with NULLS LAST.';

revoke execute on function public.ai_knowledge_search(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.ai_knowledge_search(text, text, text, integer)
  to service_role;
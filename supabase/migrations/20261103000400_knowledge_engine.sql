-- Phase 3 · Agricultural Knowledge Engine
--
-- The existing knowledge tables already had authored bilingual entries,
-- versioning, provenance and a keyword search RPC. This migration adds the
-- parts a source-grounded assistant still lacked:
--
--   * a source registry with a checkable publisher/reference and date fields;
--   * explicit evidence tiers, so supplementary editorial notes and community
--     observations can never be mistaken for official guidance;
--   * crop/problem/symptom/region classification for deterministic retrieval;
--   * a retrieval RPC that handles natural-language questions, searches Urdu
--     content, and returns the source metadata the UI must show.
--
-- No vector column is populated and no embedding provider is called. Keyword
-- retrieval is the implemented path and remains disclosed.

-- ---------------------------------------------------------------------------
-- Source registry
-- ---------------------------------------------------------------------------

create table public.agri_knowledge_sources (
  code                text primary key,
  name                text not null,
  publisher           text,
  url                 text check (url is null or url ~ '^https://'),
  source_type         text not null check (source_type in (
                        'official_extension', 'regulator', 'university',
                        'supplementary', 'editorial', 'community'
                      )),
  coverage            text,
  verification_status text not null default 'candidate' check (verification_status in (
                        'verified', 'supplementary', 'community', 'candidate'
                      )),
  reviewed_at         timestamptz,
  notes               text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

comment on table public.agri_knowledge_sources is
  'The publishers behind published knowledge. A URL is recorded only when it was checked; an empty URL is an honest unknown, not a claim that no source exists.';

insert into public.agri_knowledge_sources
  (code, name, publisher, url, source_type, coverage, verification_status, reviewed_at, notes)
values
  (
    'app_editorial',
    'Farmer App editorial notes',
    'Farmer App',
    null,
    'editorial',
    'Punjab field crops; supplementary summaries',
    'supplementary',
    now(),
    'Seeded editorial summaries. They are useful context but are not official guidance; primary extension references are pending.'
  ),
  (
    'punjab_agri',
    'Punjab Agriculture Department',
    'Agriculture Department, Government of the Punjab',
    'https://agripunjab.gov.pk/pw_economic',
    'official_extension',
    'Punjab; pest economic thresholds and crop advisory material',
    'verified',
    now(),
    'Official Punjab Government page checked 2026-11-03. It publishes economic threshold levels by pest.'
  ),
  (
    'uaf',
    'University of Agriculture Faisalabad',
    'University of Agriculture, Faisalabad',
    'https://uaf.edu.pk/',
    'university',
    'Punjab; agronomy and crop protection research',
    'candidate',
    null,
    'Institution is credible; no specific publication is cited until a checkable paper or extension note is selected.'
  ),
  (
    'dpp',
    'Department of Plant Protection',
    'Government of Pakistan',
    null,
    'regulator',
    'Pakistan; pesticide registration and label requirements',
    'candidate',
    null,
    'Authoritative for pesticide registration, but no stable public reference was confirmed from this environment. Never treat a product name as approval without a label check.'
  ),
  (
    'cabi_plantwise',
    'CABI PlantwisePlus Knowledge Bank',
    'CABI',
    'https://plantwiseplusknowledgebank.org/',
    'supplementary',
    'Global; pest and disease factsheets, including Pakistan crops',
    'candidate',
    null,
    'Supplementary reference only. CABI material is not a substitute for a Pakistan label or a local extension recommendation.'
  )
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Classification and source attachment on the existing entries
-- ---------------------------------------------------------------------------

alter table public.agri_knowledge_entries
  add column if not exists problem_type text not null default 'other',
  add column if not exists symptoms text[] not null default '{}'::text[],
  add column if not exists regions text[] not null default '{Punjab}'::text[],
  add column if not exists source_code text references public.agri_knowledge_sources (code),
  add column if not exists source_url text,
  add column if not exists source_published_on date,
  add column if not exists source_updated_on date,
  add column if not exists source_accessed_on date,
  add column if not exists evidence_tier text not null default 'supplementary';

alter table public.agri_knowledge_entries
  add constraint agri_knowledge_problem_type_check
    check (problem_type in ('pest', 'disease', 'weed', 'disorder', 'agronomy', 'safety', 'nutrition', 'water', 'other')),
  add constraint agri_knowledge_evidence_tier_check
    check (evidence_tier in ('verified', 'supplementary', 'community')),
  add constraint agri_knowledge_verified_has_source
    check (
      evidence_tier <> 'verified'
      or (source_code is not null and source_url is not null and source_accessed_on is not null)
    ),
  add constraint agri_knowledge_source_url_https
    check (source_url is null or source_url ~ '^https://');

comment on column public.agri_knowledge_entries.evidence_tier is
  'verified = checked against a named primary source; supplementary = useful editorial context; community = an observation, never official guidance.';
comment on column public.agri_knowledge_entries.regions is
  'Geographic applicability. Punjab is the default for this corpus; an empty array means the author did not state a region.';

update public.agri_knowledge_entries
   set problem_type = case topic
     when 'pest' then 'pest'
     when 'disease' then 'disease'
     when 'weed' then 'weed'
     when 'safety' then 'safety'
     when 'nutrition' then 'nutrition'
     when 'irrigation' then 'water'
     when 'agronomy' then 'agronomy'
     else 'other'
   end,
       source_code = coalesce(source_code, 'app_editorial'),
       source_accessed_on = coalesce(source_accessed_on, current_date),
       regions = case when cardinality(regions) = 0 then '{Punjab}'::text[] else regions end
 where true;

update public.agri_knowledge_entries
   set symptoms = case slug
     when 'cotton-pink-bollworm' then '{holes in bolls, rosette flowers, pink larvae inside bolls}'::text[]
     when 'cotton-whitefly' then '{white insects under leaves, honeydew, sooty mould}'::text[]
     when 'wheat-yellow-rust' then '{yellow stripes on leaves, powdery yellow spores}'::text[]
     when 'irrigation-timing' then '{dry soil, wilting at crown root initiation}'::text[]
     else symptoms
   end
 where slug in ('cotton-pink-bollworm', 'cotton-whitefly', 'wheat-yellow-rust', 'irrigation-timing');

update public.agri_knowledge_entries
   set provenance = 'Farmer App editorial summary; primary extension source pending'
 where source_code = 'app_editorial'
   and provenance = 'Extension bulletin, reviewed';

-- One checked primary-source entry demonstrates the verified tier without
-- upgrading the seven editorial summaries by assertion. The threshold is taken
-- from the Punjab Agriculture Department's published economic-threshold page.
insert into public.agri_knowledge_entries (
  slug, version, title_en, title_ur, body_en, body_ur, body_local,
  crop_code, topic, provenance, is_published, problem_type, symptoms, regions,
  source_code, source_url, source_accessed_on, evidence_tier
)
values (
  'cotton-pink-bollworm-etl', 1,
  'Pink bollworm economic threshold',
  'گلابی سنڈی کی معاشی حد',
  'Punjab Agriculture Department guidance puts the economic threshold for pink bollworm at 5 larvae per 100 bolls. Count larvae inside bolls before deciding to spray; do not spray on a calendar alone.',
  'محکمہ زراعت پنجاب کی رہنمائی کے مطابق گلابی سنڈی کی معاشی حد 100 ڈوڈوں میں 5 سنڈیاں ہیں۔ سپرے کا فیصلہ کرنے سے پہلے ڈوڈوں کے اندر سنڈیاں گنیں؛ صرف کیلنڈر پر سپرے نہ کریں۔',
  '{}'::jsonb,
  'cotton', 'pest',
  'Punjab Agriculture Department, Economic Threshold Levels of Insect Pests (accessed 2026-11-03)',
  true, 'pest',
  '{holes in bolls, pink larvae inside bolls}',
  '{Punjab}',
  'punjab_agri', 'https://agripunjab.gov.pk/pw_economic', current_date, 'verified'
)
on conflict (slug, version) do nothing;

insert into public.agri_knowledge_index (entry_id, crop_code, content)
select e.id, e.crop_code,
       e.title_en || ' ' || e.body_en || ' ' || e.title_ur || ' ' || e.body_ur || ' ' || array_to_string(e.symptoms, ' ')
  from public.agri_knowledge_entries e
 where e.is_published
   and not exists (select 1 from public.agri_knowledge_index i where i.entry_id = e.id);

-- ---------------------------------------------------------------------------
-- Retrieval
-- ---------------------------------------------------------------------------

-- The previous function required every term in a websearch query to match.
-- "How do I control pink bollworm in cotton?" therefore retrieved nothing even
-- though the corpus covered it. The replacement keeps the strict query first,
-- then broadens to OR terms only when needed. Ranking still prefers crop match,
-- verified sources and the strict hit.
drop function if exists public.ai_knowledge_search(text, text, integer);

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
  with q as (
    select
      websearch_to_tsquery('simple', left(coalesce(nullif(btrim(p_query), ''), 'crop'), 500)) as strict,
      websearch_to_tsquery(
        'simple',
        regexp_replace(left(coalesce(nullif(btrim(p_query), ''), 'crop'), 500), '[[:space:]]+', ' OR ', 'g')
      ) as broad
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
    (p_crop is not null and e.crop_code = p_crop) desc,
    case e.evidence_tier when 'verified' then 3 when 'supplementary' then 2 else 1 end desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, text, integer) is
  'Published, source-labelled knowledge only. Strict full-text match first, then a bounded OR fallback for natural-language questions; crop match and evidence tier rank above raw score.';

revoke execute on function public.ai_knowledge_search(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.ai_knowledge_search(text, text, text, integer)
  to service_role;

alter table public.agri_knowledge_sources enable row level security;
revoke all on public.agri_knowledge_sources from anon, authenticated;
grant select on public.agri_knowledge_sources to service_role;

comment on table public.agri_knowledge_sources is
  'Source registry used by the AI gateway. The gateway alone reads it; clients receive only the labelled citation fields in an answer.';
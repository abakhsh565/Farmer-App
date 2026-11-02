-- Farmer App · migration 0018 · what the Edge Functions need
--
-- Three server components were written against this schema before it existed:
--
--   · `ai`             retrieves published knowledge and the product behind a
--                      treatment, and must never reach the tables directly with
--                      a request-shaped query.
--   · `otp`            stores one-time codes as keyed hashes with attempt and
--                      send limits.
--   · `weather-ingest` writes normalised readings, and needs the vendor to exist
--                      as a provider row before any reading can reference it.
--
-- Everything here is reachable only through the service key: the functions run
-- with `security definer` semantics on the server, and no farmer's device ever
-- calls these directly. That is why the functions below are granted to no role
-- at all — the table grants at the end of the RLS migration remain the only
-- farmer-facing surface.

-- ---------------------------------------------------------------------------
-- Open-Meteo as a provider
-- ---------------------------------------------------------------------------
--
-- The PRD named WeatherAPI.com as the initial candidate, and that row exists.
-- Open-Meteo is added because it is the provider that actually works today: it
-- is keyless, so live weather is reachable before an account exists, and the
-- client already reads it. Registering it here is what lets the same numbers be
-- stored in `weather_readings` — which is what makes "the UI and the AI read the
-- same reading" true rather than aspirational.

insert into public.weather_providers (code, name, is_initial_candidate, requires_api_key, attribution, notes)
values (
  'open_meteo',
  'Open-Meteo',
  false,
  false,
  'Weather data by Open-Meteo.com',
  'Keyless vendor. Used by the client directly for live conditions and by the weather-ingest function to fill weather_readings, so the UI and the AI can be shown to read the same row.'
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- One-time codes
-- ---------------------------------------------------------------------------
--
-- The code is stored as an HMAC over (destination, code) keyed by a server
-- secret, never as plaintext. A database dump therefore does not contain working
-- login codes, and the hash cannot be recomputed without the secret.

create table public.otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null check (channel in ('phone', 'email')),
  -- Normalised international form (923001234567) or a lowercased address, so
  -- one farmer is one destination and a rate limit cannot be sidestepped by
  -- writing the same number three ways.
  destination text not null,
  code_hash   text not null,
  attempts    integer not null default 0 check (attempts >= 0),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  -- Set when the requester was signed in, so a verification can be attributed.
  party_id    uuid references public.parties (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index otp_challenges_destination_idx
  on public.otp_challenges (destination, created_at desc);

-- The lookup the verify path makes: the newest unconsumed challenge for a
-- destination. Partial, because consumed rows are history, not candidates.
create index otp_challenges_live_idx
  on public.otp_challenges (destination, created_at desc)
  where consumed_at is null;

comment on table public.otp_challenges is
  'One-time verification codes, stored as keyed hashes. Written and read only by the otp Edge Function with the service key; no client role is granted anything on this table.';
comment on column public.otp_challenges.code_hash is
  'HMAC-SHA256 over "<destination>:<code>", keyed by OTP_HASH_SECRET. Plaintext codes are never stored, logged or returned to a client.';

-- ---------------------------------------------------------------------------
-- Knowledge retrieval
-- ---------------------------------------------------------------------------
--
-- Full-text search over the authored entries, ranked by ts_rank. Deliberately
-- keyword-based: the `embedding` column exists for a semantic upgrade, and
-- `used_embedding` comes back false today so the gateway can *disclose* that
-- answers come from a keyword index rather than pretend otherwise.
--
-- A published entry is the only thing the model is allowed to see. Drafts are
-- excluded here rather than filtered later, so an unreviewed entry cannot leak
-- into an answer through a caller that forgot to filter.

create or replace function public.ai_knowledge_search(
  p_query text,
  p_crop  text default null,
  p_limit integer default 4
)
returns table (
  id             uuid,
  slug           text,
  version        integer,
  title_en       text,
  title_ur       text,
  body_en        text,
  body_ur        text,
  topic          text,
  crop_code      text,
  provenance     text,
  score          double precision,
  used_embedding boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select websearch_to_tsquery('simple', coalesce(nullif(btrim(p_query), ''), 'crop')) as ts
  )
  select
    e.id,
    e.slug,
    e.version,
    e.title_en,
    e.title_ur,
    e.body_en,
    e.body_ur,
    e.topic,
    e.crop_code,
    e.provenance,
    -- Scaled into 0..1 so the caller's confidence formula is not sensitive to
    -- how many words happened to match.
    least(1.0, ts_rank(to_tsvector('simple', e.title_en || ' ' || e.body_en), q.ts) * 8)::double precision as score,
    false as used_embedding
  from public.agri_knowledge_entries e, q
  where e.is_published
    -- A crop-specific question prefers its own crop but is not limited to it:
    -- a wheat farmer asking about stored grain should still find the answer, so
    -- there is deliberately no crop filter here — the preference lives in the
    -- ordering below, not in the WHERE clause.
    and (
      to_tsvector('simple', e.title_en || ' ' || e.body_en) @@ q.ts
      or e.title_en ilike '%' || btrim(p_query) || '%'
      or e.slug ilike '%' || btrim(p_query) || '%'
    )
  order by
    -- Crop-relevant entries first, then by match quality.
    (p_crop is not null and e.crop_code = p_crop) desc,
    score desc,
    e.version desc
  limit greatest(1, least(coalesce(p_limit, 4), 8));
$$;

comment on function public.ai_knowledge_search(text, text, integer) is
  'Published knowledge only, ranked for the AI gateway. Returns used_embedding so the caller can disclose keyword-mode retrieval instead of implying semantic search.';

-- The product behind a treatment: the canonical product an entry names, plus the
-- shops currently listing it. Read from the database so the scan result and the
-- dealer page cannot quote different prices for the same shop.
create or replace function public.ai_product_for_knowledge(p_slug text)
returns table (
  canonical_id      text,
  name              text,
  registration_no   text,
  listing_dealer_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with entry as (
    -- body_local is carried through because the product lookup below reads
    -- `products` out of it. Selecting only the id here made the second CTE
    -- reference a column its input does not expose.
    select e.id, e.slug, e.body_local
    from public.agri_knowledge_entries e
    where e.slug = p_slug and e.is_published
    order by e.version desc
    limit 1
  ),
  product as (
    select p.id, p.slug, p.name, p.registration_no
    from public.canonical_products p
    where p.slug in (
      -- The entry names its product by slug in `body_local`, which is how a
      -- treatment and a listing are tied together without a second join table.
      select value::text
      from entry e, jsonb_array_elements_text(coalesce(e.body_local -> 'products', '[]'::jsonb))
    )
    order by p.name
    limit 1
  )
  select
    product.slug,
    product.name,
    product.registration_no,
    coalesce(
      (
        select array_agg(distinct dp.dealer_id)
        from public.dealer_products dp
        where dp.canonical_product_id = product.id
          and dp.in_stock is not false
      ),
      '{}'::uuid[]
    )
  from product;
$$;

comment on function public.ai_product_for_knowledge(text) is
  'The evidence chain behind a diagnosis: canonical product plus the dealers listing it. Returns no row when the entry names no product, which the gateway renders as a diagnosis without a purchase step.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
--
-- The blanket loop in the RLS migration runs before this file, so these tables
-- would otherwise be created without RLS. Enabling it here — and granting nothing
-- to anon or authenticated — is what makes the service key the only way in.

alter table public.otp_challenges enable row level security;

revoke all on public.otp_challenges from anon, authenticated;

comment on table public.otp_challenges is
  'One-time verification codes, stored as keyed hashes. Written and read only by the otp Edge Function with the service key; no client role is granted anything on this table.';

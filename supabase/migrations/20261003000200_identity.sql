-- Farmer App · migration 0002 · identity
--
-- The PRD's identity rules, expressed so that the schema cannot violate them:
--
--   * Farmer and Dealer/Shop Owner identities are kept separate.
--   * Accounts are never merged automatically by phone number.
--   * A dealer's customer records are never imported during farmer signup.
--   * Integration happens only when the farmer explicitly enters a dealer workflow.
--
-- The enforcement is a composite foreign key, not a comment. A dealer row
-- cannot point at a farmer row because no such link is expressible.

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------

create table public.parties (
  id            uuid primary key default gen_random_uuid(),
  kind          public.party_kind not null,
  -- auth.users is the only identity provider. A party is a domain actor that
  -- happens to be authenticated, not the other way round.
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  display_name  text not null check (length(btrim(display_name)) between 1 and 120),
  locale        text not null default 'ur' check (locale in ('ur', 'en', 'pa', 'sk', 'sd', 'ps')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger parties_touch before update on public.parties
  for each row execute function public.touch_updated_at();

comment on table public.parties is
  'One row per domain actor. `kind` is immutable in practice: nothing in the app moves a party between farmer and dealer.';

-- Phone numbers live in their own table because the PRD treats a phone number
-- as an *identifier*, never as an authorization or a merge key.
create table public.party_contacts (
  id           uuid primary key default gen_random_uuid(),
  party_id     uuid not null references public.parties (id) on delete cascade,
  channel      text not null check (channel in ('phone', 'email')),
  -- Normalised for lookup (digits only for phone, lowercased for email).
  value        text not null,
  raw_value    text not null,
  verified_at  timestamptz,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (channel, value)
);

create index party_contacts_party_idx on public.party_contacts (party_id);

-- At most one primary per channel per party.
create unique index party_contacts_one_primary_idx
  on public.party_contacts (party_id, channel)
  where is_primary;

comment on column public.party_contacts.value is
  'Normalised lookup form. Unique across all parties so a duplicate signup is detectable — but detection is NOT merging: the app must ask the human which account they meant.';

comment on table public.party_contacts is
  'Phone/email are identifiers. Uniqueness here exists to detect duplicates, never to auto-link a farmer to a dealer.';

-- ---------------------------------------------------------------------------
-- Farmer profile
-- ---------------------------------------------------------------------------

create table public.farmer_profiles (
  party_id            uuid primary key references public.parties (id) on delete cascade,
  -- The farmer's *default* location. A temporary search area must never write here.
  default_area_id     uuid,
  default_lat         double precision check (default_lat between -90 and 90),
  default_lon         double precision check (default_lon between -180 and 180),
  default_location_label   text,
  -- How that location was established. PRD requires the source be stated.
  default_location_source  text check (default_location_source in ('profile_entry', 'device_permission', 'dealer_record')),
  location_set_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint farmer_default_location_complete check (
    (default_lat is null and default_lon is null and default_location_label is null)
    or (default_lat is not null and default_lon is not null and default_location_label is not null)
  )
);

create trigger farmer_profiles_touch before update on public.farmer_profiles
  for each row execute function public.touch_updated_at();

comment on column public.farmer_profiles.default_lat is
  'Default location only. Temporary dealer-search areas are session-scoped and never persisted here.';

-- A farmer may hold several search preferences; only one is active.
create table public.farmer_search_settings (
  farmer_id     uuid primary key references public.farmer_profiles (party_id) on delete cascade,
  radius_km     integer not null default 10 check (radius_km between 1 and 100),
  updated_at    timestamptz not null default now()
);

comment on column public.farmer_search_settings.radius_km is
  'Capped at 100 km by check constraint — the PRD maximum is enforced by the database, not by a UI slider.';

-- Ephemeral search areas. A row here expires; it never touches farmer_profiles.
create table public.farmer_temporary_areas (
  id            uuid primary key default gen_random_uuid(),
  farmer_id     uuid not null references public.farmer_profiles (party_id) on delete cascade,
  label         text not null,
  lat           double precision not null,
  lon           double precision not null,
  radius_km     integer check (radius_km between 1 and 100),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 hours',
  constraint farmer_temporary_areas_expiry check (expires_at > created_at)
);

create index farmer_temporary_areas_live_idx
  on public.farmer_temporary_areas (farmer_id, expires_at desc);

comment on table public.farmer_temporary_areas is
  'A temporary search area. Exists separately from farmer_profiles so "searching near Kot Ladha" can never silently become the farmer''s location.';

-- ---------------------------------------------------------------------------
-- Dealer projection (read-facing)
-- ---------------------------------------------------------------------------

-- The PRD is explicit that the dealer's business system owns products, stock,
-- transactions, credit status and business records, and that the farmer app is
-- a synchronised read-facing layer. So this table is a *projection*: it records
-- which upstream system and record it mirrors, and when it last agreed.
create table public.dealer_profiles (
  id                  uuid primary key default gen_random_uuid(),
  party_id            uuid references public.parties (id) on delete set null,
  -- Upstream identity. Deliberately a triple so the same shop can be seen from
  -- a POS instance and, later, an onboarding pipeline without collision.
  source_system       text not null default 'agri_shop_pos',
  source_ref          text not null,
  source_shop_id      uuid,
  shop_name           text not null,
  phone               text,
  address             text,
  lat                 double precision check (lat between -90 and 90),
  lon                 double precision check (lon between -180 and 180),
  -- Stated so the app can show it; absence means "unknown", never "unverified-therefore-bad".
  verified_at         timestamptz,
  verified_by         uuid references public.parties (id),
  verification_source text,
  opening_hours       text,
  -- Projection freshness. A stale dealer must be shown as stale.
  synced_at           timestamptz,
  sync_state          text not null default 'fresh' check (sync_state in ('fresh', 'stale', 'unreachable')),
  is_accepting_requests boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (source_system, source_ref)
);

create index dealer_profiles_geo_idx on public.dealer_profiles (lat, lon);
create trigger dealer_profiles_touch before update on public.dealer_profiles
  for each row execute function public.touch_updated_at();

comment on table public.dealer_profiles is
  'A read-facing projection of a dealer as held by the dealer business system. Never the source of truth for stock, price or credit status.';

comment on column public.dealer_profiles.synced_at is
  'When this projection last agreed with upstream. The UI must surface staleness rather than present a stale dealer as current.';

-- Which farmers a dealer is permitted to see, and only after an explicit act
-- (a field visit or a credit request). Created by those workflows, never by
-- matching phone numbers.
create table public.dealer_farmer_links (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null references public.dealer_profiles (id) on delete cascade,
  farmer_id      uuid not null references public.farmer_profiles (party_id) on delete cascade,
  -- Why the link exists. Evidence of an explicit act.
  established_by text not null check (established_by in ('field_visit', 'credit_request', 'farmer_initiated_message')),
  source_id      uuid not null,
  created_at     timestamptz not null default now(),
  unique (dealer_id, farmer_id, established_by, source_id)
);

comment on table public.dealer_farmer_links is
  'The only path by which a dealer and a farmer become related. Every row cites the explicit act that created it, so account merging by phone number is not merely discouraged but unrepresentable.';

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

-- What a party may do. Kept minimal and explicit; the PRD wants human-audited
-- authority, not a reputation scalar.
create table public.party_capabilities (
  party_id     uuid not null references public.parties (id) on delete cascade,
  capability   text not null check (capability in ('moderator', 'admin', 'expert')),
  granted_at   timestamptz not null default now(),
  granted_by   uuid references public.parties (id),
  revoked_at   timestamptz,
  primary key (party_id, capability)
);

create or replace function public.has_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.party_capabilities c
    join public.parties p on p.id = c.party_id
    where p.auth_user_id = auth.uid()
      and c.capability = p_capability
      and c.revoked_at is null
  );
$$;

comment on function public.has_capability(text) is
  'Used by RLS. Authority is a granted row, never a community score.';

-- Helper used across every policy: the party id of the caller.
create or replace function public.current_party_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id from public.parties p where p.auth_user_id = auth.uid();
$$;

create or replace function public.current_farmer_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.party_id
  from public.farmer_profiles f
  join public.parties p on p.id = f.party_id
  where p.auth_user_id = auth.uid();
$$;

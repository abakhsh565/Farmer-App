-- Farmer App · migration 0028 · keep the received advisory, not only the parsed row
--
-- Step 1 asks each importer to store raw *and* normalised rows. Three of the four
-- sources already do: `market_observations`, `climate_observations` and
-- `climate_forecasts` each keep the payload as received. `agri_advisories` kept
-- only the parsed result, so every normalisation decision — a topic coerced to
-- `other`, a summary cut at the column's limit, a date reinterpreted, a crop code
-- that failed the catalogue check — was unrecoverable the moment the row was
-- written. That is precisely the failure mode the raw copy exists to prevent.
--
-- Existing rows keep the default rather than a reconstruction: an invented
-- "original" is worse than an absent one, because it would be indistinguishable
-- from a real payload and could be trusted.

alter table public.agri_advisories
  add column if not exists raw jsonb not null default '{}'::jsonb;

comment on column public.agri_advisories.raw is
  'The advisory exactly as received (CSV cells or feed record), so a normalisation mistake stays debuggable and the original is never lost. Empty for rows imported before this column existed — deliberately, rather than a reconstruction.';

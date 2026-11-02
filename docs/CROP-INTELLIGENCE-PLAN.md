# Crop Intelligence & Next-Crop — reuse, gaps, sources, design, plan

## 1. Existing-backend reuse and gap analysis
- Reuse: `dealers_within_radius` PostGIS pattern (geography, GiST, ST_DWithin); `market_observations` + `market_rates` (36h honesty window); `weather_readings` + `latest_weather`/`weather_is_usable` (Open-Meteo keyless ingest); `crop_catalog`/`crop_instances`/facts-vs-inferences; `recommendations` + `farmer_insight_feed` (canonical advice — NOT duplicated); `community_posts` idempotency + soft-delete; `expert_verifications` badge gate; `intel` migration `20261014000000` adds the missing geo observation layer.
- Gaps closed by this slice: no observation table with geography; `farmer_insight_feed` had no radius/crop/evidence filters; no advisory regional fallback; no source registry. Still missing: historical yield/price depth for predictions; AMIS/advisory automated APIs (manual CSV path instead).

## 2. Pakistan data-source inventory (researched 2026-10-14, free-first)
| Source | URL / docs | Access | License / commercial | Status |
|---|---|---|---|---|
| PBS agriculture statistics | https://www.pbs.gov.pk/agriculture-sector-of-pakistan-importance-role-key-statistics/ + dissemination policy | PDFs, dashboard | Aggregate normally free w/ attribution, confirm per-product tier | manual_import |
| National Accounts crops dashboard (121 crops, district) | https://na.data.gov.pk/crops/home | Browser dashboard, no API found | Unconfirmed | manual_import |
| Punjab CRS estimates | https://agripunjab.gov.pk/crs-services, /crs-crop-estimates | Pages (cert blocked scraper) | Unconfirmed | needs_permission |
| AMIS Punjab rates | http://www.amis.pk/ | Pages only, no API docs | Unconfirmed, seek permission, no scraping | needs_permission |
| Punjab crop advisories | https://agripunjab.gov.pk/crop_advisory | Page/doc (unreachable in research) | Unconfirmed | needs_permission |
| Open-Meteo forecast/history | https://open-meteo.com/en/docs | REST, keyless | CC BY 4.0 data BUT free API non-commercial only (10k/d) | needs_permission (paid plan for prod) |
| NASA POWER agroclimatology | https://power.larc.nasa.gov/docs/services/api/ | REST point/regional | CC BY 4.0, no fixed limit (429 + max ~5 concurrent) | verified_api |
| SoilGrids 250m | https://rest.isric.org/soilgrids/v2.0/docs | REST PAUSED, use WCS/WebDAV/GEE | CC BY 4.0 maps, 5/min fair use when up | unavailable (REST) |
| Platform farmer/expert reports | own DB (`submit_crop_report`) | platform | platform terms | verified_api |

Rule: visible online ≠ API ≠ permission. `intel_sources` encodes this; nothing invents an endpoint.

## 3. Schema/API + migration impact
- New: `intel_sources`, `crop_reports` (approx geog, evidence, cluster, expiry 21d), `agri_advisories` (regional, nullable geog), `submit_crop_report()` (rounds to 2 decimals, idempotent), `intel_feed(lat,lon,radius_m,crop,topic,limit)` — radius 1..500000m drives ST_DWithin; dedupe verified→newest; expiry at read time; returns distance+area_label, never coords.
- Impact: additive only; no rewrites of recommendations/market/weather/community. RLS: public live-row reads for anon+authenticated; all writes revoked from clients (functions only). Migration-check safe: new tables RLS-enabled, no dangling refs.

## 4. Geographic matching + evidence validation
- Metres internally; lon-first point; GiST partial indexes on published/live rows; exact (non-immutable) expiry kept out of index predicates.
- Evidence: farmer_report (default) / expert_verified (only via grant path) / official_advisory (manual import w/ URL) / forecast_risk (weather models only, never outbreak proof). Radius affects eligibility, never severity. District advisories = fallback labelled advisory, never a point at farmer coords. Privacy: rounded storage + feed returns no lat/lon.

## 5. Historical trends + next-crop methodology (baseline, honest)
- Separate: (a) cultivation patterns, (b) suitability recommendations, (c) price forecasts — never interchangeable.
- Gate first: season/calendar → water → soil → rotation eliminate; then rank survivors by margin scenarios (conservative/central/favourable) + water + price-variance downside + disease evidence + farmer priorities. Weak data → exposed limitation, no false precision.
- Hypothesis test (low price/disease → less planting → supply/price shift): validate on PBS/AMIS history with chronological holdouts, no future leakage, control for policy/weather; report hit-rate vs naive seasonal baseline. NOT encoded as a rule. LLM may explain calculated rows only; prices/yields/costs/eligibility come from traceable rows + recorded snapshot/rule-version/assumptions.

## 5b. Step 1 — what was built, and what only the owner can unblock

Built and verified offline (typecheck, tests, `lint:migrations`, `lint:functions` all green — the checks and their output are in the handover note):

- **Schema.** `20261015000000_dgkhan_intake.sql` — the division's six districts as reference data with headquarters coordinates; `nasa_power` registered in `weather_providers` (it is the history source and was not in the registry); `climate_observations` (one row per provider × district × day, missing days NULL and never zero, re-pulls upsert); `climate_ingestion_runs` and `advisory_import_runs` so a **failed fetch is a recorded row**, not a silent empty table. RLS on all four, writes revoked from clients.
- **`20261015000100_crop_report_intake_guard.sql`** — `submit_crop_report` no longer accepts a client-supplied `p_reporter_id`. The author is the caller's own party (`current_party_id()`), EXECUTE is revoked from `public`/`anon` and granted to `authenticated`. Without this, any holder of the anon key could file a report as another farmer — the one thing a traceable field report cannot allow.
- **`climate-ingest`** — NASA POWER daily district history (keyless, CC BY 4.0, needs no vendor secret), ≤62 days per call, `-999` treated as *not reported* rather than as a value, failures recorded in the run table.
- **`advisory-ingest`** — attempts `ADVISORY_FEED_URL` if one exists, accepts only JSON in a documented shape, and records a failed run with the reason otherwise. It never fabricates a row to fill the gap.
- **`scripts/import-advisories.mjs`** (`npm run import:advisories -- file.csv`) — the durable path while no permitted feed exists: CSV in, rows out with `source_url` provenance, per-line rejections reported, every run logged. Template at `data/advisories-template.csv`.
- **The field-report card on Home** — `src/intel/districts.ts` (nearest-district attribution, refusing to name one beyond 120 km), `src/intel/report.ts` (the SQL's rules, enforced before the round trip; coordinates rounded to the ~1.1 km cell *before* they leave the device), `src/services/intelReports.ts`, `src/components/intel/FieldReportSheet.tsx`. Crop and area, never the exact field; the privacy line says so on the screen.

### What is needed from the owner — four things, none of them code

1. **Apply the two new migrations** (`supabase/migrations/2026101500*.sql`) and re-bundle `apply-all.sql`. Blocks: climate history, advisory rows, field-report intake and the district list. The `supabase/apply-all.sql` bundle has been regenerated, so the paste-into-SQL-editor route works without any credential sharing.
2. **Deploy `climate-ingest` and `advisory-ingest`** alongside the existing functions. NASA POWER needs **no** secret; `ADVISORY_FEED_URL` stays unset until item 3 is answered.
3. **A permission decision on the advisory and market pages.** `agripunjab.gov.pk/crop_advisory` and `amis.pk` are pages, not APIs, and neither publishes terms permitting automated collection. Either (a) request written permission, (b) supply the department's own feed if one exists internally, or (c) accept the CSV import path indefinitely. This is a decision, not a credential — nothing in the codebase will scrape without it.
4. **The service-role key in the environment** for `npm run import:advisories` (never in a file, never in chat). Only needed when the first real advisory import is run.

Decisions taken by the agent, recorded so they can be reversed: the pilot division is **DG Khan** (six districts, including the recently created Taunsa and Kot Addu); history comes from **NASA POWER** rather than the current-conditions vendor; the report card lives **on Home under the watch feed**, because the answer to "nothing verified near you" is a neighbour's report.

## 6. Staged plan + acceptance criteria
- Phase 1 (this slice): migration + `src/intel/geo.ts` + `geo.test.ts`; criteria: 8/10/100/500km eligibility tests, outside-exclusion, expiry/dupe/evidence/privacy/missing-context fallbacks green; migration lint green.
- Phase 2: PBS/AMIS manual-CSV importers + transparent suitability/economic ranker + holdout evaluation of the response hypothesis.
- Phase 3: permitted auto-ingest (NASA POWER first; Open-Meteo paid if commercial; SoilGrids WCS cache), calibration/monitoring, notifications only on severity×confidence×delivery rules.
- Recalc scope: affected region×crop×window only, never all farmers on any write.

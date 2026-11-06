# Phase 9 — Live ingestion runtime, scheduling and operational evidence

Status: **runtime-verified against the staging project only**, including the
admin source-health read under a temporary, audited fixture. This is not a
production deployment and not commercial clearance.

Migrations `20261104002600_source_health_completeness.sql`,
`20261104002700_source_health_inventory.sql`,
`20261104003000_ingestion_run_accounting.sql`,
`20261104003100_ingestion_health_accounting.sql` and
`20261104003200_weather_partial_status.sql`,
`20261104003300_ingestion_run_leases.sql` and
`20261104003400_ingestion_run_lease_role.sql` have been applied to staging
through the existing Management API path. The migration ledger was intentionally
not modified; no production database was touched.

## Guardrails

- Staging project `swmbmtvwgksicfnfsehg`; no production deployment.
- No paid provider plan, no purchased API key and no provider commitment.
- No farmer-facing UI work.
- Existing `pg_cron` jobs were preserved. No second scheduler was introduced.
- The model coefficients and Layyah-only activation were not changed.
- No migration-ledger entry was fabricated and `supabase db push` was not used.

## Executed functions

All five functions were deployed with the gateway JWT and the function-level
`x-ingest-key` check. The calls below were made against the deployed staging
functions, not a local TypeScript harness.

| Function | Provider | Runtime result | Persistence |
| --- | --- | --- | --- |
| `forecast-ingest` | Open-Meteo ECMWF IFS | HTTP 200, 7 days, 0 skipped | 7 live forecast rows; all 7 now carry `source_url` and `provenance` |
| `weather-ingest` | Open-Meteo | HTTP 200, 8 readings per call | 26 weather rows across 3 cells; latest current observation 2026-11-04 20:45 UTC |
| `climate-ingest` | NASA POWER | HTTP 200, 9 days | 9 reanalysis observations, 2026-10-25..2026-11-02 |
| `historical-forecast-ingest` | Open-Meteo Single Runs / ECMWF IFS | HTTP 200, 9 runs, 0 failed | 63 archived forecast rows |
| `soil-ingest` | ISRIC SoilGrids | First call HTTP 502 after a real 20 s timeout; retry HTTP 200, 1 cell / 6 depths | 12 soil rows, 2 districts |
| `soil-ingest` all-district (earlier call) | ISRIC SoilGrids | HTTP 207, 2 cells written, 4 failed | 2 of 6 district headquarters covered |

The SoilGrids all-district response was:

```text
cellsRequested=6 cellsWritten=2 failed=4
missing usable depth values: kot_addu, muzaffargarh, rajanpur, taunsa
```

Those four districts are absent, not backfilled from a neighbouring cell.
SoilGrids is a 250 m model; all soil values are priors, not soil tests.

## Scheduling

Migration `20261104002500_ingestion_scheduler.sql` installs `pg_net`, creates the
dispatch-lock state table and uses the existing `pg_cron` installation.
Migration `20261104002800_environment_safe_ingestion_scheduler.sql` removes the
URL from every cron command and resolves the project URL/ref from Vault.
Migration `20261104002900_scheduler_credential_isolation.sql` additionally binds
the gateway JWT's `ref` claim to the configured project ref.

| Job | Schedule | Function |
| --- | --- | --- |
| `farmer-ingest-weather` | `*/15 * * * *` | `weather-ingest` with `targets=true` |
| `farmer-ingest-forecast` | `5 */3 * * *` | `forecast-ingest`, Layyah, 7 days |
| `farmer-ingest-climate` | `10 3 * * *` | `climate-ingest`, rolling 7 days |
| `farmer-ingest-historical` | `40 3 * * 0` | `historical-forecast-ingest`, rolling 14 days |
| `farmer-ingest-soil` | `20 4 1 * *` | `soil-ingest`, all districts |

`dispatch_ingestion_job()`:

- claims a per-job lock before making an HTTP request;
- resolves `ingestion_project_url` and `ingestion_project_ref` from this
  project's Vault, requires an exact `https://<ref>.supabase.co` pair, and builds
  the function URL from a validated function name;
- requires the gateway JWT's `ref` claim to equal the configured project ref;
- posts through `pg_net` with a 60 s timeout;
- reads the gateway key and ingestion token from Vault at dispatch time;
- records dispatch failure and releases the lock on an exception;
- is executable only by `service_role` (not `anon`, not `authenticated`).

The dispatch state is deliberately **not** a success indicator. Its status can
only be `never`, `dispatched` or `dispatch_failed`; the per-provider run table is
the authority for whether ingestion succeeded.

Scheduler evidence:

- Manual `pg_net` dispatch returned HTTP 200 and created a forecast run with 7
  written rows.
- A real one-minute test cron ran at 20:39 and 20:40 UTC. Both
  `cron.job_run_details` executions succeeded, both HTTP responses were 200, and
  both forecast runs wrote 7 rows.
- The production weather schedule ran at 20:45 and 21:00 UTC. Both executions
  succeeded and both functions returned HTTP 200 with `cellsRequested=0`, which
  is correct for not-yet-due cells.
- The immediate duplicate lock test returned `true` for the first claim and
  `false` for the second while the 90 s lock was live.
- Test cron jobs and test lock rows were removed. Only the five intended
  `farmer-ingest-*` jobs remain.

## Environment-safe scheduler

Migration 028 was applied to staging (HTTP 201). The five cron commands now pass
only a function name; none contains a URL. The Vault pair is staging-specific:
`ingestion_project_url` = `https://swmbmtvwgksicfnfsehg.supabase.co` and
`ingestion_project_ref` = `swmbmtvwgksicfnfsehg`. The dispatcher rejects a
missing pair, an invalid ref, a URL/ref mismatch, an invalid function name, and
a gateway credential whose JWT `ref` belongs to another project. Migration 029
adds that credential binding and was also applied to staging (HTTP 201).

Scheduler runtime evidence (2026-11-04):

- The real 23:00 UTC weather cron succeeded; `pg_net` returned HTTP 200 with
  `cellsRequested=0` (no cell was due), and the dispatch lock was claimed.
- A temporary one-minute forecast cron at 23:04 UTC succeeded; HTTP 200 and
  `climate_ingestion_runs` id 21 finished `ok` with 1 row seen and 1 written.
  The temporary job and its state row were removed.
- The duplicate-dispatch probe returned `false` while the weather lock was
  live.
- Five schedules remain: weather, forecast, climate, historical and soil; all
  use the same five cadences and the dispatcher ACL remains
  `anon=false`, `authenticated=false`, `service_role=true`.

### Production scheduler provisioning

Do not copy staging Vault values into production. Before applying or activating
the scheduler in production:

1. In the production project's Vault, create both environment values:
   - `ingestion_project_url` = `https://<production-project-ref>.supabase.co`
   - `ingestion_project_ref` = `<production-project-ref>`
2. Keep the existing production credentials in Vault only:
   `ingest_gateway_key` must be a project JWT whose `ref` claim matches the
   production ref, and `ingest_token` must be the matching function ingress
   token. Never put either value in a migration, cron command, client bundle or
   log.
3. Apply forward migrations through 029 only after the four Vault values are in
   place. Do not rewrite migration 025, fabricate ledger rows, or use
   `supabase db push`.
4. Verify all five `farmer-ingest-*` commands contain no URL, then run one
   temporary one-minute production dispatch with explicit production approval.
   Inspect `cron.job_run_details`, `net._http_response` and the relevant run
   table, then remove the temporary job and state row.
5. Recheck the tri-binding before activation: URL host = configured ref,
   configured ref = gateway JWT `ref`, and all five jobs still target only their
   named functions. Vault is project-scoped; do not share secrets across
   staging and production.

No paid provider was activated and no production migration or request was made.

## Admin source-health execution

`ingestion_health()` is admin-gated in its function body. It had never been
executed before this QA pass. A temporary staging fixture was created through the
supported identity path: a confirmed `auth.users` row was provisioned by the
`on_auth_user_created` trigger, then its `parties` row received an unrevoked
`party_capabilities` row with `capability='admin'`. No RLS policy, function gate
or privilege was changed. The fixture was deleted after the checks, so staging
has no permanent admin capability.

The first authenticated admin call failed with PostgreSQL `42702`:
`column reference "source_code" is ambiguous`. The cause was unqualified
`source_code` references in the market/soil run subqueries, where the
`RETURNS TABLE` output variable has the same name. The references were qualified,
the migration was bundled, and the corrected function was deployed to staging.
The deployed definition has no unqualified `source_code` reference.

Final authorization results:

| Caller | HTTP | Result |
| --- | --- | --- |
| Temporary admin (`has_capability('admin')=true`) | 200 | Eight source rows returned, including per-provider forecast rows |
| Authenticated farmer with no capability | 403 | `Ingestion health requires admin capability.` |
| Anonymous (`anon` key, no user JWT) | 401 | `permission denied for function ingestion_health` |

There is no employee party kind in this schema (`party_kind` is `farmer`,
`dealer`), so an employee denial could not be exercised without changing the
schema. The authenticated non-admin farmer covers the non-admin path.

Admin source-health output after 026/027 (staging, 2026-11-04):

| Source | Access | Status | Freshness | Last error |
| --- | --- | --- | --- | --- |
| Open-Meteo weather | `needs_permission` | `ok` | `fresh` | — |
| NASA POWER climate | `verified_api` | `ok` | `current` | — |
| Open-Meteo forecast | `needs_permission` | `ok` | `fresh` | — |
| WeatherAPI forecast | `needs_permission` | `never` | `empty` | — |
| AMIS Punjab | `needs_permission` | `never` | `empty` | — |
| Research feed | `unverified` | `never` | `expired` | — |
| Punjab advisory | `needs_permission` | `never` | `empty` | — |
| ISRIC SoilGrids | `verified_api` | `partial` | `current` | `SoilGrids returned no usable depth values.` |

The WeatherAPI row is an optional provider that has never run; it is shown as
`never`, not as a successful configuration. The Open-Meteo `needs_permission`
value is its licensing state, not a successful commercial clearance. The
SoilGrids row reports `partial` with the provider error visible instead of
silently claiming complete coverage.

### Source-health completeness fix

Migration `20261104002600_source_health_completeness.sql` replaces
`ingestion_health()` without changing its signature or admin gate:

- market health starts from the registered `market_sources` inventory and reads
the latest run **per source**, so a later `research_feed` run can no longer hide
AMIS Punjab;
- advisory health starts from `intel_sources`, so `punjab_advisory` appears as
`never` with its `needs_permission` access state instead of disappearing;
- every branch carries the latest provider `last_error` in `detail`, including
weather, climate, forecast, market, advisory and soil;
- never-run sources return `last_status='never'`, zero written rows and an
`empty` freshness value rather than a false success.

Applied to staging through the Management API: HTTP 201, stored function body
matches the migration file hash, `anon` execute is false and `authenticated`
execute is true. Runtime fixtures proved the market branch keeps the latest run
per source: AMIS returned its newer `ok` run while `research_feed` returned its
newer `failed` run, and advisory returned `partial` with its provider error. All
six `last_error` branches were exercised and the fixtures were deleted.

### Source-health inventory for every ingestion source

Migration `20261104002700_source_health_inventory.sql` closes the remaining
fresh-deployment gap. Weather, climate, forecast and soil health now start from
`intel_sources` rather than from a run row, so an environment that has never run
them returns `last_status='never'` instead of omitting them. Forecast health is
now calculated independently per provider, so Open-Meteo and WeatherAPI cannot
hide each other.

Runtime evidence:

- Baseline after 027 returns **8 rows**: weather, climate, two forecast
  providers, two market sources, advisory and soil.
- A rolled-back staging transaction deleted every run row and called the function
  under temporary admin claims: all 8 rows remained present with
  `last_status='never'`; data-derived freshness was retained where rows existed.
- After the rollback, the staging counts were restored: weather 9 runs, climate
  14, soil 4, admin capabilities 0.
- A second rolled-back transaction inserted an Open-Meteo failure and a
  WeatherAPI failure. The two forecast rows returned their own distinct errors,
  proving the per-provider branch.
- HTTP authorization after 027: admin 200, non-admin farmer 403, anonymous 401.
  Cleanup left 3 auth users, 0 test parties and 0 admin capabilities.

Static validation after the lifecycle migrations: 66 migrations, 85 tables/85
with RLS, 174 functions; bundle regenerated to 24,078 lines. No production
database was touched and no migration-ledger row was fabricated.

## Per-run record accounting

Migrations 030–032 add and expose six counters on `climate_ingestion_runs` and
`weather_ingestion_runs`, and the same six on `soil_ingestion_runs`:

- `records_fetched`: provider records seen before validation, including
  duplicates and records later rejected.
- `records_inserted` / `records_updated`: actual target-row outcomes reported by
  `record_climate_forecasts`, `record_climate_observations`,
  `record_weather_readings` and `record_soil_observations` from
  `INSERT ... ON CONFLICT ... RETURNING (xmax = 0)`.
- `records_skipped`: duplicates, unchanged rows, unsupported horizon days and
  unavailable values.
- `records_rejected`: structurally invalid records refused before persistence.
- `records_failed`: rows whose persistence call failed. Provider fetches that
  returned no records are represented by the run status and error, not by an
  invented fetched count.

The recording RPCs are `security definer`, use `search_path = public, pg_temp`,
and are executable only by `service_role`. Their inputs are de-duplicated before
the write; unchanged rows are not updated, so a repeated run cannot inflate the
insert or update count. `rows_written` on the run tables now means inserted plus
updated, not attempted. The existing weather `cells_written` and soil
`cells_written` meanings are unchanged.

Staging runtime evidence (2026-11-04):

| Function/run | Status | fetched | inserted | updated | skipped | rejected | failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `forecast-ingest`, run 22 | partial | 7 | 0 | 1 | 6 | 0 | 0 |
| `forecast-ingest` duplicate, run 24 | partial | 7 | 0 | 0 | 7 | 0 | 0 |
| `climate-ingest`, run 23 | ok | 7 | 2 | 5 | 0 | 0 | 0 |
| `climate-ingest` duplicate, run 25 | partial | 7 | 0 | 0 | 7 | 0 | 0 |
| `weather-ingest`, run 13 | ok | 4 | 4 | 0 | 0 | 0 | 0 |
| `weather-ingest` duplicate, run 16 | partial | 4 | 0 | 0 | 4 | 0 | 0 |
| `weather-ingest` scheduled, run 17 | partial | 8 | 1 | 0 | 7 | 0 | 0 |
| `historical-forecast-ingest`, run 27 | ok | 14 | 14 | 0 | 0 | 0 | 0 |
| `historical-forecast-ingest` partial, run 28 | partial | 28 | 21 | 0 | 7 | 0 | 0 |
| `soil-ingest`, run 6 | partial | 6 | 0 | 0 | 6 | 0 | 0 |
| `climate-ingest` provider failure, run 26 | failed | 0 | 0 | 0 | 0 | 0 | 0 |

The historical partial run requested six archive issues; two future issues were
rejected by Open-Meteo with HTTP 400. Twenty-one rows from four available runs
were inserted, seven rows were skipped or absent, and the run retained the first
provider error. The climate failure is a real NASA POWER HTTP 422 for 1900 and
has `rows_written=0`. Row counts after the runs were `climate_forecasts=105`,
`climate_observations=11`, `weather_readings=36`, `soil_observations=12`.
The duplicate weather run added no rows; a later scheduled weather run (17)
added one new current reading.

The accounting RPC SQL checks passed for all four target tables, including
within-batch duplicates, unchanged reruns, a changed update, an invalid-row
constraint failure with no partial persistence, and empty input. The synthetic
2099 test rows used for that check were removed; zero remain.

### Weather status correction

The weather table's original status constraint allowed only `running`, `ok` and
`failed`. The adapter's intended `partial` update violated that constraint and
the update error was previously ignored, leaving a run `running`. Migration 032
adds `partial` to the allowed domain. Two runs created before 032 were
reconciled from their recorded HTTP responses (`14`: 4 fetched/4 skipped;
`15`: 4 fetched/1 inserted/3 skipped), and post-fix runs (`16` and scheduled
`17`) updated themselves to `partial` with real counters. The all-district soil
dispatch timed out at the gateway after 60 seconds with no completion response;
its test run 7 was marked `failed` with that timeout error rather than left
`running`.

The `ingestion_health` replacement was invoked under a temporary staging admin
capability and authenticated claims. The returned weather, climate, forecast and
soil rows carried the same counters as their persisted run rows; the cap-
ability was removed and the remaining admin capability count was zero. The
fixture party `3c18c192-1426-4fa1-a8d3-67520c21a6e2` and its auth user
`00000000-0000-4000-8000-0000000000a1` were deleted after verification; both
are absent and no active admin capability remains.

## Run lifecycle hardening

Migrations 033–034 add a renewable 15-minute lease and heartbeat to every run
table, a service-only `touch_ingestion_run(kind, id)` RPC, and a service-only
`recover_abandoned_ingestion_runs(limit)` RPC. Recovery only selects runs whose
lease has already expired, uses `for update skip locked`, preserves the original
error text and counters, sets `recovered_at`, and appends the recovery reason.
An active adapter renews its lease before provider work, so a concurrent
recovery cannot classify it as abandoned.

Every adapter now checks run creation, lease renewal, accounting and final
status updates. A successful request with a failed final update returns HTTP 500
with `run_finalization_error`, never a success response. A failed request whose
final update also fails returns both the ingestion error and the finalization
error. `completedStatus` now treats only source gaps, rejected records and
persistence failures as partial; unchanged/duplicate database rows are `ok`.

Staging lifecycle evidence:

| Scenario | Response | Persisted result |
| --- | --- | --- |
| Weather success, run 52 | HTTP 200 `ok` | 4 fetched, 2 inserted, 2 updated, status `ok` |
| Forecast success, run 43 | HTTP 200 `ok` | 2 fetched, 0 inserted, 2 updated, status `ok` |
| Historical provider partial, run 40 | HTTP 207 | 21 fetched, 0 inserted, 7 updated, 14 skipped, status `partial` |
| Climate complete provider failure, run 41 | HTTP 502 | 0 fetched, status `failed`, NASA POWER 422 |
| Accounting RPC denied, run 42 | HTTP 502 | 1 fetched, 1 failed, status `failed`, permission error |
| Final status update denied, run 53 | HTTP 500 with `run_finalization_error` | row remained `running` while denied; test row removed |
| Abandoned lease, climate 37 / weather 50 / soil 8 | recovery RPC | all three became `failed`, original error preserved |
| Active lease, climate 38 / weather 51 / soil 9 | recovery RPC | all three remained `running`; fixtures removed |

The all-district SoilGrids attempt (run 10, six cells, 25-second bounded calls)
failed all six cells with `Signal timed out.`; a single-district retry (run 11)
received HTTP 503. Both are terminal `failed` rows with no invented writes. No
coverage improvement was observed because the provider was unavailable; the
unresolved coverage remains the four NoData districts.

All test-created recovery/finalization rows were removed. Staging ended with
zero `running` rows in all three run tables, zero synthetic target rows, 112
forecasts, 11 observations, 75 weather readings and 12 soil observations. The
five existing cron schedules were unchanged.

## Idempotency and failure behavior

Before a repeated weather/forecast run, the data counts were:

```text
weather_readings=25  climate_forecasts=70  climate_observations=9  soil_observations=12
```

After the repeated calls, the data counts were unchanged; only the run-log rows
increased. A later weather call at a new observation timestamp added one new
current row, which is correct: it was a new event, not a duplicate of the prior
event. At that earlier checkpoint the counts were 26 weather and 70 forecast
rows; after the later accounting runs the current counts are 36 weather and 105
forecast rows.

The earlier SoilGrids timeout was recorded as a failed run with the provider
error `Signal timed out.` The bounded retry then succeeded, and the earlier
all-district call returned HTTP 207 with 2 cells written and 4 failed. A later
all-district dispatch exceeded the gateway's 60-second limit with no completion
response; that test run was marked `failed` with the timeout error rather than
left `running` or reported as complete. Failed and partial runs remain visible
in `soil_ingestion_runs`, `weather_ingestion_runs` and
`climate_ingestion_runs`.

## Freshness, coverage and operational limits (earlier snapshot)

- Current weather: latest current observation 2026-11-04 21:15 UTC; classified
  `fresh` by the existing 90-minute rule. The table also contains older daily
  rows and an old `(0,0)` test cell; these are not current observations.
- Forecast: latest issue 2026-11-04, latest forecast day 2026-11-10; 7 live
  rows, all calibrated.
- Climate: 9 NASA POWER reanalysis days, latest 2026-11-02. These are reanalysis,
  not ground-station readings.
- Soil: Dera Ghazi Khan and Layyah covered, six depths each; Kot Addu,
  Muzaffargarh, Rajanpur and Taunsa return no usable depth values.
- Run rows after the final rollback: weather 9, climate 14, soil 4. The earlier
  execution evidence above remains the provider result record.
- `ingestion_health()` remains admin-only. The temporary admin fixtures were
  removed; no permanent admin capability remains. Migrations 026/027 make every
  branch inventory-based, so a never-run source is reported as `never` rather
  than omitted.
- Inserted/updated/skipped/rejected counters are only partially available. Run
  logs expose rows seen/written and weather cells requested/written, and the
  forecast response exposes `skipped=0`. There is no per-record updated or
  rejected counter, and no target-level rejection table.
- The legacy `(0,0)` weather cell and older weather rows created before the
  provenance patch still lack the new raw `source_url` metadata. New weather
  writes preserve it. Those old rows were not rewritten with invented metadata.

## Model-input compatibility

Both registered Layyah models remain active and unchanged:

| Target | Model ID | Training end | Holdout rows |
| --- | --- | --- | --- |
| `forecast_tmax_c` | `4b85bbed-9f9a-4e8a-acbe-61ad2b39c019` | 2026-10-24 | 193 |
| `forecast_tmin_c` | `f09a3826-bbcc-483c-af98-92ec33aae2eb` | 2026-10-24 | 193 |

After fresh ingestion, all 7 live Layyah forecast rows have both calibrated
values and both model IDs. Example contract row:

```text
forecast_on=2026-11-04  raw tmax=29.3  calibrated tmax=31.48
                         raw tmin=18.6  calibrated tmin=18.71
```

The database trigger, not the adapter, applied the models. No coefficient or
activation scope changed.

## Licensing and commercial readiness

This is an engineering record, not legal advice.

| Source | Actual status | Production position |
| --- | --- | --- |
| Open-Meteo free API | Free API is non-commercial only. Paid subscriptions grant a commercial-use licence and a dedicated API key. <https://open-meteo.com/en/terms> <https://open-meteo.com/en/pricing> | **Blocked.** No paid plan purchased; current staging/evaluation use is the only approved use. |
| ECMWF IFS via Open-Meteo | Delivered through Open-Meteo's ECMWF IFS endpoint. No separate ECMWF commercial clearance has been obtained or verified. | **Blocked with Open-Meteo.** Do not claim independent ECMWF commercial rights. |
| NASA POWER | NASA POWER data are stated to have no use/access/download restrictions, with citation requested; listed as CC BY 4.0. <https://registry.opendata.aws/nasa-power/> | Attribution/citation still required. Values are reanalysis, not station observations. |
| ISRIC SoilGrids 250 m | CC BY 4.0; attribution required. <https://isric.org/explore/soilgrids> | Commercial reuse is permitted by the licence, but values are modelled priors and missing districts stay missing. |
| WeatherAPI.com | Optional adapter exists but no key is configured. The vendor's terms require a licence for commercial use; free-tier use is not treated as commercial approval. <https://www.weatherapi.com/terms> | **Not approved / not active.** |
| Visual Crossing | Vendor states its free plan permits commercial use with attribution and usage limits (1,000 records/day). <https://www.visualcrossing.com/resources/documentation/what-can-i-do-with-the-visual-crossing-weather-free-plan/> | Candidate only; not integrated or activated. |

Open-Meteo remains configurable as the default staging provider. No paid plan,
paid key or commercial activation was introduced.

## Security check results

- Missing `x-ingest-key`: HTTP 401 `Ingestion credential is not valid.`
- Wrong `x-ingest-key`: HTTP 401 with the same body.
- Valid gateway JWT plus valid `x-ingest-key`: HTTP 200 and real writes.
- The gateway rejected the new secret key as a bearer credential; the legacy
  service-role JWT is used only for the Supabase gateway, while the function
  credential is a separate Vault-backed token.
- `dispatch_ingestion_job` execute privilege: `anon=false`,
  `authenticated=false`, `service_role=true`.
- All five cron commands contain no URL; the deployed function body contains no
  hardcoded project host.
- Missing configuration, invalid ref, URL/ref mismatch, invalid function name,
  and credential-ref mismatch were rejected before `net.http_post`.
- The staging Vault URL/ref and gateway JWT ref all resolve to
  `swmbmtvwgksicfnfsehg`; no production URL is present in staging dispatch
  configuration.
- `ingestion_health` admin gate: temporary admin HTTP 200; authenticated
  non-admin HTTP 403; anonymous HTTP 401. The temporary capability was removed.
- No credential was printed in this record or committed to a migration.

## Verification results

| Check | Result |
| --- | --- |
| Migration lint | Pass: 66 migrations, 85 tables/85 with RLS, 174 functions |
| Edge-function lint | Pass: 15 sources, 9 functions |
| TypeScript | Pass: `tsc --noEmit` |
| Production build | Pass: 2,161 modules, Vite build 18.51 s; only the existing >500 kB chunk warning |
| Migration bundle | Pass: 66 migrations, `supabase/apply-all.sql`, 24,078 lines |
| Baseline unit tests (`7efcc80`) | **Fail: 341 passed, 45 failed, 1 skipped (387 tests; 38 files; 11 failed files)**. |
| Current unit tests | **Pass: 526 passed, 1 skipped, 0 failed (527 tests; 59 files)**, including 10 accounting/finalization tests. |
| Local Deno check | **Not run:** `deno: command not found` in this shell. Runtime deployment and HTTP execution were verified instead. |

## Remaining work before production

1. Obtain commercial rights for Open-Meteo and clarify the ECMWF chain; do not
   activate a paid plan without approval.
2. Migrations 026–034 are applied on staging. Keep
   `ingestion_health()` admin-gated; a production administrator needs a
   deliberate, audited capability grant, not a service-role widening.
3. Resolve the four SoilGrids NoData districts, or keep them explicitly
   uncovered; do not fill them from neighbours.
4. Clean the legacy `(0,0)` weather cell and decide whether old weather rows
   should be backfilled with non-invented provenance.
5. The 33 frontend test failures are resolved in `af7c708`; the full suite,
   typecheck and production build are green.
6. Test provider rate limits and repeated outage behavior. This run exercised a
   real timeout and partial provider coverage, but not HTTP 429 or a sustained
   provider outage.
7. Production scheduler activation still requires the production Vault values,
   a production credential check, and explicit approval; see “Production
   scheduler provisioning” above. Staging is not production readiness.

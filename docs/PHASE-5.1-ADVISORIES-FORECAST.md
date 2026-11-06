# Phase 5.1 — Official Advisories and Forecast-Risk Integration

Status: **infrastructure implemented and applied to staging on 2026-11-04**.
The verified-advisory and active-forecast positive paths are **not** demonstrated:
there is no official advisory feed permission/data and no agronomist-reviewed
active forecast rule. Phase 6 has not been started.

This phase extends the canonical Phase 5 alert engine. It does not add a second
alert table, notification model, producer or Home surface. Every alert remains a
`recommendations` row with `alert_level`; its inbox pointer remains the existing
`notification_events` row.

---

## 1. Migration reconciliation

The staging project is `swmbmtvwgksicfnfsehg`. Its repository migrations were
missing for two separate reasons, and neither was a broken SQL file:

1. **Base history is incomplete.** `supabase_migrations.schema_migrations` has
   only **23** base versions. The Phase 1–5 objects were applied through the
   Management API without corresponding ledger rows. This predates Phase 5.1.
2. **Seven repository migrations were never applied to staging.** They were the
   2026-10-14/15 chain that defines the advisory and forecast infrastructure:
   - `20261014000000_crop_intelligence.sql`
   - `20261015000000_dgkhan_intake.sql`
   - `20261015000100_crop_report_intake_guard.sql`
   - `20261015000200_climate_forecast.sql`
   - `20261015000300_advisory_raw.sql`
   - `20261015000400_report_photo.sql`
   - `20261015000500_report_verification.sql`

Those seven were applied through the established Management API query path. All
returned HTTP 201, and staging now has `intel_sources`, `crop_reports`,
`agri_advisories`, `districts`, `climate_forecasts`, `forecast_risk_rules` and
`forecast_risks`.

Phase 5.1 adds `20261103001000_advisory_forecast_alerts.sql`. It was applied the
same way and returned HTTP 201. The ledger still reports **23** rows: the
Management API does not write `schema_migrations` rows. **No ledger rows were
invented or rewritten, and `supabase db push` was not used.** A future
reconciliation must be an explicit owner decision; the absence of ledger rows
means a fresh clone cannot assume `db push` is safe.

`supabase/apply-all.sql` was regenerated from **42 migrations**.

---

## 2. Source and evidence architecture

### 2.1 Official advisory gate

`agri_advisories` now carries:

- `verification_status` (`unverified` default, `verified`, `rejected`)
- `verified_at`, `verified_by`, `verification_note`
- `alert_level` (`info` / `watch` / `urgent`)
- Urdu `title_ur` / `summary_ur`

A row is readable by `anon`/`authenticated` **only** when all of these hold:

- `is_active`
- `verification_status = 'verified'`
- `valid_until is not null`
- `valid_until > now()`

The table constraint for a verified row additionally requires:

- a direct HTTPS `source_url`
- a district
- a future validity window
- an alert level
- the reviewing party and timestamp
- Urdu title and summary

`verify_official_advisory(advisory_id, status, alert_level, note)` is the review
act. It requires the `admin` capability, a note, an active `official_advisory`
source, and the evidence fields above. Rejection deactivates the row. Importing a
CSV never verifies anything: the default is `unverified`, and the importer has no
verification parameter.

`intel_feed()` was corrected for the same rule. It no longer labels every active
advisory `official_advisory`; it requires `verification_status = 'verified'` and
a source whose kind is `official_advisory`.

### 2.2 Forecast-risk gate

Forecast risks remain rows generated from `forecast_risk_rules`. A risk reaches
an alert only when:

- its rule is `is_active`
- the rule cites a published knowledge entry at `evidence_tier = 'verified'`
- the rule cites an active source whose kind is `forecast_risk`
- the risk has not expired
- the district matches the farmer's district
- the risk crop is null or matches an open crop
- the rule's knowledge stage applicability is null/all or matches the crop stage

`activate_forecast_risk_rule()` now rejects a rule whose cited entry is not
published **or not `verified`**, and rejects an inactive/non-forecast source.
The existing `spray-wind-too-strong` rule remains **inactive**; its citation
(`spray-wind`) is **supplementary** and its 20 km/h value is explicitly an
interpretation. It must not be activated without an agronomist's review.

`forecast_risks.confidence` is optional. When absent it remains NULL; the alert
does not invent a confidence from the threshold.

### 2.3 One producer, distinct provenance

`recommendations.alert_source_kind` is now explicit:

| Value | Meaning |
|---|---|
| `weather_observation` | direct current WMO condition |
| `knowledge` | reviewed time-bound crop knowledge |
| `official_advisory` | verified official advisory |
| `forecast_risk` | modelled forecast risk, never an observation/outbreak |

The producer inserts the value on every new alert. Existing alert rows were
backfilled from their source. The feed returns it so the client cannot confuse a
forecast risk or advisory with observed weather.

Advisory and forecast alerts use the existing:

- JWT-derived farmer identity (`prepare_my_alerts`)
- `recommendations` + `notification_events` model
- dedupe/live cap/cooldown paths (advisory and risk rows are one per source row)
- read/dismiss/preferences and Home/bell presentation
- server-only `refresh_farmer_alerts`

---

## 3. Implementation

Migration: `supabase/migrations/20261103001000_advisory_forecast_alerts.sql`.

Server changes:

- additive advisory verification columns, constraints and RLS policy;
- admin-only `verify_official_advisory(...)`;
- stricter `activate_forecast_risk_rule(...)`;
- optional `forecast_risks.confidence`;
- `recommendations.alert_source_kind` and backfill;
- replacement `refresh_farmer_alerts` with verified-advisory and active-risk loops;
- replacement `intelligence_alert_feed` returning `alert_source_kind`;
- replacement `intel_feed` gating unverified advisories and non-active/unverified
  forecast evidence.

Client changes:

- `src/intelligence/alerts.ts` — `AlertSourceKind`, parser support, legacy
  fallback, and `alertTrustKey` precedence for official/forecast provenance;
- `src/components/alerts/ProactiveAlert.tsx` — official/forecast trust labels,
  publication/issue and affected-area detail, and forecast wording;
- `src/components/insights/Insights.tsx` — trust label in the existing inbox row;
- `src/i18n/catalog.ts` — English and Urdu labels for official advisories,
  forecast risks, publication and region; settings safety copy updated.

No new dependency, design token, alert screen or Home surface was added.

---

## 4. Staging verification

Farmers:

- **A** — Jatoi/Muzaffargarh profile; a temporary cotton/fruiting crop and a
  temporary `Dera Ghazi Khan` profile district.
- **B** — Alipur/Muzaffargarh profile; live wheat/sown, maize/sown and
  cotton/fruiting crops.

Fixtures were explicitly marked `PHASE 5.1 TEST FIXTURE` and were all removed
afterward. Four advisories were **unverified** (valid B, expired B, wrong-crop B,
and DG Khan/A). One synthetic `forecast_risks` row referenced the **inactive**
`spray-wind-too-strong` rule. One current weather row was inserted at B's rounded
coordinate to exercise the unchanged Phase 5 weather path.

| Check | Result |
|---|---|
| Direct advisory reads as `anon` and authenticated A | **0** |
| `intel_feed()` at B for the fixtures | **0** rows, **0** test titles |
| A `prepare_my_alerts()` | **0** |
| A authenticated alert feed | **0**; A notification pointers **0** |
| B `prepare_my_alerts()` after fixture weather | **1** weather alert |
| B alert provenance | `alert_source_kind = weather_observation` |
| B duplicate `prepare_my_alerts()` | **0** additional |
| Active forecast rules | **0** |
| `generate_forecast_risks()` as service role | **0**; fixture risk did not alert |
| `verify_official_advisory` as B | rejected, SQLSTATE `42501`, admin required |
| `activate_forecast_risk_rule` as B | rejected, SQLSTATE `42501`, admin required |
| B preference categories `['pest']` | feed **0** |
| B categories restored | feed **1** |
| Mark read | `true`; feed row `is_read = true` |
| Dismiss | `true`; feed **0** |
| Cleanup | advisories **0**, risks **0**, fixture weather **0**, A crop/profile **0**, B alerts **0**, B notifications **0**, B alert preferences **0**; B live recommendations **6** |

Server-side column/constraint/function checks confirmed all seven new advisory
columns, `recommendations.alert_source_kind`, both replacement feed functions,
and the new policy. The staging ledger remained at **23**.

### What this evidence does not prove

- **No verified official advisory was created.** Correct advisory matching,
  expired-verified suppression, and verified wrong-crop/region suppression were
  therefore **not** positively tested. The advisories above were all unverified;
  their suppression proves the verification gate, not the matching predicates.
- **No forecast rule was activated.** Correct forecast matching, activation and
  deactivation, and positive forecast-risk delivery were not tested. A synthetic
  row for an inactive rule only proves the inactive-rule gate.
- No official advisory data or production forecast data was available.
- No push delivery was tested or claimed.

---

## 5. Blocked human dependencies

1. **Official advisory source and review authority.** `intel_sources.punjab_advisory`
   is `needs_permission` with `dashboard_doc` access. Written permission or the
   department's own feed, plus an authorized reviewer who can check the document,
   district, crop, validity and Urdu wording, is required before a real advisory
   can be imported as `verified`.
2. **Agronomic review of forecast thresholds.** `spray-wind-too-strong` is
   inactive; its cited knowledge is `supplementary`, not `verified`. An
   agronomist must publish verified evidence for the threshold and an admin must
   activate the rule with a note. No threshold was activated or fabricated here.
3. **Forecast data/provider permission.** `weatherapi` is still
   `needs_permission`; `climate_forecasts` is empty. Even with an active rule, no
   real risk can be generated until a permitted forecast source is ingested.
4. Push delivery remains unconfigured. Phase 6 remains unstarted.

---

## 6. Deployment and rollback

1. Regenerate the bundle with `npm run db:bundle` (currently 42 migrations).
2. Apply `20261103001000_advisory_forecast_alerts.sql` after the Phase 5 chain.
   Do not use `supabase db push` on this staging history.
3. The migration is additive. To stop advisory generation, leave advisory rows
   unverified or deactivate them; to stop forecast alerts, deactivate the rule.
   Existing recommendation history remains readable.
4. The client deploy is the normal Vite build. Run typecheck, focused alert tests,
   design lint, migration lint and build before release.

The unresolved ledger gap is a deployment risk, not a success: a fresh clone must
not be treated as having the same migration history until the owner reconciles it.

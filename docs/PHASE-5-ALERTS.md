# Phase 5 — Proactive Crop Intelligence and Alerts

Status: **implemented and staging-verified** on 2026-11-04 (UTC staging run).
Phase 5.1 extends this producer with verified official-advisory and active
forecast-risk gates; see
[`PHASE-5.1-ADVISORIES-FORECAST.md`](./PHASE-5.1-ADVISORIES-FORECAST.md).
The Phase 5.1 positive data paths remain blocked, as recorded there. Phase 6 has
not been started.

Phase 5 adds proactive alerts without creating an alert table, an alert screen or
a second recommendation engine. An alert is a canonical `recommendations` row
with alert metadata; its inbox entry is the existing pointer-only
`notification_events` row. Home, the bell and the alert feed therefore read the
same object.

The central safety rule is deliberate: **a published knowledge entry alone does
not create an outbreak alert.** Knowledge alerts require an active, time-bound
rule created specifically for that crop and stage. No live curatable rule was
seeded. The three active rules are direct weather-observation rules.

---

## 1. Dependency and reuse audit

| Existing object | Phase 5 use |
|---|---|
| `crop_instances` | registered crop, stage and primary crop |
| `weather_readings` / `latest_weather()` / `weather_is_usable()` | current observation only; no forecast is invented |
| `agri_knowledge_entries` / `agri_knowledge_sources` | reviewed copy, evidence tier and HTTPS source |
| `recommendations` | the canonical alert row; no separate alert table |
| `notification_events` | inbox pointer, read/dismiss state and delivery-channel truth |
| `farmer_preferences` | the single explicit `alerts` preference object |
| `intelligence_config` | version, cooldown, cap and push-availability flags |
| Phase 4 generator/feed | crop sync, canonical advice shape and Home card |
| `CropCard` / `NotificationBell` / `InsightSheets` | existing Home and inbox surfaces |
| `ProfileScreen` Notifications row | now opens the alert settings screen |
| `LocaleProvider` / `catalog.ts` | English/Urdu copy and RTL |

No paid API, new external service, new push provider or new dependency was added.

### Missing dependencies, handled explicitly

The missing 2026-10-14/15 migration chain is now applied to staging. The
database contains `agri_advisories`, `crop_reports`, the forecast-risk tables,
`districts` and `climate_forecasts`, and Phase 5.1 added the gated adapters.
There is still **no verified official advisory data** and **no active forecast
rule**; those positive paths remain blocked and are not claimed.

The migration ledger remains incomplete: staging records only 23 base versions,
while the Phase 1–5 objects and the eight later migrations were applied through
the Management API. See the Phase 5.1 reconciliation report before using
`supabase db push`.

`spray-wind-too-strong` remains inactive. Its cited knowledge is supplementary
and its 20 km/h threshold is an interpretation. Activation requires verified
evidence and an agronomist/admin decision; neither was invented.

---

## 2. Data and generation

### Migration

`supabase/migrations/20261103000900_proactive_alerts.sql`:

- `recommendations`: `alert_level` (`info`/`watch`/`urgent`), `alert_at`,
  `alert_rule_code`, with an all-or-none constraint and a live-alert index.
- `farmer_intelligence_profiles`: `alerts_refreshed_at`.
- `alert_rules`: source kind, level, category, crop/stage, knowledge entry,
  weather condition codes, bilingual copy for weather rules, validity,
  cooldown, daily cap, active window and version.
- `intelligence_config`: rule version, 15-minute refresh bound, 3 live alerts
  per farmer and `alert_push_available = false`.
- RPCs:
  - `farmer_alert_preferences()` / `set_farmer_alert_preferences(...)`
  - `refresh_farmer_alerts(uuid)` — service-only
  - `prepare_my_alerts()` — authenticated JWT-derived seam
  - `intelligence_alert_feed(limit)` — own feed only
  - `mark_alert_read(uuid)` / `dismiss_alert(uuid)` / `mark_all_alerts_read()`
  - `job_refresh_all_alerts()` — service-only scheduler wrapper
- `notification_events` client `UPDATE` is revoked. Read/dismiss go through the
  alert RPCs, which verify the caller owns the announcement.

`supabase/apply-all.sql` was regenerated: **42 migrations** (the Phase 5
migration plus the Phase 5.1 extension and the previously missing chain).

### Weather rules

The active weather rules use direct WMO condition codes from a current reading:

| Rule | Codes | Level | Validity |
|---|---|---|---|
| `weather-thunderstorm` | 95, 96, 99 | urgent | 90 min |
| `weather-heavy-rain` | 65, 67, 82 | watch | 180 min |
| `weather-heavy-snow` | 75, 86 | watch | 180 min |

These are **observations**, not an agronomic threshold and not a forecast. The
body says the weather service reported the condition at a time and tells the
farmer to avoid spraying and check standing water; it does not claim a pest or
disease outbreak and contains no pesticide instruction. Source attribution is
the provider name; the test used the provider `research_fixture`, and the UI would
show that label rather than presenting it as live weather.

The generator requires:

- a saved location and a fresh, usable current reading at that rounded cell;
- an open registered crop;
- an active rule whose category is selected by the farmer;
- no live alert for the same rule/crop cause;
- the rule cooldown and daily cap to be clear;
- the per-farmer live-alert cap (3) to have room.

Dedupe key includes provider, condition code, rounded observation hour and rule.
A cooldown row plus the partial unique index make repeat generation a no-op.

### Knowledge rules

A knowledge rule must:

- be `source_kind = 'knowledge'` and active;
- cite a published `verified` knowledge entry;
- specify a crop and a stage;
- have a bounded `starts_at`/`ends_at` window;
- pass the selected category and the same live/cooldown/cap checks.

The generator copies the entry’s bilingual title/body, evidence tier and HTTPS
source. It does not generate a new diagnosis, an outbreak claim or a pesticide
instruction. The only knowledge rule used in this phase was a staging fixture,
removed after the test. **No live knowledge alert is claimed.**

### Notification creation

Only a newly inserted alert creates a notification pointer:

- weather → `notification_kind = 'weather_alert'`;
- curated knowledge → `notification_kind = 'recommendation'`.

`delivered_channels` is `{in_app}`. No push dispatch is implemented or claimed.

---

## 3. Producer and read contracts

```text
useAlerts (client)
  → prepare_my_alerts()                 [JWT owner]
      → refresh_farmer_alerts(uuid)     [service-only rule producer]
          ├─ fresh current weather observation + active weather rule
          └─ active time-bound knowledge rule + open crop/stage match
              → recommendations (alert_level/alert_at/alert_rule_code)
              → notification_events (pointer, in-app delivery marker)
  → intelligence_alert_feed()           [own alerts only]
```

- The client never sends a farmer id. The owner comes from
  `current_farmer_id()`/the JWT.
- `refresh_farmer_alerts` is revoked from `public`, `anon` and `authenticated`
  and granted only to `service_role`.
- `intelligence_alert_feed` respects in-app/category preferences, dismissal,
  live crop, validity, notification ownership and a 20-row bound.
- The feed orders by level, then alert time, then creation time.
- Read/dismiss verify that the notification belongs to the caller and points at
  an alert recommendation. Dismissal also records the existing `dismissed`
  feedback verdict, but a feedback failure cannot undo the dismissal.
- The existing `job_expire_recommendations` path retires expired recommendations;
  the alert feed independently excludes any expired row even before that job
  runs.
- The existing `audit_log` records refresh, generation, preference changes and
  dismissal. Alert rows remain attributable to their rule.

---

## 4. Frontend

`CropCard` remains the only Home advice area:

- `ProactiveAlert` renders the highest-priority alert above the existing
  `PersonalizedAdvice`.
- It shows level, category, title/body in the active language, the reason,
  source, trust label and time.
- Details reveal evidence and a safe HTTPS source link; opening Details marks the
  alert read.
- The action uses the existing `open_weather` / `open_scan` actions.
- Dismiss removes the notification and records the verdict.
- Alert recommendations are filtered out of `PersonalizedAdvice`, so the same
  canonical row cannot appear twice on Home.
- Loading, empty, error and offline states are distinct. No alert is rendered
  from a failed or offline read.
- The bell counts unread server alerts for an account.
- The notifications sheet lists server alerts with unread state, source and
  dismiss controls; it does not duplicate the local insight list for an account.
- Profile’s previously inert Notifications row opens `AlertSettingsScreen`.
- Settings has in-app toggle, four category choices, save/error/offline states
  and an explicitly disabled push row that says delivery is not connected.
- English and Urdu strings are present. Urdu inherits the existing `dir="rtl"`
  document direction; no physical-direction utilities were added.

The client gateway, parser, hook and settings store are isolated:

- `src/intelligence/alerts.ts`
- `src/intelligence/alertPreferences.ts`
- `src/intelligence/useAlerts.ts`
- `src/intelligence/useAlertPreferences.ts`
- `src/components/alerts/ProactiveAlert.tsx`
- `src/screens/AlertSettingsScreen.tsx`

---

## 5. Verification

### Static and focused gates

```text
npm run typecheck          pass
npm run lint               pass (design tokens / logical direction)
npm run lint:functions     pass (12 function sources, 4 client routes)
npm run lint:migrations    pass (42 files, 75 tables, 75 with RLS, 109 functions)
npm run test:unit          420 passed, 1 skipped
focused Phase 5/5.1 tests  25 passed
npm run build              pass; only the pre-existing >500 kB chunk warning
git diff --check           pass
```

The running app was also loaded against staging. `prepare_my_alerts`,
`intelligence_alert_feed` and `prepare_my_recommendations` returned HTTP 200,
and Profile → Notifications opened the alert settings screen. No alert-specific
console error appeared; the existing Sheet ref warning and Vite Fast Refresh
invalidations remain unrelated pre-existing warnings.

Focused Phase 5 tests:

- `src/intelligence/alerts.test.ts` — 9 tests: validation, dedupe, cap, unsafe
  URL rejection, categories, trust, official/forecast provenance, legacy fallback
  and expiry.
- `src/intelligence/useAlerts.test.tsx` — 6 tests: ready/empty/error/offline,
  read confirmation, read rollback and dismiss rollback.
- `src/components/alerts/ProactiveAlert.test.tsx` — 5 tests: evidence, details,
  read, action, dismiss, loading/error/offline, Urdu/RTL.
- `src/screens/AlertSettingsScreen.test.tsx` — 5 tests: controls, saved
  categories, empty-category guard, offline state and sign-in gate.

### App suite baseline

```text
npm run test:app → 64 passed, 33 failed
```

This is the same accepted 33-name baseline recorded in
`docs/PHASE-3-ACCEPTANCE.md`. The failing set is unchanged: chat, credit, identity,
isolation, journeys, location, location-search, resilience and three
profile/Shop tests. No Phase 5 test is in that failure set. The App suite is not
reported as green.

### Staging evidence

Staging project: `swmbmtvwgksicfnfsehg`.
The staging run used the two existing demo farmers, a temporary crop for A (A
had none), two `research_fixture` weather readings explicitly marked as research
fixtures, and one explicitly reviewed, time-bound knowledge fixture. All
fixtures were removed afterward.

Observed results:

| Check | Result |
|---|---|
| A with no usable reading at its cell | `refresh_farmer_alerts(A)` → **0** |
| A with direct WMO 95 at its cell | **1** urgent thunderstorm alert, cotton, source `Research fixture` |
| B with direct WMO 65 at its cell | **1** watch heavy-rain alert, cotton |
| B immediate duplicate | **0** |
| B after cooldown reset, while alert live | **0** |
| B with active reviewed wheat/sown rule | **1** verified knowledge alert, wheat, source Punjab Agriculture Department |
| A, same wheat rule but no wheat crop | **0** |
| B notification pointers | 2 `weather_alert`, 1 `recommendation` |
| A authenticated feed | **1** row, only A’s thunderstorm; no B row |
| B authenticated feed | **2** rows, B’s heavy rain and verified wheat note; no A row |
| Mark read | `true`; subsequent feed row `is_read = true` |
| Dismiss | `true`; dismissed alert absent from the feed |
| A in-app alerts disabled | feed **0** |
| A in-app alerts restored | feed **1** |
| A validity moved into the past | feed **0** |
| Push opt-in | HTTP 400: `Push delivery is not configured in this build.` |
| Unknown category | HTTP 400: `Unknown alert category.` |
| Cleanup | alert rows **0**, fixture weather **0**, A crop **0**, A profile **0**, test rule **0**, test knowledge **0**, alert preferences **0**; B live recommendations **6** |

Execute grants were checked directly: `anon` on the alert feed **false**,
`authenticated` on the feed **true**, `authenticated` on `prepare_my_alerts`
**true**, `authenticated` on `refresh_farmer_alerts` **false**, and
`service_role` on `refresh_farmer_alerts` **true**.

The temporary test crop, profile row, alerts, notification pointers, feedback,
interest movement, knowledge entry, rule and weather rows were removed. B’s six
Phase 4 recommendations and the existing app crops remain intact. The source
provider for the test weather is `research_fixture`; this is not a claim that a
live severe-weather event occurred.

### What was not tested

- The advisory and forecast-risk **infrastructure** was added in Phase 5.1, but
  no real official advisory feed exists and no official advisory was verified.
  Correct advisory matching and expired verified-advisory suppression remain
  untested; only the unverified gate and negative fixtures were exercised.
- No forecast rule was activated. The existing inactive spray-wind rule was not
  activated, and positive forecast-risk matching/delivery remains untested.
- No live curated knowledge alert rule exists. The knowledge path was tested with
  a fixture and is intentionally inert in production until a reviewer creates a
  time-bound rule.
- No push sender, device registration or FCM delivery was tested. The preference
  API reports `push_available = false`; the UI disables the push control.
- The staging weather rows are development fixtures with an explicit source
  label; the live weather ingestion path was not changed.

---

## 6. Decisions and limitations

1. **Canonical recommendation, not a new alert table.** This preserves one
   explanation and one Home card. The alert-specific fields are enough to filter
   and present alerts.
2. **Direct weather only for live rules.** WMO 95/96/99, 65/67/82 and 75/86 are
   observed conditions. The app does not infer a pest or disease outbreak from
   them and does not invent a rainfall or wind threshold.
3. **Knowledge alerts are curated campaigns, not static article alerts.** The
   crop/stage and the start/end window are required. No live rule qualifies yet.
4. **Push remains unavailable.** The existing push table/plugin is not enough to
   claim delivery; no sender is configured. The UI says so rather than requesting
   a permission it cannot honour.
5. **Advisories and forecast risks use the same producer, but their positive
   paths are gated and currently blocked.** The tables now exist on staging;
   verified advisory data and an active, verified-evidence forecast rule do not.
   Do not treat the presence of the tables as an official-data or forecast
   activation success.
6. **The App suite’s 33 failures remain accepted baseline**, not Phase 5 success.
7. **Notion remains blocked** by the missing approved write tools recorded in
   Phase 3. No Notion write was retried.

## 7. Deployment / rollback

1. `npm run db:bundle` (already regenerated to 42 migrations).
2. Apply `supabase/migrations/20261103000900_proactive_alerts.sql` and
   `20261103001000_advisory_forecast_alerts.sql` after
   `20261103000100`–`00800`. Apply the missing 2026-10-14/15 chain first where it
   is absent; do not use `supabase db push` against the staging ledger.
3. The migration is additive. To disable all alert generation without deleting
   history, set `alert_push_available`/rules inactive or remove execute on
   `prepare_my_alerts`; existing recommendation rows remain readable. Do not drop
   the table as a routine rollback.
4. Client deploy is the normal Vite build. Run
   `npm run build` and the focused Phase 5 tests before release.

Phase 6 was not started.

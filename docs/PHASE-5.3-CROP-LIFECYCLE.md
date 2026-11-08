# Phase 5.3 — Crop Lifecycle Intelligence

Backend and database only. No farmer-facing screen, Profile change, Evidence
Center change or reviewer UI change was made.

## 1. What was built

The existing crop model already had `crop_catalog`, `crop_instances`,
`crop_facts`, `crop_inferences`, `crop_stage_history`, the ordered-stage trigger
and the farmer context. No second crop or stage system was introduced.

### Provenance on the canonical instance

`crop_instances` keeps its one `stage`, now with:

- `variety` (optional);
- `stage_source`: `unknown | estimated | farmer_confirmed | agronomist_confirmed`;
- `stage_confidence` (0..1);
- `stage_estimated_at`, `stage_confirmed_at`, `stage_confirmed_by`;
- `stage_rule_version`;
- `stage_evidence` (bounded JSON: calendar id/version, matched inputs, days
  since sowing, weather context; no coordinates);
- `stage_inputs_hash` and `stage_calculated_at` for idempotency.

`stage_source = 'unknown'` is the explicit unknown state. The `crop_stage` enum
was **not** extended, so existing consumers keep working and an unknown stage
cannot be mistaken for `planned`. The farmer context emits `stage_unknown` and
`stage_is_unknown = true` when the source is unknown.

`crop_stage_history` now carries `stage_source`, `confidence`, `rule_version`
and `evidence` alongside the existing from/to, actor and reason.

Backfill rule: app-synced rows came from a stage the farmer chose, so they are
recorded as `farmer_confirmed`; every other legacy row starts `unknown`. No
legacy row was guessed.

### Calendars

`crop_lifecycle_calendars` stores a versioned, ordered list of inclusive day
windows from sowing:

```json
[{"stage":"sown","start_day":0,"end_day":7},
 {"stage":"vegetative","start_day":21,"end_day":45}]
```

A row is usable only when `is_validated`, `is_active`, and has a validator,
validation time and HTTPS source URL. `agri_validate_stage_calendar()` checks
contiguity, lifecycle order, no repeats, first day 0 and at least 20 days or an
open final window. It judges structure only, not agronomy.

**No calendar is seeded.** A crop with no validated calendar stays unknown.
Writes are revoked from clients; authenticated admins have a read policy.

### Deterministic estimator

`agri_recalculate_crop_stage(crop_id, now)`:

1. Returns immediately for a closed crop or a confirmed stage.
2. Reads `sown_on` from the instance, then the live `sown_on` fact; reads
   `variety` the same way; reads district from
   `farmer_intelligence_profiles`.
3. Rejects a missing, future or older-than-1500-day sowing date.
4. Selects the richest validated calendar: crop + variety + district, then
   crop + variety, then crop + district, then crop-only; latest rule version
   wins within a tier.
5. Finds the inclusive window for days-since-sowing; no match is
   `outside_calendar`.
6. Computes confidence:
   - variety + district: 0.90
   - variety only: 0.80
   - district only: 0.75
   - generic: 0.60
   - minus 0.05 when a supplied variety/district was not matched, clamped to
     0.40..0.95.
7. Writes the stage, source, confidence, rule version, evidence and input hash;
   records history and an inference row with confidence and evidence.
8. Is idempotent: same input hash inside `stage_recalc_min_hours` (default 12)
   returns `unchanged` without writing.

When inputs are insufficient the instance becomes `unknown`, an explicit
history row records the withdrawal, and the reason is one of
`sowing_date_missing`, `sowing_date_future`, `sowing_date_too_old`,
`calendar_unavailable` or `outside_calendar`.

Weather is recorded as evidence only (`provider`, `observed_at`, `usable`,
`temp_c`). It does **not** shift a stage: this repository has no validated
weather-to-stage thresholds, so using it would invent agronomy.

### Confirmation and correction

- `confirm_crop_stage(crop_id, stage, reason?)` derives the farmer from the
  JWT, checks ownership, sets `farmer_confirmed`, confidence 1, confirmation
  actor/time, clears estimate rule data and records history/audit. A backward
  move without a reason is refused.
- `correct_crop_stage(crop_id, stage, reason)` is now a wrapper over the
  confirmation path and still requires a reason. The old API is preserved.
- `recalculate_my_crop_stage(crop_id)` is the authenticated estimator seam;
  ownership is checked against `current_farmer_id()`.
- `sync_my_crops(jsonb)` accepts optional `sown_on` and `variety`. A supplied
  stage is a farmer confirmation; an omitted stage is never invented. Sowing
  date and variety are validated. Only app-owned stale rows are closed.

Triggers recalculate after `sown_on`/`variety` changes on the instance and after
live `sown_on`/`variety` facts are inserted, updated or superseded. Confirmed
stages are never overwritten by any of these paths.

`job_refresh_crop_stages()` is the service-only batch seam for open,
unconfirmed crops with a sowing date. It is **not scheduled** by this phase;
the estimator is idempotent, so an external daily schedule is safe.

## 2. Intelligence integration

`farmer_intelligence_context()` now returns, for the primary crop and every
crop: `stage` (or `stage_unknown`), `stage_source`, `stage_confidence`,
`stage_is_unknown`, `stage_estimated_at`, `stage_confirmed_at`,
`stage_rule_version`. Farmer-facing code can therefore distinguish a confirmed
stage from an estimate without a new screen.

One gate is used everywhere:

```sql
agri_stage_matches(source, confidence, stage, required_stages, min_confidence)
```

- confirmed stages always match their required stage;
- estimates match only at or above `stage_confidence_min_for_advice`
  (default 0.70);
- unknown never matches a stage-specific requirement.

Applied to:

- `refresh_farmer_recommendations()`: stage-specific knowledge is excluded
  unless the gate passes; generic entries remain eligible;
- `refresh_farmer_alerts()`: knowledge campaigns require the gate; forecast
  risks require it when the entry declares stages;
- weather alerts remain stage-independent, because they are observations, not
  stage claims.

No threshold, duration or regional rule was invented.

## 3. Security and integrity

- Farmer identity always comes from the JWT; no RPC accepts a farmer id.
- `recalculate_my_crop_stage`, `confirm_crop_stage` and `correct_crop_stage`
  check the caller owns the crop.
- `agri_recalculate_crop_stage()` and the batch job are service-only; execute
  is revoked from `public`, `anon` and `authenticated`.
- Calendar writes are revoked from clients; admin read policy is explicit.
- Stage changes keep the existing ordering rule; backward movement requires a
  reason; history is append-only by policy.
- Estimate, confirmation, withdrawal and correction are audited.
- Cross-farmer calls were tested and denied with `insufficient_privilege`.

## 4. Verification

Staging project `swmbmtvwgksicfnfsehg`, applied through the Management API
(HTTP 201), never `supabase db push`; the migration ledger was not modified.

A transaction-scoped suite ran with temporary farmer fixtures and rolled back.
**27/27 checks passed:**

- estimation from a validated calendar: `vegetative`, confidence 0.75,
  rule version 9001, evidence persisted;
- second calculation `unchanged`; history not duplicated;
- sowing-date change recalculated to `flowering`;
- confirmation recorded `farmer_confirmed`, confidence 1, and a later
  estimate did not overwrite it;
- correction with reason recorded; correction without reason refused;
- missing sowing date → `unknown` / `sowing_date_missing`;
- crop with no validated calendar → `unknown` / `calendar_unavailable`;
- gate: unknown denied, 0.60 estimate denied, 0.75 estimate allowed,
  confirmed allowed;
- context exposed `stage_unknown` then confirmed provenance;
- recommendation gate: estimated qualifies, unknown denied, confirmed
  qualifies;
- alert gate: confirmed qualifies, unknown denied;
- cross-farmer recalculate and confirm denied;
- confirmation and correction history rows present;
- estimated→unknown withdrawal history row present.

The test calendar and dossier were clearly labelled fixtures marked validated
inside the rolled-back transaction. They are **not** agricultural evidence and
were not persisted.

Other checks after the change:

- `npm run lint:migrations`: 48 migrations, 79 tables (79 with RLS), 149
  functions in force — passed.
- `npm run typecheck`: exit 0.
- `npm run test:unit`: 46 files, 420 passed, 1 skipped — exit 0.
- `npm run build`: production build passed in 15.4 s (existing large-chunk
  warning only).
- `npm run db:bundle`: 48 migrations, 19,225 lines.Staging cleanup: 0 lifecycle calendars, 0 test dossiers, 0 test knowledge entries, 0 test alert rules and 0 test recommendations remain. The three pre-existing demo crops (farmer B, created 3 Nov) were not created by this suite and were retained; the migration backfilled them as `farmer_confirmed` because they are app-synced.

## 5. Handover by category

### Implemented and verified

- Provenance columns and history evidence.
- Validated, versioned calendar infrastructure with structural validation.
- Deterministic estimation, confidence, rule version, idempotency and
  recalculation on relevant input changes.
- Explicit unknown state and context projection.
- Farmer confirmation and correction, history and audit.
- Stage gate in recommendations, knowledge alerts and forecast risks.
- Cross-farmer denial and service-only estimator.
- The 27 staging checks above.

### Implemented but not fully verified

- `sync_my_crops()` payload propagation for `sown_on` and `variety`, and the
  omitted-stage rule, were not exercised end-to-end in this suite. The function
  compiles and retains its existing contract.
- `job_refresh_crop_stages()` was not run as a scheduled job; it has no cron
  installation in this phase.
- The calendar admin read policy was not exercised through a signed-in admin
  session; it is a simple `has_capability('admin')` policy.
- Weather evidence was tested only without a live reading; the estimator
  records weather but deliberately does not use it to move a stage.
- No production deployment was performed.

### Blocked by missing agricultural evidence

- **No validated crop calendars exist.** Until an agronomist or extension
  source supplies crop/variety/district calendars with a rule version and
  HTTPS provenance, real estimates remain `stage_unknown`. This is the
  intended safe state, not a defect.
- No validated weather/GDD-to-stage thresholds; adding them requires
  agronomic validation, not code.
- No authoritative variety catalogue; variety is free text capped at 80
  characters.

### Future capabilities

- Admin calendar management and review workflow (backend RPC/UI).
- Calendars for the ten catalog crops, with variety and district variants.
- Validated weather/GDD adjustment and confidence calibration.
- A daily scheduler entry for `job_refresh_crop_stages()`.
- Stage-aware farmer UI that shows estimate vs confirmation, without changing
  the current screens in this phase.
- Backfill/measurement of estimation accuracy against farmer confirmations.

## 6. Files

- `supabase/migrations/20261103001500_crop_lifecycle.sql` — schema, calendars,
  estimator, confirmation/correction, context and producer gates.
- `supabase/migrations/20261103001600_crop_lifecycle_fix.sql` — corrective
  replacement of the recommendation producer after the staging apply exposed a
  UNION column-order mismatch; fresh installs apply 015 then 016.
- `supabase/apply-all.sql` — regenerated (48 migrations).
- `docs/PHASE-5.3-CROP-LIFECYCLE.md` — this handover.

No application TypeScript was changed; the work is database-first by design.

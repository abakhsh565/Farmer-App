# Phase 6 — Personalization completion

**Date:** 2026-11-04
**Scope:** backend/DB only. No farmer-facing UI, no ML, no new recommendation
engine, no additional agricultural assumptions.

## Capability delivered

Phase 6 now covers the complete backend personalization contract:

1. **Recommendation-type preferences.** Explicit `muted_kinds` in
   `farmer_preferences.key = 'recommendations'`; supported types are `pest`,
   `disease`, `weather`, `market`, `crop_stage` and `general`.
2. **Explicit crop priorities.** `crop:<catalog-code>` interests can be set to
   `normal` or `high` and are pinned against learning.
3. **Explicit topic priorities.** `topic:<slug>` interests can be created even
   when no learned-interest row exists, including topics that only appear in a
   recommendation's `reason_context`.
4. **Explicit suppression.** A crop or topic can be suppressed without deleting
   canonical recommendations or feedback. Matching recommendations are removed
   from the ranked feed while the preference exists.
5. **Preference lifecycle.** Set, update, restore, suppress, clear and idempotent
   removal are covered. No duplicate preference row is created by repeated calls.
6. **Separate alert preferences.** Alert categories, in-app/push and consent
   remain in the existing `alerts` object. Recommendation choices do not rewrite
   alert choices.
7. **Learning protection.** Explicit rows are `source='explicit'` and pinned.
   Feedback and interest refresh cannot move their weights. The old remove RPC
   clears an explicit preference rather than silently leaving a suppression.

### Migrations

| Migration | Purpose |
| --- | --- |
| `20261103001700_recommendation_preferences.sql` | Recommendation-type mute list and feed wrapper. |
| `20261103001800_personalization_completion.sql` | Explicit crop/topic priorities, suppression, clearing, feed filtering and preference reset. |

### Backend contract

| Function | Purpose |
| --- | --- |
| `farmer_recommendation_preferences()` | Reads the caller's muted recommendation types. |
| `set_farmer_recommendation_preferences(text[])` | Validates and replaces the mute list. |
| `clear_farmer_recommendation_preferences()` | Removes the explicit row; idempotent. |
| `farmer_interest_preferences()` | Reads explicit crop/topic rows, including suppressed ones. Learned rows are excluded. |
| `set_farmer_interest_preference(text, text)` | Creates/replaces an explicit crop or topic priority. Normal weight 0.65, high 1.00; pinned. |
| `suppress_farmer_interest(text, text)` | Creates an explicit suppression, even for a topic with no learned history. |
| `clear_farmer_interest_preference(text)` | Deletes only the caller's explicit row; returns false when absent. |
| `dismiss_farmer_interest(text)` | Existing removal: learned rows are softly dismissed; explicit rows are cleared. |
| `intelligence_recommendation_feed(integer)` | Applies type mutes and crop/topic suppression over the unchanged internal scorer. |

All functions derive the farmer from the authenticated session. No function
accepts a farmer id. Direct writes to `farmer_interests` and
`farmer_preferences` remain revoked from `authenticated`; validation and audit
happen in the RPCs.

### Feed behavior

- A prioritised crop matches `crop:<crop_code>` and contributes the existing
  interest boost plus the pinned-interest component.
- A prioritised topic matches `topic:<kind>` or
  `topic:<recommendation.reason_context.topic>`.
- A suppressed crop removes recommendations with that crop code.
- A suppressed topic removes recommendations whose kind or reason topic matches.
- Type mutes remove the selected kinds.
- Muting, suppression and clearing are serving filters. Canonical recommendation
  rows and feedback are retained, so restoration is immediate.
- Suppression applies to the recommendation feed, not alert generation or alert
  delivery. Alert categories remain the independent `alerts` preference.

### Deliberately out of scope

- **Per-farmer frequency controls.** The recommendation surface is pull-based,
  already bounded by `max_recommendations_per_farmer = 12` and the 15-minute
  refresh cooldown. Alerts are separately capped by `alert_max_per_farmer = 3`.
  Adding a farmer-facing rate limit would duplicate those controls without a
  delivery mechanism to limit. It is not required for this phase.
- A farmer-facing preference screen.
- Per-crop numeric weights beyond the two bounded levels.
- Push delivery and production deployment.

## Verification

### Staging

Both migrations applied through the Supabase Management API: **HTTP 201** for
`017` and `018`.

A transaction-scoped staging suite used farmers A and B and temporary
recommendation/crop fixtures. **66 checks passed**:

- **45 behavioral checks:** explicit crop/topic creation, normal/high weights,
  pinned state, context visibility, normalization/idempotency, crop and topic
  boosts, pinned component, crop suppression, topic suppression, restoration by
  re-prioritising, suppression clearing, type mutes, type-preference clearing,
  feed restoration, alert independence, feedback protection, explicit removal,
  cross-farmer isolation and persistence across session switches.
- **21 security/input checks:** unknown crop, invalid topic, invalid priority,
  oversized reason, null suppression topic, invalid clear topic, unknown
  recommendation type, oversized type list, invalid alert category, direct
  insert/update/delete denial, internal-base-feed denial, anonymous RPC denial
  and authenticated read permission.

The suite rolled back. A post-check found **0** test recommendations, **0** test
crop rows, **0** explicit test interests and **0** test recommendation-preference
rows. No fixtures were left behind.

### Repository checks

```text
npm run db:bundle          → 50 migrations, 19,890 lines
npm run lint:migrations    → 50 migrations, 79 tables (79 RLS), 156 functions
npm run typecheck          → exit 0
npm run lint               → design check passed
npm run test:unit          → 46 files, 420 passed, 1 skipped
npm run build              → exit 0, built in 9.95 s
```

The build retains the existing large-chunk warning only. No production
deployment was performed.

## Remaining limitations

- No farmer-facing UI wires these RPCs yet.
- No per-crop/topic numeric weighting beyond normal/high.
- No per-farmer frequency preference (see scope rationale above).
- No push delivery; alert push remains unavailable until a sender is configured.
- Clearing an explicit preference is an audited hard delete of that explicit
  interest row. Feedback and canonical recommendation records are not deleted.
- Real recommendation quality still depends on reviewed knowledge, validated
  crop calendars and the existing human evidence-review process.

## Completion assessment

**Phase 6 backend personalization is functionally complete for the stated
scope.** Persistence, explicit-vs-learned separation, ranking, serving,
authorization, lifecycle and cross-farmer isolation are implemented and
verified. Phase 6 is not a claim that the product is launch-ready: the
preference UI, production deployment, push delivery and real agricultural
content remain outside this backend phase.

## Next highest-priority work

**Proceed to Phase 8 integration and launch-readiness work, not automatically to
another feature phase.** The remaining risk is no longer missing personalization
logic; it is wiring the already-verified backend into the product and proving it
in the target environment: preference UI integration, authenticated end-to-end
recommendation/alert flows, production deployment and configuration, push
delivery, real evidence/calendar content and launch verification.

Phase 7 should be selected only if its remaining scope is a confirmed launch
blocker. Otherwise, Phase 8 testing and launch-readiness is the shortest path to
a usable product.

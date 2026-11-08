# Farmer Intelligence Foundation (Phase 1)

Status: implemented, statically verified, not yet applied to a live database.

This document describes the single intelligence layer that every future
personalization feature reads from: the home feed, AI answers, product and dealer
ranking, notifications, and the farmer-facing algorithm controls.

---

## 1. What already existed, and what was reused

The repository already contained most of the primitives. Phase 1 **extends** them
instead of creating parallel systems:

| Existing object | Reused as |
|---|---|
| `farmer_profiles` | identity + default location; parent of every intelligence row |
| `crop_instances` | the farmer's crops, stages and the single primary crop |
| `crop_facts` | confirmed facts only — no inference can be written here |
| `crop_inferences` | hypotheses, promoted only through `confirm_inference_as_fact()` |
| `behaviour_signals` | raw behaviour log (extended additively, see below) |
| `signal_weight()` | the existing decay curve (90/180/365-day strengths) |
| `recommendations` + `emit_recommendation()` | the canonical advice object |
| `farmer_insight_feed()` | the existing unscored read model |
| `agri_knowledge_entries/index` | the AI's citable corpus |

No table was duplicated and no second recommendation model was introduced.

## 2. New schema (migration `20261103000100_intelligence_foundation.sql`)

| Table | Purpose | Key constraints |
|---|---|---|
| `farmer_intelligence_profiles` | small derived snapshot per farmer: engagement level, signal count, interest summary, computed time | PK `farmer_id` → `farmer_profiles`; never a source of truth |
| `farmer_interests` | one row per farmer per topic (`crop:wheat`, `product:urea`, `topic:pest`) with weight, confidence, source, pin, dismissal | `unique (farmer_id, topic)`; weight/confidence 0..1; explicit/pinned rows protected from learning |
| `farmer_preferences` | explicit farmer choices (algorithm settings) as small JSON values | PK `(farmer_id, key)`; value ≤ 2 KB; written only through the RPC |
| `intelligence_config` | versioned weights and limits, readable by the app | one row per knob; seeded with decay, confidence, interest, penalty and `scoring_version` |
| `intelligence_rules` | personalization rules as data (matcher v1 + weight) | unique `code`; unknown conditions are inert, never guessed |
| `intelligence_feedback` | the learning signal: helpful / not relevant / acted / dismissed / saved | idempotent per `(farmer_id, idempotency_key)`; ≤ 280-char reason |

### Additive change to `behaviour_signals`

New nullable columns only — historical rows remain valid:

- `event_key` — client idempotency key, unique per farmer when present.
- `session_id` — optional, coarse session grouping.
- `occurred_at` — device time; `observed_at` remains server arrival time. The two are never conflated.
- `context` — coarse slugs only (screen, crop, stage, topic, rank), capped at 2 KB.

## 3. RPC contracts

| Function | Who calls it | Guarantees |
|---|---|---|
| `record_behaviour_event(...)` → `bigint` | app | owner derived from `current_farmer_id()`; type/source allowlists; subject must be a lowercase slug; time within −90 days … +5 min; retries safe via event key |
| `upsert_farmer_interest(topic, weight, crop, pinned)` | app (settings) | namespaced topic; clamps weight; marks the interest explicit |
| `farmer_interest_settings()` | app (settings) | own non-dismissed interests only, including `source`, `pinned` and `crop_code`; full list, not the context's top 10 |
| `set_farmer_interest_pin(topic, pinned)` | app (settings) | own row only; changes only the pin and timestamp; never rewrites weight or provenance |
| `dismiss_farmer_interest(topic)` | app (settings) | own row only; sets `dismissed_at`; the row is retained, never deleted |
| `record_intelligence_feedback(key, verdict, recommendation, ref, reason, context)` | app | verdict allowlist; recommendation ownership checked; applies a clamped interest movement; pinned interests never moved |
| `refresh_farmer_interests(days)` → `int` | job / service role | aggregates decayed behaviour into interests, refreshes the snapshot; not executable by clients |
| `farmer_intelligence_context(farmer?)` → `jsonb` | app, AI gateway | own row only unless admin; crops, primary crop, location label, top interests, preferences, signal count, scoring version; no coordinates or contacts |
| `intelligence_recommendation_feed(limit)` | app | ranks existing canonical recommendations; returns score + component breakdown; never invents advice |
| `job_refresh_farmer_intelligence(days)` | scheduler | thin wrapper around the refresh |

## 4. Scoring v1 (transparent by construction)

```
score = clamp01(
    0.40 × (100 − min(priority, 100)) / 100
  + confidence_weight × confidence
  + min(max_interest_boost, interest_weight × matched_interest)
  + primary_crop_weight × is_primary
  − min(negative_penalty_cap, negative_count × negative_feedback_penalty)
)
```

- `matched_interest` is the strongest live interest on `crop:<crop_code>` or `topic:<kind>`.
- Weights come from `intelligence_config`; rule weights come from `intelligence_rules`
  (`primary_crop_match`, `interest_topic_match`, `explicit_preference_boost`,
  `negative_feedback_penalty`). The matcher is code; the numbers are data.
- Every row returns `components`, so a score can be explained to a farmer or an
  engineer without re-running the query.
- Negative feedback only counts inside `negative_window_days` (default 30).

## 5. Security and privacy

- **RLS on all six new tables.** Farmers read only their own rows; config and
  active rules are readable by any authenticated user; all writes are revoked.
- **Owner is never client-supplied.** Every mutation derives the farmer from the
  session (`current_farmer_id()`); the client has no parameter for it.
- **No free text.** Subjects must be slugs; context keys are allowlisted on the
  client and size-capped on the server. Searches, messages, names, phone numbers
  and exact coordinates cannot enter the behaviour log.
- **Pinned beats learned.** `source = 'explicit'` is provenance, not protection:
  only `pinned` freezes a weight. Unpinning preserves the weight and the
  explicit provenance, then lets aggregation and feedback move it again.
- **Idempotency.** Unique indexes make retries safe for both events and feedback.
- **No bypass.** The only `security definer` functions are narrow, fixed-purpose,
  set `search_path`, and re-derive the owner; clients cannot set weights directly.
- **Feedback is explicit and idempotent.** A verdict is not inferred from an
  open or a tap-through. Helpful, not-relevant and dismissed travel through
  `record_intelligence_feedback()`; the unique idempotency index makes a retry a
  no-op before any interest movement.

## 6. Client integration

| Module | Responsibility |
|---|---|
| `src/intelligence/events.ts` | vocabulary, validation, PII refusal, idempotency key, bounded outbox (100 events, newest kept) |
| `src/intelligence/client.ts` | typed RPC gateway (events, feedback, context, ranked feed); returns `null`/`false` instead of throwing |
| `src/intelligence/track.ts` | one non-blocking seam: validate → enqueue → background drain, with a single in-flight guard |
| `src/insights/InsightProvider.tsx` | records `insight_open`, `insight_act`, `insight_dismiss` at the three existing actions |

The app builds and runs with no backend: `getSupabaseClient` returns `null`, events
stay queued on the device, and no screen is affected.

## 7. How future features connect

- **Personalized home feed** → `intelligence_recommendation_feed()` replaces the
  local ordering in `InsightProvider`; the existing `Insight` contract maps 1:1.
- **Personalized AI** → pass `farmer_intelligence_context()` into `POST /ai/ask`'s
  `context`; the gateway already accepts crop, stage and district.
- **Product / dealer ranking** → read `farmer_interests` and the same config
  weights; do not add a second scoring formula.
- **Algorithm controls** → `farmer_preferences` + `upsert_farmer_interest()` are
  the write path; `intelligence_config`/`intelligence_rules` are the tunables.
- **Notifications** → select from the ranked feed, not from raw `recommendations`,
  so the order matches the screen.
- **Regional intelligence** → `intel_feed()` and `crop_reports` remain the source;
  interest and scoring decide ordering only.

## 8. Phase 2 plan (precise)

1. **Apply and backfill.** Run the migration through `supabase/apply-all.sql`,
   then `select job_refresh_farmer_intelligence(90);`.
2. **Wire the feed.** Replace `activeForCrop` ordering with
   `intelligence_recommendation_feed()` behind the existing provider, keeping the
   local document as the offline fallback.
3. **Interest settings UI.** Implemented. `InterestsScreen` reads
   `farmer_interest_settings()`, pins/unpins through
   `set_farmer_interest_pin()`, and soft-removes through
   `dismiss_farmer_interest()`. The context also carries provenance and pin state
   for AI/UI consumers. No scoring logic is added on the client.
4. **Feedback capture.** Implemented. The insight sheet offers "Helpful / Not
   relevant" only when one unambiguous server recommendation stands behind the
   local insight; dismissal submits the existing `dismissed` verdict. Opening
   and acting remain separate behaviour signals. Every submission uses a
   deterministic idempotency key, so a retry cannot record a second verdict or
   move an interest twice.
5. **AI context.** Implemented in Phase 2D. `/ai/ask` loads
   `farmer_intelligence_context()` through a JWT-scoped client, derives the farmer
   only from the verified token, and sends a bounded crop/location/interest block
   to the model. Answers carry `scoring_version`, context availability, the
   categories actually used and published knowledge slugs. Context failures fall
   back to the existing knowledge-only path rather than failing the request.
6. **Emission.** **Implemented in Phase 4.** Generate recommendations from
   knowledge + usable weather via the canonical table and `refresh_farmer_recommendations()`,
   with per-cause dedupe keys and a bounded per-farmer refresh.
7. **Evaluation harness.** Fixed farmer fixtures + expected ordering; assert score
   components, not just order, so a weight change is explainable.
8. **Guardrails.** Cap boosts, monitor concentration (one topic dominating a feed),
   and expose a "why am I seeing this?" panel fed by `components`.

## 9. Acceptance criteria (Phase 1) — evidence

| Criterion | Evidence |
|---|---|
| Meaningful events recorded with owner, type, time, context | `record_behaviour_event` + RLS policy + client tests |
| Structured intelligence profile | `farmer_intelligence_profiles`, refreshed by `refresh_farmer_interests` |
| Explicit preferences stored | `farmer_preferences` + `upsert_farmer_interest` |
| Configurable rules | `intelligence_rules` + `intelligence_config`, read by scoring |
| Reliable event history | append-only table, unique `(farmer_id, event_key)`, prune job unchanged |
| Duplicate protection | partial unique indexes on events and feedback |
| No unnecessary PII | slug-only subjects, allowlisted context, no coordinates/contacts |
| RLS preserved | 6/6 tables enabled; writes revoked; policies inspected |
| No duplicate business logic | scoring reads `recommendations`; no second recommendation table |

## 10. Verification performed

```
npm run lint:migrations   → pass (33 files, 73 tables, 73 with RLS, 92 functions)
npm run db:bundle          → apply-all.sql regenerated (9,729 lines)
npm run typecheck          → pass
npm run lint               → pass (design system)
npx vitest run             → 371 passed, 33 failed, 1 skipped (405)
                             (33 failures pre-date Phase 1: UI-redesign backlog)
npx vitest run src/intelligence → 14/14 pass
npm run build              → pass
```

**Not verified:** the SQL has not been executed against PostgreSQL. This
environment has no local Postgres, no container runtime and no Supabase CLI, so
the migration is checked statically (delimiters, references, RLS coverage,
duplicate objects, set-returning functions) and reviewed by hand. RLS behaviour is
established from the policies, not from a live two-account test. Apply to a
staging project before production, then run the two-account isolation check.

## 11. Deployment steps

1. `npm run db:bundle`
2. Apply `supabase/apply-all.sql` in the Supabase SQL editor (single transaction).
3. Verify: `select count(*) from public.intelligence_config;` → 8;
   `select count(*) from public.intelligence_rules;` → 4.
4. Run `select public.job_refresh_farmer_intelligence(90);` after the first day of
   traffic.
5. No Edge Function changed in Phase 1; no redeploy is required.

## 12. Phase 2D runtime reliability (2026-11-04)

The AI timeout was diagnosed rather than widened:

- The non-model path answers in about 1.7 s; the Gemini path hit the 25 s abort.
- The published corpus is small (largest entry 306 characters), and the bounded
  context block is smaller still, so prompt size was not the cause.
- Gemini 3.8 Flash defaults to `thinkingLevel: medium`. `/ai/ask` now explicitly
  requests `thinkingLevel: low`; diagnosis intentionally leaves the default
  unchanged. The low-thinking request reached Gemini in roughly 1–5 s instead of
  timing out.
- A bounded Flash-Lite fallback was trialled and removed: it took 29.8 s and did
  not produce an answer, so it made failure slower rather than more reliable.
- The remaining live failure is the provider: Gemini returns `503 UNAVAILABLE`
  (“currently experiencing high demand”), with `429 RESOURCE_EXHAUSTED` after
  rapid retries. Health remains configured and active; the application returns a
  clear 502 and the Scan UI falls back to local guidance.
- Deployed staging function: version 8, model `gemini-3.8-flash`, low thinking for
  ask. A successful authenticated answer could not be obtained, so Phase 2D is
  not marked end-to-end complete.

## 13. Phase 3 — knowledge engine (2026-11-03)

The Phase 3 implementation record is in
[`docs/PHASE-3-KNOWLEDGE-ENGINE.md`](PHASE-3-KNOWLEDGE-ENGINE.md). It covers the
source registry and evidence tiers, natural-language English/Urdu retrieval,
source-labelled citations, the retrieval-only provider fallback, migrations
applied to staging, live retrieval evidence, and the remaining Gemini and
corpus limitations. Phase 2D remains open and is not subsumed by this work.

## 14. Phase 4 — personalized recommendation engine (2026-11-03)

The Phase 4 implementation and acceptance evidence are in
[`docs/PHASE-4-RECOMMENDATIONS.md`](PHASE-4-RECOMMENDATIONS.md). It adds the
validated local-crop → server-context sync, evidence-backed generation from
published knowledge and usable weather, scoring v2 with crop/stage/interest/
evidence/region/recency/feedback components, the bounded refresh cooldown, and
the existing `CropCard` presentation with reasons, trust labels, safe sources and
English/Urdu feedback. Migrations `20261103000700` and `20261103000800` are
applied to staging; the full migration chain is 40 files.

The App suite remains at its documented accepted baseline of 33 failures; no
Phase 4 regression was found.

## 15. Phase 5 — proactive alerts (2026-11-04)

Phase 5 extends the canonical recommendation with alert metadata and uses the
existing `notification_events` pointer as the inbox. It does not create an alert
table or screen. The implementation and staging evidence are in
[`docs/PHASE-5-ALERTS.md`](PHASE-5-ALERTS.md).

- Active live causes are direct severe-weather observations only (WMO 95/96/99,
  65/67/82, 75/86). No pest/disease outbreak is inferred from weather.
- Knowledge alerts require an active, time-bound rule citing a published verified
  entry and a specific crop/stage. No live knowledge rule is active; the staging
  fixture was removed.
- `refresh_farmer_alerts()` is service-only and idempotent; `prepare_my_alerts()`
  is the JWT-derived authenticated seam. The feed respects category/in-app
  preferences, dismissal and validity.
- The existing `CropCard`, bell, inbox and Profile settings list are the only UI
  surfaces. Alert settings has an honestly disabled push control because no push
  sender is configured.
- Migration `20261103000900` is applied to staging; the chain is 42 files after
  the Phase 5.1 migration. The staging migration ledger is still incomplete; see
  `docs/PHASE-5.1-ADVISORIES-FORECAST.md`. The Phase 5/5.1 focused suite is
  25/25; unit is 420 passed, 1 skipped. The App suite remains the accepted 64/33
  baseline.
- Phase 6 had not been started at the time of this phase.

## 16. Phase 5.2 — evidence and review (2026-11-04)

Phase 5.2 adds the review dossier around the existing knowledge, advisory and
forecast-rule rows. It does not add a second knowledge or alert engine. The full
implementation, audit, lifecycle, security model, test evidence and handover are
in [`docs/PHASE-5.2-EVIDENCE-REVIEW.md`](PHASE-5.2-EVIDENCE-REVIEW.md).

- `agri_evidence_items` records source identity, document, dates, language,
  crop/topic/district/stage applicability, classification, separate source/
  applicability/agronomic checks, validity, version and supersession.
- `agri_evidence_reviews` is append-only. `agri_review_authorities` separates
  named `evidence_reviewer` and `content_manager` authority from `admin`; no
  authority was seeded.
- Publication/verification/activation triggers require a published evidence
  dossier. The existing Phase 5.1 verification and threshold checks were not
  weakened. The inactive spray-wind rule remains inactive.
- `recommendations.evidence_item_id` and `decision_trace` provide a farmer-safe
  explanation and an internal reviewer trace without another event log.
- The reviewer workspace is reached only when the server returns review
  authority; it covers queue, detail, checks, approval/rejection, correction,
  publication, expiry, supersession and history in English and Urdu.
- Migrations `20261103001100`–`20261103001300` are applied to staging. The bundle
  is now **45 migrations**; the staging ledger remains **23** and was not
  fabricated. The transaction-scoped staging suite passed **30/30** checks and
  left no fixtures; a separate cross-farmer trace check was refused. The full
  non-App suite is 420 passed, 1 skipped. Real reviewer names, source permission
  and threshold sign-off remain human dependencies, so real approval/activation
  stays closed.
- Phase 6 had not been started at the time of this phase.

## 17. Phase 6 — personalization completion (2026-11-04)

Phase 6 completes the backend personalization contract on the existing
interests, preferences and ranked-feed model. The full implementation, staging
evidence and remaining limitations are in
[`docs/PHASE-6-PERSONALIZATION.md`](PHASE-6-PERSONALIZATION.md).

- `farmer_preferences.key = 'recommendations'` stores explicit `muted_kinds` for
  the six emitted recommendation types. A missing row means every type is
  enabled; `clear_farmer_recommendation_preferences()` restores that default.
- `farmer_interests` now has an explicit crop/topic contract:
  `set_farmer_interest_preference()` creates a pinned `normal` (0.65) or `high`
  (1.00) priority, `suppress_farmer_interest()` creates an explicit suppression
  even with no learned history, and `clear_farmer_interest_preference()` removes
  only the explicit row. `farmer_interest_preferences()` reads these rows
  including suppressed state.
- `intelligence_recommendation_feed()` applies type mutes and crop/topic
  suppression over the unchanged internal scorer. Canonical recommendation rows
  and feedback are retained, so restoration is immediate. Alert categories
  remain the separate `alerts` preference; recommendation choices do not rewrite
  them.
- Learning is subordinate to explicit choices: explicit rows are pinned, feedback
  cannot move their weights, and the old remove RPC clears an explicit row rather
  than leaving an unintended suppression behind.
- Migrations `20261103001700` and `20261103001800` are applied to staging. The
  bundle is now **50 migrations**; migration lint reports 79 tables (79 RLS) and
  156 functions. The transaction-scoped staging suite passed **66/66** checks and
  left no fixtures. Typecheck, design lint, 420 unit tests and the production
  build passed.
- Deliberate limits: no farmer-facing UI; no per-farmer frequency preference
  (the pull feed already has a 12-row cap and 15-minute cooldown; alerts have a
  3-row cap); no push delivery or production deployment. The next priority is
  Phase 8 integration and launch-readiness work rather than another feature
  phase.

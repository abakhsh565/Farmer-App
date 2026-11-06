# Phase 4 — Personalized Recommendation Engine

Status: **implemented and staging-verified** on 2026-11-03.

Phase 4 adds a deterministic, server-side producer for the canonical
recommendation object. It does not create a second recommendation model, a
second crop store, or a client-side ranking formula. Home still has one
recommendation area: the existing `CropCard`, backed by
`intelligence_recommendation_feed()`.

Phase 5 is documented separately in
[`docs/PHASE-5-ALERTS.md`](PHASE-5-ALERTS.md). Phase 2D's live Gemini generation
remains a separate, open limitation.

---

## 1. What was reused

| Existing object | Phase 4 use |
|---|---|
| `crop_instances` | canonical crop, stage and primary-crop context |
| `recommendations` | the only advice rows; no new advice table |
| `intelligence_recommendation_feed()` | the only ranked read model, extended with Phase 4 fields |
| `agri_knowledge_entries` / `agri_knowledge_sources` | evidence-backed source of generated advice |
| `farmer_interests` | explicit, learned and pinned topic matching |
| `behaviour_signals` / `refresh_farmer_interests()` | learned-interest input |
| `intelligence_feedback` | helpful, not-relevant and dismissed signals |
| `intelligence_config` / `intelligence_rules` | versioned weights and rule data |
| `CropCard` / `InsightFeedback` | one Home surface and one feedback control |

No paid API, embedding service, custom ML training or new external integration
was added. Gemini is not on the generation path.

## 2. Data flow

```text
local crop document (offline-first)
        │  validated catalog code + server stage + primary
        ▼
prepare_my_recommendations(p_crops)
        │
        ├─ sync_my_crops() ──► crop_instances (app_synced only)
        │                         closes only stale app-owned rows
        │
        └─ refresh_farmer_recommendations() [service path]
                 │
                 ├─ published knowledge, verified/supplementary only
                 ├─ crop + stage + region filters
                 ├─ interest/pin matching
                 └─ usable weather reading, when coordinates exist
                          │
                          ▼
                 canonical recommendations
                 (bilingual copy, evidence, reason, rule version)
                          │
                          ▼
              intelligence_recommendation_feed()
                          │
                          ▼
              existing CropCard / PersonalizedAdvice
```

`prepare_my_recommendations()` is the authenticated seam. It derives the farmer
from the JWT, synchronizes the crop context and refreshes at most once per
configured cooldown (15 minutes). `refresh_farmer_recommendations(uuid)` is
service-role only; `job_refresh_all_recommendations()` is the scheduler wrapper.

## 3. Schema and migrations

- `supabase/migrations/20261103000700_recommendation_engine.sql`
  - adds bilingual recommendation copy, action labels, evidence tier, source URL,
    reason code/context and rule version;
  - adds `crop_instances.app_synced` and
    `farmer_intelligence_profiles.recommendations_refreshed_at`;
  - adds the configuration/rules, sync/generation/preparation RPCs and feed v2.
- `supabase/migrations/20261103000800_recommendation_refresh_cooldown.sql`
  - corrects the initial primary-crop capture in `sync_my_crops()` so a no-op
    synchronization leaves the cooldown intact.
- `supabase/apply-all.sql` regenerated: **40 migrations**.

Applied to staging project `swmbmtvwgksicfnfsehg`:
`007` then `008`. No Edge Function was changed by Phase 4.

## 4. Recommendation types

The generator only emits rows where a published knowledge entry or a fresh
weather reading exists:

| `kind` | Source | Eligibility |
|---|---|---|
| `pest` | knowledge | crop-specific pest entry; verified or supplementary |
| `disease` | knowledge | crop-specific disease entry |
| `crop_stage` | knowledge | irrigation, nutrition, agronomy or stage-scoped entry |
| `weather` | existing weather reading | only a usable current reading for saved coordinates; never inferred |
| `market` | knowledge | only when a published market entry exists |
| `general` | knowledge | general entry matched to an explicit/learned interest |

Community-tier knowledge is never eligible. No title, body, action or source is
invented when the underlying data is absent.

## 5. Scoring v2

Rows are scored by `intelligence_recommendation_feed()`; the client preserves the
returned order and never recalculates. The score is clamped to `0..1`:

```text
score = clamp01(
    0.20 × priority component
  + 0.20 × confidence
  + min(0.25, 0.50 × matched interest)
  + 0.15 × primary crop
  + 0.08 × crop match
  + 0.10 × stage match
  + 0.12 × verified evidence (supplementary = half; unknown = quarter)
  + 0.04 × region match
  + 0.04 × recency (14-day linear decay)
  + 0.08 × pinned interest
  + min(0.10, helpful verdicts × 0.05)
  − min(0.45, negative verdicts × 0.15)
)
```

The returned `components` object names every contribution, including
`matched_interest`, `rule_version` and `scoring_version`. The UI deliberately
shows the human reason and source, not score numbers or internal component names.

## 6. Safety, security and performance

- Owner comes from `current_farmer_id()` / the JWT. No RPC accepts a farmer id
  from the client.
- `recommendations` keeps RLS and client `INSERT`/`UPDATE` are denied.
- `sync_my_crops()` accepts at most 12 crops, only catalog crop codes, only the
  `crop_stage` enum, rejects duplicate crop codes, and closes only
  `app_synced` rows.
- `prepare_my_recommendations()` is authenticated-only; anonymous execution is
  denied. `refresh_farmer_recommendations()` and the batch job are service-role
  only.
- The feed filters expired rows, withdrawn rows, closed crops, dismissed rows for
  90 days, and a recommendation with two or more recent `not_relevant` verdicts.
- Duplicate generation is bounded by the per-farmer cooldown and the unique
  `(farmer_id, dedupe_key)` live-row index. A repeat prepare returns `0` rather
  than rewriting or duplicating rows.
- Queries are bounded: maximum 12 generated rows per farmer, maximum 50 returned
  by the feed, maximum 12 synced crops, and a 15-minute refresh cooldown.
- Source links are HTTPS-only in the database and again at the UI boundary.
- Pinned interests are protected by the existing feedback RPC; negative feedback
  does not move a pinned or explicit weight.

## 7. Frontend integration

`CropCard` remains the only Home recommendation area.

- When the server feed is ready, the card shows up to three server-ranked rows
  with category, title/body in the active language, a localized reason, evidence
  trust, source label, safe source link, time and the existing Helpful /
  Not relevant controls.
- When the server is unavailable, it leaves the existing local insight document
  and its sheet actions unchanged.
- Loading, empty, error and offline states are centralized in
  `personalizationNotice()` and tested.
- English and Urdu copy is included; Urdu uses the existing `dir="rtl"` document
  direction set by `LocaleProvider`. No physical-direction utility was added.
- The source URL is rechecked in the component; a malformed or `http://` value
  cannot become a link.

## 8. Verification

### Static and focused gates

```text
npm run typecheck          pass
npm run lint               pass
npm run lint:migrations    pass — 40 files, 74 tables, 74 with RLS, 99 functions
npm run lint:functions     pass
npm run test:unit          395 passed, 1 skipped
focused Phase 4 tests      47 passed
npm run build              pass
git diff --check           pass
```

The focused suite covers the crop adapter, feed contract, gateway preparation,
personalized-feed statuses, source-trust/reason rendering, English/Urdu, RTL and
the four Home states.

### App suite baseline

```text
npm run test:app → 64 passed, 33 failed
```

This is exactly the accepted pre-Phase-4 UI-redesign baseline recorded in
`docs/PHASE-3-ACCEPTANCE.md` (371/33/1 before Phase 1; current App subset
64/33/9 files). No Scan, assistant, feed-contract or Phase 4 test is in the
failure set. The baseline is not reported as green.

### Staging data and retrieval evidence

Using authenticated demo-farmer contexts and then removing the generated test
rows:

- Farmer A (cotton + wheat) received **6** recommendations. The verified Punjab
  Agriculture Department pink-bollworm threshold ranked first.
- Farmer B (wheat) received **3** wheat recommendations; cotton count was **0**
  and the other farmer's rows visible to B were **0**.
- A stage-scoped fixture produced `reason_code = crop_stage` and
  `stage_match = 0.10`; the live corpus currently has `applies_to_stages = null`
  for all entries, so ordinary live rows explain crop relevance instead.
- A pinned `crop:cotton` interest produced `pinned_interest = 0.08` and
  `matched_interest = 0.8`; after a negative verdict its weight remained `0.8`
  and `pinned = true`.
- Helpful feedback raised the verified row from **0.90 to 1.00**.
- One dismissed whitefly recommendation disappeared. Two `not_relevant`
  verdicts removed the supplementary pink-bollworm row. The feed went from 6 to
  4 rows.
- Repeating prepare inside the cooldown returned **0**; the live row count stayed
  **6**.
- Expiring one row moved the feed from **3 to 2** and the expired title count to
  **0**.
- `community` rows in the feed: **0**.
- `authenticated` insert/update on `recommendations`: **false**.
- `authenticated` execute of `refresh_farmer_recommendations`: **false**.
- `anon` execute of `prepare_my_recommendations`: **false**.
- The explicit test cleanup removed its rows. The running demo app later
  synchronized 3 crops and generated 6 recommendations through
  `prepare_my_recommendations()`; no `p4:` feedback or test interest rows remain.

The weather branch is implemented against `latest_weather()`, but no live weather
recommendation was generated in this run because the test farmers have no saved
coordinates/usable current reading. The existing Weather card remains the
canonical weather surface.

## 9. Limitations and decisions

- The live corpus has one verified and seven supplementary entries; all
  `applies_to_stages` values are currently null. The stage path is implemented
  and fixture-tested, but broader stage coverage needs reviewed metadata.
- No live weather recommendation is claimed until a farmer has saved
  coordinates and a usable current reading.
- Market recommendations are supported only if a published market entry exists;
  none is generated from raw market rows.
- Crop synchronization requires network and an account. Guests and offline users
  keep the existing local fallback; no server recommendation is fabricated.
- The 33 App-suite failures remain the accepted historical baseline, not Phase 4
  success and not a Phase 4 regression.
- The Notion PRD write remains blocked by the approved-tool permission issue
  recorded in Phase 3; this documentation is local and no Notion write was
  retried.

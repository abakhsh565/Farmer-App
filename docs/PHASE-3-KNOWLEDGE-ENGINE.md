# Phase 3 — Agricultural Knowledge Engine & RAG

Status: implemented and applied to staging. Phase 2D remains open because Gemini
has not produced a successful live generated answer. Phase 3 retrieval and its
non-model fallback are live-verified.

Final acceptance: **ACCEPTED** on 2026-11-03 against the named pre-existing
App-suite baseline in [`docs/PHASE-3-ACCEPTANCE.md`](PHASE-3-ACCEPTANCE.md).
This does not close Phase 2D or make the full App suite green.

Lifecycle completion status (2026-11-05): the acquisition, withdrawal,
licence, stage/district retrieval and health-monitoring code is implemented and
has passed the local static gates, but migration
`20261105000100_knowledge_lifecycle_completion.sql` has **not** been applied to
staging. No persisted-state or runtime lifecycle test has been run, so Phase 3
lifecycle completion is **not** claimed complete. See §8 for the exact gap.

## 1. What existed before

- `agri_knowledge_entries` with bilingual title/body, slug, version, crop, stage,
  topic, provenance and publication state.
- `agri_knowledge_index` with a nullable embedding column; no embeddings are
  populated.
- `ai_knowledge_search(text, text, integer)` using strict English full-text
  search, with a crop preference but no source/trust metadata.
- `/ai/ask` retrieved up to four entries, built a grounded prompt, checked farmer
  context through the JWT-scoped RPC, and returned citations and metadata. On a
  provider failure it returned 502 and the Scan screen used local guidance.
- The Scan conversation accepted follow-ups through the real service gateway,
  with English/Urdu RTL, loading and offline states.

The gaps were: source identity/reliability and dates were not structured;
entries were not classified by problem, symptom or region; strict search failed
natural-language questions; Urdu body text was not searched; source trust was
not visible in the UI; and provider failure discarded the retrieved knowledge.

## 2. What was implemented

### Knowledge schema and source registry

- `agri_knowledge_sources`: publisher, HTTPS reference, source type, coverage,
  verification status, review time and notes.
- Entry classification: `problem_type`, `symptoms`, `regions`, `source_code`,
  `source_url`, publication/update/access dates, and `evidence_tier`
  (`verified`, `supplementary`, `community`).
- A verified tier requires a named source, HTTPS URL and access date at the
  database level. The seven existing editorial summaries are explicitly
  supplementary; one official Punjab Agriculture Department economic-threshold
  entry is source-verified.
- The source registry records Punjab Agriculture Department as verified for the
  threshold page. UAF, DPP and CABI PlantwisePlus are registered as candidate or
  supplementary sources; they are not cited as official approval and no product
  claim is attached to an unchecked label.

### Retrieval

- `ai_knowledge_search` now returns source/trust/classification metadata.
- It searches English and Urdu titles/bodies, topic, problem type, symptoms and
  slug.
- It first tries strict content terms, then a bounded OR fallback after removing
  English question stopwords. This fixes natural questions such as “How do I
  control pink bollworm in cotton?” without making “Who won the cricket match?”
  match general words such as “the”.
- Selected-crop matches rank first (`NULLS LAST`), followed by evidence tier and
  score. Results are capped at eight.
- The RPC is executable by `service_role` only; `anon` and `authenticated` cannot
  execute it. Source rows are service-only and have RLS enabled.

### Assistant integration

- `/ai/ask` loads the JWT-scoped farmer context before retrieval, then ranks with
  the same crop/district the model would see.
- Citations contain the entry title, slug, version, publisher, HTTPS source URL,
  evidence tier and dates.
- If the model is unconfigured, unavailable, over quota or times out, the gateway
  returns HTTP 200 with `generation: "retrieval"`, the top published entry as a
  direct excerpt, its citations, and an explicit caveat. It does not retry, claim
  the text was model-generated, or expose provider details.
- The prompt tells the model to prefer verified entries, treat supplementary
  entries as context, and never present community observations as confirmed.

### Frontend

- The existing Scan conversation renders a localized sources block under answer
  text: title, trust badge, publisher, version, date and a safe HTTPS link.
- Retrieval-only answers display “Published guidance only · the AI model is
  unavailable”; model answers say they are AI-assisted and grounded in the
  sources below.
- English and Urdu catalog entries were added; the existing design tokens and RTL
  direction are reused. No duplicate assistant screen was created.

## 3. Files and migrations

- `supabase/migrations/20261103000400_knowledge_engine.sql`
- `supabase/migrations/20261103000500_knowledge_retrieval_fix.sql`
- `supabase/migrations/20261103000600_knowledge_write_lock.sql`
- `supabase/apply-all.sql` regenerated (38 migrations)
- `supabase/functions/_shared/knowledge.ts`
- `supabase/functions/ai/index.ts`
- `src/services/types.ts`
- `src/scan/analyze.ts`
- `src/screens/ScanScreen.tsx`
- `src/i18n/catalog.ts`
- `src/intelligence/knowledge.test.ts`
- `src/App.test.tsx`

## 4. Verification

### Static and unit gates

- `npm run typecheck`: pass
- `npm run lint`: pass
- `npm run lint:migrations`: pass — 38 files, 74 tables, 74 with RLS, 95 functions
- `npm run lint:functions`: pass
- `npm run test:unit`: 380 passed, 1 skipped
- Focused Scan suite: 7 passed, including source trust, retrieval label, loading,
  offline fallback and Urdu/RTL
- `npm run build`: pass
- `npm run test:app`: 64 passed, 33 failed in 9 pre-existing UI-redesign tests;
  the named baseline and evidence are in `docs/PHASE-3-ACCEPTANCE.md`. The
  failures are not hidden and are not counted as Phase 3 success.

### Staging migration and retrieval

Migration applied transactionally to the staging database. Invariants:

```text
sources=5, published_entries=8, verified_entries=1, supplementary_entries=7
sources_rls=true
anon_can_search=false, auth_can_search=false, anon_can_read_sources=false
```

Natural-language retrieval:

```text
How do I control pink bollworm in cotton? → cotton-pink-bollworm-etl (verified,
  Punjab Agriculture Department), cotton-pink-bollworm, cotton-whitefly
کپاس میں گلابی سنڈی کا علاج → cotton-pink-bollworm-etl first
Who won the cricket match? → no rows
```

### Live gateway

- `ai` function: **version 9**, ACTIVE, `verify_jwt: true`.
- `/ai/health`: 200; Gemini configured, `gemini-3.8-flash`.
- One live covered-question call returned **HTTP 200 in 28.9 s** with
  `generation: "retrieval"`, the verified Punjab citation and a clear caveat.
  The model did not answer; the fallback did, which is the intended behaviour.
- This does not prove live Gemini generation. Phase 2D remains pending.

## 5. Free-tier dependencies and limitations

- No new paid API, vector database or embedding service was introduced.
- PostgreSQL full-text search is the retrieval engine; embeddings remain NULL and
  responses disclose keyword mode.
- Gemini remains subject to the existing free-tier capacity/quota failures. The
  fallback is useful but the live model path is still unreliable.
- The corpus is intentionally small: eight published entries, one verified and
  seven supplementary. Coverage is the main product limitation, not retrieval
  infrastructure.
- No community-authored knowledge entries exist yet; the `community` tier and
  source type are modelled, but expert validation and moderation workflows for
  contributing them remain future work.

## 6. Remaining work

1. Restore Gemini capacity or quota through the owner decision recorded in the
   Phase 2D audit; then repeat authenticated live generation and two-farmer
   isolation evidence.
2. Have an agronomist convert more primary extension material into verified
   entries with source/date references; do not promote editorial summaries by
   assertion.
3. Add the expert-validation workflow before accepting community submissions as
   knowledge. Community observations must never inherit the verified badge.
4. Revisit semantic retrieval only if keyword retrieval demonstrably misses
   farmer questions and a free, permitted embedding path exists.

Phase 3 is implemented and its retrieval/fallback path is live-verified. The
Recommendation Engine and other roadmap phases have not been started.

## 7. Handover status

This file is the local implementation record. The Notion PRD append was attempted
against the existing Farmer App PRD page, but the connected Notion server rejected
both `notion-update-page` and `notion-create-pages` as “not in the set you
approved”.The PRD page itself was not changed. Approve Notion write access (or
copy this section into the PRD) before treating the Notion handover as complete.

## 8. Knowledge lifecycle completion (2026-11-05)

Status: implemented in source and statically verified; **applied to staging on
2026-11-08** (including forward-only gate `20261108130627`), but **not
runtime-verified** under a signed-in lifecycle. This section adds to the earlier
retrieval work; it does not replace the acceptance record in §1.

### Acquisition and source terms

- `agri_knowledge_ingestion_runs` records one audited acquisition attempt per
  source document: idempotency key, request hash, source, document URL/title,
  publication and access dates, licence, counters, error, duplicate/rejection
  detail and terminal status (`running`, `ok`, `partial`, `failed`).
- `agri_knowledge_ingestion_items` records only accepted items, with a unique
  content hash per source. A replayed key returns the persisted run; the same key
  with a different payload is rejected instead of importing twice.
- `agri_ingest_knowledge_document(text, text, jsonb, jsonb)` is service-role only.
  It requires an active source with a recorded `granted` or `not_required`
  permission, a licence, a direct HTTPS document URL, a non-future publication
  date and a future validity end. It validates bilingual title/body, crop,
  stage, district, problem type and evidence classification.
- Accepted items create an **unpublished** knowledge row and a **draft** evidence
  dossier, and append a `create` event to the existing review ledger. The RPC
  never approves or publishes anything; the existing reviewer/content-manager
  path remains the only route to verified publication.
- Rejections and duplicates are recorded in the run detail and counted. A blocked
  source or invalid document produces a failed run rather than an unrecorded
  exception.
- `agri_set_source_terms(...)` is admin-only and records a human permission and
  licence decision. No permission or reviewer is seeded. `app_editorial` is
  explicitly `not_required`; `punjab_agri` remains `unknown` and therefore blocks
  new ingestion until a human records the permission. Existing published entries
  are not changed by that block.

### Lifecycle, withdrawal and monitoring

- Evidence status now has an explicit `withdrawn` state, with `withdrawn_at` and
  `withdrawal_reason`; the review ledger accepts `withdraw`.
- `agri_withdraw_evidence(uuid, text)` requires content-manager authority. It
  does not delete history: it unpublishes the target, marks the dossier withdrawn
  and appends the reason to the ledger and audit log. The existing withdrawal
  trigger then withdraws recommendations built from the affected knowledge
  version.
- Publishing a new version of a slug unpublishes older versions. Withdrawal is
  distinct from expiry; re-publishing clears the withdrawal marker, but an old
  recommendation is never silently revived.
- `agri_knowledge_health()` returns aggregate source-permission readiness,
  lifecycle counts, stale/expiring published guidance, ingestion outcomes and
  active authorities. It returns no farmer data; service/admin/reviewer access is
  required.

### Retrieval and assistant integration

- `ai_knowledge_search(text, text, text, integer, text)` now accepts a crop stage,
  excludes withdrawn, unpublished and expired evidence, filters by explicit
  district applicability, and ranks crop first, then stage, district, evidence
  tier and text score. Legacy province-wide entries remain eligible when they
  carry no district list.
- Each hit returns `stages`, `districts`, `source_publisher`, `source_license`
  and a `stale` flag in addition to the existing source/date/tier metadata.
- `retrieveKnowledge` passes the stage and maps the new metadata. `/ai/ask` and
  `/ai/diagnose` pass the effective crop stage; citations prefer the publisher
  and a stale source adds an explicit caveat. Unreviewed or withdrawn evidence is
  never returned as verified advice.

### Verification actually run

- `npm run lint:migrations`: pass — 68 files, 87 tables, all 87 with RLS, 186
  functions.
- `npm run typecheck`: pass.
- `npm run lint:functions`: pass — 15 function sources and client routes.
- `npm run lint`: pass.
- `npm run check:ingestion-lifecycle`: 36/36 passed.
- `npm test`: 570 passed, 1 skipped, 60 files.
- `npm run build`: pass — 2,161 modules.
- `npm run db:bundle`: 68 migrations bundled into `supabase/apply-all.sql`.
- `git diff --check`: pass (CRLF advisory only).
- GitHub Actions run
  [`42117332553`](https://github.com/abakhsh565/Farmer-App/actions/runs/42117332553):
  the dedicated `ingestion-lifecycle` job passed, including
  `npm run check:ingestion-lifecycle`. The separate `verify` job passed type
  check, design lint, migration chain and Edge contracts, then failed in the
  pre-existing App/credential tests (`src/testing/credential.ts#19` cannot find
  the OTP group; `src/App.chat.test.tsx#93` cannot find the Shop label). The
  production build was skipped because that earlier test step failed. The full
  workflow is therefore **not** green.

### Staging gap and external dependencies

- The lifecycle migration has **not** been applied to staging. This environment
  has no `psql`, no SQL-write Management API credential and no writable Supabase
  MCP tool; the read-only Supabase MCP call also returned permission denied. No
  `agri_knowledge_ingestion_runs` relation, RPC behaviour, withdrawal propagation
  or recommendation invalidation was observed on a live database.
- Applying it needs an approved SQL-write path and a staging-only transaction.
  Do not use `supabase db push`; do not apply to production.
- Real operation still needs: an admin to record a permitted official source's
  licence/permission; appointed evidence reviewers and content managers; and an
  agronomist to review the draft dossiers. None of those people or permissions
  are fabricated here.

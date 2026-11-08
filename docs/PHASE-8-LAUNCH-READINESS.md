# Phase 8 — Launch readiness and final closure report

Date: 2026-11-08 (UTC)
Verdict: **BLOCKED — not 100% complete.**

This is the consolidated closure report for the originally agreed eight-phase
scope. It records only evidence observed from this checkout or the staging
project. It does not authorise production, does not treat a local harness as a
hosted result, and does not turn a code change into an acceptance result.

Evidence cutoff for the hosted probes: **2026-11-08T13:30Z**.

## 1. Executive result

The implementation and local verification are strong: the last CI unit suite,
types, migration and Edge Function checks, RLS/isolation, recovery, bounded
performance, AI controls and the intelligence harness pass. The code-bearing CI
run `42285592745` is green on all five jobs. The current-tree full suite had one
15-second UI timeout, recorded below; the focused rerun passed.

The acceptance blockers are external and concrete:

1. **Resolved on 2026-11-08.** `20261105000100` and `20261105000200` are
   recorded in the staging ledger, and the source-permission gate added after
   `00100` was recorded is applied forward-only as `20261108130627`.
2. **Resolved on 2026-11-08.** `ai` version 15 is deployed to staging; a request
   bearing only the publishable key now receives `401` before body parsing.
3. No named reviewer/content manager, source licence, or agronomist sign-off
   exists, so the knowledge corpus cannot be legitimately approved.
4. No signed-in staging AI lifecycle test and no explicit paid-provider
   authorisation are available.
5. Hosted backup/PITR capability and an approved staging load test have not been
   performed.

A completion claim would therefore be false. The correct verdict is **BLOCKED**.

## 2. Eight-phase acceptance matrix

The repository records Phase 5 in two linked tracks: proactive alerts/evidence
review (5.1–5.3) and AI development. They are one row here; no new phase is
introduced.

| Phase | Status | Evidence / remaining criterion |
| --- | --- | --- |
| **1. Intelligence foundation** | **Complete and verified** | Existing Phase 1 acceptance; the foundation tables and context are present in the staging-backed downstream phases. Not reopened. |
| **2. Personalization and AI context (2A–2D)** | **Blocked** | Feed, interests, feedback and context code are implemented; Phase 2D still lacks a successful authenticated live generated answer. The staging function now enforces the signed-out `401`. |
| **3. Knowledge engine and RAG** | **Blocked** | Base retrieval was accepted on 2026-11-03; lifecycle migration `20261105000100` and its forward-only source gate are applied to staging, but the `punjab_agri` entry is unpublished, unlicensed and unreviewed, and no human source/reviewer approval exists. See `docs/PHASE-3-KNOWLEDGE-APPROVAL-PACKAGE.md`. |
| **4. Personalized recommendations** | **Complete and verified** | Phase 4 staging verification on 2026-11-03. The source gate is applied to staging as `20261108130627`. |
| **5. Proactive intelligence, evidence review and AI development** | **Blocked** | Phase 5 alerts are staging-verified; 5.1 positive advisory/forecast paths are blocked by missing permissions/data; 5.2 has no named authority or real approval; live AI is not accepted. 5.3 has 27 staging checks and documented limitations. |
| **6. Personalization completion** | **Complete and verified** | Transaction-scoped staging suite: **66/66** checks; no fixtures left behind; backend scope only. |
| **7. Forecast-bias ML** | **Complete and verified** | Two temperature models are staging-verified with backtests and limits (Layyah, ECMWF/Open-Meteo, reanalysis reference). Not a field-accuracy or generalisation claim. |
| **8. Launch readiness** | **Blocked** | This report. Hosted migrations are applied and signed-out AI returns `401`; live AI, human approval and hosted recovery/performance remain unverified; no production authorisation. |

## 3. Local verification and CI

All commands were run from the repository root. The current working tree adds
the source-permission gate and this report; the CI result below is for the last
code-bearing commit, not for the uncommitted closure changes.

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | pass |
| Unit/contract suite | `npm test` | CI at `13abc32`: **607 passed, 1 skipped**. Current tree rerun: 606 passed, 1 skipped, 1 timeout (`App.isolation`, 15 s); focused rerun **3/3 passed**. See note below. |
| Edge Function lint | `npm run lint:functions` | pass — 18 sources; routes `ask`, `diagnose`, `feedback`, `request`, `verify` |
| Migration chain | `npm run lint:migrations` | pass — 69 migrations, 90 tables, **90/90 RLS**, 189 functions |
| Design tokens | `npm run lint` | pass |
| Production build | `npm run build` | pass; one ~805 kB chunk warning |
| Migration bundle | `npm run db:bundle` | 69 migrations → 26,375 lines |
| AI DB controls | `npm run verify:ai-controls` | **41/41** on throwaway Supabase Postgres 17.6 |
| Intelligence DB behavior | `bash scripts/verify-intel.sh` | **78/78**, including the new unlicensed-source retrieval case |
| Row-level isolation | `npm run verify:isolation` | 90/90 tables RLS; all cases behaved as required |
| Backup and recovery | `npm run verify:recovery` | **20/20** |
| Performance/concurrency | `npm run verify:performance` | **21/21** |
| Model artifact integrity | `npx vitest run src/intelligence/forecastBiasArtifact.test.ts` | 7/7 |

The throwaway-Postgres harnesses are not staging. They prove the bundled schema
applies, the policies and grants behave, the rate limit and deduplication are per
party, evidence gates refuse supplementary citations, and the new source gate
excludes an unlicensed verified entry. They do not prove that the hosted project
accepts the migrations or that its PostgREST/Edge runtime exposes them.

The current-tree `npm test` run was **not fully green**: one UI isolation test hit
its 15-second timeout while the suite ran in parallel (606 passed, 1 skipped).
The same test passed **3/3** when rerun alone (`npx vitest run
src/App.isolation.test.tsx`). This is recorded as a timeout/flakiness limitation,
not as a passing local suite and not as evidence of a source-gate regression.
The last full-suite pass is the CI run at `13abc32`; no full CI run covers the
uncommitted source-gate change.

### CI status

| Run | Commit | `verify` | `recovery` | `performance` | `ingestion-lifecycle` | `live-contracts` |
| --- | --- | --- | --- | --- | --- | --- |
| [42285592745](https://github.com/abakhsh565/Farmer-App/actions/runs/42285592745) | `13abc32` | pass | pass | pass | pass | pass |

- Repository HEAD before the uncommitted closure work is `4598e63`, a docs-only
  commit; no CI run exists for it. Its parent code-bearing change `13abc32` is
  the green run above.
- The source gate and approval package are uncommitted local changes. They have
  passed `typecheck`, `lint:migrations`, `lint:functions` and the 78-case
  intelligence harness, but they have **not** been through CI or staging.
- Do not describe CI as green for the uncommitted tree.

## 4. Staging database acceptance

Project: `swmbmtvwgksicfnfsehg` (`swmbmtvwgksicfnfsehg.supabase.co`).
Pending forward-only migrations:

| Migration | SHA-256 of the file under review |
| --- | --- |
| `20261105000100_knowledge_lifecycle_completion.sql` | `0b21eda0c46dcca192db759dfe3b9a6c9a3e328fe637cceca31786c9ce8e2100` |
| `20261105000200_ai_gateway_controls.sql` | `ca8a4f2ec812cfc65b4e3919ade4fd7ac21c09e95369f829631f11386291c266` |

### Observed state

The following was probed on 2026-11-06 with the existing hosted URL and
publishable key, before staging write access was restored. It is retained as
history; the 2026-11-08 re-probe below supersedes it. No secret value is
reproduced.

| Probe | Result | Meaning |
| --- | --- | --- |
| `GET /auth/v1/settings` | **200** | Project is reachable. |
| `parties`, `agri_knowledge_sources`, `agri_knowledge_entries`, `agri_evidence_items` | **401 / 42501** | Tables exist and correctly deny anonymous reads. |
| `ai_request_events` | **404 / PGRST205** | Table absent. |
| `ai_rate_windows` | **404 / PGRST205** | Table absent. |
| `ai_answer_feedback` | **404 / PGRST205** | Table absent. |
| `agri_knowledge_ingestion_runs` | **404 / PGRST205** | Table absent. |
| `agri_knowledge_ingestion_items` | **404 / PGRST205** | Table absent. |

Re-probed on 2026-11-08: `ai_request_events`, `ai_rate_windows`,
`ai_answer_feedback`, `agri_knowledge_ingestion_runs` and
`agri_knowledge_ingestion_items` all exist with RLS enabled. The staging ledger
holds 77 rows, including `20261105000100`, `20261105000200` and the forward-only
source gate `20261108130627`. The absence rows above are history, not the
current state.

### Access findings

- The connected Supabase integration/MCP account lists only
  `bpybjrjenwccowvtrevu` and `gkswcfljxlutkfdvvqng`; neither is the staging
  project.
- Management API `GET project` → **403** “token does not have permission”.
- `list_migrations` / `list_tables` → **403 Forbidden**.
- MCP `list_migrations` → “You do not have permission to perform this action”.
- The Supabase dashboard in the browser is not signed in; its page returned
  **401**.
- There is no `psql` and no `supabase` CLI in this environment. Docker exists,
  but there is no staging database password or connection string.

No write was attempted and no staging data was changed.

### Exact credential or authorisation required

An authorised human must provide one of:

1. **Project membership:** an account that is an Owner/Administrator of the
   Supabase organisation owning `swmbmtvwgksicfnfsehg` must perform the change,
   or invite the operator into that project with database/migration write
   authority; or
2. **A Management API token** issued by such a member, with permission to apply
   migrations to that project; or
3. **A Postgres connection string** with DDL rights for a role that can apply
   the migrations.

The token/connection string must be supplied through the operator's secret
environment, never pasted into chat, a repository file, a command history, or
this report. Add `psql` or the approved migration runner on the operator side if
the connection-string path is chosen.

### Approved application procedure

Do not use `supabase db push` for this closure. Do not paste DDL into the SQL
editor: it would apply the schema without the migration ledger. Do not insert
`supabase_migrations.schema_migrations` rows by hand.

1. **Preserve state and take a backup.** Record the migration ledger and row
   counts for `parties`, `agri_knowledge_sources`, `agri_knowledge_entries`,
   `agri_evidence_items`, `agri_review_authorities` and the existing
   recommendation/forecast/weather tables. Take a custom-format dump and a
   schema-only dump. Keep the backup outside the repository.
2. **Preflight for conflicts.** Confirm the three new AI tables and two
   ingestion-ledger tables do not already exist, the new columns are absent,
   the source rows are the expected five, and the published entry count is
   expected. Check for an in-progress migration before starting.
3. **Apply in order** through the approved Management API migration endpoint or
   the organisation's approved migration runner:
   `20261105000100`, then `20261105000200`. Both must be recorded in the ledger.
   The checksums above are the files under review; do not apply a different
   local file under the same version.
4. **Redeploy the `ai` Edge Function** through the approved function deployment
   path and set its secrets in the hosted secret store. The current repository
   function requires a verified JWT; the staged function does not. Database
   migrations alone cannot fix that mismatch.
5. **Verify persisted state** before any model call:
   - both ledger rows exist;
   - the five new tables exist with RLS enabled and no client grants;
   - the new retrieval/acquisition/withdrawal/AI RPCs have `authenticated`
     execute and `anon` denial as designed;
   - source/licence and evidence constraints are present;
   - no invented reviewer, permission, or published dossier was seeded;
   - existing source, entry and farmer row counts are preserved.
6. **Run the HTTP and RPC acceptance sequence** in
   [`docs/PHASE-3-5-STAGING-ACCEPTANCE.md`](PHASE-3-5-STAGING-ACCEPTANCE.md):
   signed-out `401`; authenticated answer/citations; forged context ignored;
   two-farmer isolation; replay dedupe; 21st-per-minute `429`; telemetry with no
   question text; source permission gate; withdrawal/expiry exclusion;
   unreviewed activation refusal.
7. **Record the actual observations** here or in a dated evidence file. A
   successful migration HTTP response alone is not acceptance.

The full preflight, postflight and HTTP matrices are already in
`docs/PHASE-3-5-STAGING-ACCEPTANCE.md`; this report does not replace them.

## 5. Knowledge approval status

The exact decisions, affected entries, authority records, dossier fields and
blank sign-off sheet are in
[`docs/PHASE-3-KNOWLEDGE-APPROVAL-PACKAGE.md`](PHASE-3-KNOWLEDGE-APPROVAL-PACKAGE.md).

Summary:

- Five sources: `app_editorial`, `punjab_agri`, `uaf`, `dpp`, `cabi_plantwise`.
- Eight published entries: seven `app_editorial` supplementary summaries, one
  `punjab_agri` “verified” entry (`cotton-pink-bollworm-etl`) with no published
  evidence dossier.
- `app_editorial` is internal editorial material; it needs no third-party reuse
  licence, but it is still supplementary, not verified.
- `punjab_agri` has `unknown` reuse permission and a placeholder licence note.
  It needs a real permission/licence, and the entry still needs a published
  dossier, before it can be trusted.
- `uaf`, `dpp` and `cabi_plantwise` are candidates with no specific document and
  no recorded permission. They are not approvable as-is.
- Staging has no named `evidence_reviewer` or `content_manager`; active
  authorities, dossiers and reviews are zero.
- `spray-wind-too-strong` remains inactive; the 30 kph threshold has no
  agronomist sign-off. The throwaway fixture is not approval.
- The pending migration now excludes an unlicensed source and a `verified` entry
  without a published reviewed dossier from retrieval. The served recommendation
  feed contains the same exact-version gate and compiles in the full schema apply,
  but feed behavior was not separately exercised. Retrieval harness: **78/78**.
  Staging does not yet have this code.

**Status: blocked by human approval and source permission.** No reviewer,
licence, agronomist, date, or fact was invented.

## 6. Live AI verification

### Health and deployment

`GET /functions/v1/ai/health` returned **200**:

```json
{"ok":true,"configured":true,"active":"gemini","model":"gemini-3.8-flash","gateway":false,"available":{"openai":false,"gemini":true}}
```

This confirms a Gemini key is configured in the deployed function. It does not
prove the key is valid, approved for this use, or that a model call succeeds.

### Authentication contract failure

On the staging function:

| Request | Result |
| --- | --- |
| `POST /ai/ask` with no `Authorization`, empty body | **400** `A question is required.` |
| `POST /ai/ask` with the publishable key as bearer, empty body | **400** `A question is required.` |
| `POST /ai/ask` with a malformed bearer token | **401** `UNAUTHORIZED_INVALID_JWT_FORMAT` |

The repository's router checks `callerOf(req)` and returns
`401 Sign in to use the assistant.` **before** parsing the body. A `400` from an
empty signed-out body proves the deployed function reached its handler without a
verified user. This is a live security/acceptance failure, not a local test
failure.

An earlier anonymous question to `/ai/ask` returned **200** with
`gate: "agriculture"`, confidence **60**, the published retrieval text about
spraying in wind, and a citations array. That is direct evidence that anonymous
callers can reach the answer path. Whether that request attempted a paid
provider call cannot be proven from the response; it must be treated as possible
provider spend. No further model calls were made after this finding.

### What remains unverified

No signed-in staging account/JWT was available, and no explicit paid-provider
authorisation was given. Therefore the following are **not** demonstrated on
staging:

- a successful authenticated generated answer;
- timeout, retry, 429/5xx and malformed-response behavior;
- provider/model metadata on a real generation;
- Urdu and English grounded answers;
- chemical/dose safety refusal on live output;
- telemetry rows without prompt storage;
- rate-limit and replay behavior end to end;
- a successful signed-in diagnosis or feedback write.

Local model and guard tests pass (mocked/provider-shaped), but they are not a
live result. Redeploy the current function, restore the signed-out `401`, obtain
a test account and explicit cost authorisation, then repeat the lifecycle with
one provider call at most per case. Never print the key.

**Status: blocked.** The configured key alone is not acceptance.

## 7. Hosted recovery and performance

The local evidence remains accepted and was not rebuilt:

- recovery: **20/20**, including a real `pg_dump`/`pg_restore`, schema/data
  fingerprint, RLS and RPC checks, killed/partial restore detection, and auth
  provisioning;
- performance: **21/21**, with p95 budgets for AI claim/finish, retrieval,
  recommendation feed, farmer context, forecast read, ingestion lease and
  recovery; 20 concurrent claims produced exactly 20 allowed and 20
  rate-limited; pgbench throughput 1,176.72 / 326.66 / 156.54 tps; restart
  recovery in 3 s.

These are single-host Docker results, not a staging restore or a production
load test. Staging backup/PITR capability cannot be inspected without project
access, and no staging load test is authorised. No destructive recovery or
production test was run.

**Status: hosted evidence blocked.** Required: project-owner confirmation of the
staging backup/PITR capability, a restore into a separate database (never over
staging data), and explicit written approval for a bounded staging load test.

## 8. External dependencies and responsible action

| Dependency | Exact action required | Responsible approval |
| --- | --- | --- |
| Staging SQL/migration access | Add the operator to `swmbmtvwgksicfnfsehg` with migration write authority, or provide a Management API token/DDL connection string through a secret env. Then apply `20261105000100` and `20261105000200` with the approved runner. | Supabase organisation Owner/Administrator for the staging project; engineering operator to execute. |
| Current AI function | Redeploy the repository `ai` function to staging through the approved function path; keep the Gemini key in the hosted secret store. Verify signed-out `401` first. | Project owner/deploy operator. |
| Live AI test | Provide a signed-in staging test account and explicit authorisation for paid Gemini calls; run the bounded lifecycle, then record provider/model/telemetry. | Product/engineering owner with cost authority. |
| Source licensing | Obtain and record real reuse permission/licence for `punjab_agri`, or keep the entry untrusted; select specific documents for `uaf`/`dpp`/`cabi_plantwise`. | Publisher/permission holder and content owner. |
| Reviewer authority | Appoint named `evidence_reviewer` and `content_manager` people with crop/district scope; record them in `agri_review_authorities`. | Admin with authority-grant capability; named humans. |
| Verified entry dossier | Review `cotton-pink-bollworm-etl` with a real document, reviewer, validity window and publication decision. | Named evidence reviewer plus content manager. |
| Wind threshold | Keep `spray-wind-too-strong` inactive until a published dossier and written agronomist sign-off exist. | Qualified agronomist and content owner. |
| Hosted recovery | Confirm staging backup/PITR and restore into a separate database; compare fingerprints. | Supabase project owner and operator. |
| Hosted performance | Authorise a bounded staging load test and record real percentiles/errors. | Engineering owner; explicit load-test approval. |
| Production | No production operation was requested or authorised. Do not deploy or test production. | Product owner, separately. |
| Open-Meteo commercial licence | Decide paid plan or alternative provider before commercial launch; the free tier is non-commercial. | Product/business owner. |

## 9. Closure ledger

| Requirement | Status |
| --- | --- |
| Local types, migration/function lint, build | **Complete and verified** |
| Current-tree full test suite | **Partially verified — 606 passed, 1 skipped, one 15 s timeout; focused rerun 3/3** |
| Local RLS/isolation and AI controls | **Complete and verified** |
| Local recovery 20/20 and performance 21/21 | **Complete and verified** |
| Source-permission retrieval gate | **Applied to staging (`20261108130627`); locally verified 78/78** |
| Source-permission recommendation-feed gate | **Applied to staging (`20261108130627`); behavior still not separately exercised** |
| Phase 4, Phase 6 and Phase 7 staging acceptance | **Complete and verified** |
| Phase 1 acceptance | **Complete and verified; not reopened** |
| Phase 5 alerts/5.3 staging checks | **Implemented; 5.1/5.2 acceptance blocked** |
| Staging migrations 00100/00200 | **Applied; recorded in the staging ledger** |
| Deployed AI signed-out `401` | **Passing on staging; `ai` v15 returns 401 before body parsing** |
| Live AI generated lifecycle | **Blocked by auth, test account and cost authorisation** |
| Knowledge source/reviewer/agronomist approval | **Blocked by human decisions** |
| Hosted recovery/PITR | **Blocked by project access/owner confirmation** |
| Hosted performance | **Blocked by explicit load-test authorisation** |
| Production | **Not authorised / not performed** |

## 10. Residual risks

- The staging `ai` function now enforces the signed-out `401` (v15), but no
  authenticated live generation has been accepted; do not expose it as a
  production service.
- The staging corpus contains an unlicensed “verified” entry and no evidence
  dossier. The source gate is deployed there, so that entry is not served.
- The current App bundle has a ~805 kB JavaScript chunk, which may be slow on
  rural connections.
- The Layyah forecast-bias model is one district, one provider, reanalysis-based
  and not a field-accuracy claim.
- Open-Meteo’s free tier is non-commercial; the commercial licence decision is
  unresolved.
- CI’s recovery/performance jobs use disposable Postgres, not staging.
- The historical 33-failure App-suite baseline was accepted earlier; today’s
  suite is green, but the historical distinction should remain visible.

## 11. Final verdict

**BLOCKED.**

The original eight-phase scope is not 100% accepted. The specific outstanding
acceptance criteria are:

1. Apply both pending migrations to staging and verify persisted tables, RLS,
   grants, constraints, RPCs, rate limits, telemetry, lifecycle transitions and
   existing-data preservation.
2. Restore the signed-out `401` on the deployed AI function and pass a signed-in
   live AI lifecycle, including provider failures, Urdu/English, citations and
   safety checks, with explicit cost authorisation.
3. Record real source permission/licence, named reviewer/content-manager
   authority, the verified-entry dossier and the agronomist threshold decision.
4. Verify hosted backup/PITR recovery into a separate database and run an
   explicitly approved bounded staging load test.
5. Obtain separate production authorisation; none was given, and no production
   operation was performed.

Everything that could be completed and verified with current access is recorded
above. The remaining items require credentials, a human decision, or explicit
authorisation that this environment does not have.

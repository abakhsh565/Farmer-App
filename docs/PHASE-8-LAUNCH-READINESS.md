# Phase 8 — Launch readiness

Date: 2026-11-06
Verdict: **NOT READY — BLOCKED**

This is a readiness assessment, not a launch approval. Recovery and load now
have measured, repeatable local evidence, but staging application of the latest
migrations, live provider behavior, human review, and production authorisation
remain unverified. Everything that can be verified from this environment passes.

## What passes today

All commands were run from the repository root on 2026-11-06. The CI workflow now
includes independent recovery and performance jobs; its first run against this
change set is recorded in the final delivery note.

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | pass |
| Unit/contract suite | `npm test` | **607 passed, 1 skipped, 65 files** |
| Edge Function lint | `npm run lint:functions` | pass — 18 sources, routes `ask`, `diagnose`, `feedback`, `request`, `verify` |
| Migration chain | `npm run lint:migrations` | pass — 69 migrations, 90 tables, **90/90 RLS**, 189 functions |
| Design tokens | `npm run lint` | pass |
| Production build | `npm run build` | pass; one 804.86 kB chunk warning |
| Migration bundle | `npm run db:bundle` | 69 migrations → 26,251 lines |
| Whitespace | `git diff --check` | pass (CRLF advisories only) |
| AI DB controls | `npm run verify:ai-controls` | **41/41 cases** on throwaway Supabase Postgres 17.6 |
| Intelligence DB behavior | `bash scripts/verify-intel.sh` | **76/76 cases**, including licensing, unreviewed activation, and unauthorized publication |
| Row-level isolation | `npm run verify:isolation` | every case behaved as required; 90/90 tables RLS |
| Backup and recovery | `npm run verify:recovery` | **20/20 cases** |
| Performance and concurrency | `npm run verify:performance` | **21/21 cases** |
| Model artifact integrity | `npx vitest run src/intelligence/forecastBiasArtifact.test.ts` | 7/7 |

The throwaway-Postgres harnesses are not staging. They prove the bundled schema
applies in one transaction, the policies and grants behave, the rate limit and
deduplication are per party, evidence gates refuse supplementary citations,
risk generation and feed geography work, and no client can read the control
tables. They do **not** prove a hosted project accepts the migrations or that
its PostgREST/Edge runtime exposes them correctly.

## Backup and recovery evidence

`scripts/verify-recovery.sh` starts a disposable Supabase Postgres 17.6, seeds
two farmers, crops, forecasts, knowledge and one completed AI event, then runs
a real `pg_dump` / `pg_restore` drill into a separate database. It compares a
schema/data fingerprint rather than trusting the restore exit code.

- Source fingerprint: `90 public tables | 90 with RLS | 87 policies | 190 functions | 8 knowledge entries | 10 sources | 2 farmers | 2 crops | 2 forecasts | 1 AI event | 0 orphaned rows | fccefa0f...`.
- The restored copy has the same fingerprint and also passes live checks: RLS
  still hides the AI event table, a guest/farmer cannot read it, farmer A can
  claim a new AI request, farmer B cannot finish it, retrieval returns the
  cotton knowledge, the personalized feed executes, and farmer context names
  the restored crop.
- Failure handling is exercised, not assumed: a schema-only restore is detected
  as incomplete, a killed restore is detected (`timeout` exit 124) and is
  recoverable by a clean re-restore, and a restore over a populated target is
  refused.
- The auth provisioning trigger is recreated in dependency order; a newly
  inserted auth user after restore provisions a party, so recovery covers the
  signup path as well as static rows.

Limit: this is a logical application-schema backup (`public` plus `auth.users`
data) on the same disposable Docker host. It is not point-in-time recovery, not
a hosted Supabase backup, and not a staging drill. Platform extensions and
storage internals are recreated by the shim, as they would be by Supabase.

## Performance evidence

`scripts/verify-performance.sh` creates 40 farmers, two personalized farms,
forecasts, an ingestion lease and the knowledge corpus, then measures inside
PostgreSQL with `clock_timestamp()` over 200 calls per path. Throughput uses
pgbench against the same disposable database.

| Path | p50 ms | p95 ms | p99 ms | Budget p95 |
| --- | ---: | ---: | ---: | ---: |
| AI claim + finish | 0.46 | 0.69 | 1.06 | 120 |
| Knowledge retrieval | 14.42 | 27.66 | 31.74 | 200 |
| Recommendation feed | 6.94 | 23.92 | 31.75 | 250 |
| Farmer context | 1.46 | 5.02 | 11.16 | 100 |
| Forecast read | 0.06 | 0.14 | 0.86 | 50 |
| Ingestion lease touch | 0.38 | 1.96 | 6.95 | 50 |
| Ingestion recovery | 0.39 | 2.27 | 11.20 | 100 |
| RLS-authenticated read | 0.98 | 2.94 | 11.02 | 50 |
| Service-role read | 0.08 | 0.34 | 1.16 | 50 |

Concurrency and recovery:

- 20 concurrent claims from one party: exactly **20 allowed** and **20
  rate-limited**; no over-admission.
- pgbench throughput with zero failed transactions: AI lifecycle **1,176.72
  tps**, retrieval **326.66 tps**, feed **156.54 tps** (floors 10/20/5).
- RLS overhead p95: 2.94 ms authenticated vs 0.34 ms service role, within the
  30 ms budget.
- A database restart answered in **3 s** (budget 60 s), and a new AI claim
  succeeded afterward.

Limit: Docker on one machine is not a production load test. It does not model
network latency, PostgREST serialization, Edge Function cold starts, provider
latency, connection-pool saturation, or multi-tenant scale. It is a repeatable
regression baseline for the database paths.

## Acceptance matrix

| Area | Status | Evidence / gap |
| --- | --- | --- |
| Regression | **Local pass** | 607 tests; CI run pending for this commit |
| Security — database | **Local pass** | 90/90 RLS, AI control tables revoked, isolation harness green |
| Security — HTTP/JWT | **Blocked** | New migrations and Edge routes are not on staging; no signed-in HTTP test |
| Data quality | **Partial** | Phase 9 staging counts exist; lifecycle/evidence additions are not applied there |
| Operational | **Partial** | Health/review/telemetry functions exist and pass local harnesses; no staging operator run |
| Recovery | **Local pass** | 20/20 application-schema drill; no PITR or staging restore |
| Performance | **Local pass** | 21/21 bounded DB/load cases; no hosted load test |
| Staging acceptance | **Blocked** | `20261105000100` and `20261105000200` are absent from staging |
| Phase 3 human approval | **Blocked** | No reviewer/content-manager authority or agronomist sign-off |
| Live AI provider | **Blocked** | No approved `GEMINI_API_KEY`; every provider call to date is mocked |
| Production | **Not deployed** | No production credentials or authorisation were used |

## Staging state

Project `swmbmtvwgksicfnfsehg` is the only hosted project used. It carries the
Phase 9 intelligence state recorded in `docs/PHASE-9-INTELLIGENCE-DATA.md`
(seven calibrated Layyah forecast days, two active temperature models, two
backtests, weather and soil rows). It does **not** carry:

- `20261105000100_knowledge_lifecycle_completion.sql`;
- `20261105000200_ai_gateway_controls.sql`.

There is no `psql` on this machine, no SQL-write Management API credential, and
the Supabase MCP calls are permission-denied. The migration ledger, the new
tables/RPCs, their RLS and grants, and the AI rate-limit/telemetry rows therefore
have **no staging-persisted evidence**. Do not describe them as deployed.

## Blockers and what unblocks each

1. **Apply the two migrations to staging.** Requires an approved SQL path
   (`psql` connection string or a Management API token with write access). Then
   follow `docs/PHASE-3-5-STAGING-ACCEPTANCE.md` and record the persisted rows.
2. **Phase 3 human approval.** Requires a named reviewer with
   `evidence_reviewer`/`content_manager` authority, a permitted source record,
   and agronomic sign-off. The seeded spray-wind rule must stay inactive until
   then; the harness promotion is throwaway-database fixture setup only.
3. **Live AI call.** Requires an approved Gemini key in the function secret
   store. No key was requested, printed, or committed.
4. **Hosted recovery and performance.** The local drills are green, but a
   staging backup/restore and an explicitly approved staging load test remain
   required for launch acceptance.
5. **Production authorisation.** Explicit approval is required before any
   production deploy. None was given.
6. **Open-Meteo licence.** The free tier is non-commercial. Commercial launch
   needs a paid plan or a different provider; that decision is unresolved.

## Residual risks

- The 805 kB JavaScript chunk may hurt first load on slow rural connections.
- The Layyah calibration is one district, one provider, model-to-model against
  reanalysis, with an 11-day independent window. It must not be generalized.
- Forecast risk rules remain inert by design; no advice is generated from the
  wind threshold until a human activates it with published evidence.
- CI now runs recovery and performance as independent jobs, but those jobs still
  use disposable Postgres, not staging.
- The existing App-suite baseline (33 historical failures) was accepted for
  Phase 3; today's full suite passes, but the distinction between the old
  baseline and current green run should be kept when reviewing history.

## Decision

**Not ready.** Local implementation, database controls, recovery and bounded
performance are verified; staging, human approval, live-provider behavior and
hosted recovery/performance are not. A launch decision now would be based on
unverified assumptions. Reassess after blockers 1–3 are closed and blocker 4 is
scheduled with an approved staging target.

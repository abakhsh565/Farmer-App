# Release SOP — one pipeline, three environments

This is the procedure every change follows. It exists because the same failure
kept recurring: a change worked in development, was "deployed", and the live
environment was still serving the previous build — on the website, on the update
channel, or both, with nothing saying which.

The rule that replaces it: **an environment is released when a record names its
commit and `verify:release` says the live surfaces serve that commit.**

## 1. What exists

The table below is for reading. The canonical, machine-readable version is
`release/environments.json`: both release scripts and the CI workflow read that
file, so there is one answer to "where does staging publish" and no second copy to
drift out of date. `docs/ENVIRONMENTS.md` is the long-form explanation.

| | Development | Staging | Production |
|---|---|---|---|
| Branch | `development` | `staging` | `main` |
| Website | https://farmer-app-dev-97xtwn.freebuff.site | https://farmer-app-staging-i1iih6.freebuff.site | https://farmer-app-production-8sc6a2.freebuff.site |
| Site id (Sites) | `3a7f2b41-6c8d-4e59-9b3a-1d2f4c6e8a01` | `5c2e9d73-1b4a-4f86-8d27-3e5a7c9b1f02` | `9e4b1c85-7d3f-4a29-bc56-2f8d3a5c7e03` |
| OTA channel | `ota-dev` | `ota-staging` | `ota-production` |
| Channel repository | `abakhsh56/Farmer-App` | `abakhsh565/Farmer-App` | `abakhsh56/Farmer-App` |
| APK id | `pk.agrishop.farmer.dev` | `pk.agrishop.farmer.staging` | `pk.agrishop.farmer` |
| Farmer database | local Docker (`127.0.0.1:54421`) | `zmyvkwijloqylvftvhvq` | `swmbmtvwgksicfnfsehg` |
| Shop/dealer database | local | `bpybjrjenwccowvtrevu` | `gkswcfljxlutkfdvvqng` |

Two GitHub repositories exist and both matter, for a reason that is not going away:

- **`origin` = `abakhsh565/Farmer-App`** is the canonical repository: code, branches,
  pull requests, and the staging update channel (its workflow token can write
  releases there, and cannot write them in the other one).
- **`upstream56` = `abakhsh56/Farmer-App`** owns the **dev and production** update
  channels, because every APK already installed in the field polls them. Moving
  those channels would strand every phone until a new APK.

So: **code is canonical in `origin`; two OTA channels necessarily live in
`upstream56`.** `scripts/verify-release.mjs` knows which is which per environment,
which is the thing that was missing when a staging APK polled the wrong repository.

## 2. The one-way path

```
development ──merge──▶ staging ──merge──▶ main
     │                    │                  │
  ota-dev             ota-staging       ota-production
```

One step at a time, each approved separately. "It works on dev" is not staging
approval; "staging is fine" is not production approval.

### Making a change

```bash
npm run stack:start            # local Postgres
npm run dev                    # VITE_APP_ENV=dev
npm run check:fast             # typecheck + design lint + unit tests
git commit                     # conventional commit message
```

Nothing is deployed by this. Development is the developer's own machine.

### Promoting to staging (approved step 1)

```bash
git checkout staging
git merge --no-ff development
git push origin staging            # publishes ota-staging via .github/workflows/ota.yml
npm run release:site -- --env staging     # builds + writes release/staging.json
# deploy deploy-site/manifest.json with sites_deploy, then:
npm run verify:release -- --env staging
```

`release:site` refuses to run on the wrong branch, on a dirty tree, and on
`production` without `--approved`.

### Promoting to production (approved step 2)

```bash
git checkout main
git merge --no-ff staging
git push origin main               # publishes ota-production
# apply any pending migration to swmbmtvwgksicfnfsehg FIRST, with approval
npm run release:site -- --env production --approved
# deploy deploy-site/manifest.json to site 9e4b1c85-…
npm run verify:release -- --env production --strict
```

`--strict` turns warnings into failures: a production release is not finished
while the website still serves a previous bundle.

## 3. What CI does, and what it cannot

`.github/workflows/release.yml` runs on every push to `staging` and `main`:

1. **gates** — typecheck, migration chain lint, Edge Function contracts, tests.
   A commit that fails these cannot be packaged.
2. **package** — builds that environment's payload with `release:site` and uploads
   `deploy-site/` plus `release/<env>.json` as an artifact.
3. **verify** — asks the live site, the update channel, auth and the dealer
   contract whether they serve that commit.

**The website upload is the one step CI cannot do.** Sites deploys need
credentials that must not live in a repository, and the workflow has no way to
hold them. That step is therefore: download the artifact (or run `release:site`
locally) and deploy `deploy-site/manifest.json`. `verify:release` is what proves
it happened. On a production run with `require_site`, a site that lags the branch
fails the gate.

## 4. Verification: what each check proves

`npm run verify:release -- --env <env>` reads only live surfaces:

| Check | Proves |
|---|---|
| release record vs branch tip | the environment was built from the branch that is now out |
| OTA `latest.json` commit | the update channel is serving the same commit |
| site entry bundle + SHA-256 | the website is serving the bytes that were built |
| `sw.js` precache | the service worker cannot keep serving a previous bundle |
| auth health + project ref | the right Supabase project answers |
| `farmer_api_me` / `farmer-media` | the dealer contract the Shop and Chat tabs call is deployed |
| migrations | **not proven** — `supabase_migrations` needs a service-role key (see §7) |

## 5. Caching

The service worker is now owned by `src/services/serviceWorker.ts`:

- **Browser**: registered with `updateViaCache: 'none'`; a worker that takes over an
  already-controlled page reloads it once, so the page moves to the deployed build
  instead of staying on the previous one.
- **Installed Android app**: no worker at all. Its assets ship inside the APK (or
  arrive as an OTA bundle), so a worker can only serve an older build — which is
  exactly what happened on staging: a freshly installed `1.0-staging` APK kept
  serving the previous bundle until the worker was cleared by hand. On startup the
  native shell unregisters any worker and deletes its caches.

After a deploy, `verify:release` also checks that `sw.js` precaches the bundle the
site is serving. A stale cache is now visible instead of silent.

## 6. Rollback

Nothing is force-pushed and no applied migration is edited.

**Code / website**

```bash
git checkout staging
git revert --no-edit <bad-commit>
git push origin staging                  # republishes ota-staging
npm run release:site -- --env staging
# deploy the payload, then
npm run verify:release -- --env staging
```

The revert is a normal commit, so the record and the verification name it like any
other release. For production, the same on `main` with `--approved`.

**OTA only** (a bad bundle, no code change):

```bash
git checkout <last-good-commit>
npx tsx scripts/ota-publish.mjs --env staging
```

This rewrites the channel to a known-good bundle; installed apps pick it up on the
next launch. It does not touch a database.

**Database** — forward only. Write a new migration that reverses the change, apply
it in order, and release it through the same path. Restoring a Supabase backup is
a last resort and needs explicit approval; it discards everything written since.

## 7. Known blockers (honest list)

1. **Website deployment is not automated end to end.** No Sites credentials in CI.
   Mitigation: artifact + `verify:release`, and `--strict` on production.
2. **Applied migrations cannot be read with the anon key.** The check needs a
   service-role key in the release environment. Until then, migration state is
   verified by running the migration against the environment deliberately.
3. **Two OTA repositories, and only one is writable from here.** Deliberate —
   installed APKs poll `abakhsh56` — but the canonical account (`abakhsh565`) has no
   write access to it, so pushes that should publish `ota-dev` and `ota-production`
   are refused 403 (`Resource not accessible by integration`). The gate in
   `.github/workflows/ota.yml` now reports this before building, naming the fix.
   
   To unblock, one of these:
   - add a repository secret **`OTA_TOKEN`** in `abakhsh565/Farmer-App`: a fine-grained
     PAT with *Contents: write* on `abakhsh56/Farmer-App`. The workflow already reads
     it (`secrets.OTA_TOKEN || secrets.GITHUB_TOKEN`), so nothing else changes;
   - or push `development` / `main` from the `abakhsh56` account itself, whose own
     workflow publishes those channels;
   - or move the channels to `abakhsh565`. Until the first two are done, this is why
     dev and production OTA stay at their last published commits (`6a329c1` and
     `f84ab96` at the time of writing) while their branches move on.
   
   Every new APK must also be built with `npm run apk:<env>` so its baked channel
   matches the repository that publishes it: an APK built before that rule polls
   `abakhsh56` even for staging.
4. **Production's website is behind `main`.** Deploying it needs approval and is
   prepared with `release:site --env production --approved`.

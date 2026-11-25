#!/usr/bin/env node
/**
 * Builds one environment's website payload and records exactly what it is.
 *
 *   npm run release:site -- --env staging
 *   npm run release:site -- --env production --approved
 *
 * Why this exists. The website used to be built and uploaded by hand, so nothing
 * tied the bytes on the site to a commit, and "did staging get that change?" could
 * only be answered by looking at it. This script makes the answer a file:
 * `release/<env>.json` names the commit, the entry bundle, its SHA-256 and the
 * SHA-256 of every file in the payload. The deploy is then this payload, and
 * `scripts/verify-release.mjs` compares the live site against the same record.
 *
 * Rules it enforces rather than documents:
 *   · the branch must be the environment's branch (`development` / `staging` / `main`);
 *   · the working tree must be clean, so what is recorded is what is committed;
 *   · production needs `--approved`, because a production release is a decision and
 *     not a build step;
 *   · the payload is rebuilt from scratch each time, so no file from a previous
 *     environment can survive into this one.
 *
 * It does not upload anything: the Sites deploy needs credentials this repository
 * does not hold. `sites_deploy` (or the panel's Publish) takes the manifest this
 * writes, and the verification afterwards is the check that it worked.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildEnvFor } from './lib/build-environment.mjs';

const ROOT = resolve(process.cwd());
const PAYLOAD = join(ROOT, 'deploy-site');
const RECORDS = join(ROOT, 'release');

/* The environment table is `release/environments.json` and only that file. A copy
   here would be a second answer to "where does staging publish", which is the
   question this whole pipeline exists to answer once. */
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'release', 'environments.json'), 'utf8'));
const ENVIRONMENTS = REGISTRY.environments;

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const env = value('--env');
const rollbackOf = value('--rollback');
const approved = args.includes('--approved');
const allowDirty = args.includes('--allow-dirty');
const skipBuild = args.includes('--skip-build');

if (!env || !ENVIRONMENTS[env]) {
  console.error('usage: npm run release:site -- --env dev|staging|production [--approved] [--allow-dirty] [--rollback <sha>]');
  process.exit(2);
}

const target = ENVIRONMENTS[env];

function fail(message, detail) {
  console.error(`\nrelease-site: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function git(...gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${gitArgs.join(' ')} failed`, result.stderr?.trim());
  return result.stdout.trim();
}

/* ---- gate 1: the branch this environment is built from -------------------- */

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (rollbackOf) {
  /*
   * Re-releasing an earlier commit is the rollback path (SOP §6), and it arrives
   * detached: a branch cannot be "at" a commit it has moved past. Requiring the
   * branch name here made the documented rollback impossible to run, which is how
   * a procedure becomes folklore. The guard that survives is the one that matters:
   * HEAD must be exactly the commit being re-released.
   */
  const wanted = git('rev-parse', rollbackOf);
  if (git('rev-parse', 'HEAD') !== wanted) {
    fail(
      `--rollback ${rollbackOf} was asked for, but HEAD is ${git('rev-parse', '--short', 'HEAD')}.`,
      `  Check out that commit first:\n    git checkout --detach ${rollbackOf}`,
    );
  }
  console.log(`release-site: re-releasing ${git('rev-parse', '--short', rollbackOf)} into ${env}`);
} else if (branch !== target.branch) {
  fail(
    `"${env}" is built from "${target.branch}", but this checkout is on "${branch}".`,
    `  Promote the change first (development → staging → main); do not build an\n  environment from another environment's branch.\n  Re-releasing an earlier commit is \`--rollback <sha>\` on that commit.`,
  );
}

/* ---- gate 2: the tree must be committed ----------------------------------- */

const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty && !allowDirty) {
  fail(
    'the working tree has uncommitted changes, so the record would name a commit that is not what was built.',
    dirty.split('\n').map((line) => `  ${line}`).join('\n') + '\n  Commit first, or pass --allow-dirty for a throwaway build.',
  );
}

/* ---- gate 3: production is a decision ------------------------------------- */

if (env === 'production' && !approved) {
  fail(
    'production needs --approved.',
    '  A production release is approved explicitly, after staging has been verified. Re-run with:\n' +
      '    npm run release:site -- --env production --approved',
  );
}

const commit = git('rev-parse', '--short', 'HEAD');

/* ---- build ---------------------------------------------------------------- */

if (!skipBuild) {
  console.log(`release-site: building ${env} from ${branch}@${commit}`);
  /* Not `{ ...process.env }`: see `scripts/lib/build-environment.mjs` — a
     developer's `.env.local` must not become the shop backend of a staging site. */
  const buildEnv = buildEnvFor(env);

  const typecheck = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (typecheck.status !== 0) fail('typecheck failed; nothing was packaged.');

  const vite = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (vite.status !== 0) fail('the web build failed; nothing was packaged.');
}

const dist = join(ROOT, 'dist');
if (!existsSync(join(dist, 'index.html'))) fail('dist/index.html is missing — run without --skip-build.');

/* ---- package -------------------------------------------------------------- */

/*
 * Rebuilt, never updated: a payload that is copied over keeps files from the
 * previous environment, and a production site that still serves a staging asset
 * is the exact failure this whole exercise is about.
 */
rmSync(PAYLOAD, { recursive: true, force: true });
mkdirSync(join(PAYLOAD, 'assets'), { recursive: true });
cpSync(dist, join(PAYLOAD, 'assets'), { recursive: true });

writeFileSync(
  join(PAYLOAD, 'worker.js'),
  `/* Generated by scripts/release-site.mjs — serves the static payload. */\nexport default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  },\n};\n`,
);

const manifest = {
  entrypoint: 'worker.js',
  compatibilityDate: new Date().toISOString().slice(0, 10),
  modules: [{ name: 'worker.js', type: 'esm', path: './worker.js' }],
  assetsDirectory: './assets',
  spa: true,
};
writeFileSync(join(PAYLOAD, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

/* ---- record --------------------------------------------------------------- */

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(join(PAYLOAD, 'assets')).map((file) => ({
  path: relative(join(PAYLOAD, 'assets'), file).split('\\').join('/'),
  bytes: statSync(file).size,
  sha256: sha256(file),
}));

/*
 * The entry bundle is the file the page loads first and the one a stale
 * deployment gives away: a site serving an old `assets/index-*.js` while the
 * branch moved on is the drift this record exists to expose.
 */
/*
 * The entry is the module `index.html` actually loads, not simply "some file
 * called index-*.js". A build emits more than one (a 0.1 kB chunk and the real
 * bundle), and recording the wrong one makes every verification compare a file
 * the page never fetches — which is what happened on the first staging release:
 * the record named `index-Bo21F54f.js` while the site served `index-DF-WD2Jb.js`.
 */
const page = readFileSync(join(PAYLOAD, 'assets', 'index.html'), 'utf8');
const referenced = /<script[^>]+src="\/?([^"]+\.js)"/i.exec(page)?.[1] ?? null;
const entry = referenced ? files.find((file) => file.path === referenced) : undefined;
if (!entry) {
  fail(`the page's entry script (${referenced ?? 'none found'}) is not in the payload — this build is incomplete.`);
}

/*
 * The deployment carries its own manifest, as `/release.json` inside the payload.
 *
 * This is not decoration. Builds are not bit-reproducible across machines: a
 * developer's untracked `.env.local` is compiled into the bundle, so CI's build of
 * the same commit and this one differ legitimately. Verifying a live site against
 * a local hash would therefore fail on a correct deployment — which it did, on the
 * first staging release. The commit, however, cannot differ. Recording it *inside*
 * the thing that is uploaded means the live site can always be asked which commit
 * it is, from any machine, without trusting a file that shipped separately.
 */
const builtAt = new Date().toISOString();
const deployedManifest = {
  env,
  branch: rollbackOf ? target.branch : branch,
  ...(rollbackOf ? { rollback: true } : {}),
  commit,
  commitFull: git('rev-parse', 'HEAD'),
  builtAt,
  entry: entry.path,
  entrySha256: entry.sha256,
  files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
};
const manifestJson = `${JSON.stringify(deployedManifest, null, 2)}\n`;
writeFileSync(join(PAYLOAD, 'assets', 'release.json'), manifestJson);
files.push({
  path: 'release.json',
  bytes: Buffer.byteLength(manifestJson),
  sha256: createHash('sha256').update(manifestJson).digest('hex'),
});

const record = {
  ...deployedManifest,
  site: target.site.url,
  siteId: target.site.id,
  channel: target.ota,
  files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
};

mkdirSync(RECORDS, { recursive: true });
writeFileSync(join(RECORDS, `${env}.json`), `${JSON.stringify(record, null, 2)}\n`);

console.log(`
release-site: payload ready
  environment   ${env}
  branch        ${branch}
  commit        ${commit}
  entry bundle  ${record.entry}  (${(entry.bytes / 1024).toFixed(1)} kB)
  files         ${record.files}  (${(record.bytes / 1024 / 1024).toFixed(1)} MB)
  record        release/${env}.json

next, in this order:
  1. deploy deploy-site/manifest.json to site ${target.site.id} (${env})
  2. deploy the payload's release to the OTA channel if this environment's APK should move
  3. prove it:  npm run verify:release -- --env ${env}${env === 'production' ? ' --strict' : ''}
`);

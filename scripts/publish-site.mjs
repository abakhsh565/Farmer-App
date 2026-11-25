#!/usr/bin/env node
/**
 * Uploads one environment's packaged payload to its website.
 *
 *   npm run publish:site -- --env staging
 *   npm run publish:site -- --env production --approved
 *   npm run publish:site -- --env staging --check     # validate, upload nothing
 *
 * Why this exists. `release:site` builds and records the payload but stops before
 * the upload, because the upload used to need a credential that lived in a
 * browser session: the release gate could prove a site was stale and could not do
 * anything about it. That left one undocumented manual step between "the branch
 * moved" and "the site moved", which is exactly where drift came from.
 *
 * The upload is a Cloudflare Workers deploy of `deploy-site/` — the same payload
 * the panel publishes, with the same worker name (recorded per environment in
 * `release/environments.json`). Doing it here means the release gate runs it in
 * the same job that built and verified the bytes, so nothing is uploaded that was
 * not just checked.
 *
 * What it refuses to do:
 *   · upload a payload that was not built from the branch this environment owns;
 *   · upload a payload whose `/release.json` disagrees with `release/<env>.json`,
 *     which would publish a site that names a commit it is not;
 *   · upload to production without `--approved`.
 *
 * The credential is `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the account
 * that holds the site). Without it the script exits 2 and says so, rather than
 * pretending the step does not exist. `--check` validates everything else, so the
 * payload can be proven deployable before the token is in place.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const PAYLOAD = join(ROOT, 'deploy-site');
const RECORDS = join(ROOT, 'release');

const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'release', 'environments.json'), 'utf8'));
const ENVIRONMENTS = REGISTRY.environments;

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const env = value('--env');
const approved = args.includes('--approved');
const checkOnly = args.includes('--check');

if (!env || !ENVIRONMENTS[env]) {
  console.error('usage: npm run publish:site -- --env dev|staging|production [--approved] [--check]');
  process.exit(2);
}

const target = ENVIRONMENTS[env];

function fail(message, detail, code = 1) {
  console.error(`\npublish-site: ${message}`);
  if (detail) console.error(detail);
  process.exit(code);
}

function git(...gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${gitArgs.join(' ')} failed`, result.stderr?.trim());
  return result.stdout.trim();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/* ---- gate 1: this environment's branch ------------------------------------ */

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== target.branch) {
  fail(
    `"${env}" deploys from "${target.branch}", but this checkout is on "${branch}".`,
    '  A site must not be published from another environment\'s branch.',
  );
}

/* ---- gate 2: production is a decision ------------------------------------- */

if (env === 'production' && !approved && !checkOnly) {
  fail(
    'production needs --approved.',
    '    npm run publish:site -- --env production --approved',
  );
}

/* ---- gate 3: the payload is the one this commit recorded ------------------- */

if (!existsSync(join(PAYLOAD, 'manifest.json'))) {
  fail('deploy-site/manifest.json is missing.', `  Build it first: npm run release:site -- --env ${env}`);
}

const recordPath = join(RECORDS, `${env}.json`);
if (!existsSync(recordPath)) {
  fail(`release/${env}.json is missing.`, `  Build it first: npm run release:site -- --env ${env}`);
}
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const head = git('rev-parse', '--short', 'HEAD');
if (record.commit !== head) {
  fail(
    `release/${env}.json records ${record.commit}, but HEAD is ${head}.`,
    '  The payload on disk belongs to another commit. Rebuild rather than deploy it.',
  );
}

const payloadManifestPath = join(PAYLOAD, 'assets', 'release.json');
if (!existsSync(payloadManifestPath)) {
  fail('the payload carries no /release.json.', '  Rebuild it: the deployment must name the commit it is.');
}
const payloadManifest = JSON.parse(readFileSync(payloadManifestPath, 'utf8'));
if (payloadManifest.commit !== record.commit || payloadManifest.env !== env) {
  fail(
    'the payload names a different release than the record does.',
    `  payload: ${payloadManifest.env}@${payloadManifest.commit}\n  record:  ${env}@${record.commit}`,
  );
}

const entryPath = join(PAYLOAD, 'assets', record.entry.split('/').join('/'));
if (!existsSync(entryPath)) {
  fail(`the recorded entry bundle ${record.entry} is not in the payload.`, '  Rebuild the payload.');
}
const entrySha = sha256(entryPath);
if (entrySha !== record.entrySha256) {
  fail(
    `the entry bundle does not match the record (${entrySha.slice(0, 16)}… vs ${record.entrySha256.slice(0, 16)}…).`,
    '  The payload was modified after it was recorded. Rebuild it.',
  );
}

/* ---- gate 4: a worker to deploy to ---------------------------------------- */

const worker = target.site.worker;
const accountId = target.site.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
if (!worker || !accountId) {
  fail(
    `the registry has no worker/account for "${env}".`,
    '  Add site.worker and site.accountId to release/environments.json — they identify the deployed script.',
  );
}

console.log(`
publish-site: ${env}
  branch        ${branch}@${record.commit}
  entry bundle  ${record.entry}  ${record.entrySha256.slice(0, 16)}…  (matches the record)
  payload       deploy-site/  ${record.files} files, ${(record.bytes / 1024 / 1024).toFixed(1)} MB
  worker        ${worker}
  account       ${accountId}
`);

if (checkOnly) {
  console.log(
    `  credential    ${process.env.CLOUDFLARE_API_TOKEN ? 'present' : 'MISSING (CLOUDFLARE_API_TOKEN)'}\n` +
      `\npublish-site: the payload is deployable — validation only, nothing was uploaded.\n`,
  );
  process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  fail(
    'CLOUDFLARE_API_TOKEN is not set, so the website upload cannot run.',
    '  Add a Cloudflare API token with "Workers Scripts: Edit" on the account above as the\n' +
      '  repository secret CLOUDFLARE_API_TOKEN. Everything up to the upload is verified.',
    2,
  );
}

/* ---- upload --------------------------------------------------------------- */

/*
 * `wrangler` is invoked through npx rather than added to the project's
 * dependencies: it is a deployment tool, it is only used by this one step, and a
 * pinned copy in package.json would make every install carry a bundler this app
 * does not build with.
 */
const configPath = join(PAYLOAD, 'wrangler.jsonc');
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      name: worker,
      account_id: accountId,
      main: 'worker.js',
      compatibility_date: new Date().toISOString().slice(0, 10),
      assets: {
        directory: './assets',
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
      },
    },
    null,
    2,
  )}\n`,
);

const deploy = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--yes', 'wrangler@4', 'deploy', '--config', configPath],
  {
    cwd: PAYLOAD,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
rmSync(configPath, { force: true });

if (deploy.status !== 0) {
  fail('the upload failed; the site still serves the previous release.', '  Nothing was verified after it, so treat this release as not deployed.');
}

console.log(`
publish-site: uploaded ${env}@${record.commit} to ${target.site.url}

prove it:
  npm run verify:release -- --env ${env}${env === 'production' ? ' --strict' : ''}
`);

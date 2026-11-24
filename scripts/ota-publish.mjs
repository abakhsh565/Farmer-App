#!/usr/bin/env node
/**
 * Publishes a live-update bundle to one environment's channel.
 *
 * The channel is a GitHub Release whose assets are rewritten each time, so the
 * URL an installed app polls never changes:
 *
 *   https://github.com/abakhsh56/Farmer-App/releases/download/ota-dev/bundle.zip
 *   https://github.com/abakhsh56/Farmer-App/releases/download/ota-dev/latest.json
 *
 * Nothing here needs a paid service or a vendor account, and it is the same
 * mechanism for dev, staging and production. `gh` supplies the credentials that
 * are already used to push, so publishing is one command on a machine that can
 * push to the repository:
 *
 *   npm run ota:publish -- --env dev
 *
 * What the installed app does with it is in `src/services/liveUpdate.ts`: it
 * reads `latest.json`, compares `bundleId` with the bundle it is running, and
 * only downloads when they differ. The `bundleId` is the commit and build time,
 * so republishing an identical commit still reaches the phone (the build time
 * changes) while a normal launch makes no download at all.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipDirectory } from './lib/zip.mjs';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts', 'ota');

/** One channel per environment; the tag is the channel. */
const CHANNELS = {
  dev: 'ota-dev',
  staging: 'ota-staging',
  production: 'ota-production',
};

function fail(message, detail) {
  console.error(`\nota-publish: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = argv.slice(2);
  let env = 'dev';
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--env') env = flags[i + 1];
    else if (flags[i].startsWith('--env=')) env = flags[i].slice('--env='.length);
  }
  if (!CHANNELS[env]) fail(`unknown environment "${env}".`, `  Choose one of: ${Object.keys(CHANNELS).join(', ')}`);
  return { env };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function gh(args) {
  try {
    return { ok: true, out: execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const { env } = parseArgs(process.argv);
const tag = CHANNELS[env];

/**
 * The repository whose Releases are the update channels.
 *
 * Named explicitly rather than inferred from `origin`: this checkout's remote is a
 * different account's copy of the app, and `gh` follows that remote — which is how
 * a release got asked for on the wrong repository the first time.
 *
 * It is configurable because the app is checked out under more than one GitHub
 * account, and a workflow's `GITHUB_TOKEN` can only write releases in the
 * repository it runs in: publishing staging from `abakhsh565/Farmer-App` was
 * refused with HTTP 403 against `abakhsh56/Farmer-App`. Setting
 * `OTA_RELEASE_REPO=owner/repository` moves one environment's channel without
 * touching the others.
 *
 * The default is the repository every installed APK polls today, so a build that
 * sets nothing publishes exactly where it always did. `scripts/build-apk.mjs`
 * reads the same variable, which is what keeps a phone's download URL and the
 * release being written the same repository.
 */
const DEFAULT_REPO = 'abakhsh56/Farmer-App';

function resolveRepo() {
  const configured = (process.env.OTA_RELEASE_REPO ?? '').trim();
  if (!configured) return DEFAULT_REPO;
  /* An owner/repository, not a URL: `gh --repo` takes the pair, and a pasted URL
     would produce a confusing 404 rather than a publish. */
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured)) {
    fail(`OTA_RELEASE_REPO is not \"owner/repository\": \"${configured}\".`);
  }
  return configured;
}

const REPO = resolveRepo();

/** Printed so a workflow log states which repository it is writing to. */
console.log(`ota-publish: channel ${tag} on ${REPO}`);

const sha = git(['rev-parse', '--short', 'HEAD']);
const builtAt = new Date().toISOString();
const bundleId = `${sha}-${builtAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`;

console.log(`ota-publish: building the ${env} web bundle…`);
// The tools are run through `node` and their own entry scripts rather than through
// npm: this project has an `npm` package in node_modules, so a shell resolves
// `npm` to that shim and dies with "Cannot find module …/node_modules/npm/bin".
const buildEnv = { ...process.env, VITE_APP_ENV: env };
const run = (script, args) => {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', ...script), ...args], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`${script.join('/')} exited with ${result.status}.`);
};
run(['typescript', 'bin', 'tsc'], ['--noEmit']);
run(['vite', 'bin', 'vite.js'], ['build']);

/**
 * The voice folder stays out of the bundle, if a build ever puts one back.
 *
 * The Urdu voice no longer ships with the app at all — it is made by Gemini TTS
 * through `/api/tts` — so there is nothing to exclude today. The rule is kept
 * because it is what makes a bundle a few MB: a model accidentally copied into
 * `public/` again must not silently turn every update into a 79 MB download.
 */
const VOICE_FOLDER = 'piper/';

const zip = zipDirectory(DIST, { exclude: (name) => name.startsWith(VOICE_FOLDER) });
const checksum = createHash('sha256').update(zip).digest('hex');

mkdirSync(OUT, { recursive: true });
const zipPath = join(OUT, 'bundle.zip');
const manifestPath = join(OUT, 'latest.json');

writeFileSync(zipPath, zip);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      bundleId,
      checksum,
      environment: env,
      commit: sha,
      builtAt,
      bytes: zip.length,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `ota-publish: bundle ${bundleId} — ${(zip.length / 1024 / 1024).toFixed(1)} MB (voice folder excluded), sha256 ${checksum.slice(0, 12)}…`,
);

/**
 * The release is created once and reused. `--clobber` replaces the two assets,
 * which is what keeps the download URL stable for every phone already installed.
 */
const existing = gh(['release', 'view', tag, '--repo', REPO]);
if (!existing.ok) {
  const notes = `Live-update channel for ${env}. Assets are replaced by \`npm run ota:publish -- --env ${env}\`; installed apps poll \`latest.json\` from this release.`;
  const created = gh(['release', 'create', tag, '--repo', REPO, '--title', `OTA ${env}`, '--notes', notes]);
  if (!created.ok) {
    fail(`could not create the "${tag}" release.`, `  gh said: ${created.out.trim()}\n  Is \`gh auth status\` logged in with push rights to ${REPO}?`);
  }
}

const uploaded = gh(['release', 'upload', tag, '--repo', REPO, zipPath, manifestPath, '--clobber']);
if (!uploaded.ok) fail(`could not upload the bundle to "${tag}".`, `  gh said: ${uploaded.out.trim()}`);

rmSync(zipPath, { force: true });

console.log(`ota-publish: ${tag} now serves bundle ${bundleId}`);
console.log(`ota-publish: phones on the ${env} build pick it up on their next launch`);

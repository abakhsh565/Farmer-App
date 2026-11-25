#!/usr/bin/env node
/**
 * Proves that what is live is what was released.
 *
 *   npm run verify:release -- --env staging
 *   npm run verify:release -- --env production --strict
 *
 * `verify:environments` answers "does this project work". This answers a different
 * question, and the one that kept being missed: **is the thing on the site and on
 * the update channel the commit we think it is** — on all three delivery surfaces
 * at once, with the same record the release was built from.
 *
 * Each check reads a live surface, never a local file's opinion of one:
 *
 *   git      the branch tip, compared with the commit the release record names
 *   OTA      the channel's latest.json, compared with that same commit
 *   site     the entry bundle actually served, and its SHA-256
 *   worker   sw.js, which must precache the bundle that is being served
 *   auth     the project that answers, and that it is the right project
 *   shop     the dealer contract the Shop and Chat tabs call
 *
 * Exit codes: 0 = every required check passed, 1 = drift, 2 = bad usage.
 * Warnings are drift that this script cannot fix or refuses to call a failure
 * (a site that has not been deployed yet). `--strict` turns them into failures,
 * which is what a production release gate uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { backendFor } from '../src/services/appEnvironments.ts';
import { resolveShopEnvironment } from '../src/services/shopEnvironments.ts';

const ROOT = resolve(process.cwd());

/* Read from the one registry, never restated here: a script that carries its own
   copy of the table can disagree with the release it is verifying. */
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'release', 'environments.json'), 'utf8'));
const ENVIRONMENTS = REGISTRY.environments;

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const env = value('--env') ?? 'staging';
const strict = args.includes('--strict');
const expectedOverride = value('--commit');

if (!ENVIRONMENTS[env]) {
  console.error('usage: npm run verify:release -- --env dev|staging|production [--commit <sha>] [--strict]');
  process.exit(2);
}

const target = ENVIRONMENTS[env];

let failures = 0;
let warnings = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const warn = (label, detail = '') => {
  warnings += 1;
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ''}`);
};

function branchTip() {
  try {
    return execFileSync('git', ['rev-parse', '--short', target.branch], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function sha256Of(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return { ok: false, status: response.status, sha: null, text: '' };
  const buffer = Buffer.from(await response.arrayBuffer());
  return { ok: true, status: response.status, sha: createHash('sha256').update(buffer).digest('hex'), text: buffer.toString('utf8') };
}

const recordPath = join(ROOT, 'release', `${env}.json`);
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
const tip = branchTip();
const expected = expectedOverride ?? record?.commit ?? tip;

console.log(`\nverify-release: ${env}`);
console.log(`  branch ${target.branch} at ${tip ?? 'unknown'}${expected ? `, expecting ${expected}` : ''}`);
console.log(`  site  ${target.site.url} (${target.site.role})`);
console.log(`  ota   ${target.ota.repo} ${target.ota.tag}`);
console.log(record ? `  record release/${env}.json (built ${record.builtAt}, ${record.commit})` : `  no release record — site commit cannot be proven`);

/* ---- 1. the record must describe the branch that is out ------------------- */

if (!record) {
  warn('release record', 'run `npm run release:site -- --env ' + env + '` to produce one');
} else if (record.commit !== tip) {
  warn(
    'release record is older than the branch',
    `${record.commit} vs ${tip} — the environment has commits that were never released`,
  );
} else {
  check('release record matches the branch tip', true, record.commit);
}

/* ---- 2. the update channel ------------------------------------------------ */

try {
  const url = `https://github.com/${target.ota.repo}/releases/download/${target.ota.tag}/latest.json`;
  const response = await fetch(url, { redirect: 'follow', cache: 'no-store' });
  const manifest = response.ok ? await response.json() : null;
  const commit = manifest?.commit ?? null;
  check(
    `OTA ${target.ota.tag} is at the expected commit`,
    commit === expected,
    commit ? `${commit} (bundle ${manifest.bundleId})` : `no manifest at ${url}`,
  );
} catch (error) {
  check(`OTA ${target.ota.tag} is reachable`, false, String(error).slice(0, 100));
}

/* ---- 3. the website ------------------------------------------------------- */

try {
  const home = await fetch(`${target.site.url}/`, { cache: 'no-store' });
  check('site answers', home.ok, `${home.status} ${target.site.url}`);
  if (target.site.role === 'mirror') {
    warn(
      'this site is a mirror, not the environment',
      'it was built against whatever the developer\'s .env.local held, so it proves layout and never data',
    );
  }
  const html = await home.text();
  const match = /\/?(assets\/index-[A-Za-z0-9_-]+\.js)/.exec(html);
  const served = match?.[1] ?? null;

  if (!served) {
    check('site serves an app entry bundle', false, 'no assets/index-*.js in the page');
  } else {
    const entry = await sha256Of(`${target.site.url}/${served}`);
    /*
     * The site is asked which commit it is, rather than compared to a hash built
     * on this machine. Those hashes legitimately differ (untracked `.env.local` is
     * compiled in locally), so the only cross-machine truth is the manifest the
     * deployment carries.
     */
    const deployedResponse = await fetch(`${target.site.url}/release.json`, { cache: 'no-store' }).catch(() => null);
    const deployed = deployedResponse?.ok ? await deployedResponse.json() : null;

    if (!deployed) {
      check(
        'the site carries its release manifest',
        false,
        'no /release.json — deployed before this pipeline existed, or an incomplete upload',
      );
    } else {
      check(
        'the deployment names the commit this release is',
        deployed.commit === expected,
        `${deployed.commit}${deployed.commit === expected ? '' : ` (expected ${expected})`}`,
      );
      check('the deployment is for this environment', deployed.env === env, String(deployed.env));
      check(
        'the served bundle is the one the deployment names',
        served === deployed.entry,
        `${served}${served === deployed.entry ? '' : ` (deployment: ${deployed.entry})`}`,
      );
      if (served === deployed.entry) {
        check(
          'its bytes match the deployment manifest',
          entry.sha === deployed.entrySha256,
          entry.sha ? entry.sha.slice(0, 16) : 'unreadable',
        );
      }
    }

    /* A worker precaching a different entry is how a deployed site keeps showing
       the build before it. It is served, so it can be read. */
    const worker = await sha256Of(`${target.site.url}/sw.js`);
    if (!worker.ok) {
      warn('service worker', `sw.js returned ${worker.status} — cannot prove the cache matches`);
    } else {
      const current = served.replace(/^assets\//, '');
      check('sw.js precaches the bundle being served', worker.text.includes(current), current);
    }
  }
} catch (error) {
  check('site answers', false, String(error).slice(0, 100));
}

/* ---- 4. auth, and which project is really behind it ----------------------- */

const backend = backendFor(env);
if (!backend) {
  /* Dev's backend is the developer's own machine, by definition — the committed
     table has no row for it, so its absence here is not drift. */
  if (env === 'dev') {
    warn('dev backend is local', 'start the stack (`npm run stack:start`) to prove it end to end');
  } else {
    check('backend is configured', false, `no backend for "${env}"`);
  }
} else {
  /* Supabase's health endpoint is not public: it needs the same anon key the app
     ships, or it answers 401 and this check would lie about a healthy project. */
  const health = await fetch(`${backend.url}/auth/v1/health`, {
    headers: { apikey: backend.key, Authorization: `Bearer ${backend.key}` },
    cache: 'no-store',
  }).catch(() => null);
  check('auth health', Boolean(health?.ok), `${health?.status ?? 'no response'} ${backend.url.replace('https://', '')}`);
  const answeredRef = backend.url.split('//')[1]?.split('.')[0] ?? '';
  const declaredRef = target.backend.projectRef;
  if (declaredRef) {
    check(
      'the answered project is the one the registry names',
      answeredRef === declaredRef,
      `${answeredRef}${answeredRef === declaredRef ? '' : ` (registry: ${declaredRef})`}`,
    );
  } else {
    check('the answered project is configured', answeredRef.length > 0, answeredRef);
  }
}

/* ---- 5. the dealer contract the Shop and Chat tabs call ------------------- */

const shop = resolveShopEnvironment(env);
if (!shop?.shopApi.url) {
  warn('shop contract', 'this environment resolves no shop project');
} else {
  /* The app resolves the shop project from `shopEnvironments.ts`; the registry
     names it. If those two ever disagree, the app is talking to a project the
     release never tested — silently. */
  const shopRef = /\/\/([a-z0-9]+)\.supabase\.co/.exec(shop.shopApi.url)?.[1] ?? 'local';
  if (target.shop.projectRef) {
    check(
      'the shop project is the one the registry names',
      shopRef === target.shop.projectRef,
      `${shopRef}${shopRef === target.shop.projectRef ? '' : ` (registry: ${target.shop.projectRef})`}`,
    );
  }
  const call = async (path, body) => {
    const response = await fetch(`${shop.shopApi.url}/rest/v1/rpc/${path}`, {
      method: 'POST',
      headers: { apikey: shop.shopApi.key, Authorization: `Bearer ${shop.shopApi.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return { status: response.status, text: await response.text() };
  };

  const me = await call('farmer_api_me', { p_token: 'verification-probe' });
  const meRefused = me.status === 400 && me.text.includes('NOT_AUTHORIZED');
  if (meRefused) {
    check('farmer_api_me refuses a bad credential', true, `${me.status}`);
  } else if (me.status === 404 && env === 'production') {
    warn('farmer_api_* is not published in production', 'the production chat cannot work until it is');
  } else {
    check('farmer_api_me refuses a bad credential', false, `${me.status} ${me.text.slice(0, 120)}`);
  }

  const media = await fetch(`${shop.shopApi.url}/functions/v1/farmer-media?message_id=00000000-0000-0000-0000-000000000000`, {
    headers: { apikey: shop.shopApi.key },
    cache: 'no-store',
  }).catch(() => null);
  if (!media) {
    warn('farmer-media', 'no response');
  } else if (media.status === 401) {
    check('farmer-media refuses an anonymous caller', true, '401');
  } else if (media.status === 404) {
    warn('farmer-media is not deployed in this project', `404`);
  } else {
    check('farmer-media refuses an anonymous caller', false, `${media.status}`);
  }
}

/* ---- 6. what this cannot see --------------------------------------------- */

warn(
  'database migrations were not proven',
  'the applied set lives in `supabase_migrations`, which the anon key cannot read; run it with a service-role key before a production release',
);

/* ---- summary -------------------------------------------------------------- */

console.log(`\n  ${failures === 0 ? 'OK' : 'DRIFT'} — ${failures} failed, ${warnings} warning(s)`);
if (failures > 0 || (strict && warnings > 0)) {
  console.log(`  ${strict ? 'strict: warnings are failures' : 'drift must be fixed before this environment is called released'}\n`);
  process.exit(1);
}
console.log('');

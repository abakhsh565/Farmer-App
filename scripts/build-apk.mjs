#!/usr/bin/env node
/**
 * Builds an installable debug APK from the current web build.
 *
 * Two problems this exists to solve, both of which were hit by hand first:
 *
 *  1. JDK selection. Android Studio's bundled runtime on this machine is
 *     Java 25, and Gradle 8.14's Groovy compiler rejects it outright:
 *       "BUG! exception in phase 'semantic analysis'
 *        Unsupported class file major version 69"
 *     So the script finds a JDK whose major version Gradle actually supports,
 *     rather than assuming JAVA_HOME is right. A perfectly reasonable JAVA_HOME
 *     fails the build; that must not be the developer's problem to diagnose.
 *
 *  2. local.properties. A Windows path written with backslashes is read by
 *     Java's Properties loader as escape sequences, and Gradle reports the
 *     wonderfully unhelpful "java.io.IOException: Invalid file path". Forward
 *     slashes are written here for that reason.
 *
 * Usage:  node scripts/build-apk.mjs
 * Requires: the Android SDK, and a JDK 17–23.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.cwd());
const ANDROID_DIR = join(ROOT, 'android');
/**
 * The three installs. Each flavor in `android/app/build.gradle` has its own
 * application id, so they coexist on one phone.
 *
 * `dev` is the default because it is the one tested first. The web bundle is
 * built for the chosen environment below — the flavor only carries the identity —
 * so the environment has to be picked before `vite build`, not at Gradle time.
 */
const FLAVORS = {
  dev: {
    task: 'assembleDevDebug',
    output: join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'dev', 'debug', 'app-dev-debug.apk'),
    target: join(ROOT, 'artifacts', 'farmer-app-dev.apk'),
    ota: 'ota-dev',
  },
  staging: {
    task: 'assembleStagingDebug',
    output: join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'staging', 'debug', 'app-staging-debug.apk'),
    target: join(ROOT, 'artifacts', 'farmer-app-staging.apk'),
    ota: 'ota-staging',
  },
  production: {
    task: 'assembleProductionDebug',
    output: join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'production', 'debug', 'app-production-debug.apk'),
    target: join(ROOT, 'artifacts', 'farmer-app-production.apk'),
    ota: 'ota-production',
  },
};

/**
 * Where a build polls for its web bundle.
 *
 * The same repository `scripts/ota-publish.mjs` writes to, read the same way, so a
 * phone cannot be pointed at a channel nobody publishes. Unset keeps the default
 * every existing install already watches; a build made for a channel published
 * from another account passes `OTA_RELEASE_REPO=owner/repository`.
 */
const OTA_RELEASE_REPO =
  (process.env.OTA_RELEASE_REPO ?? '').trim() || 'abakhsh56/Farmer-App';
const OTA_RELEASES = `https://github.com/${OTA_RELEASE_REPO}/releases/download`;

function parseArgs(argv) {
  const flags = argv.slice(2);
  let flavor = 'dev';
  let clean = false;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--flavor') flavor = flags[i + 1];
    else if (flags[i].startsWith('--flavor=')) flavor = flags[i].slice('--flavor='.length);
    else if (flags[i] === '--clean') clean = true;
  }
  if (!FLAVORS[flavor]) {
    fail(`unknown flavor "${flavor}".`, `  Choose one of: ${Object.keys(FLAVORS).join(', ')}`);
  }
  return { flavor, clean };
}

const { flavor, clean } = parseArgs(process.argv);
const selection = FLAVORS[flavor];
const APK_SOURCE = selection.output;
const APK_TARGET = selection.target;

/** Gradle 8.14 supports up to Java 23. Java 24+ fails on the build script itself. */
const MIN_MAJOR = 17;
const MAX_MAJOR = 23;

function fail(message, detail) {
  console.error(`\nbuild-apk: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/** Reads JAVA_VERSION from a JDK's `release` file. Returns the major, or null. */
function jdkMajor(jdkPath) {
  const releaseFile = join(jdkPath, 'release');
  if (!existsSync(releaseFile)) return null;
  try {
    const text = readFileSync(releaseFile, 'utf8');
    const match = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(text);
    if (!match) return null;
    const first = Number(match[1]);
    // Java 1.8 style is not relevant here, but guard anyway.
    return first === 1 ? Number(match[2]) : first;
  } catch {
    return null;
  }
}

function candidateJdks() {
  const candidates = [];

  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  // JDKs that Android Studio / IntelliJ manage per-user. On this machine the
  // working JDK 21 lives here, which is why it is searched early.
  const jdksDir = join(homedir(), '.jdks');
  if (existsSync(jdksDir)) {
    for (const entry of readdirSync(jdksDir)) {
      candidates.push(join(jdksDir, entry));
    }
  }

  // Common system install locations, including Android Studio's bundled
  // runtime — which is listed so it can be *rejected* with a clear message
  // rather than silently used and then blamed on the toolchain.
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  for (const base of [programFiles, programFilesX86]) {
    candidates.push(join(base, 'Android', 'Android Studio', 'jbr'));
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft']) {
      const vendorDir = join(base, vendor);
      if (existsSync(vendorDir)) {
        for (const entry of readdirSync(vendorDir)) candidates.push(join(vendorDir, entry));
      }
    }
  }

  return [...new Set(candidates)];
}

function selectJdk() {
  const seen = [];
  for (const candidate of candidateJdks()) {
    const major = jdkMajor(candidate);
    if (major === null) continue;
    seen.push(`${candidate} (Java ${major})`);
    if (major >= MIN_MAJOR && major <= MAX_MAJOR) {
      return { path: candidate, major };
    }
  }

  fail(
    `no JDK between ${MIN_MAJOR} and ${MAX_MAJOR} was found.\n` +
      `  Gradle 8.14 refuses newer runtimes with "Unsupported class file major version",\n` +
      `  so a JDK 21 must be installed (Eclipse Temurin 21 is a safe choice).`,
    seen.length ? `  Examined:\n${seen.map((s) => `    - ${s}`).join('\n')}` : undefined,
  );
  return null;
}

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    // A usable SDK has platforms and build-tools; a bare directory does not.
    if (existsSync(join(candidate, 'platforms')) && existsSync(join(candidate, 'build-tools'))) {
      return candidate.replace(/\\/g, '/');
    }
  }

  fail(
    'no Android SDK found.\n' +
      '  Set ANDROID_HOME to a directory containing platforms/ and build-tools/,\n' +
      '  or install the SDK through Android Studio.',
  );
  return null;
}

// ---------------------------------------------------------------------------

const jdk = selectJdk();
const sdk = resolveAndroidSdk();

console.log(`build-apk: JDK   ${jdk.path} (Java ${jdk.major})`);
console.log(`build-apk: SDK   ${sdk}`);

if (!existsSync(ANDROID_DIR)) {
  fail('android/ does not exist. Run "npx cap add android" first.');
}

// Forward slashes: Java's Properties loader treats a backslash as an escape,
// and Gradle reports the resulting mess as "Invalid file path".
writeFileSync(join(ANDROID_DIR, 'local.properties'), `sdk.dir=${sdk}\n`);

const env = {
  ...process.env,
  JAVA_HOME: jdk.path,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
};

const isWindows = process.platform === 'win32';
// The absolute wrapper path is used on Windows for two reasons: `cmd /c` does
// not resolve gradlew.bat from the working directory the way a shell on Unix
// would, and this project's path contains a space, so the path is quoted
// explicitly rather than left to cmd's own parsing.
const wrapper = join(ANDROID_DIR, isWindows ? 'gradlew.bat' : 'gradlew');

if (!existsSync(wrapper)) {
  fail(`${wrapper} is missing — the android/ platform is incomplete.`);
}

const isWindowsShell = process.platform === 'win32';

/**
 * The web bundle is flavour-specific (environment + update channel are baked in),
 * so it is rebuilt and synced for every APK rather than copied once into all
 * three. This is the only way three installs on one phone can each follow their
 * own channel.
 */
function runWebBuild() {
  // A plain command line through the shell: on Windows `shell: true` resolves
  // npm/npx through PATHEXT, which a quoted `npm.cmd` does not (Node then tries to
  // load the .cmd file as JavaScript and reports MODULE_NOT_FOUND).
  const buildEnv = { ...env, VITE_APP_ENV: flavor, VITE_OTA_BASE: `${OTA_RELEASES}/${selection.ota}` };

  // Run the tools through `node` and their own entry scripts, not through npm:
  // this project has an `npm` package in node_modules, so a shell resolves `npm`
  // to that shim and dies with "Cannot find module …/node_modules/npm/bin".
  const node = process.execPath;
  const tsc = spawnSync(node, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) fail(`typecheck failed (exit ${tsc.status}).`);

  const vite = spawnSync(node, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (vite.status !== 0) fail(`the web build failed (exit ${vite.status}).`);

  const capacitor = spawnSync(node, [join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], {
    cwd: ROOT,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (capacitor.status !== 0) fail(`cap sync failed (exit ${capacitor.status}).`);
}

runWebBuild();

/**
 * `--clean` throws away Gradle's intermediates first.
 *
 * Needed whenever what is IN the bundle changes rather than its contents: removing
 * the 79 MB voice model left every new APK still carrying it, because the merged
 * asset directory is incremental and the old folder survived. `cap sync` had
 * already written the correct 2 MB, so the stale bytes were invisible until the
 * APK was measured.
 */
if (clean) {
  console.log('build-apk: gradlew clean…');
  const cleaned = isWindowsShell
    ? spawnSync(`"${join(ANDROID_DIR, 'gradlew.bat')}" clean`, { cwd: ANDROID_DIR, env, stdio: 'inherit', shell: true })
    : spawnSync(join(ANDROID_DIR, 'gradlew'), ['clean'], { cwd: ANDROID_DIR, env, stdio: 'inherit' });
  if (cleaned.status !== 0) fail(`gradlew clean failed (exit ${cleaned.status}).`);
}

console.log(`build-apk: running Gradle ${selection.task} (first run downloads dependencies)…\n`);

// Passed as a single quoted command string with shell:true on Windows. That
// produces the ""C:\...\gradlew.bat" assembleDebug" form that cmd.exe parses
// correctly; passing the path as a separate argv entry gets double-escaped by
// Node and cmd then reports the whole thing as an unrecognised command.
const build = isWindows
  ? spawnSync(`"${wrapper}" ${selection.task}`, {
      cwd: ANDROID_DIR,
      env,
      stdio: 'inherit',
      shell: true,
    })
  : spawnSync(wrapper, [selection.task], { cwd: ANDROID_DIR, env, stdio: 'inherit' });

if (build.status !== 0) {
  fail(`Gradle exited with status ${build.status}.`);
}

if (!existsSync(APK_SOURCE)) {
  fail(`Gradle reported success but ${APK_SOURCE} is missing.`);
}

mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
copyFileSync(APK_SOURCE, APK_TARGET);

const bytes = statSync(APK_TARGET).size;
console.log(`\nbuild-apk: APK written to ${APK_TARGET}`);
console.log(`build-apk: size ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`build-apk: install with  adb install -r artifacts/farmer-app-${flavor}.apk`);

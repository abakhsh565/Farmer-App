/**
 * Live updates for the installed Android app.
 *
 * The APK ships one web bundle. This module lets that same install move to a
 * newer bundle without anyone reinstalling: it asks the environment's channel
 * for a manifest, and if the manifest names a bundle the app is not already
 * running, it downloads the zip, checks it, sets it as the next bundle and
 * reloads.
 *
 * Why self-hosted: Capawesome's plugin is MIT and downloads from any URL, so the
 * channel is a GitHub Release asset per environment — no paid service, no vendor
 * account, and the same free path works in production. `sync()` from that plugin
 * talks to Capawesome Cloud and is deliberately not used.
 *
 * One channel per environment, baked in at build time by `VITE_OTA_BASE`:
 *
 *   dev        …/releases/download/ota-dev
 *   staging    …/releases/download/ota-staging
 *   production …/releases/download/ota-production
 *
 * Each release carries two assets, both rewritten on every publish:
 *
 *   bundle.zip   the built web assets, index.html at the root
 *   latest.json  { "bundleId": "…", "checksum": "<sha256 of bundle.zip>" }
 *
 * Rules this follows, in the order they matter:
 *
 *  · Web is never touched. A browser already fetches the deployment's own files,
 *    so the plugin is not even imported into that path at runtime.
 *  · A network or manifest failure is not an error the farmer sees: the app keeps
 *    the bundle inside the APK, which is always a complete, working build.
 *  · `ready()` is called first, before any download, because the plugin rolls the
 *    app back to the shipped bundle if a new bundle never reports itself ready.
 *  · The checksum is verified by the native side, so a truncated or foreign zip
 *    is rejected instead of being booted into.
 *
 * ## Why the manifest is read natively
 *
 * It used to be `fetch()`. Inside the app the page is served from
 * `https://localhost` and GitHub's release CDN sends no
 * `Access-Control-Allow-Origin`, so the browser refused every read and the app
 * printed a CORS error to a console no farmer can see. Nothing downloaded, ever,
 * and the swallow-on-error rule above turned "no updates" into a silent
 * permanent state.
 *
 * `CapacitorHttp` performs the request in native code, where the WebView's
 * same-origin policy does not apply. That is the whole fix: same URL, same
 * manifest, no policy in the way. The browser path keeps `fetch` because there
 * the deployment is same-origin and already current.
 *
 * ## And why a failed read retries
 *
 * The check runs at launch and whenever the app comes back to the foreground. A
 * phone that opens on a dead spot therefore used to wait up to fifteen minutes
 * for the next attempt; now a failed read is retried after a minute, and the
 * failure is logged with its reason so a device on a bench can be diagnosed
 * without guessing.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';

/** Written by `scripts/ota-publish.mjs` next to the zip it describes. */
type Manifest = {
  bundleId: string;
  checksum: string;
};

const MANIFEST_FILE = 'latest.json';
const BUNDLE_FILE = 'bundle.zip';

/** How long an install that is already open waits before asking again. */
const RECHECK_AFTER_MS = 15 * 60 * 1000;

/** How soon a failed read is tried again. Short, because a failure is not a state. */
const RETRY_AFTER_MS = 60 * 1000;

/** A manifest read that hangs must not hold the retry timer for ever. */
const NETWORK_TIMEOUT_MS = 20 * 1000;

/**
 * The channel this build watches, or null when the build was made without one
 * (a plain `npm run build` for the browser, or a local debug build).
 */
function channelBase(): string | null {
  const configured = import.meta.env.VITE_OTA_BASE;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The manifest, from whatever the transport returned.
 *
 * `CapacitorHttp` parses JSON when it can and hands back the raw text when it
 * cannot, so both shapes are accepted here rather than assuming one — a manifest
 * that arrives as a string is still a manifest, and refusing it would be the same
 * silent no-update this module exists to end.
 */
function asManifest(value: unknown): Manifest | null {
  if (typeof value === 'string') {
    try {
      return asManifest(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const bundleId = record.bundleId;
  const checksum = record.checksum;
  if (typeof bundleId !== 'string' || bundleId.length === 0) return null;
  if (typeof checksum !== 'string' || checksum.length === 0) return null;
  return { bundleId, checksum };
}

/**
 * The channel's current manifest, or null when it could not be read.
 *
 * On a device the read goes through native HTTP, which is the only transport that
 * is not subject to the WebView's cross-origin rules. In a browser it stays a
 * plain `fetch`: that origin serves its own files, and the module is a no-op there
 * anyway.
 */
async function readManifest(url: string): Promise<Manifest | null> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      connectTimeout: NETWORK_TIMEOUT_MS,
      readTimeout: NETWORK_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      console.warn(`liveUpdate: manifest answered HTTP ${response.status}`);
      return null;
    }
    const manifest = asManifest(response.data);
    if (!manifest) console.warn('liveUpdate: manifest was not readable JSON');
    return manifest;
  }

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    console.warn(`liveUpdate: manifest answered HTTP ${response.status}`);
    return null;
  }
  const manifest = asManifest(await response.json());
  if (!manifest) console.warn('liveUpdate: manifest was not readable JSON');
  return manifest;
}

/**
 * One look at the channel.
 *
 * Returns true when the phone is now on the newest bundle (already, or after the
 * download and reload), false when the channel could not be consulted — which is
 * the only case worth retrying.
 */
async function check(base: string): Promise<boolean> {
  const current = await LiveUpdate.getCurrentBundle();
  const next = await LiveUpdate.getNextBundle();

  /*
   * The query string is not decoration: GitHub's release CDN caches assets by URL
   * and was seen serving the previous publish's `latest.json` after a new one had
   * been uploaded — the app read the bundleId it was already running, concluded it
   * was up to date, and stayed on the old code with nothing in the log. A unique
   * URL per check is a different cache key, so the manifest read is never stale.
   */
  const manifest = await readManifest(`${base}/${MANIFEST_FILE}?v=${Date.now()}`);
  if (!manifest) return false;

  // Already running it, or already staged it. The second case only needs the
  // reload that a previous attempt did not reach (the app was killed first).
  if (current.bundleId === manifest.bundleId) return true;
  if (next.bundleId === manifest.bundleId) {
    console.info(`liveUpdate: ${manifest.bundleId} is already staged — reloading`);
    await LiveUpdate.reload();
    return true;
  }

  console.info(
    `liveUpdate: downloading ${manifest.bundleId} (running ${current.bundleId ?? 'the bundled build'})`,
  );

  try {
    await LiveUpdate.downloadBundle({
      /* Keyed by bundleId for the same reason: an asset URL that has already been
         served once must not hand this bundle a zip from an earlier publish. The
         checksum would reject it, which is safe but silent. */
      url: `${base}/${BUNDLE_FILE}?v=${encodeURIComponent(manifest.bundleId)}`,
      bundleId: manifest.bundleId,
      checksum: manifest.checksum,
    });
  } catch (failure) {
    /*
     * An interrupted attempt leaves the bundle directory behind, and the native
     * plugin refuses to download a bundle it already has. That is not a failure of
     * this check: the bytes are verified by checksum on the next step, so staging
     * what is already on disk is exactly right. Anything else is rethrown.
     */
    const message = failure instanceof Error ? failure.message : String(failure);
    if (!/exist/i.test(message)) throw failure;
    console.info('liveUpdate: bundle was already downloaded — staging it');
  }

  await LiveUpdate.setNextBundle({ bundleId: manifest.bundleId });
  await LiveUpdate.reload();
  return true;
}

/**
 * When the last check ran, whether one is running now, and the pending retry.
 *
 * Module scope because it must survive a screen changing: the app is one WebView,
 * and re-mounting React is in no way a reason to ask the channel again.
 */
let lastCheckAt = 0;
let checking = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Ask the channel again in a minute.
 *
 * A timer rather than a loop: the WebView is suspended while the phone is in a
 * pocket, and a retry that fires there costs nothing but also does nothing — the
 * foreground listener is what covers that case. This only shortens the wait for a
 * phone that is open and was briefly offline.
 */
function scheduleRetry(base: string): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void checkWhenDue(base, true);
  }, RETRY_AFTER_MS);
}

/**
 * Ask the channel, at most once per interval and never twice at once.
 *
 * Checking only at cold start meant a phone that is opened from the background
 * every morning — which is how a messaging app is actually used — could sit on a
 * bundle from weeks ago and never see a fix. The interval is what keeps that from
 * becoming a network call every time the farmer glances at the screen. `forced`
 * is for the retry timer, which is already the interval.
 */
async function checkWhenDue(base: string, forced = false): Promise<void> {
  if (checking) return;
  if (!forced && lastCheckAt !== 0 && Date.now() - lastCheckAt < RECHECK_AFTER_MS) return;

  checking = true;
  try {
    const settled = await check(base);
    if (!settled) scheduleRetry(base);
  } catch (failure) {
    // Offline, a manifest that is not there yet, or a download that was cut off.
    // The shipped bundle keeps running, and the read is tried again shortly.
    console.warn('liveUpdate: check failed, will retry', failure);
    scheduleRetry(base);
  } finally {
    checking = false;
    lastCheckAt = Date.now();
  }
}

/**
 * Called once at startup. Never awaited by the render path: an update must not
 * delay the first screen, and a failure must not stop the app from opening.
 */
export function startLiveUpdates(): void {
  if (!Capacitor.isNativePlatform()) return;

  // Before anything else: this is what tells the plugin the running bundle is
  // healthy and stops the automatic rollback timer.
  void LiveUpdate.ready()
    .then((ready) => {
      console.info(
        `liveUpdate: ready — running ${ready.currentBundleId ?? 'the bundled build'}, previous ${ready.previousBundleId ?? 'none'}`,
      );
    })
    .catch((failure: unknown) => {
      console.warn('liveUpdate: ready() failed', failure);
    });

  const base = channelBase();
  if (!base) return;

  console.info(`liveUpdate: watching ${base}`);
  void checkWhenDue(base);

  // Returning to the app is the other moment it can update: Android keeps a
  // WebView alive for days, so "next launch" may not happen for a week.
  void (async () => {
    try {
      const { App } = await import('@capacitor/app');
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void checkWhenDue(base);
      });
    } catch {
      // No App plugin (an older shell): the startup check still happened.
    }
  })();
}

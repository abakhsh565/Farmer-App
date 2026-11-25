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
 */

import { Capacitor } from '@capacitor/core';
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

async function check(base: string): Promise<void> {
  const current = await LiveUpdate.getCurrentBundle();
  const next = await LiveUpdate.getNextBundle();

  /*
   * The query string is not decoration: GitHub's release CDN caches assets by URL
   * and was seen serving the previous publish's `latest.json` after a new one had
   * been uploaded — the app read the bundleId it was already running, concluded it
   * was up to date, and stayed on the old code with nothing in the log. A unique
   * URL per check is a different cache key, so the manifest read is never stale.
   */
  const response = await fetch(`${base}/${MANIFEST_FILE}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return;

  const manifest = (await response.json()) as Manifest | null;
  if (!manifest?.bundleId || typeof manifest.checksum !== 'string') return;

  // Already running it, or already staged it. The second case only needs the
  // reload that a previous attempt did not reach (the app was killed first).
  if (current.bundleId === manifest.bundleId) return;
  if (next.bundleId === manifest.bundleId) {
    await LiveUpdate.reload();
    return;
  }

  await LiveUpdate.downloadBundle({
    /* Keyed by bundleId for the same reason: an asset URL that has already been
       served once must not hand this bundle a zip from an earlier publish. The
       checksum would reject it, which is safe but silent. */
    url: `${base}/${BUNDLE_FILE}?v=${encodeURIComponent(manifest.bundleId)}`,
    bundleId: manifest.bundleId,
    checksum: manifest.checksum,
  });
  await LiveUpdate.setNextBundle({ bundleId: manifest.bundleId });
  await LiveUpdate.reload();
}

/**
 * When the last check ran, and whether one is running now.
 *
 * Module scope because it must survive a screen changing: the app is one WebView,
 * and re-mounting React is in no way a reason to ask the channel again.
 */
let lastCheckAt = 0;
let checking = false;

/**
 * Ask the channel, at most once per interval and never twice at once.
 *
 * Checking only at cold start meant a phone that is opened from the background
 * every morning — which is how a messaging app is actually used — could sit on a
 * bundle from weeks ago and never see a fix. The interval is what keeps that from
 * becoming a network call every time the farmer glances at the screen.
 */
async function checkWhenDue(base: string): Promise<void> {
  if (checking) return;
  if (lastCheckAt !== 0 && Date.now() - lastCheckAt < RECHECK_AFTER_MS) return;

  checking = true;
  try {
    await check(base);
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
  void LiveUpdate.ready().catch(() => {});

  const base = channelBase();
  if (!base) return;

  const quietly = () => {
    // Offline, a manifest that is not there yet, or a plugin that is not built
    // into this APK. The shipped bundle keeps running.
  };

  void checkWhenDue(base).catch(quietly);

  // Returning to the app is the other moment it can update: Android keeps a
  // WebView alive for days, so "next launch" may not happen for a week.
  void (async () => {
    try {
      const { App } = await import('@capacitor/app');
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void checkWhenDue(base).catch(quietly);
      });
    } catch {
      // No App plugin (an older shell): the startup check still happened.
    }
  })();
}

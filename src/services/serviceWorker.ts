/**
 * The service worker — and the one rule an installed app must never break.
 *
 * In a browser the worker is what makes the app open with no signal, so it
 * caches the shell and the assets. In the installed Android app it is a hazard:
 * the web assets ship *inside the APK* (or arrive as an OTA bundle), so a worker
 * left over from a previous build keeps answering with the previous build's
 * `index.html` and asset names. Installing a newer APK then looks like a no-op
 * until somebody clears site data by hand — which is exactly what happened on
 * staging: a fresh `1.0-staging` APK served the old bundle until the worker was
 * unregistered.
 *
 * So the native shell does not get a worker at all. It has nothing to gain from
 * one (its files are local and complete) and everything to lose. A worker found
 * there — from an older build of this same app — is removed along with its
 * caches, once, on startup.
 *
 * In the browser the worker stays, registered directly rather than by the
 * generated `registerSW.js`, with `updateViaCache: 'none'` so a new deployment's
 * `sw.js` is always re-read. A worker that takes over a page that was already
 * controlled means the page is running one build behind the deployment, and the
 * page is reloaded once to the build that was actually shipped.
 */

import { Capacitor } from '@capacitor/core';

/** Whether this platform should run a service worker at all. */
export function shouldUseServiceWorker(native: boolean): boolean {
  return !native;
}

/**
 * Whether a controller change should reload the page.
 *
 * Only when the page was *already* controlled: the first worker claiming an
 * uncontrolled page is normal startup, and reloading there would double every
 * first visit.
 */
export function shouldReloadOnControllerChange(hadController: boolean): boolean {
  return hadController;
}

/** Removes every worker and cache this origin has. Returns what it removed. */
export async function clearWorkerState(): Promise<{ unregistered: number; caches: string[] }> {
  let unregistered = 0;
  const cleared: string[] = [];

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if (await registration.unregister()) unregistered += 1;
    }
  }

  if (typeof caches !== 'undefined') {
    for (const key of await caches.keys()) {
      if (await caches.delete(key)) cleared.push(key);
    }
  }

  return { unregistered, caches: cleared };
}

/**
 * Called once at startup, before the first render completes.
 *
 * Never throws and never blocks: a failure here leaves the app with whatever the
 * previous build had, which is worse than a clean worker but better than no app.
 */
export async function startServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const native = Capacitor.isNativePlatform();

  try {
    if (!shouldUseServiceWorker(native)) {
      await clearWorkerState();
      return;
    }

    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (shouldReloadOnControllerChange(hadController)) window.location.reload();
    });

    const registration = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none',
    });

    // Ask now rather than waiting for the browser's own timer: an app opened once a
    // day should not discover a week-old deployment.
    await registration.update();
  } catch {
    /* Offline, or a worker the platform refused: the app still runs. */
  }
}

import { describe, expect, it } from 'vitest';

import {
  clearWorkerState,
  shouldReloadOnControllerChange,
  shouldUseServiceWorker,
} from './serviceWorker';

/**
 * The rule these pin: the installed app must never be able to serve a bundle
 * older than the one it was shipped with, and a browser must keep its offline
 * shell. The first is what broke on staging — a new APK kept serving the old
 * bundle because a worker from the previous build answered first.
 */
describe('the service worker and the installed app', () => {
  it('runs no worker in the native shell and keeps one in the browser', () => {
    expect(shouldUseServiceWorker(true)).toBe(false);
    expect(shouldUseServiceWorker(false)).toBe(true);
  });

  it('reloads only when the page was already controlled', () => {
    // A worker taking over an uncontrolled page is ordinary startup.
    expect(shouldReloadOnControllerChange(false)).toBe(false);
    // A worker replacing one the page was already using is a new deployment.
    expect(shouldReloadOnControllerChange(true)).toBe(true);
  });

  it('reports nothing to clear when the platform has no worker or caches', async () => {
    await expect(clearWorkerState()).resolves.toEqual({ unregistered: 0, caches: [] });
  });
});

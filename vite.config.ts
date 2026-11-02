import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: false,
    host: '127.0.0.1',
  },
  /*
   * MapLibre parses tiles in a web worker, and it ships that worker as a module.
   * Vite's default worker format is an IIFE, which cannot load an ES module
   * worker — the map comes up grey with a "Worker failed to load" error and no
   * console clue about why. Building workers as ES modules fixes it.
   */
  worker: {
    format: 'es',
  },
  /*
   * onnxruntime's wasm build is imported at runtime, after a press, so Vite only
   * discovers it then — and a dependency it has not pre-bundled is a module the
   * page cannot fetch. Naming it here bundles it up front.
   */
  optimizeDeps: {
    exclude: ['onnxruntime-web/wasm'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    /*
     * The screen-level suites assert on real timers — the feed's own 600 ms
     * loading state, a 4 s window for storage, a 1.2 s analysis step. Run with
     * every core saturated and those windows close before the assertion lands,
     * which reads as a product failure and is not one. Capping the pool is the
     * honest fix: the tests keep their real timing, the machine stops being
     * oversubscribed.
     */
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
    testTimeout: 15_000,
    /*
     * The environment the suites run in, pinned rather than inherited.
     *
     * Vite loads `.env.local` in every mode, including this one — so a working
     * copy that has live weather switched on would have every screen test making
     * a network call and asserting on a delivery the fixture never produces. The
     * weather source is configuration, and a test's configuration is not the
     * developer's: it is this, and it is the same on every machine.
     */
    env: {
      VITE_WEATHER_PROVIDER: 'development',
      /*
       * The same rule for every other endpoint, and now it matters for all of
       * them: a developer who has filled in `.env.local` — which is the normal
       * state of a working copy — would otherwise have every screen test talking
       * to a real project. Empty means "unconfigured", which is what resolves the
       * suite to the development providers.
       */
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_AI_ENDPOINT: '',
      VITE_OTP_ENDPOINT: '',
      VITE_WEATHER_INGEST_ENDPOINT: '',
      VITE_DEALER_ENDPOINT: '',
      // Both spellings are neutralised for tests. The new name is what the app
      // asks for first; the old one is still read as a fallback, so a
      // deployment configured before the rename keeps working.
      VITE_ANALYTICS_KEY: '',
      VITE_POSTHOG_KEY: '',
      /*
       * Pinned empty for the same reason as every other value here, and more so:
       * this one holds demo credentials. Left unset, a developer's own `.env.local`
       * would silently decide whether the suite exercised the demo sign-in path —
       * and the suites that assert the ordinary providers would be running against
       * a different app than the one on disk.
       */
      VITE_DEMO_FARMERS: '',
    },
  },
});

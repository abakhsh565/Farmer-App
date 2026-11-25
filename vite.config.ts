import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import speak, { type HandlerRequest, type HandlerResponse } from './api/tts';
import transcribe from './api/transcribe';

/**
 * The Urdu voice, served by the dev server as well as by a deployment.
 *
 * `api/tts.ts` is a Vercel-style serverless function, and `vite dev` has no
 * functions: every Listen press in a development build used to request
 * `/api/tts`, get a `404` from the Vite server, fall back to the hosted Worker,
 * and — on a day when that Worker's model quota was spent — end in silence. The
 * pill then looked broken on the one machine where the voice was being worked on.
 *
 * So the same handler is mounted here, unchanged. It reads `GEMINI_API_KEY` from
 * `process.env` exactly as it does in production, which is why the key stays
 * server-side in both: nothing is inlined into the JavaScript the browser loads.
 * `apply: 'serve'` keeps it out of every build, so a bundle can never contain it.
 *
 * This is a development aid, not an environment: it holds the developer's own key
 * and talks to no database of its own.
 */
function voiceInDevelopment(): Plugin {
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    /** One of the two API functions: the adapter below is identical for both. */
    handler: (request: HandlerRequest, response: HandlerResponse) => Promise<void>,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));

    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = {};
    try {
      body = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }

    /*
     * The handler speaks Express's `res`, not Node's. This adapter is the whole
     * of the difference between the two, which is why the function itself did not
     * need a second implementation.
     */
    const adapter: HandlerResponse = {
      status(code) {
        response.statusCode = code;
        return adapter;
      },
      setHeader(name, value) {
        response.setHeader(name, value);
      },
      json(payload) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
      },
      send(payload) {
        response.end(payload);
      },
      end(payload) {
        response.end(payload);
      },
    };

    try {
      await handler({ method: request.method, body }, adapter);
    } catch {
      /* A missing key or a dead provider is already a status the app understands;
         anything else is a bug in the handler and must not hang the request. */
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'voice-failed' }));
    }
  }

  return {
    name: 'farmer-voice-in-development',
    apply: 'serve',
    configureServer(server) {
      /*
       * Both halves of the voice, mounted the same way. The microphone is not a
       * development-only idea — `api/transcribe.ts` ships with the deployment — but
       * a dev server has no functions, so without this the mic would fail on the
       * one machine where it is being worked on.
       */
      server.middlewares.use('/api/tts', (request, response) => {
        void handle(request, response, speak);
      });
      server.middlewares.use('/api/transcribe', (request, response) => {
        void handle(request, response, transcribe);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  /*
   * The key the voice function reads is not a `VITE_` variable, so Vite does not
   * put it in `import.meta.env` — and that is the point: it must never reach the
   * browser bundle. `loadEnv` with an empty prefix reads the whole file for the
   * *server* process, which is where `api/tts.ts` looks.
   */
  const env = loadEnv(mode, process.cwd(), '');
  process.env.GEMINI_API_KEY ||= env.GEMINI_API_KEY ?? '';
  process.env.GEMINI_TTS_MODEL ||= env.GEMINI_TTS_MODEL ?? '';
  process.env.GEMINI_TTS_VOICE ||= env.GEMINI_TTS_VOICE ?? '';


  return {
  plugins: [
    react(),
    tailwindcss(),
    voiceInDevelopment(),
    /*
     * Installability for phones that will never see a store listing.
     *
     * An installed PWA on iOS is the only path to a home-screen app without an
     * Apple developer account, and on Android it is a first-class install. The
     * service worker caches the shell so the app opens with no signal, which is
     * the normal state in a field.
     *
     * Skipped in the test run: workbox writes real files and registers real
     * workers, and a unit suite that does either is testing the bundler.
     */
    ...(mode === 'test'
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/apple-touch-icon.png', 'icons/mark.svg'],
            manifest: {
              name: 'Farmer — apni dukan',
              short_name: 'Farmer',
              description:
                'Mandi rates, weather, crop advice and your shop, in Urdu and English.',
              lang: 'ur',
              start_url: '/',
              scope: '/',
              display: 'standalone',
              orientation: 'portrait',
              background_color: '#FAF9F5',
              theme_color: '#1F2A17',
              categories: ['business', 'productivity', 'weather'],
              icons: [
                { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                {
                  src: '/icons/icon-maskable-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            workbox: {
              globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
              navigateFallback: '/index.html',
              /* MapLibre's worker and the font subset push past the 2 MB default. */
              maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
              cleanupOutdatedCaches: true,
            },
          }),
        ]),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: false,
    host: '127.0.0.1',
    /*
     * A cold dev load is dominated by transforming the screen graph, not by the
     * browser. Warming the entry graph when the server starts moves that work
     * off the first navigation. It has no effect on the production build.
     */
    warmup: {
      clientFiles: ['./src/main.tsx', './src/App.tsx', './src/screens/HomeScreen.tsx'],
    },
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
       * The suite runs as its own environment, not as `dev`.
       *
       * `dev`, `staging` and `production` each resolve to a real AgriShop project
       * (`services/shopEnvironments.ts`), so a suite that inherited any of them
       * would read live listings and could write into a live shop's conversation.
       * `test` resolves to nothing, which is what keeps the empty endpoints below
       * actually empty.
       */
      VITE_APP_ENV: 'test',
      /*
       * The same rule for every other endpoint, and now it matters for all of
       * them: a developer who has filled in `.env.local` — which is the normal
       * state of a working copy — would otherwise have every screen test talking
       * to a real project. Empty means "unconfigured", which is what resolves the
       * suite to the development providers.
       */
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      // The marketplace is a second project with its own key; pinned empty for
      // the same reason, and more so here: these tests must never read the
      // production listings, and an empty key resolves the dealer service to the
      // fixture the suites assert on.
      VITE_MARKETPLACE_URL: '',
      VITE_MARKETPLACE_KEY: '',
      // The shop app's backend. Pinned empty so no suite ever reaches a real
      // shop, and so the on-device conversation the chat suites assert on is the
      // one they get.
      VITE_SHOP_API_URL: '',
      VITE_SHOP_API_KEY: '',
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
  };
});

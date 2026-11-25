/**
 * The environment a web bundle is built for, with the developer's own backend
 * kept out of it.
 *
 * Vite loads `.env.local` for every build, and `src/services/config.ts` prefers an
 * explicit `VITE_SHOP_API_URL` / `VITE_MARKETPLACE_URL` over the per-environment
 * table. On a developer's machine that file points at the local stack, so a
 * staging build made there shipped `http://127.0.0.1:54321` as the shop backend:
 * unreachable from a browser or a phone, and invisible in the build log because
 * the build itself succeeded and the screen simply failed to connect.
 *
 * `scripts/build-apk.mjs` has guarded the APK path against this from the start.
 * This module is the same guard for the two other paths that publish a bundle —
 * the site (`scripts/release-site.mjs`) and the live-update channel
 * (`scripts/ota-publish.mjs`), which is how a phone gets its web layer.
 *
 * `dev` keeps the developer's values, because dev's backend *is* the local stack.
 * An empty string overrides the file (process env wins) and reads back as
 * "unset", so the environment table in `src/services/` decides — which is the
 * rule every CI build already follows.
 */
export function buildEnvFor(environment, base = process.env) {
  if (environment === 'dev') return { ...base, VITE_APP_ENV: environment };

  return {
    ...base,
    VITE_APP_ENV: environment,
    VITE_SHOP_API_URL: '',
    VITE_SHOP_API_KEY: '',
    VITE_MARKETPLACE_URL: '',
    VITE_MARKETPLACE_KEY: '',
    // Unused by a staging or production build — `config.ts` takes the backend from
    // the environment table for both — but inlined all the same, and a localhost
    // URL inside a release artifact is a false alarm waiting to happen.
    VITE_SUPABASE_URL: '',
    VITE_SUPABASE_ANON_KEY: '',
  };
}

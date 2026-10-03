import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Wraps the built farmer app as a native Android application.
 *
 * The PRD blueprint names React Native + Expo. That was not taken up: the
 * approved UI is a React 18 web app and is locked, so the mobile target is
 * reached by packaging that exact build rather than by re-implementing the
 * screens on another framework. A rewrite would have meant rebuilding every
 * screen the PRD says is already final, which is the one thing the brief rules
 * out. The consequence is stated plainly in docs/PRD-ALIGNMENT.md: this is a
 * WebView application, not a native one.
 *
 * `webDir` must match Vite's output, which is `dist`.
 */
const config: CapacitorConfig = {
  appId: 'pk.agrishop.farmer',
  appName: 'Farmer',
  webDir: 'dist',

  android: {
    // The app talks to Supabase over HTTPS and nothing else, so cleartext stays
    // off. A development build against a local server would need this flipped,
    // which is why it is written here explicitly rather than left at default.
    allowMixedContent: false,
  },

  server: {
    // No `url` is set on purpose: the app must load its bundled assets. Setting
    // one would make the installed app depend on a developer's laptop, which is
    // exactly the prototype dependency this build is meant to remove.
    androidScheme: 'https',
  },
};

export default config;

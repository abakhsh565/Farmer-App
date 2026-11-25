import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted, bundled at build time — nothing is fetched from a font CDN, so the
// app renders in its real voice with no network at all.
//
// Latin subsets only. The interface is English and Urdu, so the extended-Latin,
// Cyrillic and Greek faces would be weight the reader never sees.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/jetbrains-mono/latin-500.css';
// Arabic subset only, not the full face with its latin ranges: Urdu is a second
// language here, and this is the difference between one small file and three.
import '@fontsource/noto-naskh-arabic/arabic-400.css';

import '@/styles/theme.css';
import { App } from '@/App';
import { initAnalytics } from '@/services/analytics';
import { startLiveUpdates } from '@/services/liveUpdate';
import { startServiceWorker } from '@/services/serviceWorker';

const container = document.getElementById('root');

if (!container) {
  throw new Error('#root container was not found in index.html');
}

// Started before the first render so a screen viewed during mount is recorded,
// and called unconditionally because it no-ops when no key is configured: an
// unconfigured build makes no network call at all.
initAnalytics();

// The installed Android app moves to a newer web bundle from its environment's
// channel without being reinstalled. A browser has nothing to do here — it fetches
// that deployment's files — so this is a no-op off the native platform, and it
// never blocks the first render.
startLiveUpdates();

// The worker belongs to the browser, not to the installed app: there it is what
// keeps a phone opening yesterday's bundle after a new build arrives. Registered
// (or removed) before the first render so the very first paint is the shipped one.
void startServiceWorker();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted, bundled at build time — nothing is fetched from a font CDN, so the
// app renders in its real voice with no network at all.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/jetbrains-mono/500.css';
// Arabic subset only, not the full face with its latin ranges: Urdu is a second
// language here, and this is the difference between one small file and three.
import '@fontsource/noto-naskh-arabic/arabic-400.css';

import '@/styles/theme.css';
import { App } from '@/App';
import { initAnalytics } from '@/services/analytics';

const container = document.getElementById('root');

if (!container) {
  throw new Error('#root container was not found in index.html');
}

// Started before the first render so a screen viewed during mount is recorded,
// and called unconditionally because it no-ops when no key is configured: an
// unconfigured build makes no network call at all.
initAnalytics();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './index.css'
import { createRoot } from 'react-dom/client';
import App from './App'
import { registerServiceWorker } from './utils/pwa';

// After a deploy, a page that was already open asks for build files that no
// longer exist (their names change every build). Vite reports that here: load
// the new version of the page once instead of showing a blank or broken page.
// A second failure within a minute is left to the caller (no reload loop).
const CHUNK_RELOAD_KEY = 'chunk-reload-at';
// The error itself still reaches the code that asked for the file (it shows a
// message until the reload lands).
window.addEventListener('vite:preloadError', () => {
  let last = 0;
  try { last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0; } catch { /* storage off */ }
  if (Date.now() - last < 60_000) return;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch { return; /* cannot guard: no reload */ }
  window.location.reload();
});

// The installable app: a service worker that keeps only the public files (production builds, docs/pwa.md).
registerServiceWorker();

// No server-side rendering any more (every route was wrapped in NoSSR, so the
// server HTML was empty anyway). The server only injects window.__INITIAL_DATA__.
createRoot(document.getElementById('root') as HTMLElement).render(
  <App isServer={false} />
)

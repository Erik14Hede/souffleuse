/* Souffleuse – Service Worker: App offline verfügbar machen */
const VERSION = '1.0.6';
const APP_CACHE = 'souffleuse-app-' + VERSION;
const LIB_CACHE = 'souffleuse-lib-v1';

const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/store.js', 'js/format.js', 'js/importers.js', 'js/ai.js', 'js/audio.js',
  'js/emotion.js', 'js/cast.js', 'js/player.js', 'js/demo.js',
  'js/engines/device.js', 'js/engines/piper.js', 'js/engines/piper-worker.js', 'js/engines/gemini.js',
  'fonts/literata-latin-opsz-normal.woff2', 'fonts/literata-latin-opsz-italic.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('souffleuse-app-') && k !== APP_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Stimmen & APIs nicht anfassen

  // Große Bibliotheken und Schriften: einmal laden, dann aus dem Cache
  if (/\/(vendor|fonts|icons)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Seitenaufrufe: erst Netz (für Updates), sonst Cache
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(APP_CACHE);
        cache.put('index.html', res.clone());
        return res;
      } catch (err) {
        return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // App-Dateien: sofort aus dem Cache, im Hintergrund aktualisieren
  e.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});

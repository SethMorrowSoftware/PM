/* Castle Tech Tasks — service worker.
 * Offline app shell + fast static loads, with NO interference with the API or
 * the ?v= cache-busting model:
 *   - /api/ requests: network only (never cached — data must be live).
 *   - navigations (HTML): network-first, fall back to cached shell when offline.
 *   - static assets (css/js/svg/fonts): stale-while-revalidate.
 * Bump CACHE to force a clean sweep on a deploy.
 */
const CACHE = 'ctt-cache-v3';
const SHELL = ['index.html', 'manifest.json', 'assets/icon.svg', 'assets/favicon.svg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never touch writes
  const url = new URL(req.url);

  // Same-origin API calls must always hit the network.
  if (url.origin === self.location.origin && url.pathname.includes('/api/')) {
    return; // default browser fetch
  }

  // Navigations: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a real, same-origin 200 as the offline shell. Caching a
          // redirect (302 to login) or an error page would poison the fallback
          // and serve that instead of index.html on the next offline load.
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && (url.origin === self.location.origin)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

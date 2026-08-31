// Service worker: cache static assets, show a friendly offline page for navigation.
// Pages themselves are always network-first so nobody ever sees stale task data.
const CACHE = 'crm-static-v1';
const ASSETS = [
  '/css/app.css', '/js/app.js', '/offline.html',
  '/img/logo.svg', '/img/empty-team.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  const url = new URL(req.url);
  if (url.origin === self.location.origin && /\.(css|js|png|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});

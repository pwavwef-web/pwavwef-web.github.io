/**
 * AZ Learner – Service Worker
 * Handles offline caching for the PWA shell and static assets.
 */

const CACHE_NAME = 'az-learner-v2.2';

// App-shell assets to pre-cache on installation
const PRECACHE_URLS = [
  '/pwa/',
  '/pwa/index.html',
  '/pwa/manifest.json',
  '/app-icon.png',
  '/favicon1.png'
];

// ── Install: pre-cache shell assets ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first with cache fallback ─────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests to same origin (skip cross-origin CDN calls)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(networkResponse => {
        // Cache a clone of successful responses for same-origin assets
        if (networkResponse && networkResponse.status === 200) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, cloned));
        }
        return networkResponse;
      })
      .catch(() => caches.match(request))
  );
});

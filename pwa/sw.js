/**
 * AZ Learner – Service Worker
 *
 * Default scope: /pwa/  (the directory where this file lives).
 * To expand the scope to / (and cache root-level assets too), configure the
 * hosting server to send the header:
 *   Service-Worker-Allowed: /
 * and register with: navigator.serviceWorker.register('/pwa/sw.js', { scope: '/' })
 * See pwa/DEPLOY.md for hosting-specific instructions.
 *
 * Caching strategy:
 *  • PWA shell files        → Pre-cached on install (instant offline load)
 *  • Firebase / Paystack    → Network-only (never cache auth tokens or live data)
 *  • Navigation requests    → Network-first → offline shell fallback
 *  • Same-origin static     → Cache-first (fast repeat loads)
 *  • CDN assets             → Network-first → cache fallback (fresh on updates,
 *                             readable offline after first visit)
 */

const CACHE_NAME = 'az-learner-v1';

/** Assets to pre-cache on install (the "app shell") */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/** URL patterns that must NEVER be served from the cache */
const NETWORK_ONLY_PATTERNS = [
  /firebasestorage\.googleapis\.com/,
  /firebaseio\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /googleapis\.com\/identitytoolkit/,
  /gstatic\.com\/firebasejs/,
  /js\.paystack\.co/,
];

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch handler ─────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension and non-http(s) schemes
  if (!url.protocol.startsWith('http')) return;

  // Network-only: Firebase, Paystack, and other sensitive external APIs
  if (NETWORK_ONLY_PATTERNS.some((re) => re.test(request.url))) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests: network-first → offline shell fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Update the cache with the fresh response
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match('./index.html').then(
            (cached) => cached || new Response('Offline – please reconnect.', { status: 503 })
          )
        )
    );
    return;
  }

  // Same-origin static assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
      )
    );
    return;
  }

  // External CDN assets (Tailwind, Font Awesome, Google Fonts): network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

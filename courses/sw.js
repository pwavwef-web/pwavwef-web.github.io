const CACHE_NAME = 'az-courses-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './html-css.html',
  './trading.html',
  './ai-prompting.html',
  './github.html',
  './linkedin-optimisation.html',
  './notebook-lm.html',
  './cert.html',
  './manifest.json',
  '/favicon1.png',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png'
];

const NETWORK_ONLY_PATTERNS = [
  /firebasestorage\.googleapis\.com/,
  /firebaseio\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /googleapis\.com\/identitytoolkit/,
  /gstatic\.com\/firebasejs/,
  /js\.paystack\.co/
];

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
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  if (NETWORK_ONLY_PATTERNS.some((re) => re.test(request.url))) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match('./index.html').then(
            (cached) =>
              cached ||
              new Response('You are currently offline. Please reconnect to access this page.', {
                status: 503
              })
          )
        )
    );
    return;
  }

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

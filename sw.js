// Keep this in sync with APP_VERSION in app.js and bump it on every deploy.
const CACHE_VERSION = '2026.04.30.4';
const CACHE_NAME = `dutch-vocab-${CACHE_VERSION}`;
const STATIC_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './sw.js',
    './manifest.json',
    './icon-512.png'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch - stale-while-revalidate for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Don't cache external API requests
    if (url.origin !== self.location.origin) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Stale-while-revalidate: serve from cache immediately, fetch update in background
    event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(event.request).then((cachedResponse) => {
                const fetchPromise = fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(() => cachedResponse);

                return cachedResponse || fetchPromise;
            });
        })
    );
});

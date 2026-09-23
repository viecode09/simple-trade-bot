const CACHE = 'simple-trade-bot-v2';
const ASSETS = [
  '/',
  '/dashboard',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(asset => cache.add(asset)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // biarkan CDN/library eksternal
  if (url.pathname.startsWith('/api/') || url.pathname === '/webhook' || url.pathname === '/health') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/dashboard')));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});

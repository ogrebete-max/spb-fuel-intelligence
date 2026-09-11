const CACHE = 'spb-fuel-intelligence-v3';
const APP_SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/fuel-intelligence.svg', 'vendor/leaflet.css', 'vendor/leaflet.js'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) {
    event.respondWith(fetch(event.request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())); return response; }).catch(() => caches.match(event.request).then((cached) => cached || new Response(JSON.stringify({ error: 'Нет подключения и сохранённого снимка.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // Code and styles must update immediately; offline cache is a fallback only.
  event.respondWith(fetch(event.request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())); return response; }).catch(() => caches.match(event.request)));
});

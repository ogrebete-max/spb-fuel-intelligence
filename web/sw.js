const CACHE = 'spb-fuel-intelligence-v8';
// app.js and styles.css carry a build tag in their URL, so they are not
// precached here; the network-first handler stores whichever build index.html
// actually asks for.
const APP_SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/fuel-intelligence.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'vendor/leaflet.css', 'vendor/leaflet.js'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
// Drop caches from earlier versions instead of leaving them on the phone.
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim())
));
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

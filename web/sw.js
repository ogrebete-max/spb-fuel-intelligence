const CACHE = 'spb-fuel-intelligence-v14';
// app.js and styles.css carry a build tag in their URL, so they are not
// precached here; the network-first handler stores whichever build index.html
// actually asks for.
const APP_SHELL = ['./', 'index.html', 'config.js', 'analytics.js', 'manifest.webmanifest', 'icons/fuel-intelligence.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'vendor/leaflet.css', 'vendor/leaflet.js'];
// One missing file must not leave the phone without a worker at all, so the
// shell is cached file by file instead of all-or-nothing.
self.addEventListener('install', (event) => event.waitUntil(
  caches.open(CACHE)
    .then((cache) => Promise.all(APP_SHELL.map((path) => cache.add(path).catch(() => null))))
    .then(() => self.skipWaiting())
));
// Drop caches from earlier versions instead of leaving them on the phone.
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim())
));

// The copy is taken before the response is handed to the page: cloning later,
// once the page has started reading the body, throws.
function remember(request, response) {
  if (!response || !response.ok || response.redirected || response.type !== 'basic') return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Opening the app is the one request that must never end in a blank screen.
  // Safari refuses a page a service worker answers with a redirected response,
  // and an empty cache hit used to be passed on as "nothing" — both showed as a
  // white screen on iPhone. A page load now always gets a real page: the
  // network one, else the cached shell.
  if (request.mode === 'navigate') {
    // The page is asked of the site, not of the browser's cache: GitHub Pages
    // lets a browser keep it ten minutes, and an app opened in those minutes
    // after a new build started on the old page (16 Sep 2026). An unchanged
    // page costs a short «304». But the answer is waited for only a moment: on
    // a slow phone network waiting for it is a white screen (17 Sep 2026), so
    // the kept page goes on the glass and the newer one is taken for next time
    // — the app itself reloads onto a new build once meta.json names it.
    const fromSite = fetch(new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((response) => {
        if (!response || !response.ok) return null;
        remember(request, response);
        if (response.redirected) {
          // Safari refuses a page a service worker answers with a redirected
          // response: it is passed on as a page of its own.
          return response.blob().then((body) => new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
        }
        return response;
      })
      .catch(() => null);
    event.respondWith((async () => {
      // The kept page goes up at once — an iPhone opening the app must never
      // wait on the network (17-18 Sep 2026: it showed a white screen, and only
      // closing and opening the app again helped). The newer page is taken in
      // the background for the next launch, and the app reloads itself onto a
      // new build once meta.json names it, a few seconds after it is on screen.
      const kept = await Promise.race([
        caches.match(request, { ignoreSearch: true })
          .then((cached) => cached || caches.match('./'))
          .then((cached) => cached || caches.match('index.html')),
        new Promise((resolve) => { setTimeout(() => resolve(null), 1500); }),
      ]);
      if (kept) {
        event.waitUntil(fromSite);
        return kept;
      }
      return (await fromSite) || Response.error();
    })());
    return;
  }

  if (url.pathname.includes('/api/')) {
    event.respondWith(fetch(request).then((response) => { remember(request, response); return response; }).catch(() => caches.match(request).then((cached) => cached || new Response(JSON.stringify({ error: 'Нет подключения и сохранённого снимка.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // Code and styles must update immediately; offline cache is a fallback only.
  event.respondWith(fetch(request).then((response) => { remember(request, response); return response; }).catch(() => caches.match(request).then((cached) => cached || Response.error())));
});

// A report from the group arrives as a push; the phone shows it even with the
// app closed. Tapping opens the station it is about.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { title: 'Свой поставил отметку', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'Свой поставил отметку', {
    body: payload.body || '',
    tag: payload.tag || 'spbfi',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { station: payload.station || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const station = event.notification.data && event.notification.data.station;
  const target = new URL(station ? `./?station=${encodeURIComponent(station)}` : './', self.location.href).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const open = clients.find((client) => client.url.startsWith(new URL('./', self.location.href).href));
    if (open) {
      open.postMessage({ station });
      return open.focus();
    }
    return self.clients.openWindow(target);
  }));
});

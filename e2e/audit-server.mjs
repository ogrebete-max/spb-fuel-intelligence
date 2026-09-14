// A stand for walking through the app by hand: the built site and the worker
// (in-process, FakeD1) on two origins, so one browser profile can be the
// owner on one and a member on the other, and a fake geolocation the page can
// be told from the address bar.
//
//   node e2e/audit-server.mjs
//   http://localhost:8971/?geo=59.9343,30.3351,15   (lat,lon,accuracy)
//   http://127.0.0.1:8973/                          (a second person)
//   http://localhost:8971/__audit/gate?mode=closed   (test | invite | closed)
//   http://localhost:8971/__audit/state              (members, invites, reports)
//
// The owner key is «audit-owner-key». In the page, window.__setGeo(lat, lon,
// accuracy) moves the fake phone.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OWNER_KEY = 'audit-owner-key';
const stores = { DB: new FakeD1(), REPORTS: new (class { constructor() { this.values = new Map(); } async get(k, o) { const v = this.values.get(k); return v == null ? null : o?.type === 'json' ? JSON.parse(v) : v; } async put(k, v) { this.values.set(k, String(v)); } })() };
const settings = { gate: process.env.AUDIT_GATE || 'closed' };
const envFor = (origin) => ({ ...stores, CLUB_OWNER_KEY: OWNER_KEY, ...(settings.gate === 'test' ? {} : { CLUB_GATE: settings.gate }), ORIGIN: origin });
globalThis.fetch = ((original) => (url, init) => {
  if (String(url).startsWith('https://push.')) { console.log('push →', String(url).slice(0, 60)); return Promise.resolve(new Response(null, { status: 201 })); }
  return original(url, init);
})(globalThis.fetch);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const GEO_MOCK = `<script>
(() => {
  const params = new URLSearchParams(location.search);
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem('__audit_geo') || 'null'); } catch {}
  if (params.get('geo')) {
    const [lat, lon, acc] = params.get('geo').split(',').map(Number);
    stored = { lat, lon, acc: acc || 15 };
    try { sessionStorage.setItem('__audit_geo', JSON.stringify(stored)); } catch {}
  }
  if (params.get('geo') === 'off' || params.get('geo') === 'deny') { stored = null; sessionStorage.removeItem('__audit_geo'); if (params.get('geo') === 'deny') sessionStorage.setItem('__audit_geo_deny', '1'); }
  const deny = sessionStorage.getItem('__audit_geo_deny') === '1';
  const watchers = new Map();
  let nextId = 1;
  const position = () => ({ coords: { latitude: stored.lat, longitude: stored.lon, accuracy: stored.acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  const fake = {
    getCurrentPosition(ok, fail) { setTimeout(() => (deny || !stored) ? fail && fail({ code: deny ? 1 : 2, message: 'audit' }) : ok(position()), 120); },
    watchPosition(ok, fail) { const id = nextId++; watchers.set(id, ok); setTimeout(() => (deny || !stored) ? fail && fail({ code: deny ? 1 : 2, message: 'audit' }) : ok(position()), 150); return id; },
    clearWatch(id) { watchers.delete(id); },
  };
  window.__setGeo = (lat, lon, acc = 15) => { stored = { lat, lon, acc }; sessionStorage.setItem('__audit_geo', JSON.stringify(stored)); watchers.forEach((ok) => ok(position())); };
  if (stored || deny) Object.defineProperty(navigator, 'geolocation', { value: fake, configurable: true });
  Object.defineProperty(window, 'matchMedia', { value: ((orig) => (q) => (q === '(pointer: coarse)' ? { matches: true, addEventListener() {}, removeEventListener() {} } : orig(q)))(window.matchMedia.bind(window)), configurable: true });
})();
</script>`;

function serveSite(sitePort, workerPort, host) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${sitePort}`);
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': types['.js'] });
      res.end(`window.SPBFI_REPORT_ENDPOINT = 'http://${host}:${workerPort}'; window.SPBFI_ANALYTICS_ENDPOINT = null;`);
      return;
    }
    if (url.pathname === '/__audit/gate') {
      const mode = url.searchParams.get('mode');
      if (['test', 'invite', 'closed'].includes(mode)) settings.gate = mode;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`gate=${settings.gate}`);
      return;
    }
    if (url.pathname === '/__audit/state') {
      Promise.all(['club:members', 'club:invites', 'club:stats', 'reports', 'club:settings', 'club:passkeys'].map(async (key) => [key, await readDoc(key)]))
        .then((pairs) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(Object.fromEntries(pairs), null, 2)); });
      return;
    }
    if (url.pathname === '/sw.js') { res.writeHead(404); res.end(); return; }
    const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (path.extname(file) === '.html') {
        res.end(data.toString('utf8').replace('<script src="config.js"></script>', `${GEO_MOCK}<script src="config.js"></script>`));
      } else {
        res.end(data);
      }
    });
  });
  server.listen(sitePort, () => console.log(`site   http://${host}:${sitePort}/`));
}

async function readDoc(key) {
  const row = await stores.DB.prepare('SELECT body FROM docs WHERE key = ?').bind(key).first().catch(() => null);
  try { return row?.body ? JSON.parse(row.body) : null; } catch { return row?.body || null; }
}

let requests = 0;
function serveWorker(workerPort, host, origin) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests += 1;
    const request = new Request(`http://${host}:${workerPort}${req.url}`, {
      method: req.method,
      headers: { ...req.headers, 'cf-connecting-ip': `10.3.${(requests >> 8) & 255}.${requests & 255}` },
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const pending = [];
    const response = await worker.fetch(request, envFor(origin), { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    const headers = Object.fromEntries(response.headers);
    delete headers['content-length'];
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(workerPort, () => console.log(`worker http://${host}:${workerPort}/  (origin ${origin})`));
}

serveSite(8971, 8972, 'localhost');
serveWorker(8972, 'localhost', 'http://localhost:8971');
serveSite(8973, 8974, '127.0.0.1');
serveWorker(8974, '127.0.0.1', 'http://127.0.0.1:8973');
console.log(`owner key: ${OWNER_KEY}; gate: ${settings.gate}`);

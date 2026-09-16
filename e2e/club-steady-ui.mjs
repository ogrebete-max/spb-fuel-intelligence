// 16 Sep 2026: of the owner's two phones, both signed in to the club, one showed
// the members' feed (names, «Спасибо», 👍 and 👎) and the other the public one,
// now this phone, now that. A single slow or failed /club/health when the app
// started, on a weak connection or while the server restarted, turned a saved
// membership into the ordinary app until the app was opened again. A member
// stays a member through a failed check and the app asks again; only the
// server saying the club is off takes the members' view away. WebKit (iPhone)
// and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9071;
const WORKER_PORT = 9072;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const STATION = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations[0];

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}

let env;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${SITE_PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end(`window.SPBFI_REPORT_ENDPOINT = 'http://localhost:${WORKER_PORT}'; window.SPBFI_ANALYTICS_ENDPOINT = null;`);
    return;
  }
  const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const workerServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, {
    method: req.method, headers: req.headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const headers = Object.fromEntries(response.headers);
  delete headers['content-length'];
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));
await new Promise((resolve) => workerServer.listen(WORKER_PORT, resolve));

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const api = async (pathName, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`http://localhost:${WORKER_PORT}${pathName}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Member-Token': token } : {}), Origin: `http://localhost:${SITE_PORT}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};

// The members' view: whose club it is, the club's tab, and Ирина's mark with a name and «Спасибо».
const membersView = () => document.querySelector('#brandTag')?.textContent === 'закрытый клуб своих'
  && !document.querySelector('#modeBar [data-club-tab]').hidden
  && (document.querySelector('#groupFeed')?.textContent || '').includes('Ирина')
  && !!document.querySelector('#groupFeed .thanks-button');
const publicView = () => document.querySelector('#brandTag')?.textContent !== 'закрытый клуб своих'
  && document.querySelector('#modeBar [data-club-tab]').hidden
  && !document.querySelector('#groupFeed .thanks-button');

// health: how the phone's first /club/health goes — 'unreachable' (no answer the
// page may read, as from the proxy while the server restarts), 'error' (a
// readable 503), 'slow' (longer than the app waits).
async function run(label, browserType, device, { health = null, clubOff = false } = {}) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}`, CLUB_OWNER_KEY: OWNER_KEY };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  const irina = await api('/club/join', { method: 'POST', body: { code: (await api('/club/invite', { method: 'POST', token: owner.token })).code, name: 'Ирина', accept: true } });
  await api('/report', { method: 'POST', token: irina.token, body: { station: STATION.id, lat: STATION.location.lat, lon: STATION.location.lon, grades: [{ grade: 'AI92', seen: false }, { grade: 'DT', seen: true }] } });
  if (clubOff) delete env.CLUB_OWNER_KEY;

  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  await context.addInitScript(([token, member]) => {
    localStorage.setItem('spbfi-club-token-v1', token);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
  }, [owner.token, owner.member]);
  let asked = 0;
  if (health) {
    await context.route(`http://localhost:${WORKER_PORT}/club/health`, async (route) => {
      asked += 1;
      if (asked > 1) return route.continue().catch(() => {});
      if (health === 'unreachable') return route.abort('connectionrefused');
      if (health === 'error') return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': `http://localhost:${SITE_PORT}` }, body: '{"error":"worker_error"}' });
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return route.continue().catch(() => {});
    });
  }
  const page = await context.newPage();
  const errors = [];
  // WebKit reports a refused cross-site fetch as a page error even when the app catches it.
  page.on('pageerror', (error) => { if (!/access control checks|Load failed|Failed to fetch/i.test(error.message)) errors.push(error.message); });
  await page.goto(siteUrl, { waitUntil: 'load' });
  check('the list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));

  if (clubOff) {
    check('the club switched off on the server takes the members\' view away', await becomes(page, publicView, null, 20000));
  } else {
    check(`a member sees the members' view although the first check ${health || 'went fine'}`, await becomes(page, membersView, null, 20000));
    if (health) {
      check('the club\'s answer comes by itself, asked again if need be', await becomes(page, () => state.club.features?.votes === true && !state.club.healthFailed, null, 40000));
      check(`and the members' view stays (${asked} checks)`, await page.evaluate(membersView));
    }
  }
  await page.screenshot({ path: path.join(OUT, `club-steady-${label}.png`) });
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone-unreachable', webkit, devices['iPhone 13'], { health: 'unreachable' });
  await run('iphone-slow', webkit, devices['iPhone 13'], { health: 'slow' });
  await run('android-error', chromium, devices['Pixel 7'], { health: 'error' });
  await run('android-fine', chromium, devices['Pixel 7']);
  await run('android-club-off', chromium, devices['Pixel 7'], { clubOff: true });
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL STEADY CLUB CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

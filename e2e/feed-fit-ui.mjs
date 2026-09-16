// 16 Sep 2026: on the owner's iPhone a «Свои сообщают» card with two names, a
// distance, a long queue and 🗑 ran off the right edge — the names, «очередь:
// до 100 машин» and «Удалить» cut off. The card's rows must stay inside it,
// and a station's own card too, on narrow phones: iPhone 13 and SE (WebKit),
// Pixel 7 and Galaxy S8 (Chromium).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9081;
const WORKER_PORT = 9082;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const STATION = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations[0];
// A few kilometres off, so the card names a distance as on the owner's phone.
const HERE = { latitude: STATION.location.lat + 0.05, longitude: STATION.location.lon + 0.05, accuracy: 15 };

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

// Everything inside each box ends where the box ends.
const overflowIn = (selector) => {
  const out = [];
  for (const box of document.querySelectorAll(selector)) {
    const edge = box.getBoundingClientRect().right;
    for (const element of box.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.right > edge + 1) out.push(`${element.className || element.tagName} +${Math.round(rect.right - edge)}px`);
    }
  }
  return { out: [...new Set(out)].slice(0, 6), page: document.documentElement.scrollWidth - innerWidth };
};

async function run(label, browserType, device) {
  console.log(`\n=== ${label} (${device.viewport.width} px)`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}`, CLUB_OWNER_KEY: OWNER_KEY };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  for (const name of ['Сергей М', 'Рэм']) {
    const code = (await api('/club/invite', { method: 'POST', token: owner.token })).code;
    const member = await api('/club/join', { method: 'POST', body: { code, name, accept: true } });
    await api('/report', { method: 'POST', token: member.token, body: { station: STATION.id, lat: STATION.location.lat, lon: STATION.location.lon, queue: 100, grades: [{ grade: 'AI92', seen: true }, { grade: 'AI95', seen: true }, { grade: 'DT', seen: true }] } });
  }

  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: HERE });
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  await context.addInitScript(([token, member]) => {
    localStorage.setItem('spbfi-club-token-v1', token);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
    // The ordinary screen first, as the owner had it.
    localStorage.setItem('spbfi-start-v1', 'app');
  }, [owner.token, owner.member]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(siteUrl, { waitUntil: 'load' });
  check('the feed shows both names, the queue and 🗑', await becomes(page, () => {
    const card = document.querySelector('#groupFeed .feed-item');
    const text = card?.textContent || '';
    return text.includes('Сергей М') && text.includes('Рэм') && text.includes('до 100') && !!card.querySelector('.look-delete') && /км|м ·|\d м/.test(text);
  }, null, 30000));
  await page.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  const feed = await page.evaluate(overflowIn, '#groupFeed .feed-item');
  check(`nothing sticks out of a «Свои» card (${JSON.stringify(feed)})`, feed.out.length === 0 && feed.page <= 0);
  await page.screenshot({ path: path.join(OUT, `feed-fit-${label}.png`) });

  await page.evaluate(() => document.querySelector('#groupFeed .feed-item').click());
  check('the station\'s card opens', await becomes(page, () => document.querySelector('#detailDrawer').classList.contains('open') && (document.querySelector('#drawerContent')?.textContent || '').includes('Рэм'), null, 15000));
  await page.waitForTimeout(500);
  const drawer = await page.evaluate(overflowIn, '#detailDrawer');
  check(`nor out of the station's card (${JSON.stringify(drawer)})`, drawer.out.length === 0);
  await page.screenshot({ path: path.join(OUT, `feed-fit-${label}-card.png`) });

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone-13', webkit, devices['iPhone 13']);
  await run('iphone-se', webkit, devices['iPhone SE']);
  await run('pixel-7', chromium, devices['Pixel 7']);
  await run('galaxy-s8', chromium, devices['Galaxy S8']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CARD FIT CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

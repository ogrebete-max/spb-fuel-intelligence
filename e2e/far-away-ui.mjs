// A phone far from every station the app knows (13 Sep 2026: a relative
// outside the region). «Рядом» must not strand it on an empty list that comes
// back after every reset, and «Показать все АЗС» inside «Свои» must leave the
// view however many times it is tapped. WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8891;
const WORKER_PORT = 8892;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const FAR = { latitude: 55.7558, longitude: 37.6173, accuracy: 30 };

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

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: FAR });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });

  check('a touch phone starts «рядом» by itself', await becomes(page, () => state.follow === true));
  check('far from every station it says so instead of an empty list', await becomes(page, () => state.searchScope === 'far' && document.querySelector('#searchContext')?.textContent.includes('км от вас АЗС нет')));
  check('and lists the stations it knows', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0));
  await page.screenshot({ path: path.join(OUT, `${label}-far-1-list.png`) });

  // The watch keeps sending fixes; none of them may bring the empty list back.
  await context.setGeolocation({ ...FAR, latitude: FAR.latitude + 0.003 });
  await page.evaluate(() => refreshLocation());
  await page.waitForTimeout(2500);
  check('new fixes leave the list in place', await page.evaluate(() => state.searchScope === 'far' && document.querySelectorAll('#stationList .station-card').length > 0));

  // «Сбросить все фильтры» really resets, «рядом» included.
  await page.evaluate(() => resetFilters());
  await page.waitForTimeout(2500);
  check('the reset switches «рядом» off and keeps the whole list', await page.evaluate(() => state.follow === false && state.searchScope == null && document.querySelectorAll('#stationList .station-card').length > 0));

  // «Свои» with one mark from the group; «Показать все АЗС» tapped twice leaves it.
  const [first] = await page.evaluate(() => state.stations.slice(0, 1).map((station) => ({ id: station.id, lat: station.location.lat, lon: station.location.lon })));
  await (await fetch(`http://localhost:${WORKER_PORT}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station: first.id, grade: 'AI95', seen: true, who: 'someone-else', lat: first.lat, lon: first.lon }) })).json();
  await page.evaluate(() => pollGroupMarks());
  check('the «Свои» chip shows the mark', await becomes(page, () => !!document.querySelector('#statusStrip [data-own]')));
  await page.click('#statusStrip [data-own]');
  check('«Свои» opens', await becomes(page, () => state.ownOnly && !!document.querySelector('#stationList [data-own-back]')));
  const back = await page.$('#stationList [data-own-back]');
  await back.click();
  await back.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2500);
  check('«Показать все АЗС» tapped twice still leaves «Свои»', await page.evaluate(() => state.ownOnly === false && document.querySelectorAll('#stationList .station-card').length > 0));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL FAR-AWAY CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

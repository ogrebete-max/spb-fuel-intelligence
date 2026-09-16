// What drivers hit in the field, re-enacted in WebKit (iPhone) and Chromium
// (Android): coarse location, tapping «рядом» to refresh, marking every grade
// and the queue straight from a card, a station just driven past, the «Свои» tab.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8841;
const WORKER_PORT = 8842;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

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
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));
await new Promise((resolve) => workerServer.listen(WORKER_PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false);

// A real station from the published snapshot (Роснефть, Суздальский пр., 99;
// the next station is 730 m away), a point 60 m from it and one 1.3 km away.
const STATION = { lat: 60.044512, lon: 30.417874 };
const NEAR = { latitude: STATION.lat + 0.00055, longitude: STATION.lon };
const FAR = { latitude: STATION.lat + 0.012, longitude: STATION.lon };

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  // The worker only answers CORS for its configured origin; locally that is this test server.
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: FAR.latitude, longitude: FAR.longitude, accuracy: 3800 },
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });

  // 1. A coarse first fix does not throw the list at the wrong district.
  await page.evaluate(() => startFollowing({ manual: true }));
  const waited = await waitFor(page, () => document.querySelector('#searchContext')?.textContent.includes('Уточняем'), null, 6000);
  check('coarse fix: «Уточняем ваше место…» instead of a wrong list', waited && await page.evaluate(() => state.searchScope !== 'device'));
  await page.screenshot({ path: path.join(OUT, `${label}-f1-coarse.png`) });

  // 2. A precise fix arrives: the list switches to «рядом».
  await context.setGeolocation({ latitude: FAR.latitude, longitude: FAR.longitude, accuracy: 15 });
  await page.evaluate(() => refreshLocation());
  check('precise fix switches to nearby', await waitFor(page, () => state.searchScope === 'device' && state.accuracy <= 20));

  // 3. Tapping the button while following refreshes and never switches off.
  await page.click('#locateButton');
  check('tapping «рядом» keeps following', await waitFor(page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Место обновлено')), null, 8000) && await page.evaluate(() => state.follow));
  check('button says where you are', (await page.textContent('#locateButton')).includes('Вы здесь'));

  // 4. Drive up to a station: the card offers every grade and the queue, outside the card button.
  await context.setGeolocation({ ...NEAR, accuracy: 10 });
  await page.evaluate(() => refreshLocation({ manual: true }));
  const composer = await waitFor(page, () => document.querySelector('.card-actions .quick-grade') || document.querySelector('#herePanel .quick-grade'), null, 15000);
  check('a nearby card or the «вы у АЗС» panel has quick grade chips', composer);
  const inButton = await page.evaluate(() => [...document.querySelectorAll('.card-main .quick-grade, .card-main .mark')].length);
  check('no mark buttons nested inside the card button', inButton === 0);
  const scope = await page.evaluate(() => (document.querySelector('#herePanel:not([hidden]) .mark-composer') ? '#herePanel' : '.card-actions'));
  await page.click(`${scope} .quick-grade[data-quick-grade="AI92"]`);
  await page.click(`${scope} .quick-grade[data-quick-grade="AI95"]`);
  await page.click(`${scope} .quick-grade[data-quick-grade="AI95"]`);
  await page.click(`${scope} .queue-chip[data-compose-queue="12"]`);
  const chipText = await page.evaluate((s) => [...document.querySelectorAll(`${s} .quick-grade`)].slice(0, 2).map((b) => b.textContent.trim()), scope);
  check(`chips cycle есть → нет (${chipText.join(', ')})`, chipText[0] === '92 ✓' && chipText[1] === '95 ✕');
  check('tapping chips did not open the card', await page.evaluate(() => !document.querySelector('#detailDrawer').classList.contains('open')));
  await page.evaluate((s) => document.querySelector(`${s} .mark-composer`).scrollIntoView({ block: 'center' }), scope);
  await page.screenshot({ path: path.join(OUT, `${label}-f2-quick.png`) });
  await page.click(`${scope} .compose-send`);
  check('the mark is confirmed where it was made', await waitFor(page, (s) => document.querySelector(`${s} .mark-sent`)?.textContent.includes('92 есть, 95 нет'), scope, 5000));
  const sent = JSON.parse(env.REPORTS.values.get('reports') || '[]');
  check(`worker got both grades with the queue (${sent.length})`, sent.length === 2 && sent.every((r) => r.queue === 12));

  // 5. «Свои» tab: the group's marks, with freshness, in the list and on the map.
  await page.evaluate(() => pollGroupMarks());
  check('«👁 Свои» chip appears', await waitFor(page, () => document.querySelector('[data-own]')?.textContent.includes('Свои · 1'), null, 8000));
  await page.click('[data-own]');
  // Freshness is its colour, its time and the heading, not a word beside a name.
  check('«Свои» list shows the station among the fresh ones', await waitFor(page, () => document.querySelector('.own-head')?.textContent.startsWith('Свежие') && /только что|мин назад/.test(document.querySelector('.own-card.fresh .own-age')?.textContent || ''), null, 8000));
  await page.screenshot({ path: path.join(OUT, `${label}-f3-own.png`) });
  await page.click('#modeBar [data-screen="map"]');
  check('map shows the group\'s station pin', await waitFor(page, () => document.querySelectorAll('.own-pin').length === 1, null, 8000));
  await page.screenshot({ path: path.join(OUT, `${label}-f4-own-map.png`) });
  await page.click('#modeBar [data-screen="list"]');
  await page.click('[data-own]');

  // 6. Drive on past a second station: it is offered afterwards.
  await page.evaluate(() => { state.marks = {}; });
  await context.setGeolocation({ latitude: FAR.latitude, longitude: FAR.longitude, accuracy: 10 });
  await page.evaluate(() => { state.passed = {}; });
  await context.setGeolocation({ ...NEAR, accuracy: 10 });
  await page.evaluate(() => refreshLocation());
  await waitFor(page, () => Object.keys(state.passed).length > 0, null, 8000);
  await context.setGeolocation({ latitude: FAR.latitude, longitude: FAR.longitude, accuracy: 10 });
  await page.evaluate(() => refreshLocation());
  check('«Недавно проезжали» offers the station just passed', await waitFor(page, () => document.querySelector('#herePanel:not([hidden]) .passed-item'), null, 10000));
  await page.evaluate(() => document.querySelector('#herePanel').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(OUT, `${label}-f5-passed.png`) });

  // 7. A late snapshot is called late.
  const late = await page.evaluate(() => formatSnapshot(35 * 60, 'static_github_pages'));
  check('35-minute-old snapshot reads «Данные отстают»', late[0] === 'Данные отстают' && late[3] === true);

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL FIELD UI CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

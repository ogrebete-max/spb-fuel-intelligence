// 15 Sep 2026: on an Android phone the list did not move under a finger at
// all, the page only stretched. `overflow-x: hidden` on both html and body
// made body a scroll box of its own with nothing to scroll, and its
// `overscroll-behavior: none` kept every swipe from reaching the page. Safari
// never did that, so the iPhone was fine. Here a finger swipes the list, a
// card and the map screen on Android (Chromium, the browser's own touch
// input), and the wheel stands in for a finger on the iPhone (WebKit).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9041;
const WORKER_PORT = 9042;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const HERE = { latitude: 59.9343, longitude: 30.3351, accuracy: 15 };

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
const scrolled = (page) => page.evaluate(() => Math.round(scrollY));
// At once: the page scrolls smoothly, and a smooth scroll still under way
// carries the page past a swipe made meanwhile.
const toTop = async (page) => {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await becomes(page, () => scrollY === 0, null, 3000);
  await page.waitForTimeout(200);
};

// A finger on the glass, through the browser's own touch input: it scrolls
// whatever a finger would, which a script's scrollTo does not show.
async function swipe(page, client, { x, y, dx = 0, dy = 0 }) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i += 1) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12 }] });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(600);
}

async function open(browserType, device, { located = false } = {}) {
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', ...(located ? { permissions: ['geolocation'], geolocation: HERE } : {}) });
  // A person's phone rather than an automated browser: the app starts the way it does for people.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  await page.goto(siteUrl, { waitUntil: 'load' });
  return { browser, context, page, errors };
}

async function android(label, { located = false } = {}) {
  console.log(`\n=== ${label}`);
  const { browser, context, page, errors } = await open(chromium, devices['Pixel 7'], { located });
  const client = await context.newCDPSession(page);
  check('the list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 3, null, 30000));
  if (located) {
    check('a phone that gives its place starts on the navigator', await becomes(page, () => drive.open, null, 30000));
    await page.evaluate(() => document.querySelector('#drive [data-drive="close"]').click());
    check('the navigator\'s 🗺 leads to the map screen', await becomes(page, () => !drive.open && document.body.classList.contains('map-screen'), null, 5000));
    await page.waitForTimeout(800);
    await swipe(page, client, { x: 200, y: 400, dy: -300 });
    check(`a swipe there moves the map, not the page (${await scrolled(page)} px)`, (await scrolled(page)) === 0);
    await page.evaluate(() => document.querySelector('#modeBar [data-screen="list"]').click());
    check('«Список» brings the list back', await becomes(page, () => !document.body.classList.contains('map-screen'), null, 5000));
    await page.waitForTimeout(800);
  }
  await toTop(page);
  await swipe(page, client, { x: 200, y: 650, dy: -450 });
  const moved = await scrolled(page);
  check(`a finger moves the list (${moved} px)`, moved > 200);
  await page.screenshot({ path: path.join(OUT, `scroll-${label}-list.png`) });
  await swipe(page, client, { x: 200, y: 300, dy: 450 });
  check(`and brings it back up (${await scrolled(page)} px)`, (await scrolled(page)) < moved);
  await swipe(page, client, { x: 320, y: 500, dx: -250 });
  const sideways = await page.evaluate(() => ({ x: Math.round(scrollX), width: document.documentElement.scrollWidth, screen: innerWidth }));
  check(`a sideways swipe does not slide the page (${JSON.stringify(sideways)})`, sideways.x === 0 && sideways.width <= sideways.screen);

  // A card scrolls inside its drawer, and the list still moves after it.
  await page.evaluate(() => { window.scrollTo(0, 0); openStation(state.stations[0].id); });
  check('a card opens, taller than the screen', await becomes(page, () => document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#detailDrawer').scrollHeight > innerHeight + 150, null, 10000));
  await page.waitForTimeout(800);
  await swipe(page, client, { x: 200, y: 600, dy: -400 });
  const inside = await page.evaluate(() => Math.round(document.querySelector('#detailDrawer').scrollTop));
  check(`a finger moves the card (${inside} px)`, inside > 100);
  await page.evaluate(() => closeDrawer());
  await page.waitForTimeout(500);
  await toTop(page);
  await swipe(page, client, { x: 200, y: 650, dy: -450 });
  check(`the list still moves once the card is closed (${await scrolled(page)} px)`, (await scrolled(page)) > 200);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

// Mobile WebKit in Playwright takes neither a wheel nor a dragged finger, so
// the iPhone is held to the cause itself: neither html nor body may turn into
// a scroll box, and nothing may be wider than the screen.
async function iphone(label) {
  console.log(`\n=== ${label}`);
  const { browser, page, errors } = await open(webkit, devices['iPhone 13']);
  check('the list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 3, null, 30000));
  const boxes = () => page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflowY, body: getComputedStyle(document.body).overflowY,
    width: document.documentElement.scrollWidth, screen: innerWidth,
  }));
  const before = await boxes();
  check(`neither html nor body is a scroll box (${JSON.stringify(before)})`, before.html === 'visible' && before.body === 'visible');
  check('nothing is wider than the screen', before.width <= before.screen);
  await page.evaluate(() => { window.scrollTo(0, 0); openStation(state.stations[0].id); });
  check('a card opens', await becomes(page, () => document.querySelector('#detailDrawer').classList.contains('open'), null, 10000));
  await page.evaluate(() => closeDrawer());
  const after = await boxes();
  check(`and once it is closed body is not a scroll box either (${JSON.stringify(after)})`, after.html === 'visible' && after.body === 'visible' && after.width <= after.screen);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await android('android-list');
  await android('android-after-navigator-and-map', { located: true });
  await iphone('iphone-list');
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL SCROLL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

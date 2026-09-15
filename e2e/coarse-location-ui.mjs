// A phone that keeps reporting a rough place (14 Sep 2026: an iPhone 15 Pro
// said ±884 m again and again while its dot sat on the right house). Pressing
// «обновить» stacked five identical banners over the screen and changed
// nothing. Now the rough place is said once; the button shows the dot on a
// small map and asks whether it is right: «yes» makes the app trust it, «no»
// shows what to switch on for the phone in hand; a recheck shows when a
// precise place has come. WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8951;
const WORKER_PORT = 8952;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ROUGH = { latitude: 59.9343, longitude: 30.3351, accuracy: 884 };

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
const buttonText = (page) => page.evaluate(() => document.querySelector('#locateButton')?.textContent || '');

async function run(label, browserType, device, words) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: ROUGH });
  // The app from the home screen, not a messenger's browser.
  if (/iPhone/.test(device.userAgent || '')) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(siteUrl, { waitUntil: 'load' });

  check('the phone follows its rough place', await becomes(page, () => state.follow && !!state.location && state.accuracy === 884, null, 20000));
  check('the button says the place is rough and offers help', await becomes(page, () => /приблизительное.*что делать/.test(document.querySelector('#locateButton')?.textContent || '')));
  check('the list says so in one short line', await becomes(page, () => !!document.querySelector('#searchContext [data-location-help]')));

  for (let i = 0; i < 5; i += 1) {
    await page.evaluate(() => refreshLocation({ manual: true }));
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200);
  const banners = await page.evaluate(() => [...document.querySelectorAll('#toastStack .toast')].filter((toast) => toast.textContent.includes('Место')).length);
  check(`five refreshes leave one banner, not five (${banners})`, banners === 1);
  await page.screenshot({ path: path.join(OUT, `coarse-${label}-1-one-banner.png`) });
  await page.evaluate(() => document.querySelectorAll('#toastStack .toast').forEach((toast) => toast.remove()));

  await page.click('#locateButton');
  check('the button shows the dot and asks whether it is right', await becomes(page, () => document.querySelector('#drawerContent')?.textContent.includes('Синяя точка стоит там, где вы?') && !!document.querySelector('#locationHelpMap')));
  check('with the radius the phone reports', (await page.textContent('#locationHelpStatus')).includes('±884 м'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `coarse-${label}-2-question.png`) });

  await page.click('#locationNo');
  const steps = await page.textContent('#locationSteps');
  check(`«no» shows what to switch on, in words for this phone (${words.join(', ')})`, await page.isVisible('#locationSteps') && words.every((word) => steps.includes(word)));
  await page.screenshot({ path: path.join(OUT, `coarse-${label}-3-steps.png`) });
  await page.evaluate(() => closeDrawer());

  await page.click('#locateButton');
  await page.waitForSelector('#locationYes', { timeout: 10000 });
  await page.click('#locationYes');
  check('«yes» makes the app trust the dot', await becomes(page, () => effectiveAccuracy() <= 300 && document.querySelector('#locationQuestion')?.textContent.includes('Точка верная')));
  check('the button agrees', (await buttonText(page)).includes('точка подтверждена'));
  check('and the list line too, with a way to change it', await becomes(page, () => document.querySelector('#searchContext')?.textContent.includes('точка подтверждена вами') && !!document.querySelector('#searchContext [data-location-help]')));
  await page.evaluate(() => closeDrawer());

  await page.reload({ waitUntil: 'load' });
  check('the answer survives reopening the app', await becomes(page, () => state.accuracy === 884 && (document.querySelector('#locateButton')?.textContent || '').includes('точка подтверждена'), null, 20000));

  await page.evaluate(() => document.querySelector('#searchContext [data-location-help]').click());
  await page.waitForSelector('#locationNo', { timeout: 10000 });
  await page.click('#locationNo');
  check('«изменить» → «no» takes the trust back', await becomes(page, () => effectiveAccuracy() === 884 && /приблизительное/.test(document.querySelector('#locateButton')?.textContent || '')));

  await context.setGeolocation({ ...ROUGH, accuracy: 12 });
  await page.click('#locationRecheck');
  check('a recheck shows when the place is precise', await becomes(page, () => document.querySelector('#locationHelpStatus')?.textContent.includes('±12 м')));
  check('and the button says where you are', await becomes(page, () => (document.querySelector('#locateButton')?.textContent || '').includes('Вы здесь · ±12 м')));

  // The navigator says the place is rough and, like the list, offers what to
  // do: a phone with a rough place opening the app afresh.
  const fresh = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: ROUGH });
  if (/iPhone/.test(device.userAgent || '')) await fresh.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const driving = await fresh.newPage();
  driving.on('pageerror', (error) => errors.push(error.message));
  await driving.goto(siteUrl, { waitUntil: 'load' });
  check('a fresh start follows the rough place', await becomes(driving, () => state.follow && state.accuracy === 884, null, 20000));
  await driving.evaluate(() => { if (!drive.open) document.querySelector('#driveButton')?.click(); });
  check('the navigator says the place is rough', await becomes(driving, () => drive.open && (document.querySelector('#drive')?.textContent || '').includes('Место приблизительное'), null, 15000));
  // A panel sliding in holds taps back for a moment.
  await driving.waitForTimeout(700);
  await driving.evaluate(() => document.querySelector('#drive [data-drive="location-help"]')?.click());
  check('«Что делать» there opens the same help over the navigator', await becomes(driving, () => document.querySelector('#detailDrawer').classList.contains('open')
    && (document.querySelector('#drawerContent')?.textContent || '').includes('Где вы сейчас'), null, 10000));
  await driving.screenshot({ path: path.join(OUT, `coarse-${label}-4-navigator-help.png`) });
  await fresh.close();

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13'], ['Сайты Safari', 'Точная геопозиция', 'Карты']);
  await run('android', chromium, devices['Pixel 7'], ['Точное местоположение', 'Chrome']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL COARSE LOCATION CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// 15 Sep 2026: the link opened inside Telegram on an iPhone showed a bare
// «Доступ к геолокации запрещён» box — on the navigator the app had opened by
// itself, and again on «Рядом со мной» — and people closed the app. A refused
// location now leaves the city list and no box. «Рядом со мной» and «За рулём»
// open a drawer that says what to do in the browser in hand: a messenger's on
// an iPhone or on Android, Safari, Chrome; a phone that never answers is told
// what to check. A phone that lets the app know where it is still starts on
// the navigator. WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9021;
const WORKER_PORT = 9022;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const HERE = { latitude: 59.9343, longitude: 30.3351, accuracy: 12 };

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
const helpSays = (page, title) => becomes(page, (want) => document.querySelector('#detailDrawer').classList.contains('open')
  && document.querySelector('#drawerContent h2')?.textContent === want, title);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('#toastStack .toast')].map((toast) => toast.textContent).join(' | '));

async function open(browserType, device, { standalone, userAgent, granted = false, silent = false, asks = false } = {}) {
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device,
    ...(userAgent ? { userAgent } : {}),
    serviceWorkers: 'block',
    ...(granted ? { permissions: ['geolocation'], geolocation: HERE } : {}),
  });
  // A person's phone rather than an automated browser: the app starts the way it does for people.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  // Playwright's WebKit has no navigator.standalone, which is how a messenger's browser on an iPhone looks.
  if (standalone !== undefined) await context.addInitScript((value) => Object.defineProperty(navigator, 'standalone', { get: () => value }), standalone);
  // A phone that never answers: every request runs out of time.
  if (silent) {
    await context.addInitScript(() => {
      const late = (fail) => setTimeout(() => fail?.({ code: 3, message: 'timeout' }), 300);
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (ok, fail) => late(fail), watchPosition: (ok, fail) => { late(fail); return 1; }, clearWatch() {} },
      });
    });
  }
  // The phone's notification question is counted, not answered.
  if (asks) {
    await context.addInitScript(() => {
      window.__asks = 0;
      if (window.Notification) Notification.requestPermission = () => { window.__asks += 1; return Promise.resolve('default'); };
    });
  }
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.goto(siteUrl, { waitUntil: 'load' });
  return { browser, page, errors, dialogs };
}

async function refused(label, browserType, device, options, expect) {
  console.log(`\n=== ${label}`);
  const { browser, page, errors, dialogs } = await open(browserType, device, options);
  check('the city list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));
  check('the refused location switched «рядом» off', await becomes(page, () => state.follow === false && !state.location));
  await page.waitForTimeout(2500);
  check('the navigator did not open by itself', await page.evaluate(() => !drive.open));
  check(`no box popped up (${dialogs.join(' | ') || 'none'})`, dialogs.length === 0);
  const banners = await toasts(page);
  if (expect.banner) check(`a banner says where the page is open (${banners})`, banners.includes(expect.banner));
  else check(`no messenger banner in a browser that asked (${banners || 'none'})`, !banners.includes('мессенджера'));
  await page.screenshot({ path: path.join(OUT, `denied-${label}-1-list.png`) });
  if (expect.banner) {
    await page.locator('#toastStack .toast', { hasText: expect.banner }).click();
    check('the banner opens the same help', await helpSays(page, expect.title));
    await page.evaluate(() => closeDrawer());
  }
  await page.evaluate(() => document.querySelectorAll('#toastStack .toast').forEach((toast) => toast.remove()));

  await page.click('#locateButton');
  check(`«Рядом со мной» opens «${expect.title}»`, await helpSays(page, expect.title));
  const text = await page.textContent('#drawerContent');
  check(`in words for this browser (${expect.words.join(', ')})`, expect.words.every((word) => text.includes(word)));
  check('and says the list and the map work without a place', text.includes('Без геопозиции тоже работает'));
  check(`still no box (${dialogs.length})`, dialogs.length === 0);
  const safari = await page.evaluate(() => document.querySelector('#openInSafari')?.getAttribute('href') ?? null);
  if (expect.safari) check(`«Открыть в Safari» hands the page to Safari (${safari})`, safari === `x-safari-${siteUrl}`);
  else check('no Safari button outside a messenger on an iPhone', safari === null);
  check(expect.copy ? 'a button copies the link' : 'a button tries again', await page.isVisible(expect.copy ? '#locationCopyLink' : '#locationRetry'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `denied-${label}-2-help.png`) });

  await page.click('#locationByAddress');
  check('«Искать АЗС по адресу» closes the help and puts the cursor in the search', await becomes(page, () => !document.querySelector('#detailDrawer').classList.contains('open') && document.activeElement?.id === 'searchInput', null, 5000));

  await page.evaluate(() => document.querySelector('#driveButton').click());
  check('«За рулём» without a place steps back to the list and says why', await becomes(page, (want) => !drive.open
    && document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#drawerContent h2')?.textContent === want, expect.title));
  check(`no box from the navigator either (${dialogs.length})`, dialogs.length === 0);
  if (expect.safari) {
    await page.evaluate(() => closeDrawer());
    await page.evaluate(() => document.querySelector('#installButton').click());
    check('the header button offers Safari at once', await becomes(page, () => document.querySelector('#detailDrawer').classList.contains('open')
      && !!document.querySelector('#drawerContent #openInSafari'), null, 5000));
    await page.evaluate(() => closeDrawer());
    if (await page.evaluate(() => pushState() === 'install-first')) {
      await page.evaluate(() => enablePush());
      check('notifications there explain the home screen in the help, not in a box', await becomes(page, () => document.querySelector('#detailDrawer').classList.contains('open')
        && document.querySelector('#drawerContent').textContent.includes('уведомления приходят только приложению')
        && !!document.querySelector('#drawerContent #openInSafari'), null, 5000));
    } else {
      console.log('     (this WebKit takes notifications in a tab; the home-screen hint is not reachable here)');
    }
    check(`no box for notifications either (${dialogs.length})`, dialogs.length === 0);
  }
  // The ordinary map over the whole screen works without a place.
  await page.evaluate(() => closeDrawer());
  await page.click('#modeBar [data-screen="map"]');
  check('«Карта» in the bar opens the map over the whole screen', await becomes(page, () => {
    const box = document.querySelector('#mapWrap').getBoundingClientRect();
    return document.body.classList.contains('map-screen') && box.top <= 1 && box.height > innerHeight * 0.8;
  }, null, 5000));
  check('with the whole city on it', await becomes(page, () => state.mapStationsGrade === state.grade && document.querySelectorAll('#map .fuel-pin').length > 100, null, 15000));
  await page.click('#mapTop [data-map-grade="DT"]');
  check('a grade on the map switches the map to it', await becomes(page, () => state.grade === 'DT' && state.mapStationsGrade === 'DT'
    && document.querySelector('#mapTop [data-map-grade="DT"]').classList.contains('active'), null, 15000));
  await page.screenshot({ path: path.join(OUT, `denied-${label}-3-map.png`) });
  await page.click('#modeBar [data-screen="list"]');
  check('«Список» brings the list back', await becomes(page, () => !document.body.classList.contains('map-screen') && !!document.querySelector('#stationList .station-card'), null, 10000));
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function silent() {
  console.log('\n=== iphone-home-screen-silent');
  const { browser, page, errors, dialogs } = await open(webkit, devices['iPhone 13'], { standalone: true, silent: true });
  check('the city list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));
  await page.waitForTimeout(1500);
  check('with no answer «рядом» keeps waiting', await page.evaluate(() => state.follow === true && !state.location));
  await page.click('#locateButton');
  check('«Рядом со мной» says the phone gives no place and offers help', await becomes(page, () => [...document.querySelectorAll('#toastStack .toast')].some((toast) => toast.textContent.includes('покажу, что проверить'))));
  await page.locator('#toastStack .toast', { hasText: 'покажу, что проверить' }).first().click();
  check('the help says what to check', await helpSays(page, 'Телефон не сообщает место'));
  const text = await page.textContent('#drawerContent');
  check('Location Services and Wi-Fi', text.includes('Службы геолокации') && text.includes('Wi-Fi'));
  check(`no box (${dialogs.length})`, dialogs.length === 0);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await page.screenshot({ path: path.join(OUT, 'denied-iphone-silent-help.png') });
  await browser.close();
}

async function granted() {
  console.log('\n=== android-granted');
  const { browser, page, errors, dialogs } = await open(chromium, devices['Pixel 7'], { granted: true, asks: true });
  check('a phone that lets the app know where it is starts on the navigator', await becomes(page, () => drive.open && !!state.location, null, 30000));
  const tapDrive = (selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
  const pushable = await page.evaluate(() => pushState() === 'off');
  await tapDrive('#drive [data-drive="theme"]');
  check('the settings offer both first screens', await becomes(page, () => document.querySelectorAll('#drivePick [data-drive="start-mode"]').length === 3, null, 5000));
  if (pushable) check('the first tap brings the phone\'s notification question', await becomes(page, () => window.__asks === 1, null, 5000));
  else console.log('     (this browser cannot take notifications here)');
  // A panel sliding in holds taps back for a moment.
  await page.waitForTimeout(700);
  await tapDrive('#drivePick [data-drive="start-mode"][data-mode="app"]');
  check('«Карта и список» shows the map and the list at once and stays chosen', await becomes(page, () => !drive.open && localStorage.getItem('spbfi-start-v1') === 'app', null, 5000));
  check('the notification question came once', !pushable || await page.evaluate(() => window.__asks === 1));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });
  await page.waitForTimeout(3000);
  check('the next start is the map and the list', await page.evaluate(() => !drive.open));
  await tapDrive('#driveButton');
  check('«За рулём» still opens the navigator', await becomes(page, () => drive.open, null, 5000));
  await tapDrive('#drive [data-drive="theme"]');
  await page.waitForTimeout(700);
  await tapDrive('#drivePick [data-drive="start-mode"][data-mode="drive"]');
  check('«Навигатор» is chosen back, and the words say what it does', await becomes(page, () => drive.open && localStorage.getItem('spbfi-start-v1') === 'drive'
    && document.querySelector('#drivePick [data-mode="drive"]')?.getAttribute('aria-pressed') === 'true'
    && document.querySelector('#drivePick').textContent.includes('сразу с навигатора'), null, 5000));
  await page.waitForTimeout(700);
  await tapDrive('#drivePick [data-drive="start-mode"][data-mode="map"]');
  check('«Карта» chosen on the navigator shows the ordinary map at once', await becomes(page, () => !drive.open && document.body.classList.contains('map-screen')
    && localStorage.getItem('spbfi-start-v1') === 'map', null, 5000));
  await page.reload({ waitUntil: 'load' });
  check('and the next start is the map', await becomes(page, () => document.body.classList.contains('map-screen') && !drive.open, null, 30000));
  await tapDrive('#modeBar [data-screen="drive"]');
  check('«🚗 Навигатор» in the bar opens the navigator', await becomes(page, () => drive.open, null, 5000));
  await tapDrive('#drive [data-drive="close"]');
  check('and its 🗺 comes back to the map', await becomes(page, () => !drive.open && document.body.classList.contains('map-screen'), null, 5000));
  check(`no box (${dialogs.length})`, dialogs.length === 0);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await refused('iphone-telegram', webkit, devices['iPhone 13'], {}, {
    title: 'Откройте в Safari', words: ['Telegram', '«⋯»', 'Открыть в Safari'], banner: 'Открыто внутри мессенджера', safari: true, copy: true,
  });
  await refused('iphone-safari', webkit, devices['iPhone 13'], { standalone: false }, {
    title: 'Разрешите геопозицию', words: ['Настройки веб-сайта', 'Службы геолокации'],
  });
  await refused('android-telegram', chromium, devices['Pixel 7'], { userAgent: devices['Pixel 7'].userAgent.replace(')', '; wv)') }, {
    title: 'Откройте в браузере', words: ['Telegram', '«⋮»', 'Открыть в браузере'], banner: 'Открыто внутри мессенджера', copy: true,
  });
  await refused('android-chrome', chromium, devices['Pixel 7'], {}, {
    title: 'Разрешите геопозицию', words: ['Разрешения', 'Местоположение'],
  });
  await silent();
  await granted();
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL LOCATION DENIED CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

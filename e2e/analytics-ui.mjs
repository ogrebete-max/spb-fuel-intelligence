// 16 Sep 2026: the owner asked how many people open the app, not only the
// club's members. With ANALYTICS=on the server keeps the app's anonymous events
// as daily totals, and the owner reads them in «👥 Клуб» → «📊 Аналитика» with
// the pass the app already holds, no key. A phone outside the club is counted;
// a member sees no such button and the panel does not open for them; anyone
// else on the page is told where it is. Members, the owner too, reach the club
// from «👥 Клуб» in the bar at the bottom, the map screen included; a phone
// outside the club has no such tab. WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9051;
const WORKER_PORT = 9052;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const OWNER_KEY = 'owner-key-used-only-in-this-test';

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
    res.end(`window.SPBFI_REPORT_ENDPOINT = 'http://localhost:${WORKER_PORT}'; window.SPBFI_ANALYTICS_ENDPOINT = 'http://localhost:${WORKER_PORT}';`);
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
const phonesToday = async (token) => {
  const data = await api('/analytics/dashboard?days=7', { token });
  return data.trend?.find((row) => row.day === new Date().toISOString().slice(0, 10))?.users || 0;
};

async function phone(browser, device, pass = null) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  // A person's phone rather than an automated browser: the app starts the way it does for people.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  if (pass) {
    await context.addInitScript(([token, member]) => {
      localStorage.setItem('spbfi-club-token-v1', token);
      localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
    }, [pass.token, pass.member]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  return { page, errors };
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}`, CLUB_OWNER_KEY: OWNER_KEY, ANALYTICS: 'on' };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  const { code } = await api('/club/invite', { method: 'POST', token: owner.token });
  const sasha = await api('/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } });
  const browser = await browserType.launch();

  // Somebody outside the club opens the app, and is counted.
  const stranger = await phone(browser, device);
  await stranger.page.goto(siteUrl, { waitUntil: 'load' });
  check('a phone outside the club opens the app', await becomes(stranger.page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));
  check('with no club tab in the bar', await stranger.page.evaluate(() => document.querySelector('#modeBar [data-club-tab]').hidden));
  let counted = 0;
  for (let i = 0; i < 40 && !counted; i += 1) {
    counted = await phonesToday(owner.token);
    if (!counted) await stranger.page.waitForTimeout(500);
  }
  check(`the server counts it for today (${counted})`, counted >= 1);

  // The owner's cabinet leads to the panel, and the panel back to the app.
  const boss = await phone(browser, device, owner);
  await boss.page.goto(siteUrl, { waitUntil: 'load' });
  check('the owner is in the club', await becomes(boss.page, () => !!state.club.member && state.club.features?.owner_analytics === true, null, 30000));
  check('the bar at the bottom has «👥 Клуб»', await becomes(boss.page, () => !document.querySelector('#modeBar [data-club-tab]').hidden, null, 10000));
  await boss.page.click('#modeBar [data-club-tab]');
  check('the club offers «📊 Аналитика»', await becomes(boss.page, () => !!document.querySelector('#drawerContent .club-analytics'), null, 10000));
  await boss.page.click('#drawerContent .club-analytics');
  check('it opens the panel with no key', await becomes(boss.page, () => location.pathname.endsWith('analytics.html') && !document.querySelector('#dashboard').hidden && document.querySelector('#login').hidden, null, 15000));
  const first = await boss.page.evaluate(() => document.querySelector('#kpis article')?.textContent || '');
  check(`«Сегодня открывали» shows the phones (${first})`, /^Сегодня открывали[1-9]/.test(first));
  const back = await boss.page.evaluate(() => ({ height: Math.round(document.querySelector('.analytics-header .back').getBoundingClientRect().height), bottom: !!document.querySelector('.back-bottom') }));
  check(`the way back is big enough for a thumb, at the top and the bottom (${JSON.stringify(back)})`, back.height >= 44 && back.bottom);
  await boss.page.screenshot({ path: path.join(OUT, `analytics-${label}-panel.png`) });
  await boss.page.click('.analytics-header a[href="./"]');
  check('«← В приложение» leads back to the app',await becomes(boss.page, () => !!document.querySelector('#stationList .station-card'), null, 30000));

  // A member sees no button, and the panel does not open for them.
  const member = await phone(browser, device, sasha);
  await member.page.goto(siteUrl, { waitUntil: 'load' });
  check('the member is in the club', await becomes(member.page, () => !!state.club.member && !!state.club.features, null, 30000));
  await member.page.click('#modeBar [data-screen="map"]');
  check('the member has «👥 Клуб» in the bar, on the map screen too', await becomes(member.page, () => document.body.classList.contains('map-screen') && !document.querySelector('#modeBar [data-club-tab]').hidden, null, 10000));
  await member.page.click('#modeBar [data-club-tab]');
  check('the member\'s club opens', await becomes(member.page, () => (document.querySelector('#drawerContent')?.textContent || '').includes('Пригласить человека'), null, 10000));
  check('with no «📊 Аналитика»', !(await member.page.$('#drawerContent .club-analytics')));
  await member.page.goto(`${siteUrl}analytics.html`, { waitUntil: 'load' });
  check('the panel tells a member it is the owner\'s', await becomes(member.page, () => !document.querySelector('#login').hidden
    && document.querySelector('#loginError').textContent.includes('владельцу клуба'), null, 15000));

  // Anyone else on the page is told where the owner finds it.
  await stranger.page.goto(`${siteUrl}analytics.html`, { waitUntil: 'load' });
  check('a stranger on the page is told where the panel is', await stranger.page.evaluate(() => !document.querySelector('#login').hidden
    && document.querySelector('#dashboard').hidden && document.querySelector('.login-card').textContent.includes('«👥 Клуб» → «📊 Аналитика»')));

  const errors = [...stranger.errors, ...boss.errors, ...member.errors];
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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL ANALYTICS CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

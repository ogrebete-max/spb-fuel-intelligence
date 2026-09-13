// «Нужны глаза рядом» and the blind-spot bonus, in WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8831;
const WORKER_PORT = 8832;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
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
const api = async (p, { method = 'GET', body, token } = {}) => (await fetch(`http://localhost:${WORKER_PORT}${p}`, {
  method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Member-Token': token } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})).json();

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), CLUB_OWNER_KEY: OWNER_KEY, ORIGIN: `http://localhost:${SITE_PORT}` };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block',
    // Lakhta, where the snapshot has several stations without fresh data.
    geolocation: { latitude: 59.9870, longitude: 30.1780 }, permissions: ['geolocation'],
  });
  await context.addInitScript(([token, member]) => {
    localStorage.setItem('spbfi-club-token-v1', token);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
    localStorage.setItem('spbfi-club-news-at-v1', String(Date.now()));
    Object.defineProperty(navigator, 'standalone', { get: () => true });
  }, [owner.token, owner.member]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });
  await page.evaluate(() => startFollowing({ manual: true }));
  await page.waitForFunction(() => state.location && state.searchScope === 'device' && state.stations.length, null, { timeout: 20000 });
  await page.evaluate(() => renderGroupFeed());
  const hint = await page.waitForSelector('.scout-hint', { timeout: 10000 }).catch(() => null);
  check('«Нужны глаза рядом» lists nearby blind spots', !!hint);
  if (hint) {
    await page.evaluate(() => document.querySelector('.scout-hint').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(OUT, `${label}-s1-scout.png`) });
    await page.click('.scout-item');
    await page.waitForSelector('.blind-hint', { timeout: 10000 });
    check('the drawer explains the bonus', (await page.textContent('.blind-hint')).includes('+2 л'));
    // Cards and the «вы у АЗС» panel carry their own composers now; use the drawer's.
    await page.click('#drawerContent [data-compose-grade="AI95"][data-compose-seen="1"]');
    await page.click('#drawerContent .compose-send');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('+3 л')), null, { timeout: 8000 }).catch(() => null);
    check('a blind-spot mark pays +3 л', await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('+3 л'))));
    await page.screenshot({ path: path.join(OUT, `${label}-s2-bonus.png`) });
  }
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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL SCOUT UI CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

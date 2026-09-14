// The motivation loop end to end in WebKit (iPhone) and Chromium (Android):
// a member marks, another confirms and says thanks, the first one hears about
// it, sees litres, a level, badges and the weekly board.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';
import { createHandler } from '../server/http.mjs';
import { SqliteD1 } from '../server/sqlite-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8821;
const WORKER_PORT = 8822;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}
// `--d1` runs the same flow against D1, the way the worker is meant to be deployed.
const useD1 = process.argv.includes('--d1');
// `--server` runs it the way the club server does: through server/http.mjs, on
// a SQLite file and with no KV at all.
const useServer = process.argv.includes('--server');
const scratch = useServer ? fs.mkdtempSync(path.join(os.tmpdir(), 'spbfi-e2e-')) : null;
const databases = [];
const serverDatabase = () => {
  databases.push(new SqliteD1(path.join(scratch, `club-${databases.length + 1}.sqlite`)));
  return databases.at(-1);
};
const storage = () => (useServer ? { DB: serverDatabase() } : { REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}) });
const OWNER_KEY = 'owner-key-used-only-in-this-test';
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
const workerServer = http.createServer(useServer ? createHandler({ worker, env: () => env, settle: true }).handle : async (req, res) => {
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

const siteUrl = `http://localhost:${SITE_PORT}/`;
const api = async (pathName, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`http://localhost:${WORKER_PORT}${pathName}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Member-Token': token } : {}), Origin: `http://localhost:${SITE_PORT}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };

async function member(browser, device, token, memberRecord, { standalone = false } = {}) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.addInitScript(([t, m, s]) => {
    localStorage.setItem('spbfi-club-token-v1', t);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(m));
    // A phone that has used the club before, so news are replayed.
    localStorage.setItem('spbfi-club-news-at-v1', String(Date.now() - 60 * 1000));
    if (s) Object.defineProperty(navigator, 'standalone', { get: () => true });
  }, [token, memberRecord, standalone]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept(dialog.defaultValue() || ''));
  page.errors = errors;
  return page;
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  const { code } = await api('/club/invite', { method: 'POST', token: owner.token });
  const sasha = await api('/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } });
  const browser = await browserType.launch();
  const isIPhone = /iPhone/.test(device.userAgent || '');

  const sashaPage = await member(browser, device, sasha.token, sasha.member, { standalone: isIPhone });
  await sashaPage.goto(siteUrl, { waitUntil: 'load' });
  await sashaPage.waitForSelector('.station-card .card-main', { timeout: 30000 });
  check('member skips the gate', await sashaPage.isHidden('#clubGate'));

  // Sasha marks a station: +1 🤝 and the first badge are celebrated.
  await sashaPage.click('.station-card .card-main');
  await sashaPage.waitForSelector('.mark-composer');
  const stationId = await sashaPage.getAttribute('.mark-composer', 'data-compose-station');
  await sashaPage.click('[data-compose-grade="AI95"][data-compose-seen="1"]');
  await sashaPage.click('[data-compose-grade="DT"][data-compose-seen="0"]');
  await sashaPage.click('[data-compose-queue="3"]');
  await sashaPage.click('.compose-send');
  await sashaPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('+1 🤝')), null, { timeout: 8000 });
  check('a mark celebrates +1 🤝 once, not per grade', (await sashaPage.$$eval('.toast', (ts) => ts.filter((t) => t.textContent.includes('+1 🤝')).length)) === 1);
  await sashaPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Первая отметка')), null, { timeout: 8000 });
  check('the first badge pops up', true);
  await sashaPage.screenshot({ path: path.join(OUT, `${label}-r1-celebrate.png`) });
  await sashaPage.evaluate(() => closeDrawer());

  // The owner sees Sasha's mark with a level icon, confirms it and says thanks.
  const ownerPage = await member(browser, device, owner.token, owner.member, { standalone: isIPhone });
  await ownerPage.goto(siteUrl, { waitUntil: 'load' });
  await ownerPage.waitForSelector('.station-card', { timeout: 30000 });
  await ownerPage.evaluate(() => pollGroupMarks());
  await ownerPage.waitForSelector('.feed-item .thanks-button', { timeout: 10000 });
  check('feed shows «🔰 Саша» with a thanks button', (await ownerPage.textContent('.feed-item')).includes('🔰 Саша'));
  await ownerPage.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  await ownerPage.screenshot({ path: path.join(OUT, `${label}-r2-feed-thanks.png`) });
  await ownerPage.evaluate((id) => openStation(id), stationId);
  await ownerPage.waitForSelector('.mark-composer');
  await ownerPage.click('[data-compose-grade="AI95"][data-compose-seen="1"]');
  await ownerPage.click('.compose-send');
  await ownerPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Вы подтвердили')), null, { timeout: 8000 });
  check('confirming says whom you confirmed', true);
  await ownerPage.evaluate(() => closeDrawer());
  await ownerPage.evaluate(() => pollGroupMarks());
  await ownerPage.waitForSelector('.feed-item .thanks-button:not([disabled])');
  await ownerPage.click('.feed-item .thanks-button');
  await ownerPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Спасибо отправлено')), null, { timeout: 8000 });
  await ownerPage.waitForSelector('.feed-item .thanks-button.done', { timeout: 8000 });
  check('thanks is sent once and the button settles', true);

  // Sasha hears about it without doing anything.
  await sashaPage.evaluate(() => pollClubNews());
  await sashaPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('говорит спасибо')), null, { timeout: 8000 });
  check('author gets «Егор говорит спасибо»', true);
  await sashaPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('подтвердил')), null, { timeout: 8000 });
  check('author gets the confirmation', true);
  await sashaPage.screenshot({ path: path.join(OUT, `${label}-r3-news.png`) });
  const clubLabel = await sashaPage.textContent('#clubButton');
  check(`club button shows handshakes (${clubLabel.trim()})`, /6 🤝/.test(clubLabel));

  // Sasha opens the club: tank, badges, weekly board.
  await sashaPage.click('#clubButton');
  await sashaPage.waitForSelector('.tank-card');
  await sashaPage.waitForSelector('.board-row', { timeout: 8000 });
  check('tank shows 6 litres', (await sashaPage.textContent('.tank-liters b')).trim() === '6');
  check('earned badges are lit', (await sashaPage.$$('.badge.earned')).length >= 1);
  check('weekly board lists both members', (await sashaPage.$$('.board-row')).length === 2);
  await sashaPage.screenshot({ path: path.join(OUT, `${label}-r4-tank.png`) });
  await sashaPage.evaluate(() => document.querySelector('.badge-grid').scrollIntoView());
  await sashaPage.screenshot({ path: path.join(OUT, `${label}-r5-badges.png`) });
  await sashaPage.evaluate(() => document.querySelector('#clubBoard').scrollIntoView());
  await sashaPage.screenshot({ path: path.join(OUT, `${label}-r6-board.png`) });

  // The owner hands out a club award from the member list.
  await ownerPage.click('#clubButton');
  await ownerPage.waitForSelector('[data-award]');
  await ownerPage.click('[data-award]');
  await ownerPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('благодарность клуба')), null, { timeout: 8000 });
  check('owner award goes through', true);
  await sashaPage.evaluate(() => { closeDrawer(); return pollClubNews(); });
  await sashaPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Благодарность клуба')), null, { timeout: 8000 });
  check('member hears about the award', true);

  const errors = [...sashaPage.errors, ...ownerPage.errors];
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
  for (const db of databases) db.close();
  try {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover temporary folder is not a failed check.
  }
}
console.log(failures.length ? `\n${failures.length} FAILED` : `\nALL REWARDS UI CHECKS PASSED${useServer ? ' (server)' : ''}`);
process.exit(failures.length ? 1 : 0);

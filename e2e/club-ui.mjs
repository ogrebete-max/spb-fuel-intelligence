// End-to-end check of the club in real browser engines: the built site is
// served locally, the worker runs in-process on a second port with in-memory
// KV, and config.js is rewritten to point at it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8811;
const WORKER_PORT = 8812;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}
// `--d1` runs the same flow against D1, the way the worker is meant to be deployed.
const useD1 = process.argv.includes('--d1');
const storage = () => ({ REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}) });
const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, ORIGIN: `http://localhost:${SITE_PORT}` };
globalThis.fetch = ((original) => (url, init) => (String(url).startsWith('https://push.') ? Promise.resolve(new Response(null, { status: 201 })) : original(url, init)))(globalThis.fetch);

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
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body });
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));
await new Promise((resolve) => workerServer.listen(WORKER_PORT, resolve));

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', geolocation: { latitude: 60.0035, longitude: 30.2603 }, permissions: ['geolocation'] });
  const errors = [];
  const newPage = async () => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept(dialog.defaultValue() || ''));
    return page;
  };

  // A stranger is stopped at the gate.
  const owner = await newPage();
  await owner.goto(siteUrl, { waitUntil: 'load' });
  await owner.waitForSelector('#clubGate:not([hidden]) .gate-card', { timeout: 15000 });
  check('stranger sees the club gate', await owner.isVisible('#clubGate'));
  await owner.screenshot({ path: path.join(OUT, `${label}-1-gate.png`) });

  // The owner signs in.
  await owner.click('#gateOwner');
  await owner.fill('#gateOwnerKey', 'wrong key');
  await owner.click('#gateOwnerForm .gate-submit');
  await owner.waitForFunction(() => document.querySelector('#gateError')?.textContent.length > 0);
  check('wrong owner key is refused in plain words', (await owner.textContent('#gateError')).includes('не подошёл'));
  await owner.fill('#gateOwnerKey', OWNER_KEY);
  await owner.fill('#gateOwnerName', 'Егор');
  await owner.click('#gateOwnerForm .gate-submit');
  await owner.waitForSelector('#clubGate', { state: 'hidden', timeout: 10000 });
  check('owner is inside', await owner.isVisible('#clubButton'));

  // The owner creates an invite.
  await owner.click('#clubButton');
  await owner.waitForSelector('#clubInvite');
  await owner.click('#clubInvite');
  await owner.waitForSelector('.club-code b');
  const code = (await owner.textContent('.club-code b')).trim();
  check(`invite code looks right (${code})`, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await owner.screenshot({ path: path.join(OUT, `${label}-2-club.png`) });

  // A second person joins by link in a separate browser profile.
  const guestContext = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const guest = await guestContext.newPage();
  guest.on('pageerror', (error) => errors.push(error.message));
  await guest.goto(`${siteUrl}?invite=${code}`, { waitUntil: 'load' });
  await guest.waitForSelector('#clubGate:not([hidden]) .gate-card');
  const isIPhone = /iPhone/.test(device.userAgent || '');
  if (isIPhone) {
    check('iPhone in Safari is told to install first', await guest.isVisible('.gate-install'));
    check('iPhone in Safari sees the code to copy', (await guest.textContent('.gate-code-line')).includes(code));
    await guest.screenshot({ path: path.join(OUT, `${label}-3-install-first.png`) });
    // Pretend we are now inside the home-screen app.
    await guest.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await guest.goto(`${siteUrl}?invite=${code}`, { waitUntil: 'load' });
    await guest.waitForSelector('#gateJoinForm:not([hidden])');
  }
  check('invite code is prefilled', (await guest.inputValue('#gateCode')) === code);
  await guest.fill('#gateName', 'Саша');
  await guest.click('#gateJoinForm .gate-submit');
  await guest.waitForFunction(() => document.querySelector('#gateError')?.textContent.length > 0);
  check('joining without accepting the rules is stopped', (await guest.textContent('#gateError')).includes('правила'));
  await guest.check('#gateAccept');
  await guest.screenshot({ path: path.join(OUT, `${label}-4-join.png`) });
  await guest.click('#gateJoinForm .gate-submit');
  await guest.waitForSelector('#clubGate', { state: 'hidden', timeout: 10000 });
  check('guest joined', await guest.isVisible('#clubButton'));

  // The guest marks a station; the owner sees the name at the top.
  await guest.waitForSelector('.station-card .card-main', { timeout: 30000 });
  await guest.click('.station-card .card-main');
  await guest.waitForSelector('.mark-composer');
  await guest.click('[data-compose-grade="AI95"][data-compose-seen="1"]');
  await guest.click('[data-compose-queue="3"]');
  await guest.click('.compose-send');
  await guest.waitForSelector('.mark-sent');
  await owner.evaluate(() => { closeDrawer(); return pollGroupMarks(); });
  await owner.waitForFunction(() => document.querySelector('#groupFeed')?.textContent.includes('Саша'), null, { timeout: 10000 });
  check('owner sees «Саша» in «Свои сообщают»', true);
  await owner.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  await owner.screenshot({ path: path.join(OUT, `${label}-5-feed.png`) });

  // The owner bans the guest; the guest is shown the reason on the next call.
  await owner.click('#clubButton');
  await owner.waitForSelector('[data-ban]');
  await owner.screenshot({ path: path.join(OUT, `${label}-6-members.png`), fullPage: false });
  await owner.click('[data-ban]');
  await owner.waitForSelector('[data-unban]', { timeout: 10000 });
  check('owner banned the guest', true);
  await guest.evaluate(() => { closeDrawer(); return checkClub(); });
  await guest.waitForSelector('#clubGate:not([hidden]) .gate-alert', { timeout: 10000 });
  check('banned guest is shut out with the reason', (await guest.textContent('.gate-alert')).includes('ложные отметки'));
  await guest.screenshot({ path: path.join(OUT, `${label}-7-banned.png`) });

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  Object.assign(env, storage());
  await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : `\nALL CLUB UI CHECKS PASSED (${useD1 ? 'D1' : 'KV'})`);
process.exit(failures.length ? 1 : 0);

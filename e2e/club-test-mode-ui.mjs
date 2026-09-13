// The club as a test, in WebKit (iPhone) and Chromium (Android): nothing
// changes for a phone outside it; the owner gets in by tapping the page title
// five times; «Не сейчас» closes an offered gate; once joining is offered an
// invite line appears; and only a closed club stops a new phone at the gate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8881;
const WORKER_PORT = 8882;
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
const appears = (page, selector, timeout = 10000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const becomes = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const settled = (page, mode) => becomes(page, (expected) => state.club.mode === expected, mode);

async function open(browser, device, url = siteUrl) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  // Every phone here runs the app from the home screen.
  if (/iPhone/.test(device.userAgent || '')) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept(dialog.defaultValue() || ''));
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const pages = [];

  // A phone outside the club during the test: the app as it always was.
  const stranger = await open(browser, device);
  pages.push(stranger);
  check('the app learns the club is a test', await settled(stranger, 'test'));
  await stranger.waitForSelector('.station-card', { timeout: 30000 });
  check('a phone outside it sees no gate, no club button and no invite line',
    await stranger.isHidden('#clubGate') && await stranger.isHidden('#clubButton') && (await stranger.locator('[data-club-join]').count()) === 0);

  // The owner taps the title five times.
  const owner = await open(browser, device);
  pages.push(owner);
  await settled(owner, 'test');
  for (let i = 0; i < 5; i += 1) await owner.tap('#heroTitle');
  check('five taps on the title open the owner sign-in', await appears(owner, '#clubGate:not([hidden]) #gateOwnerForm'));
  check('with «Не сейчас» to close it', await owner.isVisible('#gateClose'));
  await owner.screenshot({ path: path.join(OUT, `${label}-t1-owner-sign-in.png`) });
  await owner.fill('#gateOwnerKey', 'wrong key');
  await owner.click('#gateOwnerForm .gate-submit');
  check('a wrong key is refused', await becomes(owner, () => document.querySelector('#gateError')?.textContent.includes('не подошёл')));
  await owner.fill('#gateOwnerKey', OWNER_KEY);
  await owner.fill('#gateOwnerName', 'Егор');
  await owner.click('#gateOwnerForm .gate-submit');
  check('the owner is inside', await appears(owner, '#clubButton:not([hidden])') && await becomes(owner, () => document.querySelector('#clubGate').hidden));
  await owner.click('#clubButton');
  await owner.click('#clubInvite');
  const code = await appears(owner, '.club-code b') ? (await owner.textContent('.club-code b')).trim() : '';
  check(`the owner creates an invite (${code})`, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await owner.screenshot({ path: path.join(OUT, `${label}-t2-owner-club.png`) });

  await stranger.reload({ waitUntil: 'load' });
  await settled(stranger, 'test');
  check('the stranger still sees the plain app', await stranger.isHidden('#clubGate') && await stranger.isHidden('#clubButton'));

  // The owner's link opens the sign-in too; «Не сейчас» leaves the plain app.
  const linked = await open(browser, device, `${siteUrl}?club=owner`);
  pages.push(linked);
  check('the owner link opens the sign-in', await appears(linked, '#clubGate:not([hidden]) #gateOwnerForm'));
  await linked.click('#gateClose');
  check('«Не сейчас» closes it and cleans the address', await linked.isHidden('#clubGate') && !(await linked.evaluate(() => location.search)));

  // Joining is offered to everyone.
  env.CLUB_GATE = 'invite';
  await stranger.reload({ waitUntil: 'load' });
  check('with invites open, a line offers to join', await appears(stranger, '[data-club-join]'));
  check('and still no gate', await stranger.isHidden('#clubGate'));
  await stranger.screenshot({ path: path.join(OUT, `${label}-t3-invite-line.png`) });
  await stranger.click('[data-club-join]');
  check('the line opens the join form', await appears(stranger, '#clubGate:not([hidden]) #gateJoinForm:not([hidden])'));
  await stranger.fill('#gateCode', code);
  await stranger.fill('#gateName', 'Саша');
  await stranger.check('#gateAccept');
  await stranger.click('#gateJoinForm .gate-submit');
  check('the invited phone is inside', await appears(stranger, '#clubButton:not([hidden])') && await becomes(stranger, () => document.querySelector('#clubGate').hidden));
  check('and the invite line is gone', await becomes(stranger, () => !document.querySelector('[data-club-join]')));

  // Behind a closed door a new phone meets the gate, with no way past it.
  env.CLUB_GATE = 'closed';
  const newcomer = await open(browser, device);
  pages.push(newcomer);
  check('a closed club stops a new phone at the gate', await appears(newcomer, '#clubGate:not([hidden]) .gate-card'));
  check('with no «Не сейчас»', (await newcomer.locator('#gateClose').count()) === 0);
  await owner.reload({ waitUntil: 'load' });
  check('members stay inside when the door closes', await appears(owner, '#clubButton:not([hidden])') && await becomes(owner, () => document.querySelector('#clubGate').hidden));

  const errors = pages.flatMap((page) => page.errors);
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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CLUB TEST-MODE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

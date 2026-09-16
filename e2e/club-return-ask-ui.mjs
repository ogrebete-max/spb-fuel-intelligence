// 16 Sep 2026: a member on a new phone asked a friend for a code and became a
// second member with nothing. The owner decided one name is one person, and
// that whoever gave the code vouches. Here Саша, back on a new phone with a
// fresh code from Оля, types «Саша»: the app asks whether it is her, Оля sees
// the request in «👥 Клуб» and says yes, and the new phone comes in as the same
// Саша with every handshake. Someone else typing a taken name picks another
// and joins as before. WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9061;
const WORKER_PORT = 9062;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const STATION = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations[0];

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
const api = async (pathName, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`http://localhost:${WORKER_PORT}${pathName}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Member-Token': token } : {}), Origin: `http://localhost:${SITE_PORT}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};
const gateText = (page) => page.evaluate(() => document.querySelector('#clubGate')?.textContent || '');

async function phone(browser, device, pass = null) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  // The app on the home screen, where an iPhone takes a code.
  if (/iPhone/.test(device.userAgent || '')) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
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

async function fillJoin(page, name) {
  await page.fill('#gateName', name);
  await page.check('#gateAccept');
  await page.click('#gateJoinForm .gate-submit');
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}`, CLUB_OWNER_KEY: OWNER_KEY };
  const owner = await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } });
  const invite = async (token) => (await api('/club/invite', { method: 'POST', token })).code;
  const sasha = await api('/club/join', { method: 'POST', body: { code: await invite(owner.token), name: 'Саша', accept: true, device: 'old-phone' } });
  const olya = await api('/club/join', { method: 'POST', body: { code: await invite(owner.token), name: 'Оля', accept: true, device: 'olya-phone' } });
  await api('/report', { method: 'POST', token: sasha.token, body: { station: STATION.id, lat: STATION.location.lat, lon: STATION.location.lon, grades: [{ grade: 'AI95', seen: true }] } });
  const handshakes = (await api('/club/me', { token: sasha.token })).profile.liters;
  const code = await invite(olya.token);
  const browser = await browserType.launch();

  // Саша's new phone, with Оля's fresh code.
  const fresh = await phone(browser, device);
  await fresh.page.goto(`${siteUrl}?invite=${code}`, { waitUntil: 'load' });
  check('the invitation opens the join form with the code in it', await becomes(fresh.page, (want) => document.querySelector('#gateCode')?.value === want, code, 30000));
  await fillJoin(fresh.page, 'саша');
  check('a taken name asks whether it is her', await becomes(fresh.page, () => (document.querySelector('#gateReturnAsk')?.textContent || '').includes('«Саша» уже в клубе'), null, 15000));
  await fresh.page.screenshot({ path: path.join(OUT, `return-ask-${label}-1-asks.png`) });
  await fresh.page.click('#gateReturnYes');
  check('«Да, это я» waits for Оля to vouch', await becomes(fresh.page, () => (document.querySelector('#gateReturnAsk')?.textContent || '').includes('Ждём, когда «Оля» подтвердит'), null, 15000));
  check('and no second Саша appeared', (await api('/club/members', { token: owner.token })).members.filter((item) => item.name === 'Саша').length === 1);

  // Оля sees the request in her club and says yes.
  const friend = await phone(browser, device, olya);
  await friend.page.goto(siteUrl, { waitUntil: 'load' });
  check('Оля is in the club', await becomes(friend.page, () => !!state.club.member && !document.querySelector('#modeBar [data-club-tab]').hidden, null, 30000));
  await friend.page.click('#modeBar [data-club-tab]');
  check('her club shows «Саша просит вернуться»', await becomes(friend.page, () => (document.querySelector('#drawerContent .club-return-ask')?.textContent || '').includes('«Саша» просит вернуться'), null, 15000));
  await friend.page.screenshot({ path: path.join(OUT, `return-ask-${label}-2-vouch.png`) });
  await friend.page.click('#drawerContent [data-return-yes]');
  check('«Да, это Саша» is taken', await becomes(friend.page, () => !document.querySelector('#drawerContent .club-return-ask'), null, 15000));

  // The new phone comes in as the same Саша, with everything.
  check('the new phone comes in as Саша by itself', await becomes(fresh.page, (id) => state.club.member?.id === id && !!localStorage.getItem('spbfi-club-token-v1'), sasha.member.id, 20000));
  check('welcomed back', (await gateText(fresh.page)).includes('Саша'));
  check(`with every handshake (${handshakes})`, await becomes(fresh.page, (want) => state.club.profile?.liters === want, handshakes, 15000));
  await fresh.page.screenshot({ path: path.join(OUT, `return-ask-${label}-3-back.png`) });

  // Someone else with a taken name picks another and joins as before.
  const other = await phone(browser, device);
  await other.page.goto(`${siteUrl}?invite=${await invite(owner.token)}`, { waitUntil: 'load' });
  await becomes(other.page, () => !!document.querySelector('#gateName'), null, 30000);
  await fillJoin(other.page, 'Саша');
  await becomes(other.page, () => !!document.querySelector('#gateReturnNo'), null, 15000);
  await other.page.click('#gateReturnNo');
  check('«Нет» asks for another name', await becomes(other.page, () => (document.querySelector('#gateError')?.textContent || '').includes('В клубе уже есть «Саша»') && !document.querySelector('#gateReturnAsk'), null, 5000));
  await fillJoin(other.page, 'Саша К');
  check('and another name joins as a new member', await becomes(other.page, () => state.club.member?.name === 'Саша К', null, 15000));

  const errors = [...fresh.errors, ...friend.errors, ...other.errors];
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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL RETURN BY CODE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

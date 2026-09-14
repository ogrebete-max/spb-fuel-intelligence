// A member whose phone forgot the pass comes back on their own, in real browser
// engines: Android (Chromium, with a virtual authenticator standing in for the
// fingerprint), a computer, and an iPhone home-screen app (WebKit, by code).
// Nobody asks the owner, nobody becomes a twin, and a friend the code was
// passed on to is not let in as someone else.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8921;
const WORKER_PORT = 8922;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}

let env;
const freshEnv = () => ({ REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` });
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
// Every browser request comes from one address; a distinct one each keeps the
// worker's per-address limit on joining out of a test that joins a lot.
let requests = 0;
const workerServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests += 1;
  const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, 'cf-connecting-ip': `10.9.${(requests >> 8) & 255}.${requests & 255}` },
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

async function api(pathname, { method = 'GET', body, token } = {}) {
  requests += 1;
  const response = await worker.fetch(new Request(`http://localhost:${WORKER_PORT}${pathname}`, {
    method,
    headers: {
      Origin: `http://localhost:${SITE_PORT}`,
      'CF-Connecting-IP': `10.8.${(requests >> 8) & 255}.${requests & 255}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: response.status, data: await response.json() };
}

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function welcome(page) {
  await page.waitForSelector('#clubGate .gate-welcome #gateDone', { timeout: 15000 });
  return page.textContent('#clubGate .gate-welcome');
}

async function atGate(page, url = siteUrl) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#gateJoinForm:not([hidden])', { timeout: 15000 });
}

// The phone forgets everything it kept for the site.
async function forget(page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#gateJoinForm:not([hidden])', { timeout: 15000 });
}

async function enterCode(page, code, answer) {
  let asked = '';
  if (answer) page.once('dialog', (dialog) => { asked = dialog.message(); return answer === 'yes' ? dialog.accept() : dialog.dismiss(); });
  await page.fill('#gateCode', code);
  await page.click('#gateJoinForm .gate-submit');
  return () => asked;
}

const handshakesOn = (page) => page.evaluate(() => Number((document.querySelector('#clubButton')?.textContent.match(/(\d+) 🤝/) || [])[1] || 0));

async function android() {
  console.log('\n=== android · Chromium with a fingerprint');
  env = freshEnv();
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const code = (await api('/club/invite', { method: 'POST', token: boss.token })).data.code;
  const browser = await chromium.launch();
  const errors = [];
  const open = async (device, label) => {
    const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    return page;
  };

  const phone = await open(devices['Pixel 7'], 'phone');
  const cdp = await phone.context().newCDPSession(phone);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await atGate(phone, `${siteUrl}?invite=${code}`);
  check('the gate tells someone coming back that the same code works', (await phone.textContent('#gateJoinForm')).includes('Уже были в клубе?'));
  await phone.fill('#gateName', 'Саша');
  await phone.check('#gateAccept');
  await phone.click('#gateJoinForm .gate-submit');
  check('a newcomer joins', (await welcome(phone)).includes('Саша, вы в клубе'));
  check('the welcome offers to remember the login', await phone.waitForSelector('#gateRemember:not([hidden])', { timeout: 10000 }).then(() => true, () => false));
  check('in Android words', (await phone.textContent('#gateRemember')).includes('отпечатку или PIN-коду'));
  await phone.screenshot({ path: path.join(OUT, 'return-android-1-remember.png') });
  await phone.click('#gateRememberButton');
  check('the login is remembered', await becomes(phone, () => document.querySelector('#gateRemember')?.textContent.includes('Вход запомнен')));
  const sasha = (await api('/club/members', { token: boss.token })).data.members.find((item) => item.name === 'Саша');
  check('the club keeps the passkey', sasha?.passkeys === 1);
  await phone.click('#gateDone');
  await api('/club/award', { method: 'POST', token: boss.token, body: { id: sasha.id, text: 'За точные отметки' } });

  // The phone forgets the pass: the fingerprint brings Sasha back.
  await forget(phone);
  check('the gate offers «Я уже в клубе»', await phone.isVisible('#gatePasskey'));
  await phone.screenshot({ path: path.join(OUT, 'return-android-2-gate.png') });
  await phone.click('#gatePasskey');
  check('the fingerprint brings Sasha back', (await welcome(phone)).includes('С возвращением, Саша'));
  check('as the same member', await phone.evaluate((expected) => state.club.member?.id === expected, sasha.id));
  check('with nothing more to remember', await phone.isHidden('#gateRemember'));
  await phone.screenshot({ path: path.join(OUT, 'return-android-3-back.png') });
  await phone.click('#gateDone');
  check('with every handshake', await becomes(phone, () => Number((document.querySelector('#clubButton')?.textContent.match(/(\d+) 🤝/) || [])[1] || 0) >= 10));

  // The phone forgets again; this time the invitation code is typed once more.
  await forget(phone);
  const asked = await enterCode(phone, code, 'yes');
  const again = await welcome(phone);
  check('the code asks «Это вы?» first', asked().includes('«Саша»') && asked().includes('Это вы?'));
  check('and brings Sasha back without a name or the rules', again.includes('С возвращением, Саша'));
  await phone.click('#gateDone');
  check('the handshakes are still there', (await handshakesOn(phone)) >= 10 || await becomes(phone, () => Number((document.querySelector('#clubButton')?.textContent.match(/(\d+) 🤝/) || [])[1] || 0) >= 10));

  // A friend the code was passed on to says «no» and stays outside.
  const friend = await open(devices['Pixel 7'], 'friend');
  await atGate(friend);
  await enterCode(friend, code, 'no');
  check('a friend with a passed-on code is not let in as Sasha', await becomes(friend, () => document.querySelector('#gateError')?.textContent.includes('не ваш')));
  check('and stays at the gate', await friend.evaluate(() => !localStorage.getItem('spbfi-club-token-v1') && !document.querySelector('#clubGate').hidden));

  // The phone shows a code; the computer comes in with it.
  await phone.click('#clubButton');
  await phone.waitForSelector('#clubDeviceCode', { timeout: 10000 });
  check('the club says the login is remembered', (await phone.textContent('#clubLoginState')).includes('запомнен'));
  await phone.click('#clubDeviceCode');
  await phone.waitForSelector('#clubDeviceCodeResult .club-code b', { timeout: 10000 });
  const deviceCode = (await phone.textContent('#clubDeviceCodeResult .club-code b')).trim();
  check(`the phone shows a code for a computer (${deviceCode})`, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(deviceCode));
  await phone.screenshot({ path: path.join(OUT, 'return-android-4-device-code.png') });
  let leaving = '';
  phone.once('dialog', (dialog) => { leaving = dialog.message(); return dialog.dismiss(); });
  await phone.click('#clubLeave');
  check('leaving names the way back', leaving.includes('Я уже в клубе') && !leaving.includes('новое приглашение'));
  check('and nothing is left when the answer is no', await phone.evaluate(() => !!localStorage.getItem('spbfi-club-token-v1')));

  const computer = await open(devices['Desktop Chrome'], 'computer');
  await atGate(computer);
  await enterCode(computer, deviceCode);
  check('the computer comes in as Sasha', (await welcome(computer)).includes('С возвращением, Саша'));

  // The owner's code, for someone who lost every device.
  const owner = await open(devices['Desktop Chrome'], 'owner');
  await atGate(owner);
  for (let i = 0; i < 5; i += 1) await owner.click('#gateTitle');
  await owner.waitForSelector('#gateOwnerForm', { timeout: 10000 });
  await owner.fill('#gateOwnerKey', OWNER_KEY);
  await owner.fill('#gateOwnerName', 'Егор');
  await owner.click('#gateOwnerForm .gate-submit');
  await welcome(owner);
  await owner.click('#gateDone');
  await owner.click('#clubButton');
  await owner.waitForSelector('#clubMembers [data-login-code]', { timeout: 10000 });
  check('the members list shows who remembered the login', (await owner.textContent('#clubMembers')).includes('🔑 вход запомнен'));
  await owner.click('#clubMembers [data-login-code]');
  await owner.waitForSelector('#clubMembers .club-code b', { timeout: 10000 });
  const ownerCode = (await owner.textContent('#clubMembers .club-code b')).trim();
  await owner.screenshot({ path: path.join(OUT, 'return-android-5-owner-code.png') });
  check('the invitation speaks to Android and iPhone', await owner.evaluate(() => /Android:/.test(inviteText('ABCD-EFGH')) && /iPhone:/.test(inviteText('ABCD-EFGH'))));

  const newPhone = await open(devices['Pixel 7'], 'new phone');
  await atGate(newPhone);
  await enterCode(newPhone, ownerCode);
  check('the owner\'s code brings Sasha back on a new phone', (await welcome(newPhone)).includes('С возвращением, Саша'));

  const everyone = (await api('/club/members', { token: boss.token })).data.members;
  check('still one Sasha in the club', everyone.filter((item) => item.name === 'Саша').length === 1);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function iphone() {
  console.log('\n=== iPhone · WebKit, the app on the home screen');
  env = freshEnv();
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const code = (await api('/club/invite', { method: 'POST', token: boss.token })).data.code;
  const browser = await webkit.launch();
  const errors = [];
  const open = async (label) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    return page;
  };

  const phone = await open('icon');
  await atGate(phone, `${siteUrl}?invite=${code}`);
  await phone.fill('#gateName', 'Дизель');
  await phone.check('#gateAccept');
  await phone.click('#gateJoinForm .gate-submit');
  check('Diesel joins', (await welcome(phone)).includes('Дизель, вы в клубе'));
  await phone.waitForTimeout(500);
  const offers = await phone.isVisible('#gateRemember');
  console.log(`     (this WebKit build ${offers ? 'offers' : 'has no authenticator to offer'} a passkey)`);
  check('when it offers a passkey it says Face ID', !offers || (await phone.textContent('#gateRemember')).includes('Face ID'));
  await phone.click('#gateDone');

  // The icon deleted and added again: its storage is new.
  const icon = await open('new icon');
  await atGate(icon);
  if (await icon.isVisible('#gatePasskey')) check('the gate button says Face ID', (await icon.textContent('#gatePasskey')).includes('Face ID'));
  const asked = await enterCode(icon, code, 'yes');
  check('the same code brings Diesel back after «Это вы?»', (await welcome(icon)).includes('С возвращением, Дизель') && asked().includes('«Дизель»'));
  await icon.screenshot({ path: path.join(OUT, 'return-iphone-1-back.png') });
  await icon.click('#gateDone');

  await phone.click('#clubButton');
  await phone.waitForSelector('#clubDeviceCode', { timeout: 10000 });
  await phone.click('#clubDeviceCode');
  await phone.waitForSelector('#clubDeviceCodeResult .club-code b', { timeout: 10000 });
  const deviceCode = (await phone.textContent('#clubDeviceCodeResult .club-code b')).trim();
  const second = await open('second iPhone');
  await atGate(second);
  await enterCode(second, deviceCode);
  check('a code from the first iPhone lets a second one in', (await welcome(second)).includes('С возвращением, Дизель'));
  const reused = await open('someone else');
  await atGate(reused);
  await enterCode(reused, deviceCode);
  check('the same code does not work twice', await becomes(reused, () => document.querySelector('#gateError')?.textContent.includes('уже сработал')));

  const everyone = (await api('/club/members', { token: boss.token })).data.members;
  check('still one Diesel in the club', everyone.filter((item) => item.name === 'Дизель').length === 1);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await android();
  await iphone();
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CLUB RETURN CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// Invitations and the club chat in real browser engines. A member who has
// handed out all three asks the owner for more; the owner sees the request in
// the members list and grants three with a tap; the member is told. The owner
// pastes the Telegram group link and only members get «💬 Чат клуба». A new
// phone at the closed door meets the invitation form and no owner sign-in.
// Android (Chromium) and iPhone (WebKit, the app on the home screen).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8941;
const WORKER_PORT = 8942;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}

let env;
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
let requests = 0;
const workerServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests += 1;
  const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, 'cf-connecting-ip': `10.5.${(requests >> 8) & 255}.${requests & 255}` },
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
      'CF-Connecting-IP': `10.4.${(requests >> 8) & 255}.${requests & 255}`,
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
const appears = (page, selector, timeout = 15000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);

async function run(label, browserType, phone) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` };
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const join = async (name, by) => {
    const code = (await api('/club/invite', { method: 'POST', token: by.token })).data.code;
    return (await api('/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
  };
  const sasha = await join('Саша', boss);
  for (const name of ['Друг 1', 'Друг 2', 'Друг 3']) await join(name, sasha);

  const browser = await browserType.launch();
  const errors = [];
  const open = async (device, who, name) => {
    const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
    if (/iPhone/.test(device.userAgent || '')) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    if (who) {
      await context.addInitScript(({ token, member }) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('spbfi-club-token-v1', token);
        localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
      }, { token: who.token, member: who.member });
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    page.on('dialog', (dialog) => dialog.accept(dialog.defaultValue() || ''));
    await page.goto(siteUrl, { waitUntil: 'load' });
    return page;
  };

  // A new phone at the closed door.
  const newcomer = await open(phone, null, 'newcomer');
  check('a new phone meets the invitation form', await appears(newcomer, '#clubGate:not([hidden]) #gateJoinForm:not([hidden])'));
  check('and no owner sign-in, not even a link to it', (await newcomer.locator('#gateOwnerForm, #gateOwner').count()) === 0);
  check('«Уже были в клубе?» comes after the invitation, when offered', await newcomer.evaluate(() => {
    const passkey = document.querySelector('#gatePasskey');
    return !passkey || !!(document.querySelector('#gateJoinForm').compareDocumentPosition(passkey) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await newcomer.screenshot({ path: path.join(OUT, `invites-${label}-1-gate.png`) });

  // Sasha has handed out all three.
  const member = await open(phone, sasha, 'member');
  check('the member is inside', await appears(member, '#clubButton:not([hidden])'));
  await member.evaluate(() => showClub());
  check('with no invitations left, a member can ask for more', await appears(member, '#clubAskInvites:not([disabled])'));
  await member.click('#clubAskInvites');
  check('the request is on its way', await becomes(member, () => document.querySelector('#clubAskInvites')?.textContent.includes('Запрос отправлен')));
  const asked = (await api('/club/members', { token: boss.token })).data.members.find((item) => item.id === sasha.member.id);
  check('the club keeps the request', !!asked.invites_asked && asked.invites_left === 0);
  await member.screenshot({ path: path.join(OUT, `invites-${label}-2-ask.png`) });
  await member.evaluate(() => closeDrawer());

  // The owner grants three and sets the chat.
  const owner = await open(devices['Desktop Chrome'], boss, 'owner');
  check('the owner is inside', await appears(owner, '#clubButton:not([hidden])'));
  await owner.evaluate(() => showClub());
  await owner.waitForSelector('#clubMembers [data-grant]', { timeout: 15000 });
  const rowOf = (name) => owner.evaluate((wanted) => [...document.querySelectorAll('#clubMembers .club-member')].find((row) => row.querySelector('strong')?.textContent.trim() === wanted)?.textContent || '', name);
  const sashaRow = await rowOf('Саша');
  check('the owner sees who asks for invitations', sashaRow.includes('Просит ещё приглашений') && sashaRow.includes('приглашений осталось: 0'));
  await owner.screenshot({ path: path.join(OUT, `invites-${label}-3-owner.png`), fullPage: true });
  await owner.evaluate(() => [...document.querySelectorAll('#clubMembers .club-member')].find((row) => row.querySelector('strong')?.textContent.trim() === 'Саша').querySelector('[data-grant]').click());
  check('one tap grants three', await becomes(owner, () => document.querySelector('#toastStack')?.textContent.includes('+3 приглашения')));
  const granted = (await api('/club/members', { token: boss.token })).data.members.find((item) => item.id === sasha.member.id);
  check('Sasha can invite three more', granted.invites_left === 3 && !granted.invites_asked);

  await owner.fill('#clubChatUrl', 'https://example.com/chat');
  await owner.click('#clubChatSave');
  check('a link that is not Telegram is refused', await becomes(owner, () => document.querySelector('#clubChatNote')?.textContent.includes('t.me')));
  await owner.fill('#clubChatUrl', 't.me/+Club_Chat-1');
  await owner.click('#clubChatSave');
  check('a Telegram link is saved', await becomes(owner, () => document.querySelector('#clubChatNote')?.textContent.includes('Сохранено') && document.querySelector('#clubChatUrl').value === 'https://t.me/+Club_Chat-1'));

  // Sasha is told and sees the chat.
  await member.evaluate(() => pollClubNews());
  check('Sasha is told about the new invitations', await becomes(member, () => document.querySelector('#toastStack')?.textContent.includes('дали ещё приглашения')));
  await member.evaluate(() => showClub());
  check('members get «💬 Чат клуба» with the link', await becomes(member, () => document.querySelector('#drawerContent a.club-chat')?.getAttribute('href') === 'https://t.me/+Club_Chat-1'));
  check('and can invite again', await becomes(member, () => !document.querySelector('#clubInvite')?.disabled && document.querySelector('#drawerContent').textContent.includes('Осталось приглашений: 3')));
  check('the ask button is gone', await member.evaluate(() => !document.querySelector('#clubAskInvites')));
  await member.screenshot({ path: path.join(OUT, `invites-${label}-4-chat.png`) });
  check('the phone at the door gets no chat link', await newcomer.evaluate(() => !document.querySelector('a.club-chat')));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('android', chromium, devices['Pixel 7']);
  await run('iphone', webkit, devices['iPhone 13']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CLUB INVITES CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

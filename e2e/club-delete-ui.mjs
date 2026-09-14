// 🗑 in real browser engines: a member marks a pump, sees «🗑 Удалить отметку»
// on the mark, confirms, and the mark leaves the feed for good with the 🤝 it
// earned; another member gets no 🗑 on it. The owner takes down a member's
// fresh mark from the feed and an older one from «Свои», and the member is
// told. Android (Chromium) and iPhone (WebKit).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8991;
const WORKER_PORT = 8992;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const START = { latitude: 59.9343, longitude: 30.3351, accuracy: 20 };
const MINUTE = 60 * 1000;

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
    headers: { ...req.headers, 'cf-connecting-ip': `10.7.${(requests >> 8) & 255}.${requests & 255}` },
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
      'CF-Connecting-IP': `10.6.${(requests >> 8) & 255}.${requests & 255}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: () => {} });
  return { status: response.status, data: await response.json() };
}

// A mark filed a while ago: the worker's clock is turned back while it takes it.
async function earlier(ms, action) {
  const realNow = Date.now;
  Date.now = () => realNow() - ms;
  try {
    return await action();
  } finally {
    Date.now = realNow;
  }
}

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const toasted = (page, text) => becomes(page, (words) => document.querySelector('#toastStack')?.textContent.includes(words), text);

async function run(label, browserType, phoneDevice) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` };
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const join = async (name) => {
    const code = (await api('/club/invite', { method: 'POST', token: boss.token })).data.code;
    return (await api('/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
  };
  const sasha = await join('Саша');
  const olya = await join('Оля');

  const browser = await browserType.launch();
  const errors = [];
  const open = async (who, name) => {
    const context = await browser.newContext({ ...phoneDevice, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: START });
    await context.addInitScript(({ token, member }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('spbfi-club-token-v1', token);
      localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
      // A phone that has read its club news before, so new ones are shown.
      localStorage.setItem('spbfi-club-news-at-v1', String(Date.now() - 60 * 1000));
    }, { token: who.token, member: who.member });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(siteUrl, { waitUntil: 'load' });
    return page;
  };
  const reportsOf = async (who) => (await api('/club/reports', { token: boss.token })).data.reports.filter((report) => report.who === who.member.id);
  const litersOf = async (who) => (await api('/club/me', { token: who.token })).data.profile.liters;

  // Sasha marks a pump from its card, the way a member does.
  const member = await open(sasha, 'member');
  check('the member is inside, and the worker deletes marks', await becomes(member, () => state.club.enabled && !!state.club.member && state.club.features?.delete_marks === true));
  check('stations are listed', await becomes(member, () => state.stations.length > 0, null, 30000));
  const [pump, older] = await member.evaluate(() => state.stations.slice(0, 2).map((station) => ({ id: station.id, lat: Number(station.location.lat), lon: Number(station.location.lon), network: station.network })));
  const before = await litersOf(sasha);
  await member.evaluate((id) => openStation(id), pump.id);
  await member.waitForSelector('#drawerContent .mark-composer', { timeout: 15000 });
  await member.click('#drawerContent [data-compose-grade="AI95"][data-compose-seen="1"]');
  await member.click('#drawerContent [data-compose-grade="AI92"][data-compose-seen="0"]');
  await member.click('#drawerContent .compose-send');
  check('the mark goes out', await becomes(member, () => document.querySelector('#drawerContent .mark-sent')?.textContent.includes('Отправлено')));
  const earned = (await litersOf(sasha)) - before;
  check(`and earns 🤝 (${earned})`, earned > 0);
  await member.evaluate(() => closeDrawer());
  // The card slides away first; the screenshot below is of the feed.
  await becomes(member, () => document.querySelector('#detailDrawer').getBoundingClientRect().left >= window.innerWidth);

  await member.evaluate(() => pollGroupMarks());
  check('his mark in the feed offers «🗑 Удалить отметку», with no votes on it yet', await becomes(member, () => document.querySelector('#groupFeed .look-delete')?.textContent.trim() === '🗑 Удалить отметку' && !document.querySelector('#groupFeed .look-vote-own')));
  await member.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  await member.screenshot({ path: path.join(OUT, `delete-${label}-1-own.png`) });

  let asked = '';
  member.once('dialog', (dialog) => { asked = dialog.message(); return dialog.accept(); });
  await member.click('#groupFeed .look-delete');
  check('a tap asks first and deletes', await toasted(member, 'Отметка удалена'));
  check(`the question names the grades («${asked.split('\n')[0]}»)`, asked.includes('95 есть, 92 нет') && asked.includes('Её перестанут видеть свои'));
  check(`the banner says the 🤝 went back («Вернули ${earned} 🤝»)`, (await member.textContent('#toastStack')).includes(`Вернули ${earned} 🤝`));
  check('the mark leaves the feed', await becomes(member, () => !document.querySelector('#groupFeed .feed-item')));
  check('the worker no longer has it', (await reportsOf(sasha)).length === 0);
  check('the 🤝 are taken back', (await litersOf(sasha)) === before);
  await member.evaluate(() => pollGroupMarks());
  check('the next read does not bring it back from the phone\'s own memory', await member.evaluate((id) => !Object.keys(state.groupMarks[id] || {}).length && !Object.keys(state.marks[id] || {}).length, pump.id));
  await member.screenshot({ path: path.join(OUT, `delete-${label}-2-gone.png`) });

  // Olya marks the pump; Sasha may not delete her mark, the owner may.
  const owner = await open(boss, 'owner');
  check('the owner is inside', await becomes(owner, () => state.club.member?.role === 'owner' && state.club.features?.delete_marks === true));
  const author = await open(olya, 'olya');
  check('Olya is inside', await becomes(author, () => state.club.member?.name === 'Оля'));
  const marked = await api('/report', { method: 'POST', token: olya.token, body: { station: pump.id, grades: [{ grade: 'AI95', seen: true }], lat: pump.lat, lon: pump.lon, name: pump.network } });
  check('Olya marked the pump', marked.status === 200);
  const olyaEarned = await litersOf(olya);

  await member.evaluate(() => pollGroupMarks());
  check('a member sees 👍 and 👎 on Olya\'s mark but no 🗑', await becomes(member, () => !!document.querySelector('#groupFeed .look-vote') && !document.querySelector('#groupFeed .look-delete')));

  await owner.evaluate(() => pollGroupMarks());
  check('the owner sees «🗑 Удалить» next to 👍 and 👎', await becomes(owner, () => document.querySelector('#groupFeed .look-vote .look-delete')?.textContent.trim() === '🗑 Удалить'));
  await owner.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  await owner.screenshot({ path: path.join(OUT, `delete-${label}-3-owner.png`) });
  asked = '';
  owner.once('dialog', (dialog) => { asked = dialog.message(); return dialog.accept(); });
  await owner.click('#groupFeed .look-vote .look-delete');
  check('the owner deletes it', await toasted(owner, 'Отметка удалена'));
  check(`the question says whose mark it is («${asked.split('\n')[0]}»)`, asked.includes('Оля: 95 есть'));
  check('it leaves the owner\'s feed', await becomes(owner, () => !document.querySelector('#groupFeed .feed-item')));
  check('the worker no longer has it, nor Olya the 🤝', (await reportsOf(olya)).length === 0 && (await litersOf(olya)) === olyaEarned - 1);
  await author.evaluate(() => pollClubNews());
  check('Olya is told «Владелец удалил вашу отметку»', await toasted(author, 'Владелец удалил вашу отметку'));

  // A mark past the hour of 👍 and 👎 is still in «Свои» for three hours.
  const old = await earlier(70 * MINUTE, () => api('/report', { method: 'POST', token: olya.token, body: { station: older.id, grades: [{ grade: 'DT', seen: false }], lat: older.lat, lon: older.lon, name: older.network } }));
  check('Olya marked another pump seventy minutes ago', old.status === 200);
  await owner.evaluate(() => pollGroupMarks());
  await owner.evaluate(() => { if (!state.ownOnly) toggleOwnOnly(); });
  check('«Свои» offers the owner «🗑 Удалить» on it', await becomes(owner, () => document.querySelector('#stationList .own-card .card-actions > .look-delete')?.textContent.trim() === '🗑 Удалить'));
  await owner.evaluate(() => document.querySelector('#stationList .own-card').scrollIntoView({ block: 'center' }));
  await owner.screenshot({ path: path.join(OUT, `delete-${label}-4-own-list.png`) });
  asked = '';
  owner.once('dialog', (dialog) => { asked = dialog.message(); return dialog.accept(); });
  await owner.click('#stationList .own-card .look-delete');
  check(`the owner deletes it from there («${asked.split('\n')[0]}»)`, await toasted(owner, 'Отметка удалена') && asked.includes('Оля: ДТ нет'));
  check('«Свои» is empty now', await becomes(owner, () => !document.querySelector('#stationList .own-card')));
  check('and so is the worker', (await api('/club/reports', { token: boss.token })).data.reports.length === 0);

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CLUB DELETE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

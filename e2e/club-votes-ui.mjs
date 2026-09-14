// 👍 and 👎 in real browser engines: a member away from the pump sees the
// buttons and is told they work only at that station; at the pump 👍 pays the
// author and 👎 asks first; the author sees the tally, is warned after three
// people and drops out after five; the owner brings them back. Android
// (Chromium) and iPhone (WebKit).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8931;
const WORKER_PORT = 8932;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const START = { latitude: 59.9343, longitude: 30.3351, accuracy: 20 };

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

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

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
  const others = [await join('Дима'), await join('Катя'), await join('Лёша'), await join('Маша')];

  const browser = await browserType.launch();
  const errors = [];
  const open = async (device, who, name, geolocation = START) => {
    const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation });
    await context.addInitScript(({ token, member }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('spbfi-club-token-v1', token);
      localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
    }, { token: who.token, member: who.member });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(siteUrl, { waitUntil: 'load' });
    return { page, context };
  };

  // Olya, somewhere in the city.
  const { page: voter, context: voterContext } = await open(phoneDevice, olya, 'voter');
  check('the member is inside', await becomes(voter, () => state.club.enabled && !!state.club.member && state.club.features?.votes === true));
  check('stations are listed', await becomes(voter, () => state.stations.length > 0, null, 30000));
  const pump = await voter.evaluate(() => {
    const station = state.stations[0];
    return { id: station.id, lat: Number(station.location.lat), lon: Number(station.location.lon), network: station.network };
  });
  const away = { latitude: pump.lat + 0.02, longitude: pump.lon, accuracy: 20 };
  await voterContext.setGeolocation(away);
  await voter.evaluate(() => refreshLocation({ manual: true }));
  check('the phone is two kilometres from the pump', await becomes(voter, (lat) => Math.abs(state.location?.lat - lat) < 0.001, away.latitude));

  // Sasha marks the pump.
  const marked = await api('/report', { method: 'POST', token: sasha.token, body: { station: pump.id, grades: [{ grade: 'AI95', seen: true }, { grade: 'AI92', seen: false }], lat: pump.lat, lon: pump.lon, name: pump.network } });
  check('Sasha marked the pump', marked.status === 200);
  const litersBefore = (await api('/club/me', { token: sasha.token })).data.profile.liters;
  await voter.evaluate(() => pollGroupMarks());
  check('the feed offers 👍 and 👎 on Sasha\'s mark', await becomes(voter, () => !!document.querySelector('#groupFeed .look-votes [data-verdict="up"]')));
  check('and says where they work', (await voter.textContent('#groupFeed .look-vote-hint')).includes('только на этой заправке'));
  check('the buttons look asleep away from the pump', await voter.evaluate(() => document.querySelector('#groupFeed .look-vote-button.up').classList.contains('away')));
  await voter.evaluate(() => document.querySelector('#groupFeed').scrollIntoView());
  await voter.screenshot({ path: path.join(OUT, `votes-${label}-1-away.png`) });

  await voter.click('#groupFeed .look-vote-button.up');
  check('a tap away from the pump explains instead of voting', await becomes(voter, () => document.querySelector('#toastStack')?.textContent.includes('только на этой заправке')));
  const reportsNow = async () => (await api('/club/reports', { token: boss.token })).data.reports.filter((report) => report.station === pump.id);
  check('nothing was counted', (await reportsNow()).every((report) => report.up === 0 && report.down === 0));
  check('the tap did not open the card', await voter.evaluate(() => !document.querySelector('#drawer.open, .drawer.open')));

  // At the pump.
  await voterContext.setGeolocation({ latitude: pump.lat + 0.0005, longitude: pump.lon, accuracy: 15 });
  await voter.evaluate(() => refreshLocation({ manual: true }));
  check('at the pump the buttons wake up', await becomes(voter, () => !!document.querySelector('#groupFeed .look-vote-hint.here') && !document.querySelector('#groupFeed .look-vote-button.up.away')));
  await voter.screenshot({ path: path.join(OUT, `votes-${label}-2-here.png`) });
  await voter.click('#groupFeed .look-vote-button.up');
  check('👍 is counted on the spot', await becomes(voter, () => document.querySelector('#groupFeed .look-vote-button.up.mine b')?.textContent === '1'));
  check('the worker has it on both grades', (await reportsNow()).every((report) => report.up === 1));
  check('Sasha is paid +3 🤝', (await api('/club/me', { token: sasha.token })).data.profile.liters === litersBefore + 3);

  let asked = '';
  voter.once('dialog', (dialog) => { asked = dialog.message(); return dialog.accept(); });
  await voter.click('#groupFeed .look-vote-button.down');
  check('👎 asks first and names the stakes', await becomes(voter, () => document.querySelector('#groupFeed .look-vote-button.down.mine b')?.textContent === '1') && asked.includes('Пять 👎'));
  check('the 👍 moved to 👎', (await voter.textContent('#groupFeed .look-vote-button.up b')) === '0');
  await voter.screenshot({ path: path.join(OUT, `votes-${label}-3-refuted.png`) });

  // Sasha sees the tally, not buttons, on his own mark.
  const { page: author } = await open(devices['Desktop Chrome'], sasha, 'author');
  await author.evaluate(() => pollGroupMarks());
  check('the author sees how the mark was judged', await becomes(author, () => document.querySelector('#groupFeed .look-vote-own')?.textContent.includes('👎 1')));
  check('and cannot vote on it', await author.evaluate(() => !document.querySelector('#groupFeed .look-vote-button')));

  // Two more people at the pump: a warning.
  const at = (await reportsNow())[0].at;
  const refute = (who) => api('/club/vote', { method: 'POST', token: who.token, body: { station: pump.id, at, author: sasha.member.id, vote: 'down', lat: pump.lat, lon: pump.lon } });
  await refute(others[0]);
  await refute(others[1]);
  await author.evaluate(() => pollClubNews());
  check('three people: Sasha is warned', await becomes(author, () => document.querySelector('#toastStack')?.textContent.includes('не согласны')));
  await author.evaluate(() => showClub());
  check('the club drawer says how many refuted', await becomes(author, () => document.querySelector('#drawerContent')?.textContent.includes('опровергли: 3 человека из 5')));
  await author.screenshot({ path: path.join(OUT, `votes-${label}-4-warned.png`) });
  await author.evaluate(() => closeDrawer());

  // Five: out of the club.
  await refute(others[2]);
  await refute(others[3]);
  await author.evaluate(() => checkClub());
  check('five people: Sasha is out, and told why', await becomes(author, () => document.querySelector('#clubGate:not([hidden]) .gate-alert')?.textContent.includes('опровергли')));
  await author.screenshot({ path: path.join(OUT, `votes-${label}-5-out.png`) });

  // The owner brings Sasha back.
  const { page: owner } = await open(devices['Desktop Chrome'], boss, 'owner');
  await owner.waitForSelector('#clubButton:not([hidden])', { timeout: 15000 });
  await owner.click('#clubButton');
  await owner.waitForSelector('#clubMembers [data-unban]', { timeout: 15000 });
  const listText = await owner.textContent('#clubMembers');
  check('the owner sees who dropped out by 👎', listText.includes('выбыл(а) по 👎') && listText.includes('опровергли: 5 человек из 5'));
  await owner.screenshot({ path: path.join(OUT, `votes-${label}-6-owner.png`) });
  await owner.click('#clubMembers [data-unban]');
  check('and brings Sasha back', await becomes(owner, () => !document.querySelector('#clubMembers [data-unban]')));
  const back = await api('/club/me', { token: sasha.token });
  check('Sasha is inside with a clean slate', back.status === 200 && back.data.refuted_by === 0);

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CLUB VOTES CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

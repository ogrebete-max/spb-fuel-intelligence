// Отметка у колонки из навигатора (28–30.09.2026).
//
// The owner, 28 Sep: «надо всё-таки заходить в карточку и выбирать там, никто
// не отмечает… Это должно делаться буквально одним движением». Two tries later:
// - one button a grade, «есть» at the first touch and «нет» at the second, sent
//   by itself three seconds later — a double touch in a car went as «95 нет»;
// - «есть» and «нет» of their own, sent at the touch — right, but one grade at a
//   time: «своим приходят с одной колонки по 4 отметки».
// Now every grade has its «есть» and «нет»; a touch chooses, the same button
// again changes nothing, the other one changes the choice, and «Отправить: 92
// нет, 95 нет» under the buttons sends it all as one look — one mark, one
// notice. Nothing leaves by itself. «Сбросить» lets the choice go, «Отменить»
// takes a sent look back. Standing by a station every grade is there at once; on
// the move the driver's sheet stays locked until «я пассажир», a passenger's
// line with «Отменить» stays while the car moves, and the station just gone
// past stays on the sheet for a moment. WebKit (iPhone) and Chromium (Android).
//   node e2e/drive-one-touch-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9131;
const WORKER_PORT = 9132;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const STEP_METRES = 16;

// ---- two stations alone on their stretch of road, from the built data
const RAD = Math.PI / 180;
const METRES_PER_DEGREE = 111320;
const LAT0 = 59.94;
const load = (grade) => JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', `stations-${grade}.json`), 'utf8'));
const planar = load('AI95').stations.filter((item) => item.location).map((station) => ({
  station,
  x: (station.location.lon - 30.31) * METRES_PER_DEGREE * Math.cos(LAT0 * RAD),
  y: (station.location.lat - LAT0) * METRES_PER_DEGREE,
}));
// A straight road heading `degrees`, passing `lateral` metres to the left of a
// station: t is metres along it from abreast of the station.
function road(from, degrees, lateral = 40) {
  const u = { x: Math.sin(degrees * RAD), y: Math.cos(degrees * RAD) };
  const right = { x: Math.cos(degrees * RAD), y: -Math.sin(degrees * RAD) };
  const abreast = { x: from.x - lateral * right.x, y: from.y - lateral * right.y };
  const along = (point) => {
    const dx = point.x - abreast.x;
    const dy = point.y - abreast.y;
    return { t: dx * u.x + dy * u.y, c: dx * right.x + dy * right.y };
  };
  const at = (t) => ({
    lat: LAT0 + (abreast.y + t * u.y) / METRES_PER_DEGREE,
    lon: 30.31 + (abreast.x + t * u.x) / (METRES_PER_DEGREE * Math.cos(LAT0 * RAD)),
  });
  return { degrees, along, at };
}
// Nobody else within `clear` metres of the stretch driven, from `from` to `to`.
function pick(skip, from, to, clear) {
  for (const item of planar) {
    if (skip.includes(item.station.id)) continue;
    for (let degrees = 0; degrees < 360; degrees += 30) {
      const way = road(item, degrees);
      const crowded = planar.some((other) => {
        if (other === item) return false;
        const q = way.along(other);
        return Math.hypot(Math.max(0, from - q.t, q.t - to), q.c) < clear;
      });
      if (!crowded) return { station: item.station, way };
    }
  }
  return null;
}
const PASSED = pick([], -700, 420, 450);
const STOOD = PASSED && pick([PASSED.station.id], -200, 60, 300);
if (!PASSED || !STOOD) {
  console.log('FAIL no station in site/static-data stands alone enough for this test');
  process.exit(1);
}
console.log(`passed: ${PASSED.station.network}, heading ${PASSED.way.degrees}°`);
console.log(`stood by: ${STOOD.station.network}`);

// Old answers aged as a phone would: every station «нет» for 95, so nothing
// the sheet says depends on the day the site was built.
const served = () => {
  const bundle = load('AI95');
  for (const item of bundle.stations) {
    item.grade.status = 'CONFIRMED_NO';
    item.grade.ttl_seconds = null;
    item.grade.age_seconds = 720;
    delete item.grade.advice;
    delete item.grade.eyewitness;
  }
  return JSON.stringify(bundle);
};
const SERVED = { '/static-data/stations-AI95.json': served() };

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
  if (SERVED[url.pathname]) {
    res.writeHead(200, { 'Content-Type': types['.json'] });
    res.end(SERVED[url.pathname]);
    return;
  }
  if (url.pathname === '/static-data/meta.json') {
    const meta = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'meta.json'), 'utf8'));
    meta.snapshot_at = new Date().toISOString();
    res.writeHead(200, { 'Content-Type': types['.json'] });
    res.end(JSON.stringify(meta));
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

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const eventually = async (predicate, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};
// A tap on a button that may be redrawn under the finger: WebKit under
// Playwright now and then waits for such a button to be «stable» until the
// timeout; one on top under its own centre is clicked directly.
const tap = async (page, selector) => {
  try {
    await page.click(selector, { timeout: 5000 });
    return true;
  } catch (error) {
    const onTop = await page.evaluate((s) => {
      const element = document.querySelector(s);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && element.contains(hit);
    }, selector).catch(() => false);
    if (onTop) {
      await page.dispatchEvent(selector, 'click');
      return true;
    }
    console.log(`     (tap ${selector}: ${String(error.message).split('\n')[0]})`);
    return false;
  }
};
const say = (grade, seen) => `#driveSheet [data-drive="say"][data-grade="${grade}"][data-seen="${seen ? 1 : 0}"]`;
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', selector);
const pressed = (page) => page.evaluate(() => [...document.querySelectorAll('#driveSheet [data-drive="say"][aria-pressed="true"]')]
  .map((button) => `${button.dataset.grade} ${button.dataset.seen === '1' ? 'есть' : 'нет'}`).sort().join(', '));
// The sheet and everything on it lies inside the screen.
const framed = (page) => page.evaluate(() => {
  const sheet = document.querySelector('#driveSheet');
  if (!sheet || sheet.hidden) return false;
  const box = sheet.getBoundingClientRect();
  return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
});

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` };
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const code = (await api('/club/invite', { method: 'POST', token: boss.token })).data.code;
  const sasha = (await api('/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;
  const reports = async (stationId) => (await api('/club/reports', { token: boss.token })).data.reports
    .filter((item) => item.station === stationId && item.who === sasha.member.id);

  const standAt = STOOD.way.at(-20);
  const start = STOOD.way.at(-130);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 10 } });
  await context.addInitScript(({ token, member }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('spbfi-club-token-v1', token);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
  }, { token: sasha.token, member: sasha.member });
  const page = await context.newPage();
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const step = async (point, ms = 1000) => {
    await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 10 });
    await page.waitForTimeout(ms);
  };
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  check('the member is in and the list is around the phone', await becomes(page, () => state.club.enabled && !!state.club.member && state.stations.length > 0, null, 30000));
  await tap(page, '#modeBar [data-screen="drive"]');
  check('the navigator opens', await becomes(page, () => drive.open && !document.querySelector('#drive').hidden, null, 8000));

  // 1. Standing by a station: every grade has its «есть» and «нет» at once. The
  // car pulls up the way cars do, and a phone standing still goes on handing
  // out fixes a metre this way or that; the app knows a car stands only from them.
  for (let t = -120; t <= -20; t += 10) await step(STOOD.way.at(t));
  for (let i = 0; i < 5; i += 1) await step({ lat: standAt.lat + (i % 2 ? 6e-6 : -6e-6), lon: standAt.lon });
  check('standing by the station, the sheet is on it', await becomes(page, (id) => document.querySelector('#drive').dataset.kind === 'near'
    && stepDrive().focus?.station.id === id && document.querySelector('#driveSheet').textContent.includes('Вы у АЗС'), STOOD.station.id, 10000));
  check('every grade has its own «есть» and «нет», my grade first, not after twenty seconds', await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#driveSheet [data-drive="say"]')];
    const first = document.querySelector('#driveSheet .drive-mark');
    return buttons.length === 10 && first?.classList.contains('mine') && first.querySelectorAll('[data-grade="AI95"]').length === 2
      && buttons.every((button) => ['есть', 'нет'].includes(button.textContent.trim())) && drive.kind !== 'at';
  }));
  check('the sheet lies on screen', await framed(page));
  await page.screenshot({ path: path.join(OUT, `one-touch-${label}-1-pairs.png`) });

  const send = '#driveSheet [data-drive="say-send"]';
  const sendText = () => text(page, send);

  // 2. A touch chooses, and nothing leaves by itself.
  check('nothing chosen, no «Отправить»', !(await page.$(send)));
  await tap(page, say('AI95', false));
  check('«95 нет» chosen: pressed, and «Отправить: 95 нет» under the buttons', await becomes(page, () => document.querySelector('#driveSheet [data-grade="AI95"][data-seen="0"]')?.getAttribute('aria-pressed') === 'true'
    && document.querySelector('#driveSheet [data-drive="say-send"]')?.textContent.trim() === 'Отправить: 95 нет', null, 5000));
  await page.waitForTimeout(3500);
  check('three and a half seconds later nothing has gone', (await reports(STOOD.station.id)).length === 0);

  // 3. The same button twice more, as a finger in a car does: still «95 нет».
  await tap(page, say('AI95', false));
  await tap(page, say('AI95', false));
  check(`a double touch changes nothing (${await pressed(page)})`, await page.evaluate(() => document.querySelector('#driveSheet [data-grade="AI95"][data-seen="0"]')?.getAttribute('aria-pressed') === 'true'));

  // 4. The other button changes the choice; more grades join the same look.
  await tap(page, say('AI95', true));
  await tap(page, say('AI92', false));
  await tap(page, say('AI98', false));
  check(`«${await sendText()}»`, (await sendText()) === 'Отправить: 92 нет, 95 есть, 98 нет' && (await pressed(page)) === 'AI92 нет, AI95 есть, AI98 нет');
  check('the sheet lies on screen with the choice and «Отправить»', await framed(page));
  await page.screenshot({ path: path.join(OUT, `one-touch-${label}-2-chosen.png`) });

  // 5. «Сбросить» lets the choice go; chosen again, «Отправить» sends one look.
  await tap(page, '#driveSheet [data-drive="say-clear"]');
  check('«Сбросить»: nothing pressed, no «Отправить»', await becomes(page, () => !document.querySelector('#driveSheet [data-drive="say-send"]')
    && !document.querySelector('#driveSheet [data-drive="say"][aria-pressed="true"]'), null, 5000));
  await tap(page, say('AI92', false));
  await tap(page, say('AI95', false));
  await tap(page, send);
  check('«Отправить» sends «92 нет» and «95 нет» as one look', await eventually(async () => {
    const got = await reports(STOOD.station.id);
    const at = new Set(got.map((item) => item.at));
    return got.length === 2 && at.size === 1 && got.every((item) => item.seen === false) && got.some((item) => item.grade === 'AI92') && got.some((item) => item.grade === 'AI95');
  }, 5000));
  const line = await text(page, '#driveSheet .drive-said');
  check(`under the buttons: «${line}», and the choice is gone`, line.includes('Ушло своим: 92 нет, 95 нет') && line.includes('Отменить')
    && !(await page.$(send)) && !(await page.$('#driveSheet [data-drive="say"][aria-pressed="true"]')));
  await page.screenshot({ path: path.join(OUT, `one-touch-${label}-3-sent.png`) });

  // 6. «Отменить» takes the look back.
  await tap(page, '#driveSheet [data-drive="said-undo"]');
  check('«Отменить» takes the look back at the club', await eventually(async () => (await reports(STOOD.station.id)).length === 0, 8000));
  check('and the line goes', await becomes(page, () => !document.querySelector('#driveSheet .drive-said'), null, 5000));

  // 7. On the move the driver's sheet is locked; «я пассажир» lifts it.
  const way = PASSED.way;
  let t = -700;
  await step(way.at(t), 300);
  while (t < -330) await step(way.at((t += STEP_METRES)));
  check('moving towards the next station, the sheet is on it', await becomes(page, (id) => document.querySelector('#drive').dataset.kind === 'near'
    && stepDrive().focus?.station.id === id, PASSED.station.id, 8000));
  check('moving, the driver\'s sheet is locked: no grade buttons', (await text(page, '#driveSheet')).includes('🔒 Отметить — на остановке')
    && await page.evaluate(() => !document.querySelector('#driveSheet [data-drive="say"]')));
  await tap(page, '#driveSheet [data-drive="passenger"]');
  await step(way.at((t += STEP_METRES)));
  check('«я пассажир»: every grade\'s «есть» and «нет», on the move', await page.evaluate(() => drive.passenger && document.querySelectorAll('#driveSheet [data-drive="say"]').length === 10 && movingNow()));
  await tap(page, say('AI95', true));
  check('a passenger\'s choice waits for «Отправить», on the move too', (await text(page, '#driveSheet [data-drive="say-send"]')) === 'Отправить: 95 есть'
    && (await reports(PASSED.station.id)).length === 0);
  await tap(page, '#driveSheet [data-drive="say-send"]');
  check('«Отправить» sends it on the move', await eventually(async () => (await reports(PASSED.station.id)).some((item) => item.grade === 'AI95' && item.seen === true), 5000));
  await step(way.at((t += STEP_METRES)));
  check('and its line with «Отменить» stays while the car moves', await page.evaluate(() => document.querySelector('#driveSheet .drive-said')?.textContent.includes('Ушло своим: 95 есть')
    && !!document.querySelector('#driveSheet [data-drive="said-undo"]') && movingNow()));

  // 8. Gone past: the station stays a passenger's sheet for a moment.
  while (t < 180) await step(way.at((t += STEP_METRES)));
  const behind = await text(page, '#driveSheet');
  check(`gone past, the sheet stays on it: «${behind.slice(0, 40)}…»`, behind.startsWith('Проехали') && await page.evaluate((id) => stepDrive().focus?.station.id === id
    && document.querySelectorAll('#driveSheet [data-drive="say"]').length === 10, PASSED.station.id));
  await page.screenshot({ path: path.join(OUT, `one-touch-${label}-3-behind.png`) });
  // Past DRIVE_PASSED_KEEP_MS the sheet goes on up the road.
  for (let i = 0; i < 24 && t < 420; i += 1) await step(way.at((t += STEP_METRES)));
  check('a little later it lets the station go', await page.evaluate((id) => stepDrive().focus?.station.id !== id, PASSED.station.id));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

const only = process.env.DRIVE_ONLY;
try {
  if (!only || only === 'iphone') await run('iphone', webkit, devices['iPhone 13']);
  if (!only || only === 'android') await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL ONE-TOUCH CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

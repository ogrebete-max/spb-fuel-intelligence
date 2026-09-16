// «За рулём» in WebKit (iPhone) and Chromium (Android), with the phone moved
// fix by fix along roads laid past real stations from the built data. A member
// of the club drives: after half a minute above walking pace the app offers
// the drive screen; a kilometre out the sheet is one line, 350 m out it shows
// every grade and no buttons while moving; standing at the pumps for twenty
// seconds brings «Вы на АЗС» with huge buttons, «Не та?» switches between
// neighbours, a mark goes to the club and «Отменить» takes it back; someone
// else's mark there gets 👍. On another road a station passed at speed is asked
// about at the next stop and the question goes when the car moves. With 98 on
// no station ahead the sheet points to the nearest that has it. The theme
// follows a mocked clock and the manual switch; leaving puts the app back.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9011;
const WORKER_PORT = 9012;
const OWNER_KEY = 'owner-key-used-only-in-this-test';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const STEP_METRES = 16;
const STEP_MS = 1000;

// ---- roads past real stations, from the data the site was built with
const RAD = Math.PI / 180;
const METRES_PER_DEGREE = 111320;
const load = (grade) => JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', `stations-${grade}.json`), 'utf8'));
const STATIONS = load('AI95').stations.filter((item) => item.location);
const WITH_98 = new Set(load('AI98').stations.filter((item) => item.location).map((item) => item.id));
const LAT0 = 59.94;
const planar = STATIONS.map((station) => ({
  station,
  x: (station.location.lon - 30.31) * METRES_PER_DEGREE * Math.cos(LAT0 * RAD),
  y: (station.location.lat - LAT0) * METRES_PER_DEGREE,
}));

// A straight road heading `degrees` that passes `lateral` metres to the left of
// the station: t is metres along it from abreast of the station, c is metres
// to its right.
function road(from, degrees, lateral) {
  const u = { x: Math.sin(degrees * RAD), y: Math.cos(degrees * RAD) };
  const right = { x: Math.cos(degrees * RAD), y: -Math.sin(degrees * RAD) };
  const abreast = { x: from.x - lateral * right.x, y: from.y - lateral * right.y };
  const along = (point) => {
    const dx = point.x - abreast.x;
    const dy = point.y - abreast.y;
    return { t: dx * u.x + dy * u.y, c: dx * right.x + dy * right.y, d: Math.hypot(dx, dy) };
  };
  const planarAt = (t) => ({ x: abreast.x + t * u.x, y: abreast.y + t * u.y });
  // Everything as seen from a point of the road: how far, and how far off the heading.
  const seen = (t) => {
    const here = planarAt(t);
    return planar.map((item) => {
      const dx = item.x - here.x;
      const dy = item.y - here.y;
      const dist = Math.hypot(dx, dy);
      return { item, dist, cos: dist ? (dx * u.x + dy * u.y) / dist : 1 };
    });
  };
  const nearestAhead = (t) => seen(t).filter((o) => o.cos >= 0.5 && o.dist <= 5000).sort((a, b) => a.dist - b.dist)[0]?.item;
  const at = (t) => {
    const point = planarAt(t);
    return { lat: LAT0 + point.y / METRES_PER_DEGREE, lon: 30.31 + point.x / (METRES_PER_DEGREE * Math.cos(LAT0 * RAD)) };
  };
  return { degrees, along, seen, nearestAhead, at };
}

// Driving up to a station: nobody else within 170 m of the road for the last
// two kilometres, the station always the nearest one ahead, alone within 100 m
// of where the car stops, and if possible one neighbour within 250 m.
function pickApproach() {
  const found = [];
  for (const item of planar) {
    const around = planar.filter((other) => Math.hypot(other.x - item.x, other.y - item.y) <= 5000).length;
    if (around < 8 || around > 400) continue;
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const way = road(item, degrees, 40);
      const blocked = planar.some((other) => {
        if (other === item) return false;
        const q = way.along(other);
        return (q.t >= -1950 && q.t <= 60 && Math.abs(q.c) < 170) || q.d < 100;
      });
      if (blocked || ![-1900, -1600, -1300, -1100, -1000, -460, -364, -110, -50].every((t) => way.nearestAhead(t) === item)) continue;
      const neighbours = planar.filter((other) => other !== item && way.along(other).d <= 250);
      found.push({ station: item.station, way, neighbour: neighbours.length === 1 ? neighbours[0].station : null });
      if (neighbours.length === 1) return found.pop();
    }
  }
  return found[0] || null;
}

// Driving past a station without stopping: nobody else near the road from
// just before it to the stops 220 and 268 m on, nothing within 120 m of the
// stops nor ahead within 420 m, and a station selling 98 off to the side.
function pickPass(avoid) {
  for (const item of planar) {
    if (item.station.id === avoid) continue;
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const way = road(item, degrees, 40);
      if (planar.some((other) => other !== item && (() => { const q = way.along(other); return q.t >= -60 && q.t <= 320 && Math.abs(q.c) < 160; })())) continue;
      if ([220, 268].some((t) => way.seen(t).some((o) => o.dist < 120 || (o.cos >= 0.5 && o.dist <= 420)))) continue;
      const side = way.seen(268)
        .filter((o) => o.item !== item && o.dist >= 900 && o.dist <= 4000 && Math.abs(o.cos) <= 0.42 && WITH_98.has(o.item.station.id))
        .sort((a, b) => a.dist - b.dist)[0];
      if (side) return { station: item.station, way, with98: side.item.station };
    }
  }
  return null;
}

const APPROACH = pickApproach();
const PASS = APPROACH && pickPass(APPROACH.station.id);
if (!APPROACH || !PASS) {
  console.log('FAIL no road in site/static-data fits this test: build the site from the full data/stations.json');
  process.exit(1);
}
console.log(`approach: ${APPROACH.station.network}, ${APPROACH.station.address}, heading ${APPROACH.way.degrees}°${APPROACH.neighbour ? `, neighbour ${APPROACH.neighbour.network}` : ''}`);
console.log(`pass: ${PASS.station.network}, ${PASS.station.address}, heading ${PASS.way.degrees}°; 98 at ${PASS.with98.network}`);

// The snapshot in the build is old and the page ages it as a phone would, so
// the answers are set here: 95 only at the station driven up to, 98 only at
// the one station aside from the other road, and «нет» everywhere else.
const served = (grade, statusOf) => {
  const bundle = load(grade);
  for (const item of bundle.stations) {
    item.grade.status = statusOf(item);
    item.grade.ttl_seconds = null;
    item.grade.age_seconds = 720;
    delete item.grade.advice;
    delete item.grade.eyewitness;
  }
  return JSON.stringify(bundle);
};
const SERVED = {
  '/static-data/stations-AI95.json': served('AI95', (item) => (item.id === APPROACH.station.id ? 'CAN_REFUEL' : 'CONFIRMED_NO')),
  '/static-data/stations-AI98.json': served('AI98', (item) => (item.id === PASS.with98.id ? 'CAN_REFUEL' : 'CONFIRMED_NO')),
};

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
    // A snapshot published a moment ago, so ages read as minutes, not days.
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
// A tap that may find nothing to tap: the check after it says what went wrong,
// and what the browser said is printed beside it.
const tap = async (page, selector) => {
  try {
    await page.click(selector, { timeout: 5000 });
    return true;
  } catch (error) {
    const seen = await page.evaluate((s) => {
      const element = document.querySelector(s);
      if (!element) return { found: false };
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        found: true,
        onTop: !!hit && element.contains(hit) && getComputedStyle(element).pointerEvents !== 'none' && !element.disabled,
        kind: document.querySelector('#drive')?.dataset.kind,
        hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : null,
      };
    }, selector).catch(() => ({ found: false }));
    // WebKit under Playwright has now and then waited for a still, uncovered
    // button on this screen to become «stable» until the timeout, while
    // Chromium taps the same button at once. Only such a button, the element
    // under its own centre and taking pointer events, is clicked directly; a
    // covered, disabled or missing one still fails the check that follows.
    if (seen.onTop && page.context().browser()?.browserType().name() === 'webkit') {
      await page.dispatchEvent(selector, 'click');
      console.log(`     (tap ${selector}: WebKit did not call it stable; it is on top and was clicked directly)`);
      return true;
    }
    const log = String(error.message).split('\n').map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
    console.log(`     (tap ${selector}: ${[...new Set(log.slice(1))].slice(0, 4).join(' / ')} — ${JSON.stringify(seen)})`);
    return false;
  }
};
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', selector);
const kind = (page) => page.evaluate(() => (drive.open ? document.querySelector('#drive').dataset.kind : 'closed'));
// The angle a CSS transform turns an element by, in degrees.
const turnOf = (page, selector) => page.evaluate((s) => {
  const element = document.querySelector(s);
  if (!element) return null;
  const matrix = getComputedStyle(element).transform;
  if (!matrix || matrix === 'none') return 0;
  const [a, b] = matrix.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
  return Math.atan2(b, a) * 180 / Math.PI;
}, selector);
const sameAngle = (a, b, within = 6) => a != null && Math.abs(((a - b) % 360 + 540) % 360 - 180) <= within;
// The drive screen keeps still on the glass: the top bar, the speed and the
// panel on show lie inside the viewport, and neither layer has been scrolled.
// Measured once a panel that has just slid in has arrived: on its way it is
// meant to start a little below the screen.
const settle = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((animation) => animation.animationName === 'drive-rise')
  .map((animation) => animation.finished.catch(() => {}))));
const framed = async (page) => {
  await settle(page);
  return page.evaluate(() => {
    const inside = (element) => {
      if (!element || element.hidden) return true;
      const box = element.getBoundingClientRect();
      return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    };
    const root = document.querySelector('#drive');
    const stage = document.querySelector('#driveStage');
    const panel = ['#drivePick', '#driveFull', '#driveSheet'].map((s) => document.querySelector(s)).find((element) => !element.hidden);
    return inside(document.querySelector('.drive-top')) && inside(document.querySelector('.drive-speed')) && inside(panel)
      && !root.scrollTop && !root.scrollLeft && !stage.scrollTop && !stage.scrollLeft;
  });
};
// The pin of the station the sheet is about stands on the free part of the map.
const focusShown = (page) => page.evaluate(() => {
  const pin = document.querySelector('.dpin.big.focus .dpin-body');
  const sheet = document.querySelector('#driveSheet');
  if (!pin || sheet.hidden) return false;
  const box = pin.getBoundingClientRect();
  return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= sheet.getBoundingClientRect().top;
});
const labels = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((element) => element.textContent.trim()).join(' '), selector);
// A panel that has just slid in is photographed once it has arrived.
const shot = async (page, options) => {
  await settle(page);
  return page.screenshot(options);
};
// Moscow's calendar day after today, at a given time of day there.
const tomorrowAt = (clock) => {
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(new Date(`${today}T${clock}:00+03:00`).getTime() + 86400000);
};

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed', ORIGIN: `http://localhost:${SITE_PORT}` };
  const boss = (await api('/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const join = async (name) => {
    const code = (await api('/club/invite', { method: 'POST', token: boss.token })).data.code;
    return (await api('/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
  };
  const sasha = await join('Саша');
  const lena = await join('Лена');
  const { station, way, neighbour } = APPROACH;
  const start = way.at(-1900);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 10 } });
  await context.addInitScript(({ token, member }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('spbfi-club-token-v1', token);
    localStorage.setItem('spbfi-club-member-v1', JSON.stringify(member));
  }, { token: sasha.token, member: sasha.member });
  const page = await context.newPage();
  // Time flows as usual; the theme checks at the end move the clock.
  await page.clock.install();
  // Panels slide in only for people who have not asked for less motion. A tap
  // by the test during a slide lands where the button was a moment ago, so the
  // run asks for less motion, as a phone set that way does.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const step = async (point) => {
    await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 10 });
    await page.waitForTimeout(STEP_MS);
  };
  const driveAlong = async (route, from, to) => {
    for (let t = from; from < to ? t <= to : t >= to; t += from < to ? STEP_METRES : -STEP_METRES) await step(route.at(t));
  };
  const reports = async () => (await api('/club/reports', { token: boss.token })).data.reports;
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  check('the member follows the phone with the list around it', await becomes(page, () => state.club.enabled && !!state.club.member && state.club.features?.delete_marks === true && state.searchScope === 'device' && state.stations.length > 0, null, 30000));
  await page.evaluate(() => {
    window.driveEvents = [];
    const original = SPBFIAnalytics.track;
    SPBFIAnalytics.track = (event, fields) => {
      if (event.startsWith('drive_')) window.driveEvents.push({ event, ...fields });
      return original(event, fields);
    };
  });
  const names = await page.evaluate(([here, next]) => ({ short: shortNetwork(here), display: displayNetwork(here), next: next ? shortNetwork(next) : null, nextDisplay: next ? displayNetwork(next) : null }), [station.network, neighbour?.network || null]);

  // 1. Half a minute at 58 km/h with the app on screen: the offer.
  let t = -1900;
  for (let i = 0; i < 20; i += 1) await step(way.at((t += STEP_METRES)));
  check('no offer after 20 seconds of driving', await page.evaluate(() => document.querySelector('#driveOffer').hidden && !drive.open));
  let offered = 0;
  for (let i = 0; i < 24 && !offered; i += 1) {
    await step(way.at((t += STEP_METRES)));
    if (await page.evaluate(() => !document.querySelector('#driveOffer').hidden)) offered = 21 + i;
  }
  check(`after about half a minute above 15 km/h the app offers the drive screen (${offered} s)`, offered >= 30 && offered <= 40);
  check('in words from the concept', (await text(page, '#driveOffer')).includes('Похоже, вы за рулём. Включить крупный режим?'));
  const speed = await page.evaluate(() => currentSpeed());
  check(`the speed is worked out from the fixes (${Math.round(speed)} km/h)`, speed > 50 && speed < 65);
  await shot(page, { path: path.join(OUT, `drive-${label}-1-offer.png`) });

  // 2. «Включить»: the drive screen over the app, which stays as it was.
  check('«Включить» opens the drive screen', await tap(page, '#driveOfferYes') && await becomes(page, () => drive.open && !document.querySelector('#drive').hidden && document.body.classList.contains('driving'), null, 5000));
  check('the offer is gone and the list is still there underneath', await page.evaluate(() => document.querySelector('#driveOffer').hidden && document.querySelectorAll('#stationList .station-card').length > 0));
  check('no «Я пассажир» anywhere', !(await page.content()).includes('Я пассажир'));

  // 3. About a kilometre out: one line about the station, the map heading up.
  while (t < -1100) await step(way.at((t += STEP_METRES)));
  check('a kilometre out the sheet is one line', await becomes(page, () => document.querySelector('#drive').dataset.kind === 'line', null, 5000));
  const line = await text(page, '#driveSheet');
  check(`«${line}»`, /Через 1(,\d)? км справа/.test(line) && line.includes(`${names.short} · 95 есть`));
  check('no buttons in it', !(await page.$('#driveSheet button')));
  check('the top bar and the sheet are on screen, and so is the station\'s pin', await framed(page) && await focusShown(page));
  const pins = await page.evaluate((id) => ({ big: document.querySelectorAll('.dpin.big').length, focus: document.querySelector('.dpin.big.focus')?.dataset.station === id, number: document.querySelector('.dpin.big b')?.textContent }), station.id);
  check(`at most three big pins with the grade's number, the station's glowing (${pins.big}, «${pins.number}»)`, pins.big >= 1 && pins.big <= 3 && pins.focus && pins.number === '95');
  const struck = await page.evaluate((id) => [...document.querySelectorAll('.dpin.big')].map((pin) => ({
    here: pin.dataset.station === id, no: pin.classList.contains('no'), line: getComputedStyle(pin.querySelector('b')).textDecorationLine.includes('line-through'),
  })), station.id);
  // The neighbour beside the station is ahead too, and has no 95.
  check(`«нет» pins are struck through, the station's is not (${struck.filter((pin) => pin.line).length} struck of ${struck.length})`,
    struck.every((pin) => pin.no === pin.line && pin.here !== pin.no) && (!neighbour || struck.some((pin) => pin.line)));
  const mapTurn = await turnOf(page, '#driveMap');
  const pinTurn = await turnOf(page, '.dpin.big .dpin-turn');
  check(`the map turns heading up (${Math.round(mapTurn)}°) and the pins turn back (${Math.round(pinTurn)}°) for heading ${way.degrees}°`, sameAngle(mapTurn, -way.degrees) && sameAngle(pinTurn, way.degrees));
  await shot(page, { path: path.join(OUT, `drive-${label}-2-line.png`) });

  // 4. 350 m out, still moving: every grade, the queue, a lock instead of buttons.
  t = -460;
  await step(way.at(t));
  while (t < -364) await step(way.at((t += STEP_METRES)));
  check('350 m out the sheet shows the station', await becomes(page, () => document.querySelector('#drive').dataset.kind === 'near', null, 5000));
  const near = await text(page, '#driveSheet');
  check(`«${near.slice(0, 90)}…»`, /Через \d+ м справа/.test(near) && near.includes(names.display));
  check('with a chip for every grade, 95 ringed', await page.evaluate(() => document.querySelectorAll('#driveSheet .drive-chip').length === 5 && document.querySelector('#driveSheet .drive-chip.mine')?.textContent.trim() === '95 ✓'));
  check('moving: «🔒 Отметить — на остановке» and no mark buttons', near.includes('🔒 Отметить — на остановке') && !(await page.$('#drive [data-drive="mark"]')));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const motion = await page.evaluate(() => getComputedStyle(document.querySelector('.dpin.big.focus .dpin-body')).animationName);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await page.evaluate(() => getComputedStyle(document.querySelector('.dpin.big.focus .dpin-body')).animationName);
  check(`the target glows (${motion}) and holds still when motion is reduced (${still})`, motion === 'drive-glow' && still === 'none');
  for (const mode of ['day', 'night']) {
    const opened = await tap(page, '#drive [data-drive="theme"]') && await becomes(page, () => drive.pick === 'theme' && !document.querySelector('#drivePick').hidden, null, 3000);
    const chosen = await tap(page, `#drivePick [data-drive="theme-mode"][data-mode="${mode}"]`) && await becomes(page, (m) => drive.theme === m, mode, 3000);
    const closed = await tap(page, '#drivePick [data-drive="pick-close"]') && await becomes(page, () => drive.pick === null && document.querySelector('#drivePick').hidden, null, 3000);
    const day = await page.evaluate(() => document.querySelector('#drive').classList.contains('is-day'));
    check(`«${mode === 'day' ? '☀️ День' : '🌙 Ночь'}» in the theme sheet sets the ${mode} theme (opened ${opened}, chosen ${chosen}, closed ${closed})`, opened && chosen && closed && day === (mode === 'day'));
    // The taps took a few seconds of standing; a few fixes more and the car is moving again.
    if (!closed) await page.evaluate(() => { drive.pick = null; renderDrive({ force: true }); });
    for (let i = 0; i < 5; i += 1) await step(way.at((t += STEP_METRES)));
    check(`${mode}: still moving, the lock, the top bar, the sheet and the station's pin all on screen`, (await text(page, '#driveSheet')).includes('🔒') && await framed(page) && await focusShown(page));
    await shot(page, { path: path.join(OUT, `drive-${label}-3-near-${mode}.png`) });
  }
  check('the choice is kept', await page.evaluate(() => localStorage.getItem('spbfi-drive-theme-v1') === 'night'));

  // 5. Up to the pumps and standing: «Вы на АЗС» only after twenty seconds.
  t = -110;
  await step(way.at(t));
  while (t < 0) await step(way.at((t = Math.min(0, t + STEP_METRES))));
  for (let i = 0; i < 12; i += 1) await step(way.at(0));
  check('twelve seconds at the pumps: not yet «Вы на АЗС»', (await kind(page)) !== 'at');
  // Yet the station is on the sheet, not the next one up the road, and can be marked.
  const beside = await text(page, '#driveSheet');
  check(`standing there, the sheet stays on the station with the buttons: «${beside.slice(0, 60)}…»`,
    (await kind(page)) === 'near' && beside.startsWith('Вы у АЗС') && beside.includes(names.display) && !!(await page.$('#driveSheet [data-drive="mark"]')));
  check('a card one feed lists with nothing fresh is no place to lead to', await page.evaluate(() => driveThin({ sources: ['gdebenzin24'], grade: { status: 'NO_FRESH_DATA' } })
    && !driveThin({ sources: ['gdebenzin24', 'sber'], grade: { status: 'NO_FRESH_DATA' } }) && !driveThin({ sources: ['gdebenzin'], grade: { status: 'LIKELY_AVAILABLE' } })));
  let standing = 12;
  while (standing < 40 && (await kind(page)) !== 'at') {
    await step(way.at(0));
    standing += 1;
  }
  check(`standing about twenty seconds brings «Вы на АЗС» (${standing} s)`, (await kind(page)) === 'at' && standing >= 18);
  const at = await text(page, '#driveFull');
  check(`«${at.slice(0, 80)}…»`, at.startsWith('Вы на АЗС') && at.includes(names.display));
  const sizes = await page.evaluate(() => [...document.querySelectorAll('#driveFull [data-drive="pick"].huge')].map((button) => [button.textContent.trim(), Math.round(button.getBoundingClientRect().height)]));
  check(`two huge buttons for my grade ${JSON.stringify(sizes)}`, sizes.length === 2 && sizes[0][0] === '95 есть' && sizes[1][0] === '95 нет' && sizes.every(([, height]) => height >= 64));
  check('the other grades below, each with «есть» and «нет»', (await labels(page, '#driveFull .drive-other > span')) === '92 98 100 ДТ'
    && await page.evaluate(() => document.querySelectorAll('#driveFull .drive-other [data-drive="pick"]').length === 8));
  check('and «Отправить» waits until something is pressed', await page.evaluate(() => document.querySelector('#driveFull [data-drive="send-look"]')?.disabled === true));
  check('and the queue: нет, мало, много', (await labels(page, '#driveFull .drive-seg button')) === 'нет мало много');
  check('«Вы на АЗС» lies on screen', await framed(page));
  check('the map keeps its turn while standing', sameAngle(await turnOf(page, '#driveMap'), -way.degrees));
  if (neighbour) {
    check(`«Не та? Рядом ${names.next}…»`, (await text(page, '#driveFull .drive-not')).startsWith(`Не та? Рядом ${names.next},`));
    await tap(page, '#driveFull .drive-not');
    check('switches to the neighbour', await becomes(page, (words) => document.querySelector('#driveFull .drive-title')?.textContent.includes(words), names.nextDisplay, 3000));
    check('which offers the first station back', (await text(page, '#driveFull .drive-not')).startsWith(`Не та? Рядом ${names.short},`));
    await tap(page, '#driveFull .drive-not');
    check('and back again', await becomes(page, (words) => document.querySelector('#driveFull .drive-title')?.textContent.includes(words), names.display, 3000));
  }
  await shot(page, { path: path.join(OUT, `drive-${label}-4-at.png`) });

  // 6. «мало», «95 есть» and «92 нет»: sent as one look, and «Отменить» takes it back.
  await tap(page, '#driveFull [data-drive="queue"][data-cars="3"]');
  check('«мало» is pressed', await page.evaluate(() => document.querySelector('#driveFull [data-cars="3"]')?.getAttribute('aria-pressed') === 'true'));
  await tap(page, '#driveFull [data-drive="pick"][data-grade="AI95"][data-seen="1"]');
  check('«95 есть» is pressed, not sent', await becomes(page, () => document.querySelector('#driveFull [data-grade="AI95"][data-seen="1"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('#driveFull')?.textContent.includes('Отправлено своим'), null, 3000));
  await tap(page, '#driveFull [data-drive="pick"][data-grade="AI92"][data-seen="0"]');
  await tap(page, '#driveFull [data-drive="pick"][data-grade="AI98"][data-seen="1"]');
  await tap(page, '#driveFull [data-drive="pick"][data-grade="AI98"][data-seen="1"]');
  check('«Отправить: 92 нет, 95 есть» — 98 pressed twice is taken back out', await becomes(page, () => document.querySelector('#driveFull [data-drive="send-look"]')?.textContent.trim() === 'Отправить: 92 нет, 95 есть', null, 3000));
  await shot(page, { path: path.join(OUT, `drive-${label}-4b-picked.png`) });
  check('the picked panel lies on screen', await framed(page));
  await tap(page, '#driveFull [data-drive="send-look"]');
  check('«Отправлено своим» with «Отменить»', await becomes(page, () => document.querySelector('#driveFull')?.textContent.includes('Отправлено своим') && !!document.querySelector('#driveFull [data-drive="undo"]'), null, 5000));
  // Five seconds to undo. The page's clock stands still while the panel is
  // photographed and the club is asked: a WebKit screenshot alone can take them.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 500);
  await shot(page, { path: path.join(OUT, `drive-${label}-5-sent.png`) });
  check('«Отправлено своим» lies on screen', await framed(page));
  const mine = async () => (await reports()).filter((item) => item.station === station.id && item.who === sasha.member.id);
  check('the club got «95 есть» with the queue and «92 нет», as one look', await eventually(async () => {
    const got = await mine();
    const yes = got.find((item) => item.grade === 'AI95' && item.seen === true && item.queue === 3);
    const no = got.find((item) => item.grade === 'AI92' && item.seen === false);
    return !!yes && !!no && yes.at === no.at && got.length === 2;
  }, 3000));
  // «Отменить» is pressed while the clock still stands; then time goes on. In
  // the full chain WebKit took the rest of the five seconds to click.
  check('«Отменить» can be pressed', await tap(page, '#driveFull [data-drive="undo"]'));
  await page.clock.resume();
  check('the club no longer has the mark', await eventually(async () => (await mine()).length === 0));
  check('nor the phone, and «Вы на АЗС» is back', await becomes(page, (id) => !Object.keys(state.marks[id] || {}).length && document.querySelector('#drive').dataset.kind === 'at' && !!document.querySelector('#driveFull [data-drive="pick"]'), station.id, 8000));

  // 7. Someone else's fresh mark there: 👍 instead of marking over it.
  const lenaMarked = await api('/report', { method: 'POST', token: lena.token, body: { station: station.id, grades: [{ grade: 'AI95', seen: true }], queue: 12, lat: station.location.lat, lon: station.location.lon, name: station.network } });
  check('Лена marks the station', lenaMarked.status === 200);
  await page.evaluate(() => pollGroupMarks());
  check('«👍 Так и есть» and «👎 Уже нет» under «Лена отметил(а)…»', await becomes(page, () => {
    const box = document.querySelector('#driveFull');
    return box?.textContent.includes('Лена отметил(а)') && box.querySelector('[data-vote="up"]')?.textContent.trim() === '👍 Так и есть' && box.querySelector('[data-vote="down"]')?.textContent.trim() === '👎 Уже нет';
  }, null, 8000));
  check('the panel with 👍 lies on screen', await framed(page));
  await shot(page, { path: path.join(OUT, `drive-${label}-6-vote.png`) });
  await step(way.at(0));
  await tap(page, '#driveFull [data-vote="up"]');
  const lenas = async () => (await reports()).filter((item) => item.station === station.id && item.who === lena.member.id);
  check('👍 goes to the club', await eventually(async () => (await lenas()).some((item) => item.up === 1)));
  check('«👍 Подтверждено», then back to the map', await becomes(page, () => document.querySelector('#driveFull')?.textContent.includes('👍 Подтверждено'), null, 5000)
    && await becomes(page, () => document.querySelector('#driveFull').hidden && !document.querySelector('#driveSheet').hidden, null, 9000));

  // 8. Another road: a station passed at speed is asked about at the next stop.
  const pass = PASS.way;
  await step(pass.at(-260));
  check('the list follows the car to the other road', await becomes(page, (id) => state.stations.some((item) => item.id === id), PASS.station.id, 20000));
  await driveAlong(pass, -244, 220);
  for (let i = 0; i < 6; i += 1) await step(pass.at(220));
  check('stopped after passing a station: a question', await becomes(page, () => document.querySelector('#drive').dataset.kind === 'question', null, 6000));
  const question = await text(page, '#driveSheet');
  const passName = await page.evaluate((network) => ({ acc: nameAccusative(shortNetwork(network)), prep: namePrepositional(shortNetwork(network)) }), PASS.station.network);
  check(`«${question}»`, question.includes(`Проехали ${passName.acc}`) && question.includes(`Что с 95 на ${passName.prep}?`) && question.includes('Тронетесь — вопрос исчезнет сам'));
  check('with «95 есть», «95 нет», «не видел»', (await page.evaluate(() => [...document.querySelectorAll('#driveSheet .drive-btn')].map((button) => button.textContent.trim()).join('|'))) === '95 есть|95 нет|не видел');
  check('the question lies on screen', await framed(page));
  await shot(page, { path: path.join(OUT, `drive-${label}-7-question.png`) });
  await driveAlong(pass, 236, 268);
  check('moving again, the question is gone', (await kind(page)) !== 'question');
  for (let i = 0; i < 6; i += 1) await step(pass.at(268));
  const asked = await page.evaluate((id) => ({ again: drive.question?.id === id, once: drive.asked.has(id) }), PASS.station.id);
  check('the next stop does not ask about it again', asked.once && !asked.again);
  // Stations passed earlier on this road may be asked about now: not seen.
  for (let i = 0; i < 4 && (await kind(page)) === 'question'; i += 1) {
    await tap(page, '#driveSheet [data-drive="skip"]');
    await page.waitForTimeout(300);
  }

  // 9. 98 on nothing ahead: the nearest station that has it, and which way.
  await tap(page, '#drive [data-drive="grades"]');
  check('the plate opens big grade chips', (await labels(page, '#drivePick .drive-grades button')) === '92 95 98 100 ДТ' && await framed(page));
  await tap(page, '#drivePick [data-grade="AI98"]');
  check('98 becomes the grade of the whole app', await becomes(page, (id) => state.grade === 'AI98' && state.stations.some((item) => item.id === id && item.grade.status === 'CAN_REFUEL') && document.querySelector('#gradePicker [data-grade="AI98"]').classList.contains('active'), PASS.with98.id, 15000));
  check('«Моя марка 98»', await becomes(page, () => document.querySelector('.drive-plate').textContent.replace(/\s+/g, ' ').trim() === 'Моя марка 98', null, 5000));
  const withName = await page.evaluate((network) => shortNetwork(network), PASS.with98.network);
  // The list of the new grade takes a moment to come in; until then nothing is said.
  check('the sheet says there is no 98 ahead', await becomes(page, (name) => document.querySelector('#drive').dataset.kind === 'none' && document.querySelector('#driveSheet').textContent.includes(`Ближайшая с 98 — ${name}`), withName, 8000));
  check('and lies on screen', await framed(page));
  const none = await text(page, '#driveSheet');
  check(`«${none}»`, none.startsWith('Впереди 98 нет') && new RegExp(`Ближайшая с 98 — ${withName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, \\d+(,\\d)? км (налево|направо)`).test(none));
  // The map zooms out to show that station (15 Sep 2026); the edge marker is
  // left for when it still does not fit.
  check('the station is on screen, or a marker on the edge points to it', await focusShown(page) || await page.evaluate(() => !document.querySelector('#driveEdge').hidden && document.querySelector('#driveEdge b').textContent === '98'));
  const bigPins = await page.evaluate(() => [...document.querySelectorAll('.dpin.big')].map((pin) => ({ number: pin.querySelector('b').textContent, no: pin.classList.contains('no'), struck: getComputedStyle(pin.querySelector('b')).textDecorationLine.includes('line-through') })));
  check(`big pins read 98, those without it struck through (${bigPins.filter((pin) => pin.no).length} of ${bigPins.length})`, bigPins.length > 0 && bigPins.every((pin) => pin.number === '98' && pin.no === pin.struck));
  await shot(page, { path: path.join(OUT, `drive-${label}-8-none.png`) });

  // 10. «Авто» by the sun: day at noon, night at half past eleven.
  if (!(await page.evaluate(() => drive.pick === 'theme'))) await tap(page, '#drive [data-drive="theme"]');
  const auto = await becomes(page, () => drive.pick === 'theme', null, 3000)
    && await tap(page, '#drivePick [data-drive="theme-mode"][data-mode="auto"]')
    && await becomes(page, () => drive.theme === 'auto', null, 3000);
  if (await page.evaluate(() => drive.pick !== null)) await tap(page, '#drivePick [data-drive="pick-close"]');
  check('«Авто» chosen in the theme sheet, and the sheet closed', auto && await becomes(page, () => drive.pick === null, null, 3000));
  const tiles = () => page.evaluate(() => getComputedStyle(document.querySelector('#driveMap .leaflet-tile-pane')).filter);
  await page.clock.setSystemTime(tomorrowAt('12:00'));
  await page.evaluate(() => applyDriveTheme());
  check(`«Авто» at noon: the day theme, tiles as they are (${await tiles()})`, await page.evaluate(() => document.querySelector('#drive').classList.contains('is-day')) && (await tiles()) === 'none');
  await shot(page, { path: path.join(OUT, `drive-${label}-9-day.png`) });
  await page.clock.setSystemTime(tomorrowAt('23:30'));
  await page.evaluate(() => applyDriveTheme());
  check(`«Авто» at 23:30: the night theme, the same tiles darkened (${await tiles()})`, !(await page.evaluate(() => document.querySelector('#drive').classList.contains('is-day'))) && (await tiles()).includes('invert'));
  check('after all of it the top bar and the sheet are still on screen', await framed(page));
  await shot(page, { path: path.join(OUT, `drive-${label}-9-night.png`) });

  // 11. A station tapped on the map: «В Яндексе» opens its own card there, with
  // «Расскажите о заправке» and what drivers wrote, when Yandex is one of its
  // feeds; the search by name and address when it is not. It opens in the tap
  // itself, or an iPhone would block the new page.
  await page.evaluate(() => {
    window.openedPages = [];
    window.open = (url) => {
      window.openedPages.push(String(url));
      return null;
    };
  });
  const known = await page.evaluate(() => {
    const ids = state.stations.filter((item) => 'yandex_org' in item).map((item) => item.yandex_org);
    const station = state.stations.find((item) => item.location && /^\d+$/.test(item.yandex_org || ''));
    return { station, count: ids.length, digits: ids.every((id) => /^\d+$/.test(id)) };
  });
  check(`the list carries the Yandex ids of stations Yandex knows (${known.count} of them nearby, digits only)`, !!known.station && known.digits);
  // The same station twice: as the build has it, then as if Yandex did not know it.
  for (const way of ['card', 'search']) {
    const station = known.station;
    if (!station) break;
    if (way === 'search') await page.evaluate((id) => delete state.stations.find((item) => item.id === id).yandex_org, station.id);
    await page.evaluate((id) => tapDriveStation(id), station.id);
    const sheet = await becomes(page, () => document.querySelector('#drive').dataset.kind === 'tapped' && !!document.querySelector('#driveSheet [data-drive="yandex"]'), null, 3000);
    check(`a tapped station (${way}): its sheet with «В Яндексе» lies on screen`, sheet && await framed(page));
    const before = await page.evaluate(() => window.openedPages.length);
    await tap(page, '#driveSheet [data-drive="yandex"]');
    const opened = await page.evaluate((count) => window.openedPages.slice(count), before);
    const expected = way === 'card'
      ? opened.length === 1 && opened[0] === `https://yandex.ru/maps/org/${station.yandex_org}/`
      : opened.length === 1 && opened[0].startsWith('https://yandex.ru/maps/?text=') && opened[0].endsWith(`&ll=${Number(station.location.lon)},${Number(station.location.lat)}&z=17`);
    check(`«В Яндексе» opens ${way === 'card' ? 'its card' : 'the search for it'}: ${opened.join(' ') || 'nothing'}`, expected);
    await tap(page, '#driveSheet [data-drive="untap"]');
    check('«Скрыть» puts the sheet back', await becomes(page, () => drive.tapped === null && document.querySelector('#drive').dataset.kind !== 'tapped', null, 3000));
  }

  // 12. 🗺: the ordinary map over the whole screen; the bar opens the navigator again.
  check('🗺 leaves the drive screen for the ordinary map', await tap(page, '#drive [data-drive="close"]') && await becomes(page, () => !drive.open && document.querySelector('#drive').hidden && !document.body.classList.contains('driving') && document.body.classList.contains('map-screen'), null, 5000));
  check('the screen lock is let go and the list and the map are intact', await page.evaluate(() => drive.wakeLock === null && !!state.map && document.querySelectorAll('#stationList .station-card').length > 0 && !!document.querySelector('#map .leaflet-tile-pane')));
  check('«🚗 Навигатор» in the bar opens it again', await tap(page, '#modeBar [data-screen="drive"]') && await becomes(page, () => drive.open, null, 5000));
  await tap(page, '#drive [data-drive="close"]');
  const events = await page.evaluate(() => window.driveEvents.map((item) => `${item.event}${item.reason ? `:${item.reason}` : ''}`));
  const expected = ['drive_open:suggestion', 'drive_mark:at_station', 'drive_undo', 'drive_mark:vote', 'drive_stop_question:shown', 'drive_close', 'drive_open:button'].concat(neighbour ? ['drive_not_this'] : []);
  check(`analytics: ${[...new Set(events)].join(', ')}`, expected.every((name) => events.includes(name)));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

// DRIVE_ONLY=iphone or DRIVE_ONLY=android runs one of the two.
const only = process.env.DRIVE_ONLY;
try {
  if (!only || only === 'iphone') await run('iphone', webkit, devices['iPhone 13']);
  if (!only || only === 'android') await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL DRIVE MODE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

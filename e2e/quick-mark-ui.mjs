// At the pump the quick-mark chips «sometimes work, sometimes don't, then
// reset» (the owner, from the road, 14 Sep 2026), and the card of the station
// the phone is at sat somewhere in the middle of the list. Beside a real
// station from the built data, in WebKit (iPhone) and Chromium (Android): taps
// on its chips survive the panel and the list being drawn again, a quick double
// tap reads «нет», the pressed chips come back when the pause is over and in the
// station's drawer, the worker gets the whole look, and the station's card is
// first in the list with the one 300 m away right after it, though neither has
// fuel and more than a page of farther stations do.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9001;
const WORKER_PORT = 9002;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

// ---- a station to stand at, from the data the site was built with
const RAD = Math.PI / 180;
const kmBetween = (a, b) => {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
};
// A point `metres` from `from` along a unit vector given as north and east parts.
const shift = (from, north, east, metres) => ({
  lat: from.lat + (north * metres) / 111320,
  lon: from.lon + (east * metres) / (111320 * Math.cos(from.lat * RAD)),
});
const BUNDLE = path.join(SITE, 'static-data', 'stations-AI95.json');
const STATIONS = JSON.parse(fs.readFileSync(BUNDLE, 'utf8')).stations.filter((item) => item.location);
const PAGE_SIZE = 40;

// The phone 30 m from a station, on the side away from its neighbour, which is
// then about 300 m from the phone; no third station within 450 m, so the two
// are all the list pins; and at least 45 stations within the first 5 km, so
// without the pin both cards would be past the first page.
function pickPlace() {
  for (const station of STATIONS) {
    const [neighbour] = STATIONS
      .filter((item) => item !== station)
      .map((item) => ({ item, km: kmBetween(station.location, item.location) }))
      .sort((a, b) => a.km - b.km);
    if (!neighbour || neighbour.km < 0.25 || neighbour.km > 0.32) continue;
    const north = station.location.lat - neighbour.item.location.lat;
    const east = (station.location.lon - neighbour.item.location.lon) * Math.cos(station.location.lat * RAD);
    const length = Math.hypot(north, east);
    const at = shift(station.location, north / length, east / length, 30);
    const fromPhone = STATIONS.map((item) => ({ item, km: kmBetween(at, item.location) })).sort((a, b) => a.km - b.km);
    if (fromPhone[0].item !== station || fromPhone[1].item !== neighbour.item || fromPhone[2].km < 0.45) continue;
    if (fromPhone.filter(({ km }) => km <= 5).length < PAGE_SIZE + 5) continue;
    // A few metres to the side: a fix that changes nothing but draws the panel again.
    const nudge = shift(at, -east / length, north / length, 8);
    return { station, neighbour: neighbour.item, at, nudge, neighbourMetres: Math.round(fromPhone[1].km * 1000) };
  }
  return null;
}
const PLACE = pickPlace();
if (!PLACE) {
  console.log('FAIL no station in site/static-data fits this test: build the site from the full data/stations.json');
  process.exit(1);
}
console.log(`station: ${PLACE.station.network}, ${PLACE.station.address}`);
console.log(`neighbour: ${PLACE.neighbour.network}, ${PLACE.neighbourMetres} m from the phone`);

// The snapshot in the build is hours or days old, and the page expires its
// answers as a phone would. So the statuses are set here: the station the
// phone is at has no fresh data, its neighbour has no fuel, every other station
// has fuel and keeps it. «Ближайшие доступные» puts both of them last.
const served = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
for (const item of served.stations) {
  item.grade.status = item.id === PLACE.station.id ? 'NO_FRESH_DATA' : item.id === PLACE.neighbour.id ? 'CONFIRMED_NO' : 'CAN_REFUEL';
  item.grade.ttl_seconds = null;
  delete item.grade.advice;
}
const SERVED_BUNDLE = JSON.stringify(served);

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
  if (url.pathname === '/static-data/stations-AI95.json') {
    res.writeHead(200, { 'Content-Type': types['.json'] });
    res.end(SERVED_BUNDLE);
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

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const stored = async () => (await (await worker.fetch(new Request(`http://localhost:${WORKER_PORT}/reports`), env, { waitUntil() {} })).json()).reports;
const eventually = async (predicate, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
};
// A tap that may find nothing to tap: the check after it says what went wrong.
const tap = (page, selector) => page.click(selector, { timeout: 5000 }).then(() => true, () => false);

// What a composer shows: its chips, the queue, the send button, and whether it
// is still the element drawn before the redraws.
const composer = (page, selector) => page.evaluate((s) => {
  const box = document.querySelector(s);
  if (!box) return { found: false, pressed: [] };
  const chip = (grade) => box.querySelector(`[data-quick-grade="${grade}"]`);
  return {
    found: true,
    kept: box.keptForFinger === true,
    ai92: chip('AI92')?.textContent.trim(),
    ai95: chip('AI95')?.textContent.trim(),
    pressed: [chip('AI92')?.getAttribute('aria-pressed'), chip('AI95')?.getAttribute('aria-pressed')],
    queue: box.querySelector('[data-compose-queue].selected')?.dataset.composeQueue ?? null,
    sendable: box.querySelector('.compose-send')?.disabled === false,
  };
}, selector);
const reads = (c) => (c.found ? `${c.ai92 ?? '—'}, ${c.ai95 ?? '—'}` : 'no composer');
const marked = (c) => c.found && c.ai92 === '92 ✓' && c.ai95 === '95 ✕' && c.pressed.every((value) => value === 'true') && c.sendable;
const order = (page) => page.evaluate(() => [...document.querySelectorAll('#stationList .station-card')].map((card) => card.dataset.nearbyStation));
const tag = (page, selector) => page.evaluate((s) => { const element = document.querySelector(s); if (element) element.keptForFinger = true; }, selector);

// Pressed down, the panel and the list drawn again, then let go.
async function tapThroughRedraw(page, selector) {
  const chip = await page.$(selector);
  if (!chip) return;
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => { renderStations(); renderHerePanel(); });
  await page.mouse.up();
}

// Two touches on the same spot, as quickly as a thumb double-taps.
async function doubleTouch(page, selector) {
  const chip = await page.$(selector);
  if (!chip) return;
  await chip.scrollIntoViewIfNeeded();
  const box = await chip.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const { station, neighbour, at, nudge } = PLACE;
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: at.lat, longitude: at.lon, accuracy: 10 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const move = async (point) => {
    await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 10 });
    await page.evaluate(() => refreshLocation());
    // Past the two seconds the badges wait between fixes.
    await page.waitForTimeout(2500);
    return page.evaluate((lat) => Math.abs(state.location.lat - lat) < 1e-7, point.lat);
  };
  const panel = `#herePanel .mark-composer[data-compose-station="${station.id}"]`;
  const card = (id) => `#stationList .station-card[data-nearby-station="${id}"] .mark-composer`;
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });

  // 1. The phone at the station: «Вы у АЗС» with its chips, and its card on top.
  check('a touch phone at the station gets the «Вы у АЗС» chips', await becomes(page, (s) => state.searchScope === 'device' && state.accuracy <= 20 && !document.querySelector('#herePanel').hidden && document.querySelector(s), panel, 30000));
  check('the list is drawn', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0));
  const data = await page.evaluate(([here, next]) => {
    const index = state.stations.findIndex((item) => item.id === here);
    return {
      index,
      here: state.stations[index]?.grade.status,
      next: state.stations.find((item) => item.id === next)?.grade.status,
      fuelAhead: state.stations.slice(0, index).filter((item) => item.grade.status === 'CAN_REFUEL').length,
    };
  }, [station.id, neighbour.id]);
  check(`the station has no fresh data, its neighbour no fuel, and ${data.fuelAhead} stations with fuel come before it in the sort (place ${data.index + 1})`, data.here === 'NO_FRESH_DATA' && data.next === 'CONFIRMED_NO' && data.fuelAhead > 0 && data.index >= PAGE_SIZE);
  const first = await order(page);
  check(`its card is first in the list and the one ${PLACE.neighbourMetres} m away second (${first.length} cards)`, first[0] === station.id && first[1] === neighbour.id && first.length === PAGE_SIZE);
  check('the first card says «Вы здесь»', await becomes(page, () => document.querySelector('#stationList .station-card')?.classList.contains('is-here'), null, 5000));
  await page.locator('#stationList').screenshot({ path: path.join(OUT, `${label}-quick-mark-list.png`) });

  // 2. 92 once, with the panel and the list drawn again while the finger is down.
  await tag(page, panel);
  await tag(page, '#stationList .station-card');
  await tapThroughRedraw(page, `${panel} [data-quick-grade="AI92"]`);
  const once = await composer(page, panel);
  check(`a redraw between pressing and letting go keeps the tap (${reads(once)})`, once.ai92 === '92 ✓' && once.pressed[0] === 'true');

  // 3. A fix a few metres off and a poll that brings a new mark: both draw again.
  check('a fix a few metres off arrives', await move(nudge));
  const report = await fetch(`http://localhost:${WORKER_PORT}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ station: neighbour.id, grade: 'AI95', seen: false, who: 'someone-else', lat: neighbour.location.lat, lon: neighbour.location.lon }),
  });
  check(`someone in the group marks the neighbour (${report.status})`, report.ok);
  await page.evaluate(() => pollGroupMarks());
  check('the poll brings the new mark', await becomes(page, (id) => !!state.groupMarks[id]?.AI95, neighbour.id, 8000));
  const afterRedraws = await composer(page, panel);
  check(`92 is still pressed, in the same composer, not a redrawn one (${reads(afterRedraws)})`, afterRedraws.kept && afterRedraws.ai92 === '92 ✓');

  // 95 twice, with another fix between the taps.
  await tap(page, `${panel} [data-quick-grade="AI95"]`);
  check('a fix back at the first spot arrives', await move(at));
  await tap(page, `${panel} [data-quick-grade="AI95"]`);
  const twice = await composer(page, panel);
  check(`92 reads «есть» and 95 «нет» (${reads(twice)})`, marked(twice) && twice.kept);
  const mirrored = await composer(page, card(station.id));
  check(`the station's card below shows the same (${reads(mirrored)})`, marked(mirrored));
  await page.locator('#herePanel').screenshot({ path: path.join(OUT, `${label}-quick-mark-kept.png`) });

  // A quick double tap is two taps, not one: the neighbour's card reads «нет».
  await doubleTouch(page, `${card(neighbour.id)} [data-quick-grade="AI95"]`);
  const double = await composer(page, card(neighbour.id));
  check(`a double tap 150 ms apart reads «нет» (${double.found ? double.ai95 : 'no composer'})`, double.ai95 === '95 ✕');

  // 4. The pause over, the panel and the list are drawn anew and the chips come back.
  check('after the pause the panel is drawn anew', await becomes(page, (s) => document.querySelector(s) && !document.querySelector(s).keptForFinger, panel, 25000));
  check('and so is the list', await becomes(page, () => !document.querySelector('#stationList .station-card')?.keptForFinger, null, 5000));
  const restored = await composer(page, panel);
  check(`the redrawn panel shows 92 «есть» and 95 «нет» again (${reads(restored)})`, marked(restored) && !restored.kept);
  const restoredCard = await composer(page, card(neighbour.id));
  check(`the neighbour's redrawn card keeps its «нет» (${restoredCard.found ? restoredCard.ai95 : 'no composer'})`, restoredCard.ai95 === '95 ✕');
  const drawn = await order(page);
  check('the redrawn list still starts with the station and its neighbour', drawn[0] === station.id && drawn[1] === neighbour.id);

  // The drawer of the same station holds the same look.
  await page.evaluate((id) => openStation(id), station.id);
  const drawer = await becomes(page, () => document.querySelector('#drawerContent .mark-composer [data-compose-grade="AI92"]'), null, 10000)
    && await page.evaluate(() => {
      const button = (grade, seen) => document.querySelector(`#drawerContent [data-compose-grade="${grade}"][data-compose-seen="${seen}"]`);
      return button('AI92', 1).classList.contains('selected') && button('AI92', 1).getAttribute('aria-pressed') === 'true'
        && button('AI95', 0).classList.contains('selected') && !button('AI95', 1).classList.contains('selected')
        && !document.querySelector('#drawerContent .compose-send').disabled;
    });
  check('the station\'s drawer shows 92 «есть» and 95 «нет» too', drawer);
  await page.evaluate(() => closeDrawer());

  // 5. The queue, then send: the worker gets both grades with the queue.
  await tap(page, `${panel} [data-compose-queue="12"]`);
  const withQueue = await composer(page, panel);
  check(`the queue chip is pressed (${withQueue.queue})`, withQueue.queue === '12');
  check('«Отправить своим» can be pressed', await tap(page, `${panel} .compose-send`));
  check('the panel says what is being sent', await becomes(page, () => document.querySelector('#herePanel .mark-sent')?.textContent.includes('92 есть, 95 нет, очередь: до 20 машин'), null, 5000));
  const mine = async () => (await stored()).filter((item) => item.station === station.id && item.who !== 'someone-else');
  const arrived = await eventually(async () => (await mine()).length === 2);
  const looks = await mine();
  const grade = (name) => looks.find((item) => item.grade === name);
  check(`the worker got 92 «есть» and 95 «нет» with the queue (${looks.map((item) => `${item.grade}:${item.seen}:${item.queue}`).join(', ') || 'nothing'})`,
    arrived && grade('AI92')?.seen === true && grade('AI95')?.seen === false && looks.every((item) => item.queue === 12));
  check('the sent draft is gone', await page.evaluate((id) => typeof composeDraft === 'function' && !composeDraft(id), station.id));

  // 6. Drawn again after sending, the station is still first, its neighbour second.
  check('after sending the card says «Вы отметили»', await becomes(page, (id) => document.querySelector(`#stationList .station-card[data-nearby-station="${id}"] .card-actions .mark-sent`)?.textContent.includes('Вы отметили'), station.id, 10000));
  const last = await order(page);
  check('and is still first, with its neighbour right after it', last[0] === station.id && last[1] === neighbour.id);

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL QUICK MARK CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

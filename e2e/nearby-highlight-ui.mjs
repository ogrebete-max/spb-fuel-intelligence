// Drivers asked for the station they pull up to, or drive past, to stand out.
// Beside a real station from the built data its card says «Вы здесь» and its
// pin pulses, a station within a kilometre says «рядом», a rough fix never says
// «Вы здесь», the badges follow the phone on the same cards without the list
// being redrawn, and 20 km away they are gone. WebKit (an iPhone 375 px wide)
// and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8961;
const WORKER_PORT = 8962;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

// ---- a station to drive up to, from the data the site was built with
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
const STATIONS = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations.filter((item) => item.location);
const nearestTo = (point, except = null) => STATIONS.reduce((best, item) => {
  if (item === except) return best;
  const km = kmBetween(point, item.location);
  return !best || km < best.km ? { item, km } : best;
}, null);

// Its nearest neighbour 450–800 m away and 8 to 40 stations within 5 km: the
// list stops at its first radius and every card is on the first page.
function pickStation() {
  for (const station of STATIONS) {
    const neighbour = nearestTo(station.location, station);
    if (neighbour.km < 0.45 || neighbour.km > 0.8) continue;
    // On the side away from the neighbour: 90 m is at the station, 235 m just past it.
    const north = station.location.lat - neighbour.item.location.lat;
    const east = (station.location.lon - neighbour.item.location.lon) * Math.cos(station.location.lat * RAD);
    const length = Math.hypot(north, east);
    const at = shift(station.location, north / length, east / length, 90);
    const past = shift(station.location, north / length, east / length, 235);
    if (nearestTo(at).item !== station || nearestTo(past, station).km < 0.3) continue;
    const around = STATIONS.filter((item) => kmBetween(at, item.location) <= 5).length;
    if (around < 8 || around > 40) continue;
    // 20 km off, in a direction with no station within a kilometre and a half.
    const far = [0, 45, 90, 135, 180, 225, 270, 315]
      .map((degrees) => shift(at, Math.cos(degrees * RAD), Math.sin(degrees * RAD), 20000))
      .find((point) => nearestTo(point).km > 1.5);
    if (far) return { station, neighbour: neighbour.item, at, past, far };
  }
  return null;
}
const PLACE = pickStation();
if (!PLACE) {
  console.log('FAIL no station in site/static-data fits this test: build the site from the full data/stations.json');
  process.exit(1);
}
console.log(`station: ${PLACE.station.network}, ${PLACE.station.address}`);
console.log(`neighbour: ${PLACE.neighbour.network}, ${Math.round(kmBetween(PLACE.at, PLACE.neighbour.location) * 1000)} m from the phone`);

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

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

// What the card of a station shows, and whether its top line is still one line.
const cardOf = (page, id) => page.evaluate((stationId) => {
  const card = document.querySelector(`#stationList .station-card[data-nearby-station="${stationId}"]`);
  if (!card) return { here: false, near: false, badge: '(no card)', oneLine: false };
  const line = card.querySelector('.card-topline');
  return {
    here: card.classList.contains('is-here'),
    near: card.classList.contains('is-near'),
    badge: line.querySelector('.nearby-badge')?.textContent || '',
    oneLine: line.getBoundingClientRect().height < line.querySelector('.network').getBoundingClientRect().height * 1.9,
    distanceShown: getComputedStyle(line.querySelector('.distance')).display !== 'none',
    frame: getComputedStyle(card).borderTopColor,
  };
}, id);
const GREEN = 'rgb(31, 122, 77)';
// Where the map pins carrying a class stand.
const pins = (page, className) => page.evaluate((name) => state.markers.getLayers()
  .filter((marker) => marker.getElement()?.classList.contains(name))
  .map((marker) => marker.getLatLng()), className);
const pinAt = (list, place) => list.some((pin) => Math.abs(pin.lat - place.lat) < 1e-6 && Math.abs(pin.lng - place.lon) < 1e-6);

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const { station, neighbour, at, past, far } = PLACE;
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: at.lat, longitude: at.lon, accuracy: 800 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const move = async (point, accuracy) => {
    await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy });
    await page.evaluate(() => refreshLocation());
  };
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });

  // 1. A rough fix beside the station: «рядом» at most, never «Вы здесь».
  check('a touch phone follows by itself on a rough fix', await becomes(page, () => state.follow && state.searchScope === 'device' && state.accuracy > 300));
  check('the station and its neighbour are in the list', await becomes(page, (ids) => ids.every((id) => document.querySelector(`#stationList [data-nearby-station="${id}"]`)), [station.id, neighbour.id]));
  const rough = await cardOf(page, station.id);
  check(`rough fix: the station reads «${rough.badge}», not «Вы здесь»`, rough.near && !rough.here && rough.badge.startsWith('📍 рядом'));
  check('rough fix: no card and no pin says «Вы здесь»', !(await page.$('#stationList .is-here')) && (await pins(page, 'here')).length === 0);

  // 2. A precise fix: that card says «Вы здесь», the neighbour «рядом», the pin pulses.
  await move(at, 10);
  check('precise fix: the station\'s card turns «Вы здесь»', await becomes(page, (id) => document.querySelector(`#stationList [data-nearby-station="${id}"]`)?.classList.contains('is-here'), station.id));
  const here = await cardOf(page, station.id);
  const near = await cardOf(page, neighbour.id);
  const hereCards = await page.locator('#stationList .station-card.is-here').count();
  check(`its badge reads «${here.badge}», beside the distance, in a green frame (${here.frame})`, here.badge === '📍 Вы здесь' && !here.near && here.distanceShown && here.frame === GREEN);
  check(`the neighbour reads «${near.badge}», the distance not repeated beside it`, near.near && !near.here && /^📍 рядом · \d+ м$/.test(near.badge) && !near.distanceShown);
  check(`one card in the list says «Вы здесь» (${hereCards})`, hereCards === 1);
  check('both top lines stay on one line', here.oneLine && near.oneLine);
  const herePins = await pins(page, 'here');
  check(`the station's pin, and only it, has class here (${herePins.length})`, herePins.length === 1 && pinAt(herePins, station.location));
  check('the neighbour\'s pin has class near', pinAt(await pins(page, 'near'), neighbour.location));
  const card = page.locator(`#stationList .station-card[data-nearby-station="${station.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(OUT, `${label}-nearby-card.png`) });
  // The longest network name in the data gives way; the badge and the distance keep their line.
  const squeezed = await page.evaluate((id) => {
    const line = document.querySelector(`#stationList [data-nearby-station="${id}"] .card-topline`);
    line.querySelector('.network').textContent = 'Российские нефтепродукты, автоматическая АЗС самообслуживания';
    const box = line.getBoundingClientRect();
    const parts = ['.network', '.nearby-badge', '.distance'].map((part) => line.querySelector(part).getBoundingClientRect());
    return box.height < parts[0].height * 1.9 && parts.every((rect) => rect.right <= box.right + 1 && rect.width > 0);
  }, station.id);
  check('with the longest network name the top line is still one line', squeezed);
  await page.click('[data-view="map"]');
  await page.waitForTimeout(1000);
  // Close enough to see both pins; moving the map draws every pin anew.
  await page.evaluate(({ lat, lon }) => state.map.setView([lat, lon], 15), station.location);
  await page.waitForTimeout(1000);
  check('on the map, redrawn after it moved, the station\'s pin still has class here', pinAt(await pins(page, 'here'), station.location));
  await page.locator('#mapWrap').screenshot({ path: path.join(OUT, `${label}-nearby-map.png`) });
  const pulse = () => page.evaluate(() => {
    const pin = document.querySelector('.leaflet-marker-icon.here .fuel-pin');
    return pin ? getComputedStyle(pin, '::before').animationName : '(no pin)';
  });
  const moving = await pulse();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await pulse();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check(`the pin pulses (${moving}) and holds still when motion is reduced (${still})`, moving === 'here-pulse' && still === 'none');
  await page.click('[data-view="list"]');

  // 3. «Свои»: the group's card for the same station says «Вы здесь» as well.
  const report = await fetch(`http://localhost:${WORKER_PORT}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ station: station.id, grade: 'AI95', seen: true, who: 'someone-else', lat: station.location.lat, lon: station.location.lon }),
  });
  check(`someone in the group marks the station (${report.status})`, report.ok);
  await page.evaluate(() => pollGroupMarks());
  check('the «Свои» chip appears', await becomes(page, () => !!document.querySelector('#statusStrip [data-own]')));
  await page.click('#statusStrip [data-own]');
  check('in «Свои» the station\'s card says «Вы здесь»', await becomes(page, (id) => document.querySelector(`#stationList .own-card.is-here[data-nearby-station="${id}"] .nearby-badge`)?.textContent === '📍 Вы здесь', station.id));
  const own = await cardOf(page, station.id);
  check(`and has the green frame too, without a decision colour (${own.frame})`, own.frame === GREEN);
  await page.locator('#stationList .own-card.is-here').screenshot({ path: path.join(OUT, `${label}-nearby-own.png`) });
  check('and its pin has class here', await becomes(page, () => state.markers.getLayers().some((marker) => marker.getElement()?.classList.contains('here'))));
  await page.click('#stationList [data-own-back]');
  check('«Показать все АЗС» brings the list back with «Вы здесь»', await becomes(page, (id) => !state.ownOnly && document.querySelector(`#stationList .station-card.is-here[data-nearby-station="${id}"]`), station.id));

  // 4. 145 m on, too little to reload the list: the very same card now says «рядом».
  await page.evaluate((id) => { document.querySelector(`#stationList [data-nearby-station="${id}"]`).keptAcrossFixes = true; }, station.id);
  await move(past, 10);
  check('just past the station the same card, not a redrawn one, says «рядом»', await becomes(page, (id) => {
    const same = document.querySelector(`#stationList [data-nearby-station="${id}"]`);
    return same?.keptAcrossFixes === true && same.classList.contains('is-near') && !same.classList.contains('is-here');
  }, station.id, 8000));
  const passing = await cardOf(page, station.id);
  check(`its badge reads «${passing.badge}»`, /^📍 рядом · 2[2-5]\d м$/.test(passing.badge));
  check('no card says «Вы здесь» any more', !(await page.$('#stationList .is-here')));
  check('its pin stops pulsing and keeps the ring', (await pins(page, 'here')).length === 0 && pinAt(await pins(page, 'near'), station.location));

  // 5. 20 km away the badges, the frame and the rings are gone.
  await move(far, 10);
  check('20 km away no card is marked', await becomes(page, (lat) => state.location?.lat === lat
    && !document.querySelector('#stationList .is-here, #stationList .is-near, #stationList .nearby-badge'), far.lat));
  await page.waitForTimeout(2500);
  check('and no pin', await page.evaluate(() => !document.querySelector('.leaflet-marker-icon.near, .leaflet-marker-icon.here, #stationList .nearby-badge')));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13 Mini']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL NEARBY HIGHLIGHT CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

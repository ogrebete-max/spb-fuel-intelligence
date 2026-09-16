// «👁 Свои» for the whole day (16 Sep 2026). People saw three marks in the list
// and took them for everything marked that day; a mark's age read «Ирина ·
// протухает», as if said about Ирина. Now the list holds the day: marks up to
// an hour and a half old on top, the rest behind a button, the age as a time.
// The station card opens the station in Yandex Maps, and the navigator's
// «👁 Свои» keeps only the stations where ours saw one's grade. On an iPhone
// (WebKit) and an Android phone (Chromium).
//   node e2e/own-day-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SITE_PORT = 9091;
const WORKER_PORT = 9092;
const HERE = { latitude: 59.9343, longitude: 30.3351 };
const MINUTE = 60 * 1000;

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
const becomes = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', selector);

// Stations from the data the site was built from, nearest to where the phones stand.
const listed = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations;
const metres = (station) => {
  const dy = (station.location.lat - HERE.latitude) * 111320;
  const dx = (station.location.lon - HERE.longitude) * 111320 * Math.cos(HERE.latitude * Math.PI / 180);
  return Math.hypot(dx, dy);
};
const nearby = listed.filter((station) => station.location && metres(station) <= 4000).sort((a, b) => metres(a) - metres(b));
const seenAt = nearby.find((station) => /^\d+$/.test(station.yandex_org || ''));
const others = nearby.filter((station) => station !== seenAt && !station.yandex_org);
if (!seenAt || others.length < 4) throw new Error(`the built data has too few stations near the test point (${nearby.length})`);
const [noAt, fiveHours, dayAgo, tooOld] = others;

function seed() {
  const now = Date.now();
  const report = (station, grade, seen, ago, who) => ({ station: station.id, grade, seen, at: now - ago, who, lat: station.location.lat, lon: station.location.lon, queue: null });
  env.REPORTS.values.set('reports', JSON.stringify([
    report(tooOld, 'AI95', true, 26 * 60 * MINUTE, 'phone-e'),
    report(dayAgo, 'AI92', true, 20 * 60 * MINUTE, 'phone-d'),
    report(seenAt, 'AI92', false, 6 * 60 * MINUTE, 'phone-f'),
    report(fiveHours, 'AI95', true, 5 * 60 * MINUTE, 'phone-c'),
    report(noAt, 'AI95', false, 60 * MINUTE, 'phone-b'),
    report(seenAt, 'AI95', true, 10 * MINUTE, 'phone-a'),
  ]));
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  seed();
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { ...HERE, accuracy: 15 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });

  // 1. The chip counts the day: four stations, not the one a day and more ago.
  await page.evaluate(() => pollGroupMarks());
  check('«👁 Свои · 4»: every station ours marked in the day', await becomes(page, () => document.querySelector('#statusStrip [data-own]')?.textContent.trim() === '👁 Свои · 4'));

  // 2. Fresh marks on top, nearest first; the rest of the day behind a button.
  await page.click('#statusStrip [data-own]');
  check('«Свои» opens', await becomes(page, () => state.ownOnly && document.querySelectorAll('#stationList .own-card').length > 0));
  check(`the bar says the day: «${await text(page, '#stationList .own-bar span')}»`, (await text(page, '#stationList .own-bar span')) === 'Отметки своих за сутки');
  const top = await page.evaluate(() => ({
    head: document.querySelector('#stationList .own-head')?.textContent.trim(),
    cards: [...document.querySelectorAll('#stationList .own-card')].map((card) => ({
      id: card.dataset.nearbyStation,
      tier: ['fresh', 'aging', 'stale'].find((key) => card.classList.contains(key)),
      grades: [...card.querySelectorAll('.feed-grade')].map((chip) => chip.textContent.trim()),
      age: card.querySelector('.own-age')?.textContent.trim(),
    })),
    more: document.querySelector('#stationList [data-own-more]')?.textContent.trim(),
    expanded: document.querySelector('#stationList [data-own-more]')?.getAttribute('aria-expanded'),
    words: document.querySelector('#stationList').textContent,
  }));
  check(`the heading: «${top.head}»`, top.head === 'Свежие — до полутора часов');
  check(`on top only the two marks of the last hour and a half, the fresher first (${top.cards.map((card) => card.tier).join(', ')})`,
    top.cards.length === 2 && top.cards[0].id === seenAt.id && top.cards[0].tier === 'fresh' && top.cards[1].id === noAt.id && top.cards[1].tier === 'aging');
  check(`a station marked again shows only its latest look: ${top.cards[0]?.grades.join(' ')}`, JSON.stringify(top.cards[0]?.grades) === '["95 ✓"]');
  check(`the age is a time, with no word beside it: «${top.cards[0]?.age}», «${top.cards[1]?.age}»`, top.cards[0]?.age === '10 мин назад' && top.cards[1]?.age === '1 ч назад');
  check('no «протухает» and no «устарела» anywhere in the list', !/протух|устарел/i.test(top.words));
  check(`the button for the rest of the day: «${top.more}»`, top.more === 'Ещё 2 АЗС за сутки ▾' && top.expanded === 'false');
  await page.evaluate(() => document.querySelector('#stationList').scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(OUT, `own-day-${label.split(' ')[0]}-1-fresh.png`) });

  // 3. The button opens the rest of the day, newest first, with clock times.
  await page.click('#stationList [data-own-more]');
  check('the older marks open', await becomes(page, () => document.querySelectorAll('#stationList .own-card').length === 4));
  const older = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('#stationList .own-head')].map((head) => head.textContent.trim()),
    cards: [...document.querySelectorAll('#stationList .own-card.stale')].map((card) => ({ id: card.dataset.nearbyStation, age: card.querySelector('.own-age').textContent.trim() })),
    more: document.querySelector('#stationList [data-own-more]')?.textContent.trim(),
  }));
  check(`they come under «${older.heads[1]}»`, older.heads[1] === 'Старше полутора часов — на месте всё могло измениться');
  check(`newest first, with the time of day: ${older.cards.map((card) => card.age).join(' / ')}`,
    older.cards.length === 2 && older.cards[0].id === fiveHours.id && older.cards[1].id === dayAgo.id
    && older.cards.every((card) => /^(сегодня|вчера) в \d\d:\d\d$/.test(card.age)));
  check(`and the button now hides them: «${older.more}»`, older.more === 'Скрыть отметки постарше ▴');
  await page.evaluate(() => document.querySelector('#stationList [data-own-more]').scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(OUT, `own-day-${label.split(' ')[0]}-2-day.png`) });
  await page.evaluate(() => pollGroupMarks());
  await page.waitForTimeout(300);
  check('a fresh read of the marks keeps them open', await page.evaluate(() => document.querySelectorAll('#stationList .own-card').length === 4 && state.ownMore));
  check('nothing sticks out sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.click('#stationList [data-own-back]');
  check('«Показать все АЗС» leaves «Свои»', await becomes(page, () => !state.ownOnly && !document.querySelector('#stationList .own-card')));
  await page.click('#statusStrip [data-own]');
  check('coming back, the older marks are closed again', await becomes(page, () => state.ownOnly && document.querySelectorAll('#stationList .own-card').length === 2 && !state.ownMore));

  // 4. The station card: «Карточка в Яндексе» opens the station itself, or the search for it.
  for (const [station, expected, way] of [
    [seenAt, `https://yandex.ru/maps/org/${seenAt.yandex_org}/`, 'its card'],
    [noAt, null, 'the search for it'],
  ]) {
    await page.evaluate((id) => openStation(id), station.id);
    const shown = await becomes(page, () => document.querySelector('#detailDrawer.open #yandexLink'));
    const href = await page.evaluate(() => document.querySelector('#yandexLink')?.getAttribute('href') || '');
    check(`the card of ${station.id} has «Карточка в Яндексе», to ${way}: ${href}`, shown
      && (expected ? href === expected : href.startsWith('https://yandex.ru/maps/?text=') && href.endsWith(`&ll=${Number(station.location.lon)},${Number(station.location.lat)}&z=17`)));
    if (way === 'its card') {
      await page.waitForTimeout(700);
      await page.evaluate(() => document.querySelector('#yandexLink').scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(OUT, `own-day-${label.split(' ')[0]}-3-card.png`) });
    }
    await page.evaluate(() => closeDrawer());
    await page.waitForTimeout(200);
  }
  await page.click('#stationList [data-own-back]');
  await becomes(page, () => !state.ownOnly);

  // 5. The navigator: «👁 Свои» keeps only where ours saw 95 within 45 minutes.
  await page.click('#modeBar [data-screen="drive"]');
  check('the navigator opens', await becomes(page, () => drive.open && !document.querySelector('#drive').hidden, null, 8000));
  check('the list around the car has the station ours saw', await becomes(page, (id) => state.stations.some((station) => station.id === id), seenAt.id, 20000));
  check(`«${await text(page, '#drive .drive-own')}»: how many stations ours saw 95 at around here`, await becomes(page, () => document.querySelector('#drive .drive-own')?.textContent.trim() === '👁 Свои · 1'));
  const placed = await page.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    const own = box('#drive .drive-own');
    const topBar = box('#drive .drive-top');
    const speed = box('#drive .drive-speed');
    return own.left >= 0 && own.right <= innerWidth && own.top >= topBar.bottom && Math.abs(own.top + own.height / 2 - (speed.top + speed.height / 2)) < 4 && own.left >= speed.right;
  });
  check('the switch stands beside the speed, under the top bar, on screen', placed);
  const before = await page.evaluate(() => drive.markers.size);
  await page.click('#drive .drive-own');
  check('pressed, it says «👁 Только свои»', await becomes(page, () => drive.ownOnly && document.querySelector('#drive .drive-own').getAttribute('aria-pressed') === 'true' && document.querySelector('#drive .drive-own').textContent.trim() === '👁 Только свои'));
  check(`only that station stays on the map (${before} pins before)`, await becomes(page, (id) => drive.markers.size === 1 && drive.markers.has(id), seenAt.id, 6000) && before > 1);
  check('its pin wears «есть»', await page.evaluate((id) => document.querySelector(`.dpin[data-station="${id}"]`)?.dataset.status === 'CAN_REFUEL', seenAt.id));
  const sheet = await text(page, '#driveSheet');
  await page.screenshot({ path: path.join(OUT, `own-day-${label.split(' ')[0]}-4-drive-own.png`) });
  check(`the sheet talks about it: «${sheet}»`, ['line', 'near'].includes(await page.evaluate(() => document.querySelector('#drive').dataset.kind)) && sheet.includes('95 есть'));

  // 98, which nobody marked: the sheet says so and offers every station back.
  await page.click('#drive [data-drive="grades"]');
  await page.click('#drivePick [data-grade="AI98"]');
  if (await page.evaluate(() => drive.pick !== null)) await page.click('#drivePick [data-drive="pick-close"]');
  const quiet = await becomes(page, () => state.grade === 'AI98' && document.querySelector('#drive').dataset.kind === 'none' && document.querySelector('#driveSheet').textContent.includes('Свои рядом 98 не видели'), null, 20000);
  check(`with 98: «${await text(page, '#driveSheet')}»`, quiet && await page.evaluate(() => drive.markers.size === 0));
  await page.click('#driveSheet [data-drive="own"]');
  check('«Показать все заправки» turns «👁 Свои» off', await becomes(page, () => !drive.ownOnly && document.querySelector('#drive .drive-own').getAttribute('aria-pressed') === 'false' && drive.markers.size > 0, null, 8000));
  await page.click('#drive [data-drive="close"]');

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iPhone 13 · WebKit', webkit, devices['iPhone 13']);
  await run('Pixel 7 · Chromium', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL OWN-DAY CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

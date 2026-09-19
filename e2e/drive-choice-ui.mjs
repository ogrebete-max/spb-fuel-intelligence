// Выбор заправок в навигаторе (18.09.2026).
//
// Driving, the owner saw one station with 95 and no sign that there were
// others: «их точно не одна в округе, должен быть выбор». The sheet names the
// next two that have the grade, a tap moves the screen to one, and the top
// line is always about a station that has it.
//   node e2e/drive-choice-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9121;
const HERE = { latitude: 59.9343, longitude: 30.3351 };

// ---- three stations with 95 around the phone, and nothing else with it
const load = (grade) => JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', `stations-${grade}.json`), 'utf8'));
const metres = (station) => {
  const dy = (station.location.lat - HERE.latitude) * 111320;
  const dx = (station.location.lon - HERE.longitude) * 111320 * Math.cos((HERE.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
};
const around = load('AI95').stations
  .filter((station) => station.location && station.network)
  .map((station) => ({ station, away: metres(station) }))
  .filter((item) => item.away >= 700 && item.away <= 4000)
  .sort((a, b) => a.away - b.away);
const CHOICE = around.slice(0, 3).map((item) => item.station);
if (CHOICE.length < 3) throw new Error('the built data has too few stations around the test point');
CHOICE.forEach((station, index) => console.log(`${index + 1}. ${station.network} — ${Math.round(metres(station))} м`));

const served = () => {
  const bundle = load('AI95');
  const has = new Set(CHOICE.map((station) => station.id));
  for (const station of bundle.stations) {
    station.grade.status = has.has(station.id) ? 'CAN_REFUEL' : 'CONFIRMED_NO';
    station.grade.age_seconds = 600;
    station.grade.ttl_seconds = null;
  }
  return JSON.stringify(bundle);
};
const SERVED = { '/static-data/stations-AI95.json': served() };

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  if (SERVED[url.pathname]) {
    res.writeHead(200, { 'Content-Type': types['.json'] });
    res.end(SERVED[url.pathname]);
    return;
  }
  const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => siteServer.listen(PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { ...HERE, accuracy: 12 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });
  await page.click('#modeBar [data-screen="drive"]');
  check('the navigator opens', await becomes(page, () => drive.open && !document.querySelector('#drive').hidden));

  // 1. The sheet offers the other stations that have 95 — the choice the owner
  // could not see from the car.
  const shown = await becomes(page, () => document.querySelectorAll('#driveSheet .drive-next').length === 2);
  const words = await page.evaluate(() => document.querySelector('#driveSheet .drive-more')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check(`«${words}» — two more stations to choose from`, shown && words.startsWith('Дальше:'));
  const offered = await page.evaluate(() => [...document.querySelectorAll('#driveSheet .drive-next')].map((chip) => chip.dataset.station));
  const inside = await page.evaluate(() => {
    const view = stepDrive();
    return { focus: view.focus?.station.id, options: (view.options || []).map((item) => item.station.id) };
  });
  check('the chips are what the screen chose to offer, and never the one it is talking about',
    JSON.stringify(offered) === JSON.stringify(inside.options) && !offered.includes(inside.focus));
  check(`every one of them has 95 (${offered.length})`, offered.length === 2 && offered.every((id) => CHOICE.some((station) => station.id === id)));
  await page.screenshot({ path: path.join(OUT, `${label}-choice-1-sheet.png`) });

  // 2. A tap moves the screen to that one.
  const picked = offered[0];
  const pickedName = CHOICE.find((station) => station.id === picked)?.network || '';
  await page.click(`#driveSheet .drive-next[data-station="${picked}"]`);
  check('tapping one makes the screen talk about it', await becomes(page, (id) => drive.tapped?.id === id && stepDrive().focus?.station.id === id, picked));
  const named = await page.evaluate(() => document.querySelector('#driveSheet')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check(`the panel names it: «${named.slice(0, 80)}…»`, named.includes(pickedName.split(',')[0]));

  // 2a. A station without the grade standing closer is no longer the headline:
  // it moves to the «мимо» line, and the one to drive to takes the top.
  await page.evaluate(() => { drive.tapped = null; renderDrive({ force: true }); });
  const reading = await page.evaluate(() => {
    const view = stepDrive();
    const sheet = document.querySelector('#driveSheet');
    return {
      kind: view.kind,
      focus: view.focus?.station.network || null,
      focusServes: [0].includes(SERVES_NOW[view.focus?.station.grade?.status]),
      passing: view.passing?.station.network || null,
      line: sheet?.querySelector('.drive-line')?.textContent.replace(/\s+/g, ' ').trim() || '',
      by: sheet?.querySelector('.drive-passing')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
  });
  console.log(`   главная строка: «${reading.line}»${reading.by ? ` | ниже: «${reading.by}»` : ''}`);
  check('the headline is a station that has the grade', reading.kind !== 'line' || reading.focusServes);
  check('and a nearer one without it, if any, is named below as «мимо»',
    !reading.passing || (reading.by.startsWith('мимо:') && reading.by.includes(reading.passing.split(',')[0])));

  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL DRIVE-CHOICE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// 10 Oct 2026, the owner: «в мобильной версии какая-то проблема с картой. Она
// вообще перестала практически скролиться». Every move of the map screen threw
// all its pins away and built them again — with no fresh answer anywhere, every
// station in town, over a second of a phone's time after each touch. Pins are
// now kept between moves and built again only when what they show changes.
// Checked here, on the map screen with every answer run out (the worst case):
// a pan keeps the very same pin elements and costs next to nothing, a pin's
// popup stays open while the map moves, labels come closer in and go further
// out, another grade repaints the pins, and «👁 Свои» leaves no pin behind.
// WebKit (iPhone) and Chromium (Android).
//   node e2e/map-pins-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const PORT = 9371;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const HERE = { latitude: 59.93428, longitude: 30.33512, accuracy: 15 };

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: HERE });
  const page = await context.newPage();
  // A day after the snapshot: every answer has run out, and the map shows every station.
  await page.clock.install({ time: new Date(Date.now() + 24 * 3600 * 1000) });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  check('the app opens', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));
  await page.evaluate(() => { if (drive.open) closeDrive(); showScreen('map'); });
  check('the map screen shows the whole city', await becomes(page, () => state.mapStationsGrade === state.grade && document.querySelectorAll('#map .fuel-pin').length > 100, null, 30000));
  await page.evaluate(() => state.map.setView([59.94, 30.31], 10, { animate: false }));
  await page.waitForTimeout(800);
  const city = await page.evaluate(() => ({
    pins: document.querySelectorAll('#map .fuel-pin').length,
    stations: state.mapStations.length,
    answered: state.mapStations.filter((station) => station.grade.status !== 'NO_FRESH_DATA').length,
  }));
  check(`with no answer left, every station is a pin (${city.pins} pins, ${city.stations} stations, ${city.answered} answered)`, city.answered < 150 && city.pins === city.stations);

  // A pan from afar: the very same pin elements, and next to no work.
  await page.evaluate(() => {
    window.__seen = new Set(document.querySelectorAll('#map .fuel-pin'));
  });
  const pans = await page.evaluate(async () => {
    const took = [];
    for (let i = 0; i < 4; i += 1) {
      const start = performance.now();
      state.map.panBy([i % 2 ? -160 : 160, i % 2 ? 90 : -90], { animate: false });
      took.push(Math.round(performance.now() - start));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return took;
  });
  const kept = await page.evaluate(() => {
    const now = [...document.querySelectorAll('#map .fuel-pin')];
    return { same: now.every((pin) => window.__seen.has(pin)), count: now.length };
  });
  check(`a pan keeps every pin as it was (${kept.count} pins, same elements: ${kept.same})`, kept.same && kept.count === city.pins);
  const full = await page.evaluate(() => {
    const start = performance.now();
    mapPins.forEach((pin) => state.markers.removeLayer(pin.marker));
    mapPins.clear();
    renderMarkers();
    return Math.round(performance.now() - start);
  });
  console.log(`     (a pan took ${pans.join(', ')} ms; building every pin anew ${full} ms)`);
  check('a pan costs a small part of building the pins anew', Math.max(...pans) < Math.max(40, full / 4));

  // A pin's popup stays open while the map moves under it.
  const opened = await page.evaluate(() => {
    const pin = [...mapPins.values()].find((item) => state.map.getBounds().pad(-0.3).contains(item.marker.getLatLng()));
    pin.marker.openPopup();
    return pin.station.id;
  });
  check('a tapped pin opens its popup', await becomes(page, () => !!document.querySelector('.leaflet-popup .popup-open'), null, 3000));
  check('with that station in it', (await page.evaluate(() => document.querySelector('.leaflet-popup .popup-open')?.getAttribute('onclick') || '')).includes(opened));
  await page.evaluate(() => state.map.panBy([40, 30], { animate: false }));
  await page.waitForTimeout(300);
  check('the popup stays open after the map moves', await page.evaluate(() => !!document.querySelector('.leaflet-popup .popup-open')));
  await page.evaluate(() => state.map.closePopup());

  // Closer in the pins in sight carry labels; further out they do not.
  await page.evaluate(() => state.map.setView([59.93428, 30.33512], 14, { animate: false }));
  check('close in, the pins in sight carry their labels', await becomes(page, () => {
    const pins = [...document.querySelectorAll('#map .fuel-pin')];
    return pins.length > 0 && pins.every((pin) => pin.classList.contains('labelled') && pin.querySelector('.pin-label'));
  }, null, 5000));
  await page.evaluate(() => state.map.setView([59.94, 30.31], 10, { animate: false }));
  check('further out, every station again, without labels', await becomes(page, (count) => {
    const pins = [...document.querySelectorAll('#map .fuel-pin')];
    return pins.length === count && pins.every((pin) => !pin.classList.contains('labelled'));
  }, city.pins, 5000));
  await page.screenshot({ path: path.join(OUT, `map-pins-${label}.png`) });

  // Another grade: the pins are those of the new grade.
  await page.click('#mapTop [data-map-grade="AI92"]');
  check('another grade paints the pins anew', await becomes(page, () => state.grade === 'AI92' && state.mapStationsGrade === 'AI92'
    && [...mapPins.values()].every((pin) => pin.station === state.mapStations.find((station) => station.id === pin.station.id)), null, 15000));

  // «👁 Свои» draws its own pins; back from it, nothing of them is left.
  const back = await page.evaluate(() => {
    state.ownOnly = true;
    renderMarkers();
    const ownOnly = document.querySelectorAll('#map .fuel-pin:not(.own-pin)').length;
    state.ownOnly = false;
    renderMarkers();
    return { ownOnly, stationsBack: document.querySelectorAll('#map .fuel-pin:not(.own-pin)').length, ownLeft: document.querySelectorAll('#map .own-pin').length, kept: mapPins.size };
  });
  check(`«👁 Свои» shows no station pins, and back from it every pin returns (${JSON.stringify(back)})`,
    back.ownOnly === 0 && back.stationsBack === back.kept && back.kept > 100 && back.ownLeft === 0);
  check(`no page errors (${errors.join(' | ') || 'none'})`, errors.length === 0);
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL MAP PIN CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

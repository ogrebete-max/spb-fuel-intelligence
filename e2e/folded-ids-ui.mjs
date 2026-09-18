// Отметки на карточках, которые свелись в одну (18.09.2026), и нижняя полоса.
//
// The day two cards became one, four of the club's marks lost their station:
// they had been made on the card that went, and its id is gone from the data.
// A folded card now carries its old ids (`also_ids`), and the app follows a
// mark — someone else's and one's own — to the card it belongs to now. The
// same morning the bottom bar drifted into the middle of the page again on an
// iPhone, so the bar is looked at here too, while the list is scrolled.
//   node e2e/folded-ids-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SITE_PORT = 9111;
const WORKER_PORT = 9112;
const HERE = { latitude: 59.9343, longitude: 30.3351 };
const GONE = 'spbfi-cardthatwent';
const MINUTE = 60 * 1000;

// ---- the nearest station, standing in for the card that absorbed another
const load = (grade) => JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', `stations-${grade}.json`), 'utf8'));
const metres = (station) => {
  const dy = (station.location.lat - HERE.latitude) * 111320;
  const dx = (station.location.lon - HERE.longitude) * 111320 * Math.cos((HERE.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
};
const listed = load('AI95').stations.filter((station) => station.location);
const KEEPER = listed.slice().sort((a, b) => metres(a) - metres(b))[0];
if (!KEEPER) throw new Error('the built data has no station near the test point');
console.log(`карточка, вобравшая соседа: ${KEEPER.network}, ${KEEPER.address}`);

// The bundles say which old ids this card answers for.
const served = (grade) => {
  const bundle = load(grade);
  for (const station of bundle.stations) {
    if (station.id === KEEPER.id) station.also_ids = [GONE];
  }
  return JSON.stringify(bundle);
};
const SERVED = Object.fromEntries(['AI92', 'AI95', 'AI98', 'AI100', 'DT']
  .map((grade) => [`/static-data/stations-${grade}.json`, served(grade)]));

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

// A mark made on the card that has since gone, by someone else of the club.
function seed() {
  const now = Date.now();
  env.REPORTS.values.set('reports', JSON.stringify([
    { station: GONE, grade: 'AI95', seen: true, at: now - 12 * MINUTE, who: 'phone-of-a-friend', name: 'Ирина', lat: KEEPER.location.lat, lon: KEEPER.location.lon, queue: null },
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
  // One's own mark, made on the same card before it went.
  await context.addInitScript(([id, at]) => {
    try {
      localStorage.setItem('spbfi-marks-v1', JSON.stringify({ [id]: { AI92: { seen: false, at, queue: null } } }));
    } catch (error) { /* private mode: the check below will say so */ }
  }, [GONE, Date.now() - 20 * MINUTE]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });
  await page.evaluate(() => pollGroupMarks());

  // 1. Someone else's mark finds the card that took the old one in.
  check('the app knows what the folded card was called', await becomes(page, (gone) => state.aliasOf?.[gone], GONE));
  check('the club mark lands on the card it belongs to now', await becomes(page, (id) => !!(state.groupMarks || {})[id]?.AI95, KEEPER.id));
  check('and not on an id of nobody', await page.evaluate((gone) => !(state.groupMarks || {})[gone], GONE));
  check('the day of «👁 Свои» counts it too', await page.evaluate((id) => !!(state.dayMarks || {})[id]?.AI95, KEEPER.id));

  // 2. One's own mark moves with it, on the phone as well.
  check('the mark kept on this phone moved to the card', await becomes(page, (id) => {
    const marks = JSON.parse(localStorage.getItem('spbfi-marks-v1') || '{}');
    return !!marks[id]?.AI92 && !marks[Object.keys(marks).find((key) => key.includes('cardthatwent')) || 'x'];
  }, KEEPER.id));

  // 3. The card says both, in words.
  const card = await page.evaluate((id) => document.querySelector(`#stationList .station-card[data-nearby-station="${id}"]`)?.textContent.replace(/\s+/g, ' ').trim() || '', KEEPER.id);
  check(`the card tells of the club's look: «${card.slice(0, 120)}…»`, /Свои видели|Ирина/.test(card));
  await page.screenshot({ path: path.join(OUT, `${label}-folded-1-card.png`) });

  // 4. The bottom bar stays on the glass while the list is scrolled.
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  const bar = await page.evaluate(() => {
    const element = document.querySelector('#modeBar');
    const box = element.getBoundingClientRect();
    return {
      bottom: Math.round(box.bottom),
      height: Math.round(window.innerHeight),
      glass: getComputedStyle(document.documentElement).getPropertyValue('--glass-bottom').trim(),
      shown: getComputedStyle(element).display !== 'none',
    };
  });
  if (bar.shown) {
    check(`the bar stands at the bottom of the screen after scrolling (${bar.bottom} of ${bar.height}, стекло ${bar.glass})`, Math.abs(bar.bottom - bar.height) <= 2);
    check(`the lift never reaches the middle of the page («${bar.glass}»)`, parseInt(bar.glass, 10) <= 120 || bar.glass === '0px' || bar.glass === '');
  } else {
    console.log('ok   (полосы нет на этом экране — пропускаем)');
  }

  // Even when the viewport pretends the keyboard is up, the bar does not climb.
  const lifted = await page.evaluate(() => {
    const view = window.visualViewport;
    const kept = Object.getOwnPropertyDescriptor(view, 'height');
    Object.defineProperty(view, 'height', { configurable: true, value: window.innerHeight - 320 });
    keepOnGlass();
    const glass = getComputedStyle(document.documentElement).getPropertyValue('--glass-bottom').trim();
    if (kept) Object.defineProperty(view, 'height', kept); else delete view.height;
    keepOnGlass();
    return glass;
  });
  check(`a viewport 320 px shorter leaves the bar where it is («${lifted}»)`, lifted === '0px');

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL FOLDED-ID CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

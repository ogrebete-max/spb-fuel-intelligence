// A phone opens the app within GitHub Pages' ten minutes of caching after a new
// build and is handed the old page. The app must notice at once, from the
// fresh meta.json, and reload itself onto the new build — once, not in a loop.
// WebKit (iPhone) and Chromium (Android).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8981;
const BUILD = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'meta.json'), 'utf8')).build;

let pagesServed = 0;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${SITE_PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    if (path.extname(file) === '.html') {
      pagesServed += 1;
      // The first page is the one left in the phone's cache: an older build.
      const html = data.toString('utf8');
      res.end(pagesServed === 1 ? html.replace(/window\.SPBFI_BUILD = "[^"]*"/, 'window.SPBFI_BUILD = "old-build"') : html);
      return;
    }
    res.end(data);
  });
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  pagesServed = 0;
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  let loads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  const timeline = [];
  const started = Date.now();
  page.on('load', () => {
    loads += 1;
    timeline.push(`${loads}: +${Date.now() - started} мс`);
  });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  // The app never reloads itself in its first seconds — that is how an iPhone
  // was left with a white screen (18 Sep 2026) — so it walks onto the new
  // build a moment after it is on screen, not instantly.
  const arrived = await page.waitForFunction((build) => window.SPBFI_BUILD === build, BUILD, { timeout: 30000 }).then(() => true, () => false);
  check(`the old page reloads itself onto the new build (${await page.evaluate(() => window.SPBFI_BUILD)})`, arrived);
  // Смысл проверки — что приложение не крутится в цикле: перезагрузка на новую
  // сборку одна, и после неё ничего больше не происходит. Точное число загрузок
  // проверять нельзя — браузер иногда успевает перезагрузиться раньше, чем
  // объявит о первой загрузке, и её не видно.
  await page.waitForTimeout(6000);
  console.log(`   загрузки: ${timeline.join(', ') || 'ни одной не замечено'} | сборка сейчас: ${await page.evaluate(() => window.SPBFI_BUILD)}`);
  check(`once, not in a loop (${loads} loads)`, loads <= 2
    && await page.evaluate((build) => window.SPBFI_BUILD === build, BUILD));
  check('and the list is there', await page.waitForSelector('.station-card', { timeout: 30000 }).then(() => true, () => false));
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

// A new build published while someone drives must not take the screen away: the
// reload blanks it for a second, leaves the ordinary map in its place and on an
// iPhone asks for the place again («этот сброс раздражает», 28 Sep 2026). It
// waits until the navigator is closed, and then happens.
async function driving(label, browserType, device) {
  console.log(`\n=== ${label}-driving`);
  // The page served is the new build itself; the app is then told it is old.
  pagesServed = 1;
  const browser = await browserType.launch();
  // The navigator stays open only for a phone that says where it is; a refused
  // location closes it by itself.
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 59.9343, longitude: 30.3351, accuracy: 12 } });
  const page = await context.newPage();
  const errors = [];
  let loads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('load', () => { loads += 1; });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });
  // Past the seconds in which the app never reloads itself, so only the
  // navigator can hold the reload back.
  await page.waitForTimeout(9000);
  const opened = await page.evaluate(() => { openDrive('button'); window.SPBFI_BUILD = 'old-build'; return drive.open; });
  const before = loads;
  await page.evaluate(() => pollForNewSnapshot());
  await page.waitForTimeout(4000);
  check('a new build leaves the navigator alone while it is open', opened && loads === before
    && await page.evaluate(() => drive.open && window.SPBFI_BUILD === 'old-build'));
  await page.evaluate(() => closeDrive());
  await page.evaluate(() => pollForNewSnapshot());
  // Counted here rather than asked of the page: the reload lands in the middle
  // of the asking and the answer is lost with the page that was asked.
  const end = Date.now() + 30000;
  while (loads === before && Date.now() < end) await page.waitForTimeout(250);
  await page.waitForLoadState('load');
  const build = await page.evaluate(() => window.SPBFI_BUILD).catch(() => null);
  check(`the new build is taken as soon as the navigator is closed (${loads - before} load, build ${build})`, loads > before && build === BUILD);
  check('and the list is there', await page.waitForSelector('.station-card', { timeout: 30000 }).then(() => true, () => false));
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
  await driving('iphone', webkit, devices['iPhone 13']);
  await driving('android', chromium, devices['Pixel 7']);
} finally {
  siteServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL UPDATE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

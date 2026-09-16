// A new build while the app is open, and the app opened again right after it
// (16 Sep 2026: the owner looked at the app on a computer minutes after a new
// build and saw the old one). The site answers as GitHub Pages does, letting a
// browser keep every file ten minutes, and the service worker is on. Coming
// back to the window finds the new build at once, and an app opened again
// starts on the new page without loading the old one first.
// Chromium as a laptop, WebKit as an iPhone.
//   node e2e/update-laptop-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const PORT = 9111;
let build = 'build-a';
const pages = { served: 0 };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const name = url.pathname === '/' ? '/index.html' : url.pathname;
  const headers = { 'Cache-Control': 'max-age=600' };
  if (name === '/config.js') {
    res.writeHead(200, { ...headers, 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  const file = path.join(SITE, decodeURIComponent(name));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    if (name === '/index.html') {
      pages.served += 1;
      res.end(data.toString('utf8').replace(/window\.SPBFI_BUILD = "[^"]*"/, `window.SPBFI_BUILD = "${build}"`));
      return;
    }
    if (name === '/static-data/meta.json') {
      res.end(JSON.stringify({ ...JSON.parse(data.toString('utf8')), build }));
      return;
    }
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
// Stands for the minute that has passed since the app last reloaded itself.
const aMinuteLater = (page) => page.evaluate(() => sessionStorage.removeItem('spbfi-auto-reload-at'));

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  build = 'build-a';
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });
  // The first visit installs the service worker, which takes the page over.
  const controlled = await becomes(page, () => !!navigator.serviceWorker?.controller, null, 15000);
  await page.waitForLoadState('load');
  await page.waitForSelector('.station-card', { timeout: 30000 });
  console.log(`     (service worker in control: ${controlled})`);

  // 1. The window stays open; a new build comes out; one comes back to the window.
  build = 'build-b';
  await aMinuteLater(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('coming back to the window finds the new build within seconds', await becomes(page, () => window.SPBFI_BUILD === 'build-b', null, 10000));
  await page.waitForSelector('.station-card', { timeout: 30000 });
  await page.close();

  // 2. Another build; the app is opened again within the ten minutes of caching.
  build = 'build-c';
  const before = pages.served;
  const again = await context.newPage();
  again.on('pageerror', (error) => errors.push(error.message));
  let loads = 0;
  again.on('load', () => { loads += 1; });
  await again.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await again.waitForSelector('.station-card', { timeout: 30000 });
  await again.waitForTimeout(4000);
  const opened = await again.evaluate(() => window.SPBFI_BUILD);
  if (controlled) {
    check(`opened again, it starts on the new build (${opened}), asking the site for the page (${pages.served - before}), in one load (${loads})`, opened === 'build-c' && loads === 1 && pages.served - before === 1);
  } else {
    check(`opened again without a service worker, it still ends on the new build (${opened})`, opened === 'build-c');
  }
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('laptop · Chromium', chromium, { viewport: { width: 1440, height: 900 } });
  await run('iPhone · WebKit', webkit, devices['iPhone 13']);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL LAPTOP UPDATE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

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
  page.on('load', () => { loads += 1; });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(7000);
  check(`the old page reloads itself onto the new build (${await page.evaluate(() => window.SPBFI_BUILD)})`, await page.evaluate((build) => window.SPBFI_BUILD === build, BUILD));
  check(`once, not in a loop (${loads} loads)`, loads === 2);
  check('and the list is there', await page.waitForSelector('.station-card', { timeout: 30000 }).then(() => true, () => false));
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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL UPDATE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

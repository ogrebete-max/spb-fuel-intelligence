// Белый экран при открытии (19.09.2026, iPhone владельца: «висит, пока не
// закроешь крестиком»).
//
// The phone's connection does not always fail — it hangs. The page came out of
// the worker's cache at once, and then the code behind it waited on a network
// that never answered: nothing was drawn, and nothing could be, until the app
// was closed and opened again. Here the site stops answering for the code and
// the styles, and the app must still come up — from the copy the worker keeps
// — or, if it has no copy at all, say so with a button instead of white.
//   node e2e/white-screen-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9191;
const HERE = { latitude: 60.06, longitude: 30.42 };

let stalling = false;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  // A connection that hangs instead of failing: the request is simply left open.
  if (stalling && /app\.js|styles\.css/.test(url.pathname)) return;
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

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  stalling = false;
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, permissions: ['geolocation'], geolocation: { ...HERE, accuracy: 20 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });
  check('the app opens and its worker is installed', await page.evaluate(() => !!navigator.serviceWorker));
  // The worker is given a moment to keep this build's code, as the app asks it to.
  await page.waitForTimeout(3000);
  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = [];
    for (const name of names) urls.push(...(await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname + new URL(request.url).search));
    return urls;
  });
  check(`the worker keeps this build's code (${kept.filter((url) => /app\.js|styles\.css/.test(url)).join(', ') || 'nothing'})`,
    kept.some((url) => url.includes('app.js?v=')) && kept.some((url) => url.includes('styles.css?v=')));

  // Opened again on a connection that hangs: the app must come up all the same.
  stalling = true;
  await page.reload({ waitUntil: 'commit' });
  const alive = await page.waitForFunction(() => !!document.querySelector('#stationList .station-card'), null, { timeout: 15000 }).then(() => true, () => false);
  check('on a network that hangs the app still comes up, from the kept code', alive);
  check('and says nothing about not loading', await page.evaluate(() => !document.getElementById('stalledNote')));
  if (alive) await page.screenshot({ path: path.join(OUT, `${label}-white-1-alive.png`), timeout: 5000 }).catch(() => {});

  // A phone that has never had the code, on the same hanging network: a way out
  // instead of a white screen.
  const bare = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const first = await bare.newPage();
  await first.goto(`http://localhost:${PORT}/`, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
  await first.waitForTimeout(9000);
  const words = await first.evaluate(() => document.getElementById('stalledNote')?.textContent.replace(/\s+/g, ' ').trim() || '').catch(() => '');
  check(`with no code at all it offers a way out: «${words.slice(0, 60)}»`, words.includes('не загрузилось') && words.includes('Обновить'));
  await bare.close();

  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL WHITE-SCREEN CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// A mark made with no signal at the pump, in WebKit (iPhone) and Chromium
// (Android): it waits on the phone, the app says so, and it goes out once the
// connection is back, dated when it was made. A newer look replaces a waiting
// older one, and a server out of its daily writes is reported in words.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8871;
const WORKER_PORT = 8872;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}

let env;
// 'up' answers; 'down' drops every report request like a dead connection;
// 'full' answers reports the way a worker out of daily writes does.
let mode = 'up';

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
  if (mode === 'down' && req.url.startsWith('/report')) {
    req.socket.destroy();
    return;
  }
  if (mode === 'full' && req.method === 'POST' && req.url === '/report') {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': `http://localhost:${SITE_PORT}` });
    res.end('{"error":"storage_limit"}');
    return;
  }
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
const STATION = { lat: 60.044512, lon: 30.417874 };
const stored = async () => (await (await worker.fetch(new Request(`http://localhost:${WORKER_PORT}/reports`), env, { waitUntil() {} })).json()).reports;
const eventually = async (predicate, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
};
const shows = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const toastSays = (page, words) => shows(page, (text) => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes(text)), words);
const outbox = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('spbfi-outbox-v1') || '[]'));

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  mode = 'up';
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: STATION.lat + 0.00055, longitude: STATION.lon, accuracy: 10 },
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  const errors = [];
  // WebKit reports every failed cross-origin load as a page error, even one the
  // app catches ("… due to access control checks"). This test cuts the
  // connection on purpose, so only other errors count.
  page.on('pageerror', (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message); });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });
  await page.evaluate(() => pollGroupMarks());
  check('the app learned the worker takes late marks', await page.evaluate(() => state.workerLateMarks === true));
  await page.evaluate(() => startFollowing({ manual: true }));
  await page.waitForFunction(() => document.querySelector('#herePanel:not([hidden]) .quick-grade') || document.querySelector('.card-actions .quick-grade'), null, { timeout: 20000 });
  const scope = await page.evaluate(() => (document.querySelector('#herePanel:not([hidden]) .mark-composer') ? '#herePanel' : '.card-actions'));

  // No signal at the pump.
  mode = 'down';
  await page.click(`${scope} .quick-grade[data-quick-grade="AI95"]`);
  await page.click(`${scope} .compose-send`);
  check('the line under the buttons says the mark will go later', await shows(page, (s) => document.querySelector(`${s} .mark-sent`)?.textContent.includes('уйдёт само'), scope, 3500));
  check('a banner says there is no connection', await toastSays(page, 'Нет связи'));
  const waiting = await outbox(page);
  check(`the look waits on the phone (${waiting.length})`, waiting.length === 1 && Number.isFinite(waiting[0].observed_at));
  check('the feed shows it is waiting', await shows(page, () => document.querySelector('.feed-outbox')?.textContent.includes('ждёт связи')));
  check('nothing reached the worker', (await stored()).length === 0);
  await page.screenshot({ path: path.join(OUT, `${label}-outbox-waiting.png`) });

  // Ten minutes without signal, then the connection is back.
  await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('spbfi-outbox-v1'));
    items[0].observed_at -= 10 * 60 * 1000;
    localStorage.setItem('spbfi-outbox-v1', JSON.stringify(items));
  });
  const observedAt = (await outbox(page))[0].observed_at;
  mode = 'up';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  check('the look reached the worker once the connection was back', await eventually(async () => (await stored()).length === 1));
  const [report] = await stored();
  check(`dated when it was made, ${report ? Math.round((Date.now() - report.at) / 60000) : '?'} min ago`, report && Math.abs(report.at - observedAt) < 5);
  check('the phone no longer holds it', await shows(page, () => !localStorage.getItem('spbfi-outbox-v1') && !document.querySelector('.feed-outbox')));
  check('a banner says it went out', await toastSays(page, 'ушла'));

  // A newer look replaces a waiting older one about the same grade.
  mode = 'down';
  await page.evaluate((id) => shareMark(id, 'DT', true), report.station);
  const first = await outbox(page);
  await page.evaluate((id) => shareMark(id, 'DT', false), report.station);
  const second = await outbox(page);
  check(`the newer look replaces the waiting one (${first.length} → ${second.length})`, first.length === 1 && second.length === 1 && second[0].seen === false);
  mode = 'up';
  await page.evaluate(() => flushOutbox());
  const diesel = (await stored()).filter((item) => item.grade === 'DT');
  check('only the newer look arrives', diesel.length === 1 && diesel[0].seen === false);

  // The server has used up its daily writes.
  mode = 'full';
  const outcome = await page.evaluate((id) => shareMark(id, 'AI92', false), report.station);
  check(`a full server refuses the mark (${outcome})`, outcome === 'refused');
  check('a banner says the daily limit ran out', await toastSays(page, 'лимит'));
  check('nothing waits in vain', (await outbox(page)).length === 0);
  await page.screenshot({ path: path.join(OUT, `${label}-outbox-limit.png`) });

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL OUTBOX UI CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

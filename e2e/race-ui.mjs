// The lost-grades bug, reproduced end to end: a slow KV, a phone that marks
// 92, 95 and 98 «нет» in one go. Once against a worker that does not take
// batches (like the one deployed now) and once against one that does.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8861;
const WORKER_PORT = 8862;

class SlowKV {
  constructor() { this.values = new Map(); }
  async get(key, options) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const value = this.values.get(key);
    return value == null ? null : options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.values.set(key, String(value));
  }
}

let env;
let oldWorker = false;
let inFlight = 0;
let maxInFlight = 0;
let reportRequests = 0;

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
  const isReport = req.method === 'POST' && req.url.startsWith('/report');
  if (isReport) {
    reportRequests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
  }
  let body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
  // The deployed worker reads only `grade`: a batch body would be refused.
  if (isReport && oldWorker && JSON.parse(body.toString()).grades) {
    inFlight -= 1;
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': `http://localhost:${SITE_PORT}` });
    res.end('{"error":"old worker takes one grade"}');
    return;
  }
  const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, { method: req.method, headers: req.headers, body });
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  let payload = Buffer.from(await response.arrayBuffer());
  if (oldWorker && req.method === 'GET' && req.url.startsWith('/reports')) {
    const data = JSON.parse(payload.toString());
    delete data.batch;
    payload = Buffer.from(JSON.stringify(data));
  }
  if (isReport) inFlight -= 1;
  const headers = Object.fromEntries(response.headers);
  delete headers['content-length'];
  res.writeHead(response.status, headers);
  res.end(payload);
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));
await new Promise((resolve) => workerServer.listen(WORKER_PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const STATION = { lat: 60.044512, lon: 30.417874 };

async function run(label, browserType, device, legacy) {
  console.log(`\n=== ${label} · ${legacy ? 'worker without batches (deployed today)' : 'worker with batches'}`);
  env = { REPORTS: new SlowKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  oldWorker = legacy;
  inFlight = 0;
  maxInFlight = 0;
  reportRequests = 0;
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: STATION.lat + 0.00055, longitude: STATION.lon, accuracy: 10 },
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.station-card', { timeout: 30000 });
  await page.evaluate(() => pollGroupMarks());
  check(`app learned batch support = ${!legacy}`, await page.evaluate(() => state.workerBatch) === !legacy);
  await page.evaluate(() => startFollowing({ manual: true }));
  await page.waitForFunction(() => document.querySelector('#herePanel:not([hidden]) .quick-grade') || document.querySelector('.card-actions .quick-grade'), null, { timeout: 20000 });
  const scope = await page.evaluate(() => (document.querySelector('#herePanel:not([hidden]) .mark-composer') ? '#herePanel' : '.card-actions'));
  for (const grade of ['AI92', 'AI95', 'AI98']) {
    await page.click(`${scope} .quick-grade[data-quick-grade="${grade}"]`);
    await page.click(`${scope} .quick-grade[data-quick-grade="${grade}"]`);
  }
  await page.click(`${scope} .compose-send`);
  const stored = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const list = JSON.parse(env.REPORTS.values.get('reports') || '[]');
      if (list.length >= 3) return list;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return JSON.parse(env.REPORTS.values.get('reports') || '[]');
  })();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const final = JSON.parse(env.REPORTS.values.get('reports') || '[]');
  check(`all three grades kept (${final.map((r) => `${r.grade.replace('AI', '')} ${r.seen ? 'есть' : 'нет'}`).join(', ')})`, final.length === 3 && ['AI92', 'AI95', 'AI98'].every((g) => final.some((r) => r.grade === g && r.seen === false)));
  check(`reports never overlapped (max in flight ${maxInFlight})`, maxInFlight === 1);
  check(`requests: ${reportRequests} (${legacy ? 'one per grade' : 'one for the whole look'})`, legacy ? reportRequests === 3 : reportRequests === 1);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13'], true);
  await run('iphone', webkit, devices['iPhone 13'], false);
  await run('android', chromium, devices['Pixel 7'], true);
  await run('android', chromium, devices['Pixel 7'], false);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL RACE UI CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

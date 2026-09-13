// «Свои» is a view of its own. On 13 Sep 2026 a Windows laptop lit up status
// chips while the list stayed on the one station the group had marked, and
// everything applied at once only when «Свои» was pressed again. Any other
// filter must leave the view at once, on a laptop and on a phone.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 8871;
const WORKER_PORT = 8872;

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

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: 59.9343, longitude: 30.3351, accuracy: 15 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });

  // Someone in the group marks the first station of the list.
  await page.evaluate(async (endpoint) => {
    const station = state.stations[0];
    await fetch(`${endpoint}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: station.id, who: 'someone-else', lat: station.location.lat, lon: station.location.lon, grades: [{ grade: 'AI92', seen: false }, { grade: 'AI95', seen: true }] }),
    });
    await pollGroupMarks();
  }, `http://localhost:${WORKER_PORT}`);
  const chip = await page.waitForSelector('#statusStrip .status-chip[data-own]', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${label}: the «Свои» chip appears after a group mark`, chip);
  if (!chip) { await browser.close(); return; }

  const snapshot = () => page.evaluate(() => ({
    ownOnly: state.ownOnly, status: state.status, timeline: state.timeline, grade: state.grade, area: state.area,
    cards: document.querySelectorAll('#stationList .station-card:not(.own-card)').length,
    active: [...document.querySelectorAll('#statusStrip .status-chip.active')].map((item) => (item.dataset.own ? 'own' : item.dataset.timeline || item.dataset.status)),
  }));
  const enter = async () => {
    if (!(await page.evaluate(() => state.ownOnly))) await page.click('#statusStrip .status-chip[data-own]', { timeout: 5000 });
    return page.waitForFunction(() => state.ownOnly && document.querySelector('#stationList .own-card'), null, { timeout: 10000 }).then(() => true).catch(() => false);
  };
  const leaves = async (name, action, expect = () => true, needCards = true) => {
    if (!(await enter())) { check(`${label}: «Свои» opens before ${name}`, false); return; }
    const started = Date.now();
    try {
      await action();
    } catch (error) {
      check(`${label}: ${name} can be pressed (${String(error.message).split('\n')[0]})`, false);
      return;
    }
    const shown = await page.waitForFunction((cards) => !state.ownOnly
      && !document.querySelector('#stationList .own-card')
      && (!cards || document.querySelector('#stationList .station-card')), needCards, { timeout: 10000 }).then(() => true).catch(() => false);
    const ms = Date.now() - started;
    const s = await snapshot();
    check(`${label}: ${name} leaves «Свои» in ${ms} ms (${s.cards} cards, lit ${JSON.stringify(s.active)})`, shown && !s.active.includes('own') && expect(s));
  };

  // A status chosen before «Свои» must not stay lit inside it.
  await page.click('#statusStrip .status-chip[data-status]:not([disabled])');
  await page.waitForFunction(() => state.status != null);
  await enter();
  const inside = await snapshot();
  check(`${label}: inside «Свои» only its chip is lit (${JSON.stringify(inside.active)})`, inside.ownOnly && inside.status == null && inside.timeline == null && JSON.stringify(inside.active) === '["own"]');
  check(`${label}: the way back is on screen`, await page.isVisible('#stationList [data-own-back]'));

  await leaves('a status chip', () => page.click('#statusStrip .status-chip[data-status]:not([disabled])', { timeout: 5000 }), (s) => s.status != null && s.active.includes(s.status));
  if (await page.$('#statusStrip .status-chip[data-timeline]:not([disabled])')) {
    await leaves('«Появилось недавно»', () => page.click('#statusStrip .status-chip[data-timeline]:not([disabled])', { timeout: 5000 }), (s) => s.timeline === 'appeared' && s.active.includes('appeared'), false);
  }
  await leaves('a fuel grade', () => page.click('#gradePicker [data-grade="AI92"]', { timeout: 5000 }), (s) => s.grade === 'AI92');
  // On a touch phone with location allowed «рядом» follows the phone, and the
  // area buttons are hidden in that mode on purpose.
  if (await page.isVisible('[data-area="spb"]')) {
    await leaves('the area switch', () => page.click('[data-area="spb"]', { timeout: 5000 }), (s) => s.area === 'spb');
  } else {
    console.log(`skip ${label}: the area switch is hidden while «рядом» follows the phone`);
  }
  await leaves('the sort menu', () => page.selectOption('#sortSelect', { index: 1 }, { timeout: 5000 }));
  await leaves('«Показать все АЗС»', () => page.click('#stationList [data-own-back]', { timeout: 5000 }));
  await leaves('pressing «Свои» again', () => page.click('#statusStrip .status-chip[data-own]', { timeout: 5000 }));
  await leaves('typing in the search box', () => page.fill('#searchInput', 'а', { timeout: 5000 }), () => true, false);
  await page.fill('#searchInput', '');
  if (await page.evaluate(() => !!state.map)) {
    await leaves('«Искать в этой области»', () => page.evaluate(() => document.querySelector('#mapAreaButton').click()), () => true, false);
    await page.evaluate(() => resetFilters());
    await page.waitForSelector('#stationList .station-card:not(.own-card)', { timeout: 10000 });
  }
  await leaves('«Рядом со мной»', () => page.click('#locateButton', { timeout: 5000 }), () => true, false);
  if (await page.waitForSelector('#searchContext [data-clear-scope]', { timeout: 15000 }).then(() => true).catch(() => false)) {
    await leaves('«Весь город»', () => page.click('#searchContext [data-clear-scope]', { timeout: 5000 }));
  }
  check(`${label}: no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('Windows laptop · Chromium', chromium, { viewport: { width: 1440, height: 900 } });
  await run('iPhone · WebKit', webkit, devices['iPhone 13']);
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL OWN-MODE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

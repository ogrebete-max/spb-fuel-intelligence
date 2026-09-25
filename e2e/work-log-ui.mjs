// 25 Sep 2026, the owner: «логи везде… кто что нажимает, кто чем пользуется,
// кто чем не пользуется, у кого что получается — включай всё». web/log.js keeps
// the app's own events and sends them in batches to the log receiver on the
// club's server, another origin than the app on GitHub Pages. A stand-in
// receiver takes them here and refuses what the real one (ladoga_logs.py)
// refuses; it answers with CORS first, then without, and every event must still
// come exactly once. Checked: what goes out (the launch, taps by the buttons'
// own names, GPS fixes with the place rounded to about a kilometre, the
// navigator's moments, the name a person typed), what never does (text typed
// into the app, the exact place, anything while «Отправлять журнал работы» or
// the statistics are off, under Global Privacy Control, or with no log address
// in config.js), «Сообщить о проблеме» from «i» and from the navigator's ◐, and
// the form on a narrow phone. WebKit (iPhone) and Chromium (Android).
//   node e2e/work-log-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9331;
const WORKER_PORT = 9332;
const LOG_PORT = 9333;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const HERE = { latitude: 59.93428, longitude: 30.33512, accuracy: 12 };
// Across town, with a radius no driver can use: an odd fix, written at once.
const ROUGH = { latitude: 59.95173, longitude: 30.40291, accuracy: 900 };
const TYPED = 'Невский проспект 28';
const PROBLEM = 'Карта не двигается пальцем — проверка журнала';
const NAME = 'Проверка Журнала';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) { const v = this.values.get(key); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v; }
  async put(key, value) { this.values.set(key, String(value)); }
}

let env;
// Whether config.js names the log's address; the other browser checks leave it out.
let logAddress = true;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${SITE_PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end(`window.SPBFI_REPORT_ENDPOINT = 'http://localhost:${WORKER_PORT}'; window.SPBFI_ANALYTICS_ENDPOINT = 'http://localhost:${WORKER_PORT}';`
      + (logAddress ? ` window.SPBFI_LOG_ENDPOINT = 'http://localhost:${LOG_PORT}';` : ''));
    return;
  }
  const file = path.join(SITE, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  // The log comes late, after the app's first fix, as on a slow network: what
  // happened before it must wait for it rather than be lost.
  setTimeout(() => fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  }), url.pathname === '/log.js' ? 1500 : 0);
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

// The stand-in for ladoga_logs.py: the same addresses, the same answers, and
// the same refusals (clean_batch: v 1, the ids' alphabet, small flat events).
const inbox = { cors: true, logs: [], reports: [], bad: [], probes: 0, hits: 0 };
const ID = /^[a-z0-9]{4,40}$/;
function badBatch(body, kind) {
  if (!body || body.v !== 1 || !Array.isArray(body.events)) return 'shape';
  if (!ID.test(String(body.iid || '')) || (body.sid && !ID.test(String(body.sid)))) return 'id';
  if (body.events.length > (kind === 'log' ? 300 : 600)) return 'too many events';
  for (const ev of body.events) {
    if (typeof ev?.e !== 'string' || typeof ev.t !== 'number') return 'event';
    const keys = Object.keys(ev);
    if (keys.length > 24 || keys.some((key) => key.length > 24)) return 'fields';
    if (Object.values(ev).some((value) => value !== null && typeof value === 'object')) return 'nested';
  }
  if (kind === 'report' && (typeof body.text !== 'string' || body.text.length > 2000)) return 'text';
  return '';
}
const logServer = http.createServer(async (req, res) => {
  inbox.hits += 1;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = { 'Cache-Control': 'no-store', ...(inbox.cors ? { 'Access-Control-Allow-Origin': `http://localhost:${SITE_PORT}`, Vary: 'Origin' } : {}) };
  const url = new URL(req.url, `http://localhost:${LOG_PORT}`);
  if (req.method === 'GET' && url.pathname === '/applog/health') {
    inbox.probes += 1;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const kind = /^\/applog\/fuel\/(log|report)$/.exec(url.pathname)?.[1];
  if (req.method !== 'POST' || !kind) {
    res.writeHead(404, headers);
    res.end();
    return;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try { body = JSON.parse(raw); } catch { /* refused below */ }
  const why = Buffer.byteLength(raw) > (kind === 'log' ? 512 * 1024 : 1024 * 1024) ? 'size' : badBatch(body, kind);
  if (why) {
    inbox.bad.push(`${kind}: ${why}`);
    res.writeHead(400, headers);
    res.end();
    return;
  }
  (kind === 'log' ? inbox.logs : inbox.reports).push({ body, raw, type: String(req.headers['content-type'] || '') });
  res.writeHead(204, headers);
  res.end();
});
await new Promise((resolve) => siteServer.listen(SITE_PORT, resolve));
await new Promise((resolve) => workerServer.listen(WORKER_PORT, resolve));
await new Promise((resolve) => logServer.listen(LOG_PORT, resolve));

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const eventually = async (predicate, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};
const tap = async (page, selector, timeout = 5000) => {
  try {
    await page.click(selector, { timeout });
    return true;
  } catch (error) {
    // What lay over the button, beside what the browser said.
    const seen = await page.evaluate((s) => {
      const element = document.querySelector(s);
      if (!element) return 'not in the page';
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}, on top: ${hit ? `${hit.tagName.toLowerCase()}#${hit.id}.${[...hit.classList].join('.')}` : 'nothing'}`;
    }, selector).catch(() => '?');
    // eslint-disable-next-line no-control-regex
    const why = String(error.message).replace(/\u001b\[\d+m/g, '').split('\n').filter((line) => line.trim().startsWith('-')).slice(-4).join(' / ');
    console.log(`     (could not tap ${selector}: ${String(error.message).split('\n')[0]}; ${seen}; ${why})`);
    fs.appendFileSync(path.join(OUT, 'worklog-taps.txt'), `${new Date().toISOString()} ${selector}\n${error.message}\n\n`);
    return false;
  }
};
const drawerSays = (page, title) => becomes(page, (want) => document.querySelector('#detailDrawer').classList.contains('open')
  && document.querySelector('#drawerContent h2')?.textContent === want, title, 5000);
const drawerText = (page) => page.evaluate(() => document.querySelector('#drawerContent').textContent.replace(/\s+/g, ' '));
const eventsOf = (iid) => inbox.logs.filter((row) => row.body.iid === iid).flatMap((row) => row.body.events);
const has = (list, name, fields = {}) => list.some((ev) => ev.e === name && Object.entries(fields).every(([key, value]) => ev[key] === value));
// Everything the phone holds goes out now, instead of in twenty seconds.
async function drain(page) {
  for (let i = 0; i < 25; i += 1) {
    const left = await page.evaluate(async () => {
      await window.SPBFILog.flush();
      return window.SPBFILog.pending();
    });
    if (!left) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function phone(browser, device, { gpc = false, blind = false, noShare = false } = {}) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: HERE });
  // A person's phone rather than an automated browser: the log does not write for robots.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  if (gpc) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }));
  if (noShare) await context.addInitScript(() => { Navigator.prototype.canShare = () => false; });
  const page = await context.newPage();
  // A tap during a sliding panel would land where the button was a moment ago.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  // WebKit reports any cross-origin fetch it refused, even one the app caught:
  // the log's question to a receiver without CORS is one such, on purpose.
  page.on('pageerror', (error) => { if (!(blind && /access control checks/i.test(error.message))) errors.push(error.message); });
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  await page.goto(siteUrl, { waitUntil: 'load' });
  return { context, page, errors };
}

const ready = (page) => becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0 && !!window.SPBFILog, null, 30000);
const toList = async (page) => {
  if (await page.evaluate(() => drive.open)) await tap(page, '#drive [data-drive="close"]');
  if (await page.evaluate(() => document.body.classList.contains('map-screen'))) await tap(page, '#modeBar [data-screen="list"]', 20000);
};

async function run(label, browserType, device, narrow) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  Object.assign(inbox, { cors: true, logs: [], reports: [], bad: [], probes: 0, hits: 0 });
  logAddress = true;
  const browser = await browserType.launch();
  const { context, page, errors } = await phone(browser, device);
  check('the app opens', await ready(page));
  check('what the app did before the late log came is taken in', await becomes(page, () => !!window.SPBFILog && !(window.SPBFI_LOG_EARLY?.length), null, 5000));
  const iid = await page.evaluate(() => localStorage.getItem('spbfi-log-install-v1'));
  const build = await page.evaluate(() => window.SPBFI_BUILD);
  check(`the phone has an install id the receiver takes (${iid})`, ID.test(iid || ''));

  // 1. The first batch goes by itself, some twenty seconds after the launch.
  check('the first batch goes out by itself', await eventually(() => eventsOf(iid).length > 0, 40000));
  check('after asking the receiver once whether it answers this page (CORS)', inbox.probes === 1 && await page.evaluate(() => window.SPBFILog.route()) === 'cors');

  // 2. The navigator: its ◐ leads to «Сообщить о проблеме», over the navigator.
  if (!(await page.evaluate(() => drive.open))) await tap(page, '#modeBar [data-screen="drive"]');
  check('the navigator is open', await becomes(page, () => drive.open, null, 5000));
  await tap(page, '#drive [data-drive="theme"]');
  check('its ◐ offers «Сообщить о проблеме»', await becomes(page, () => !!document.querySelector('#drivePick:not([hidden]) [data-drive="problem"]'), null, 3000));
  await tap(page, '#drivePick [data-drive="problem"]');
  const formUp = await drawerSays(page, 'Сообщить о проблеме');
  // The drawer slides in for a quarter of a second.
  await page.waitForTimeout(500);
  check('which opens the form over the navigator', formUp && await page.evaluate(() => {
    const field = document.querySelector('#problemText').getBoundingClientRect();
    return document.querySelector('#detailDrawer').contains(document.elementFromPoint(field.left + field.width / 2, field.top + field.height / 2));
  }));
  await page.screenshot({ path: path.join(OUT, `worklog-${label}-1-nav-form.png`) });
  await tap(page, '#drawerClose');
  // A finger takes the map off the car; «⌖» brings it back.
  await page.evaluate(() => loosenDriveMap());
  await tap(page, '#drive [data-drive="recenter"]');
  await tap(page, '#drive [data-drive="close"]');
  // The map screen draws every station in town: in the check's WebKit, which
  // paints without a graphics card, the page stands still for seconds after it
  // opens (with or without the log), and the bar waits for it.
  await tap(page, '#modeBar [data-screen="list"]', 20000);
  await tap(page, '#gradePicker [data-grade="AI92"]');
  // The phone jumps across town with a rough fix. (Before the search: typing
  // there leaves «рядом», and the app stops following the phone.)
  await context.setGeolocation(ROUGH);
  check('the app hears the rough fix', await becomes(page, () => state.accuracy === 900, null, 8000));
  await page.fill('#searchInput', TYPED);
  await page.waitForTimeout(500);
  await page.fill('#searchInput', '');
  await tap(page, '#aboutButton');
  check('«i» says the work log is sent, with the switch on', await drawerSays(page, 'Что здесь иначе')
    && (await drawerText(page)).includes('Журнал работы: отправляется') && await page.isChecked('#workLogSend'));
  await page.fill('#workLogWho', NAME);
  await tap(page, '#drawerClose');
  check('everything goes out', await drain(page));

  const all = eventsOf(iid);
  const taps = [...new Set(all.filter((ev) => ev.e === 'tap').map((ev) => ev.what))];
  check('the launch: «start» and «ready»', has(all, 'start') && has(all, 'ready'));
  const startAt = all.find((ev) => ev.e === 'start')?.t;
  check('«start» is dated when the page began to open, before anything else', all.every((ev) => ev.t >= startAt));
  check('the navigator\'s moments: opened, map freed, back by «⌖», closed',
    has(all, 'nav_start') && has(all, 'map_free') && has(all, 'recenter', { why: 'button' }) && has(all, 'nav_end'));
  check(`taps by the buttons' own names (${taps.join(', ')})`,
    ['drive-theme', 'drive-problem', 'drive-recenter', 'drive-close', 'screen-list', 'aboutButton', 'drawerClose'].every((what) => taps.includes(what))
    && has(all, 'tap', { what: 'grade', v: 'AI92', on: 'list' }));
  const fixes = all.filter((ev) => ev.e === 'fix');
  check(`GPS fixes, the place rounded to about a kilometre (${fixes.map((ev) => `${ev.at}±${ev.acc}${ev.odd ? ` ${ev.odd}` : ''}`).join('; ')})`,
    fixes.some((ev) => ev.at === '59.93,30.34') && fixes.every((ev) => /^\d+\.\d{1,2},\d+\.\d{1,2}$/.test(ev.at)));
  check('the rough fix across town is written at once, as odd', fixes.some((ev) => ev.at === '59.95,30.4' && ev.acc === 900 && /acc/.test(ev.odd || '')));
  const raw = inbox.logs.filter((row) => row.body.iid === iid).map((row) => row.raw).join('\n');
  check('the text typed into the search never goes out', !raw.includes(TYPED) && !raw.includes('Невский'));
  check('nor the exact place', !['59.934', '30.335', '59.951', '30.402'].some((digits) => raw.includes(digits)));
  check(`the name typed in «Как вас зовут» goes along as «who» (${inbox.logs.at(-1)?.body.who})`, inbox.logs.at(-1)?.body.who === NAME);
  check('and nowhere among the events', !JSON.stringify(all).includes(NAME));
  check(`each batch names the build (${build}) and this phone`, inbox.logs.every((row) => row.body.app === build && row.body.iid === iid && ID.test(row.body.sid)));
  check('sent as text/plain, so no preflight', inbox.logs.every((row) => row.type.startsWith('text/plain')));
  check(`the receiver took every batch (${inbox.bad.join(', ') || 'no refusals'})`, inbox.bad.length === 0);
  const lines = all.map((ev) => JSON.stringify(ev));
  check(`no event twice (${lines.length} events in ${inbox.logs.length} batches)`, new Set(lines).size === lines.length);

  // 3. «Сообщить о проблеме» from «i»: the words, the name, the last minutes of the log.
  await tap(page, '#aboutButton');
  await tap(page, '#problemOpen');
  check('«Сообщить о проблеме» in «i» opens the form', await drawerSays(page, 'Сообщить о проблеме'));
  check('with the name already in it', await page.inputValue('#problemWho') === NAME);
  await tap(page, '#problemSend');
  check('an empty report asks for words', await becomes(page, () => /пару слов/.test(document.querySelector('#problemStatus').textContent), null, 3000));
  await page.fill('#problemText', PROBLEM);
  await tap(page, '#problemSend');
  check('the report is sent', await becomes(page, () => document.querySelector('#problemStatus').textContent.includes('Отправлено'), null, 10000));
  const report = inbox.reports.at(-1)?.body;
  check('the receiver has the words, the name and the screen',
    report?.text === PROBLEM && report.who === NAME && /\d+×\d+@/.test(report.screen) && report.standalone === false && report.iid === iid);
  check(`with the last minutes of the log (${report?.events.length} events)`,
    has(report?.events || [], 'tap', { what: 'aboutButton' }) && report.events.every((ev) => ev.t >= Date.now() - 41 * 60000));
  check('and not the text typed in the search', !JSON.stringify(report).includes(TYPED));
  await tap(page, '#drawerClose');
  await drain(page);
  check('the words stay out of the log itself, which only notes the report',
    !JSON.stringify(eventsOf(iid)).includes(PROBLEM) && has(eventsOf(iid), 'report_sent', { via: 'server' }));

  // 4. «Отправлять журнал работы» off: nothing goes out; on again: only what came after.
  await tap(page, '#aboutButton');
  await tap(page, '#workLogSend');
  check('switched off, «i» says it is not sent', await becomes(page, () => /Журнал работы: не отправляется/.test(document.querySelector('#drawerContent').textContent)
    && !document.querySelector('#workLogSend').checked, null, 3000));
  await tap(page, '#drawerClose');
  let before = inbox.logs.length;
  await tap(page, '#gradePicker [data-grade="AI95"]');
  await page.evaluate(() => window.SPBFILog.flush());
  await page.waitForTimeout(1500);
  check('nothing goes out while it is off', inbox.logs.length === before);
  await tap(page, '#aboutButton');
  await tap(page, '#workLogSend');
  await tap(page, '#drawerClose');
  await tap(page, '#gradePicker [data-grade="AI98"]');
  await drain(page);
  const back = inbox.logs.slice(before).flatMap((row) => row.body.events);
  check('switched on again, only what came after goes out',
    has(back, 'log_on') && has(back, 'tap', { what: 'grade', v: 'AI98' }) && !has(back, 'tap', { what: 'grade', v: 'AI95' }) && !has(back, 'log_off'));

  // 5. «Отключить статистику» stops the log too, as the app's privacy rules say.
  await tap(page, '#aboutButton');
  await tap(page, '#analyticsToggle');
  check('with the statistics off, «i» says the log is off too', await becomes(page, () => document.querySelector('#drawerContent').textContent.includes('не отправляется — выключена статистика'), null, 3000));
  await tap(page, '#drawerClose');
  before = inbox.logs.length;
  await tap(page, '#gradePicker [data-grade="DT"]');
  await page.evaluate(() => window.SPBFILog.flush());
  await page.waitForTimeout(1500);
  check('and nothing goes out', inbox.logs.length === before);
  check(`no page errors (${errors.join(' | ') || 'none'})`, errors.length === 0);
  await context.close();

  // 6. A receiver without CORS still gets every batch, each event once.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  inbox.cors = false;
  const blind = await phone(browser, device, { blind: true });
  check('without CORS at the receiver the app opens all the same', await ready(blind.page));
  const blindIid = await blind.page.evaluate(() => localStorage.getItem('spbfi-log-install-v1'));
  await toList(blind.page);
  await tap(blind.page, '#gradePicker [data-grade="AI92"]');
  check('the batches go out', await drain(blind.page));
  check(`sent blind (${await blind.page.evaluate(() => window.SPBFILog.route())})`, await blind.page.evaluate(() => window.SPBFILog.route()) === 'blind');
  await tap(blind.page, '#gradePicker [data-grade="AI95"]');
  await drain(blind.page);
  await drain(blind.page);
  const blindEvents = eventsOf(blindIid);
  const blindLines = blindEvents.map((ev) => JSON.stringify(ev));
  check(`the receiver has them, each once (${blindLines.length} events)`,
    has(blindEvents, 'start') && has(blindEvents, 'tap', { what: 'grade', v: 'AI92' }) && has(blindEvents, 'tap', { what: 'grade', v: 'AI95' }) && new Set(blindLines).size === blindLines.length);
  await tap(blind.page, '#aboutButton');
  await tap(blind.page, '#problemOpen');
  await blind.page.fill('#problemText', PROBLEM);
  await tap(blind.page, '#problemSend');
  check('a report goes out blind too', await becomes(blind.page, () => document.querySelector('#problemStatus').textContent.includes('Отправлено'), null, 10000)
    && inbox.reports.some((row) => row.body.iid === blindIid && row.body.text === PROBLEM));
  check(`no page errors (${blind.errors.join(' | ') || 'none'})`, blind.errors.length === 0);
  await blind.context.close();
  inbox.cors = true;

  // 7. Global Privacy Control: not a single request to the receiver.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let hits = inbox.hits;
  const quiet = await phone(browser, device, { gpc: true });
  check('under Global Privacy Control the app opens', await ready(quiet.page));
  await toList(quiet.page);
  await tap(quiet.page, '#gradePicker [data-grade="AI92"]');
  await quiet.page.evaluate(() => window.SPBFILog.flush());
  await quiet.page.waitForTimeout(1500);
  await tap(quiet.page, '#aboutButton');
  check('«i» says why the log is not sent', (await drawerText(quiet.page)).includes('не отправляется — браузер просит сайты не следить'));
  check(`and the receiver heard nothing (${inbox.hits - hits} requests)`, inbox.hits === hits);
  await quiet.context.close();

  // 8. No log address in config.js, as in the other browser checks: nothing is
  // sent, and a report is saved as a file for the person to pass on.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  logAddress = false;
  hits = inbox.hits;
  const bare = await phone(browser, device, { noShare: true });
  check('with no log address the app opens', await ready(bare.page));
  await toList(bare.page);
  await tap(bare.page, '#gradePicker [data-grade="AI92"]');
  await bare.page.evaluate(() => window.SPBFILog.flush());
  await tap(bare.page, '#aboutButton');
  await tap(bare.page, '#problemOpen');
  await bare.page.fill('#problemText', PROBLEM);
  const download = bare.page.waitForEvent('download', { timeout: 8000 }).then((file) => file.suggestedFilename(), () => '');
  await tap(bare.page, '#problemSend');
  const saved = await download;
  check(`the report is kept as a file (${saved || 'no file'})`, /^spbfi-problem-.*\.txt$/.test(saved)
    && await becomes(bare.page, () => document.querySelector('#problemStatus').textContent.includes('файлом'), null, 5000));
  check(`and the receiver heard nothing (${inbox.hits - hits} requests)`, inbox.hits === hits);
  await bare.context.close();
  logAddress = true;

  // 9. The form on a narrow phone: nothing past the drawer's edge.
  const small = await phone(browser, narrow);
  check(`on ${narrow.viewport.width} px the app opens`, await ready(small.page));
  await toList(small.page);
  await tap(small.page, '#aboutButton');
  const fitAbout = await small.page.evaluate(() => {
    const drawer = document.querySelector('#detailDrawer');
    const right = drawer.getBoundingClientRect().right;
    return drawer.scrollWidth <= drawer.clientWidth && [...drawer.querySelectorAll('.work-log *')].every((el) => el.getBoundingClientRect().right <= right + 0.5);
  });
  check('the work log block fits the drawer', fitAbout);
  await tap(small.page, '#problemOpen');
  await small.page.fill('#problemText', PROBLEM);
  const fitForm = await small.page.evaluate(() => {
    const drawer = document.querySelector('#detailDrawer');
    const right = drawer.getBoundingClientRect().right;
    return drawer.scrollWidth <= drawer.clientWidth && [...drawer.querySelectorAll('.problem-form *')].every((el) => el.getBoundingClientRect().right <= right + 0.5);
  });
  check('and so does the form', fitForm);
  await small.page.screenshot({ path: path.join(OUT, `worklog-${label}-2-narrow-form.png`) });
  await small.context.close();
  await browser.close();
}

await run('iphone', webkit, devices['iPhone 13'], devices['iPhone SE']);
await run('android', chromium, devices['Pixel 7'], devices['Galaxy S8']);
siteServer.close();
workerServer.close();
logServer.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);

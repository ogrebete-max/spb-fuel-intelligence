// Голос за рулём (18.09.2026). The owner asked to be able to say «Где мне
// сейчас заправиться рядом?» and to mark a station from the car window, with
// rules doing the work instead of a model. The phone's recogniser is replaced
// here by one that says what the test wants said; everything after it — the
// rules, the answer on the screen, the spoken line, the mark that goes to the
// club — is the app's own. On an iPhone (WebKit) and an Android phone
// (Chromium).
//   node e2e/voice-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SITE_PORT = 9101;
const WORKER_PORT = 9102;

// ---- where the car stands, and which stations have what
const load = (grade) => JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', `stations-${grade}.json`), 'utf8'));
const listed = load('AI95').stations.filter((station) => station.location && station.network);
const METRES = (a, b) => {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};
const centre = { lat: 59.9343, lon: 30.3351 };
const near = listed.slice().sort((a, b) => METRES(a.location, centre) - METRES(b.location, centre));
const AT = near[0];
// Two other stations, each far enough that the answer can only be about it.
const AWAY = near.filter((station) => {
  const away = METRES(station.location, AT.location);
  return away >= 500 && away <= 4000;
});
const WITH_95 = AWAY[0];
const WITH_98 = AWAY.find((station) => station !== WITH_95 && METRES(station.location, WITH_95.location) >= 300);
if (!AT || !WITH_95 || !WITH_98) throw new Error('the built data has too few stations around the test point');
console.log(`стоим у: ${AT.network}, ${AT.address}`);
console.log(`95 есть у: ${WITH_95.network} (${Math.round(METRES(WITH_95.location, AT.location))} м)`);
console.log(`98 есть у: ${WITH_98.network} (${Math.round(METRES(WITH_98.location, AT.location))} м)`);

// Only one station in the whole city has one's grade, so an answer naming it
// can have come from nowhere else.
const served = (grade, only) => {
  const bundle = load(grade);
  for (const station of bundle.stations) {
    station.grade.status = station.id === only.id ? 'CAN_REFUEL' : 'CONFIRMED_NO';
    station.grade.age_seconds = 600;
    station.grade.ttl_seconds = null;
  }
  return JSON.stringify(bundle);
};
const SERVED = {
  '/static-data/stations-AI95.json': served('AI95', WITH_95),
  '/static-data/stations-AI98.json': served('AI98', WITH_98),
};

// ---- a recogniser that hears what the test says, and a voice that keeps what
// it was told to say
const EARS = `
window.__voice = { said: null, spoken: [], starts: 0 };
class TestRecognition {
  start() {
    window.__voice.starts += 1;
    setTimeout(() => {
      const said = window.__voice.said;
      // With nothing to say it keeps listening, as a real one does until it is
      // stopped: that is how the second press can be tried at all.
      if (!said) return;
      if (this.onresult) this.onresult({ results: [[{ transcript: said, confidence: 0.9 }]] });
      if (this.onend) this.onend();
    }, 20);
  }
  abort() { if (this.onend) this.onend(); }
  stop() { if (this.onend) this.onend(); }
}
// Both names: Chromium has a recogniser of its own under each of them, and it
// would be asked instead of this one.
for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
  try {
    Object.defineProperty(window, name, { configurable: true, writable: true, value: TestRecognition });
  } catch (error) {
    window[name] = TestRecognition;
  }
}
try {
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: function (text) { this.text = text; } });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: { cancel() {}, speak(line) { window.__voice.spoken.push(String(line.text)); } },
  });
  window.__voice.speaking = true;
} catch (error) {
  window.__voice.speaking = false;
}
`;

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
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', selector);
const stored = async () => (await (await worker.fetch(new Request(`http://localhost:${WORKER_PORT}/reports`), env, { waitUntil() {} })).json()).reports;

// Said into the phone: the word the recogniser will return, then the button.
// The app answers by replacing its own «🎤 Слушаю» line, so that is what is
// waited for — not merely the line appearing.
async function say(page, words) {
  await page.evaluate((said) => { window.__voice.said = said; }, words);
  await page.click('#drive [data-drive="voice"]');
  const answered = await becomes(page, () => {
    const line = document.querySelector('#drive .drive-flash')?.textContent || '';
    return !!line && !line.includes('Слушаю');
  }, null, 12000);
  if (!answered) console.log(`   (не ответил: ${JSON.stringify(await page.evaluate(() => ({ starts: window.__voice.starts, listening: voice.listening, heard: voice.heard, flash: drive.flash?.text })))})`);
  return answered;
}

const flash = (page) => text(page, '#drive .drive-flash');
const spoken = (page) => page.evaluate(() => window.__voice.spoken.slice(-1)[0] || '');

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device, serviceWorkers: 'block', permissions: ['geolocation'],
    geolocation: { latitude: AT.location.lat, longitude: AT.location.lon, accuracy: 12 },
  });
  await context.addInitScript(EARS);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#stationList .station-card', { timeout: 30000 });
  await page.click('#modeBar [data-screen="drive"]');
  check('the navigator opens', await becomes(page, () => drive.open && !document.querySelector('#drive').hidden));
  check('the phone that can listen shows «🎤 Голос»', await becomes(page, () => {
    const button = document.querySelector('#drive [data-drive="voice"]');
    return !!button && !button.hidden && button.textContent.includes('Голос');
  }));

  // 1. «Где мне сейчас заправиться рядом?» — the one station with 95, its name,
  // how far and what the app says about it, on the screen and aloud.
  check('«Где мне сейчас заправиться рядом?» is answered', await say(page, 'Где мне сейчас заправиться рядом?'));
  const answer = await flash(page);
  console.log(`   ответ: ${answer}`);
  check(`the answer names the only station with 95 («${answer}»)`, answer.toLowerCase().includes(WITH_95.network.split(',')[0].toLowerCase()) && /\d+\s*(м|км)/.test(answer) && answer.includes('есть'));
  check('and it is said aloud', await page.evaluate(() => window.__voice.speaking === false || window.__voice.spoken.length > 0));
  check('the station it names is the one the screen now talks about', await page.evaluate((id) => drive.tapped?.id === id, WITH_95.id));
  await page.screenshot({ path: path.join(OUT, `${label}-voice-1-answer.png`) });

  // 2. A grade the driver does not normally take: the app switches to it and
  // answers about it.
  check('«Где заправиться 98-м» is answered', await say(page, 'Где заправиться 98-м'));
  check('the app takes 98 as the grade', await becomes(page, () => state.grade === 'AI98', null, 12000));
  const eighth = await becomes(page, (network) => (document.querySelector('#drive .drive-flash')?.textContent || '').toLowerCase().includes(network), WITH_98.network.split(',')[0].toLowerCase(), 12000);
  check(`the answer names the only station with 98 («${await flash(page)}»)`, eighth);

  // 3. A mark said at the pumps: the grade named in the phrase, not the one on
  // the screen, and it goes to the club.
  check('«95 есть» is taken', await say(page, '95 есть'));
  const said95 = await flash(page);
  check(`the app repeats the station and the mark («${said95}»)`, said95.includes('95 есть') && said95.toLowerCase().includes(AT.network.split(',')[0].toLowerCase()));
  // The «Отменить» panel is not looked for here: a phone that is not moved
  // gives no speed, the navigator counts that as driving, and a mark made on
  // the move has never shown it. The word said back is the driver's receipt.
  let reports = [];
  for (let attempt = 0; attempt < 40 && !reports.length; attempt += 1) {
    reports = (await stored()).filter((item) => item.grade === 'AI95');
    if (!reports.length) await page.waitForTimeout(150);
  }
  check(`the club got «95 есть» at this station (${reports.map((item) => `${item.grade}:${item.seen}`).join(', ') || 'ничего'})`,
    reports.length === 1 && reports[0].station === AT.id && reports[0].seen === true && reports[0].queue == null);

  // 4. A mark with a queue, in the words a driver uses.
  check('«92 нет, очередь пять машин» is taken', await say(page, '92 нет, очередь пять машин'));
  let queued = [];
  for (let attempt = 0; attempt < 40 && !queued.length; attempt += 1) {
    queued = (await stored()).filter((item) => item.grade === 'AI92');
    if (!queued.length) await page.waitForTimeout(150);
  }
  check(`the club got «92 нет» with the queue (${queued.map((item) => `${item.grade}:${item.seen}:${item.queue}`).join(', ') || 'ничего'})`,
    queued.length === 1 && queued[0].seen === false && queued[0].queue === 5);
  await page.screenshot({ path: path.join(OUT, `${label}-voice-2-mark.png`) });

  // 5. Anything else is not guessed at: a wrong mark costs a driver a stop.
  const before = (await stored()).length;
  check('a phrase about something else is answered honestly', await say(page, 'Привет, как дела'));
  const puzzled = await flash(page);
  check(`it says it did not understand («${puzzled}»)`, puzzled.includes('Не понял'));
  check('and writes nothing down', (await stored()).length === before);

  // 5a. «Поехали»: the app chooses the station, says where it is taking you and
  // opens the route; a browser that refuses to open it leaves a button instead.
  await page.evaluate(() => {
    window.__opened = [];
    window.__allowOpen = true;
    window.open = (url) => { window.__opened.push(url); return window.__allowOpen ? {} : null; };
  });
  check('«Поехали» is answered', await say(page, 'Поехали'));
  const led = await flash(page);
  const opened = await page.evaluate(() => window.__opened.slice(-1)[0] || '');
  check(`it names the station and says it is leading: «${led}»`, led.includes('Веду в Яндексе') && led.toLowerCase().includes(WITH_98.network.split(',')[0].toLowerCase()));
  check(`the route opens in Yandex Maps («${opened.slice(0, 60)}»)`, opened.includes('yandex.ru/maps') && opened.includes('rtext='));
  check('and nothing was left to press', await page.evaluate(() => !document.querySelector('#drive .drive-flash-go')));

  // 6. Pressed a second time on purpose, the button stops listening and says
  // nothing: the driver has changed their mind, not failed to speak.
  await page.evaluate(() => { window.__voice.said = null; });
  await page.click('#drive [data-drive="voice"]');
  await becomes(page, () => voice.listening === true, null, 4000);
  await page.click('#drive [data-drive="voice"]');
  const quiet = await becomes(page, () => {
    const line = document.querySelector('#drive .drive-flash')?.textContent || '';
    return voice.listening === false && !line.includes('Слушаю') && !line.includes('Ничего не услышал');
  }, null, 6000);
  check(`a second press stops listening quietly («${await flash(page)}»)`, quiet);

  // Last, because the page leaves for Yandex: a blocked new window must not
  // mean «nothing happened» — «поехали» that does not switch is useless
  // (19 Sep 2026, the owner), so the app goes there in this very tab.
  const wentTo = [];
  await page.route('**yandex.ru/**', (route) => { wentTo.push(route.request().url()); route.abort(); });
  await page.evaluate(() => { window.__allowOpen = false; });
  await say(page, 'Проложи маршрут');
  for (let attempt = 0; attempt < 30 && !wentTo.length; attempt += 1) await page.waitForTimeout(150);
  check(`a blocked window still leads to Yandex, in this tab («${(wentTo[0] || 'никуда').slice(0, 60)}»)`,
    wentTo.length > 0 && wentTo[0].includes('rtext='));

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
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL VOICE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

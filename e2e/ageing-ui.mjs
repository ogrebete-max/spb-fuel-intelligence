// 15 Sep 2026 review: an answer stayed on screen after its signal had run out
// in a page left open with no new snapshot coming, and answers from sources
// that give no time never ran out in the browser at all. The build now says
// when every answer runs out, and an open page ages the list, the cards and
// the grades brief by itself, with no network too: here the phone goes offline
// and its clock jumps fifty minutes past the snapshot. A card that failed with
// no network opens once the network is back. WebKit (iPhone, the list) and
// Chromium (Android, the map screen).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import worker from '../worker/spbfi-reports.js';
import { FakeD1 } from '../worker/fake-d1.mjs';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const SITE_PORT = 9031;
const WORKER_PORT = 9032;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const MINUTE = 60 * 1000;
const SNAPSHOT_AT = Date.parse(JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'meta.json'), 'utf8')).snapshot_at);

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

const siteUrl = `http://localhost:${SITE_PORT}/`;
const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

// What the phone holds about two stations, read in the page.
const readStations = ([dated, undated]) => (async () => {
  const card = async (id) => {
    const grade = (await api(`/api/stations/${id}`)).grades.AI95;
    return { status: grade.status, probability: grade.probability_percent };
  };
  const { stations } = await api('/api/stations?grade=AI95&limit=5000');
  const listed = (id) => stations.find((station) => station.id === id)?.grade.status;
  const ours = (list) => (list || []).filter((station) => station.id === dated || station.id === undated).map((station) => station.grade.status);
  return {
    query: { dated: listed(dated), undated: listed(undated) },
    cards: { dated: await card(dated), undated: await card(undated) },
    brief: { dated: state.gradesBrief[dated]?.AI95 ?? null, undated: state.gradesBrief[undated]?.AI95 ?? null },
    aged: { dated: briefFor(dated).AI95?.s ?? null, undated: briefFor(undated).AI95?.s ?? null },
    answered: state.stations.filter((station) => station.grade.status !== 'NO_FRESH_DATA').length,
    shown: ours(state.stations),
    onMap: ours(state.mapStations),
    minutes: Math.round((Date.now() - Date.parse(state.meta.snapshot_at)) / 60000),
  };
})();

async function ageing(label, browserType, device, { onMap = false } = {}) {
  console.log(`\n=== ${label}`);
  env = { REPORTS: new MemoryKV(), DB: new FakeD1(), ORIGIN: `http://localhost:${SITE_PORT}` };
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  // A person's phone rather than an automated browser: the app starts the way it does for people.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }));
  // The app is opened a minute after the snapshot, and the clock runs on as usual.
  await context.clock.install({ time: SNAPSHOT_AT + MINUTE });
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  // WebKit reports a failed cross-site fetch as a page error even when the app
  // catches it, and this test cuts the network on purpose.
  page.on('pageerror', (error) => { if (!/access control checks/i.test(error.message)) errors.push(error.message); });
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.goto(siteUrl, { waitUntil: 'load' });
  check('the list is there', await becomes(page, () => document.querySelectorAll('#stationList .station-card').length > 0, null, 30000));
  check('the grades brief is in', await becomes(page, () => !!state.gradesBrief && Object.keys(state.gradesBrief).length > 0, null, 30000));
  if (onMap) {
    await page.click('#modeBar [data-screen="map"]');
    check('the map screen holds the whole city', await becomes(page, () => document.body.classList.contains('map-screen')
      && state.mapStationsGrade === state.grade && state.mapStations.length > 100, null, 15000));
  }

  // Two answers that run out within 49 minutes: one resting on a signal with a
  // time, one from sources that give none.
  const picked = await page.evaluate(async (within) => {
    const now = Date.now();
    const { stations } = await api('/api/stations?grade=AI95&limit=5000');
    const soon = (station) => {
      const end = Date.parse(station.grade.expires_at);
      return station.grade.status !== 'NO_FRESH_DATA' && station.grade.probability_percent != null && end > now + 3 * 60000 && end < now + within;
    };
    const dated = stations.find((station) => soon(station) && !station.grade.undated_only && station.grade.age_seconds != null);
    const undated = stations.find((station) => soon(station) && station.grade.undated_only);
    const minutesLeft = (station) => station && { id: station.id, status: station.grade.status, left: Math.round((Date.parse(station.grade.expires_at) - now) / 60000) };
    return { dated: minutesLeft(dated), undated: minutesLeft(undated), untouched: stations.at(-1)?.id };
  }, 49 * MINUTE);
  check(`an answer with a time runs out within 49 minutes (${JSON.stringify(picked.dated)})`, !!picked.dated);
  check(`and one from sources without time (${JSON.stringify(picked.undated)})`, !!picked.undated);
  if (!picked.dated || !picked.undated) {
    await browser.close();
    return;
  }
  const ids = [picked.dated.id, picked.undated.id];

  // Both cards are read while the network is there.
  const before = await page.evaluate(readStations, ids);
  check(`their cards give an answer with a probability (${JSON.stringify(before.cards)})`, Object.values(before.cards).every((card) => card.status !== 'NO_FRESH_DATA' && card.probability != null));
  check(`the brief says when each runs out, the undated one too (${JSON.stringify(before.brief)})`, before.brief.dated?.x != null && before.brief.undated?.x != null);
  check(`and has both still answered (${JSON.stringify(before.aged)})`, before.aged.dated !== 'NO_FRESH_DATA' && before.aged.undated !== 'NO_FRESH_DATA' && before.aged.dated && before.aged.undated);
  check(`the list shows answered stations (${before.answered})`, before.answered > 0);
  if (onMap) check(`and so does the map (${before.onMap})`, before.onMap.length === 2 && before.onMap.every((status) => status !== 'NO_FRESH_DATA'));
  await page.screenshot({ path: path.join(OUT, `ageing-${label}-1-before.png`) });

  // No network, and fifty minutes pass with the app open.
  await context.setOffline(true);
  await context.clock.fastForward(50 * MINUTE);
  await context.clock.runFor(65 * 1000);
  check('within a minute the list is drawn again by itself, with fewer answers', await becomes(page, (was) => state.stations.filter((station) => station.grade.status !== 'NO_FRESH_DATA').length < was, before.answered, 15000));
  if (onMap) check('and the map is read again', await becomes(page, (want) => (state.mapStations || []).filter((station) => want.includes(station.id)).every((station) => station.grade.status === 'NO_FRESH_DATA'), ids, 15000));
  const after = await page.evaluate(readStations, ids);
  check(`${after.minutes} minutes after the snapshot a full query has both run out (${JSON.stringify(after.query)})`, after.query.dated === 'NO_FRESH_DATA' && after.query.undated === 'NO_FRESH_DATA');
  check(`their cards, with no network, say so and give no probability (${JSON.stringify(after.cards)})`, Object.values(after.cards).every((card) => card.status === 'NO_FRESH_DATA' && card.probability === null));
  check(`the brief has run out for both (${JSON.stringify(after.aged)})`, after.aged.dated === 'NO_FRESH_DATA' && after.aged.undated === 'NO_FRESH_DATA');
  check(`the list on the phone lost its answers (${before.answered} → ${after.answered})`, after.answered < before.answered);
  check(`where the list shows the two, they have run out (${after.shown})`, after.shown.every((status) => status === 'NO_FRESH_DATA'));
  if (onMap) check(`so have their pins on the map (${after.onMap})`, after.onMap.length === 2 && after.onMap.every((status) => status === 'NO_FRESH_DATA'));
  await page.screenshot({ path: path.join(OUT, `ageing-${label}-2-after.png`) });

  // A card never opened fails with no network, and is not stuck failing after.
  const offline = await page.evaluate((id) => api(`/api/stations/${id}`).then(() => 'opened', (error) => `failed: ${error.message}`), picked.untouched);
  check(`a card never opened fails with no network (${offline})`, offline.startsWith('failed'));
  await context.setOffline(false);
  const online = await page.evaluate((id) => api(`/api/stations/${id}`).then((station) => (station.id === id ? 'opened' : 'another'), (error) => `failed: ${error.message}`), picked.untouched);
  check(`and opens once the network is back (${online})`, online === 'opened');

  check(`no box popped up (${dialogs.join(' | ') || 'none'})`, dialogs.length === 0);
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await ageing('iphone-list', webkit, devices['iPhone 13']);
  await ageing('android-map', chromium, devices['Pixel 7'], { onMap: true });
} finally {
  siteServer.close();
  workerServer.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL AGEING CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

// The published app as people open it: no box pops up, the list opens, the
// map over the whole screen works and the list comes back, nothing throws.
// Run once static-data/meta.json on the site shows the new build.
//   node e2e/live-open.mjs
import { webkit, chromium, devices } from 'playwright';
const url = 'https://ogrebete-max.github.io/spb-fuel-intelligence/';
const becomes = (page, fn, timeout) => page.waitForFunction(fn, null, { timeout }).then(() => true, () => false);
let problems = 0;
for (const [label, type, device] of [['iPhone 13 / WebKit', webkit, devices['iPhone 13']], ['Pixel 7 / Chromium', chromium, devices['Pixel 7']]]) {
  const browser = await type.launch();
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.station-card', { timeout: 60000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => ({
    build: window.SPBFI_BUILD,
    gate: !document.querySelector('#clubGate').hidden,
    clubEnabled: state.club.enabled,
    cards: document.querySelectorAll('.station-card').length,
    feed: !!document.querySelector('#groupFeed').textContent.trim(),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  await page.evaluate(() => document.querySelector('#modeBar [data-screen="map"]').click());
  const map = await becomes(page, () => document.body.classList.contains('map-screen') && state.mapStationsGrade === state.grade && document.querySelectorAll('#map .fuel-pin').length > 100, 30000);
  const pins = await page.evaluate(() => document.querySelectorAll('#map .fuel-pin').length);
  await page.evaluate(() => document.querySelector('#modeBar [data-screen="list"]').click());
  const list = await becomes(page, () => !document.body.classList.contains('map-screen') && !!document.querySelector('#stationList .station-card'), 15000);
  const ok = info.cards > 0 && map && list && !dialogs.length && !errors.length;
  if (!ok) problems += 1;
  console.log(label, JSON.stringify({ ...info, map, pins, backToList: list, dialogs }), 'page errors:', errors.length, errors.slice(0, 2).join(' | '), ok ? 'OK' : 'PROBLEM');
  await browser.close();
}
process.exit(problems ? 1 : 0);

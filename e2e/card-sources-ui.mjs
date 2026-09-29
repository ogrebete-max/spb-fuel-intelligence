// Кто из источников отвечает, а кто молчит — в карточке АЗС (29.09.2026).
//
// Early in the morning the owner opened a card of grey «устарело» rows and read
// it as sources taken away: «я думал, наоборот прибавится, а их намного меньше».
// The number had not changed; only two of the feeds had anything fresh. Now the
// card says it in words above the rows — «Сейчас отвечают 2 из 5 источников.
// Молчат: …» — names a feed that did not answer the last refresh apart, and
// folds the expired rows under their count. WebKit (iPhone) and Chromium (Android).
//   node e2e/card-sources-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9141;

// One real station of the build, its 95 answered by two feeds now and by
// three a while ago; T-Bank did not answer the last refresh.
const stations = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'stations-AI95.json'), 'utf8')).stations;
const station = stations.find((item) => item.location && fs.existsSync(path.join(SITE, 'static-data', 'details', `${item.id}.json`)));
if (!station) {
  console.log('FAIL no station with a details file in site/static-data');
  process.exit(1);
}
const now = Date.now();
const iso = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
const row = (source, availability, secondsAgo, fresh, kind = 'crowd_status') => ({
  grade: 'AI95', availability, kind, observed_at: iso(secondsAgo), effective_observed_at: iso(secondsAgo), received_at: iso(secondsAgo),
  age_seconds: secondsAgo, fresh, source, provenance_cluster: `${source}-cluster`, effective_provenance: `${source}-cluster`, independent: false, confidence: null, note: '',
});
const details = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'details', `${station.id}.json`), 'utf8'));
details.grades.AI95.evidence = [
  row('sber', 'AVAILABLE', 600, true, 'payment_projection'),
  row('alfa-azs', 'AVAILABLE', 900, true, 'payment_projection'),
  row('gdezapravka', 'NOT_AVAILABLE', 5 * 3600, false),
  row('benzonavt', 'AVAILABLE', 7 * 3600, false),
  row('tbank-fuel', 'AVAILABLE', 9 * 3600, false, 'payment_projection'),
];
const meta = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'meta.json'), 'utf8'));
meta.snapshot_at = new Date(now).toISOString();
meta.collectors = { ok: 30, total: 31, failed: [{ name: 'tbank-fuel', error: 'IncompleteRead' }], off: [] };
const SERVED = {
  [`/static-data/details/${station.id}.json`]: JSON.stringify(details),
  '/static-data/meta.json': JSON.stringify(meta),
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
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
await new Promise((resolve) => server.listen(PORT, resolve));

const failures = [];
const check = (label, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) failures.push(label); };
const becomes = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await becomes(page, () => state.stations.length > 0, null, 30000);
  await page.evaluate((id) => openStation(id), station.id);
  check('the card opens with the answers for 95', await becomes(page, () => !!document.querySelector('#drawerContent .sources-summary'), null, 15000));
  const summary = await page.evaluate(() => document.querySelector('#drawerContent .sources-summary')?.textContent.replace(/\s+/g, ' ').trim());
  check(`«${summary}»`, summary?.startsWith('Сейчас отвечают 2 из 5 источников.')
    && summary.includes('Молчат: ГдеЗаправка, Бензонавт — свежего у них по этой АЗС нет')
    && summary.includes('Не ответили при последнем обновлении: Т-Банк.'));
  const shown = await page.evaluate(() => {
    const open = [...document.querySelectorAll('#drawerContent .evidence-list')].find((list) => !list.closest('details'));
    const folded = document.querySelector('#drawerContent details.evidence-stale');
    return {
      open: open ? open.querySelectorAll('.evidence-row').length : 0,
      openNames: open ? [...open.querySelectorAll('.evidence-meta')].map((meta) => meta.textContent.split('·')[0].trim()).join(', ') : '',
      folded: folded ? folded.querySelectorAll('.evidence-row').length : 0,
      closed: folded ? !folded.open : false,
      summary: folded?.querySelector('summary')?.textContent.trim(),
    };
  });
  check(`the two fresh answers are on show (${shown.openNames})`, shown.open === 2 && shown.openNames === 'Сбер, Альфа-Банк');
  check(`the expired ones folded under «${shown.summary}»`, shown.folded === 3 && shown.closed && shown.summary === 'Устаревшие ответы (3)');
  await page.click('#drawerContent details.evidence-stale > summary');
  check('and open on a touch', await becomes(page, () => document.querySelector('#drawerContent details.evidence-stale').open, null, 3000));
  await page.screenshot({ path: path.join(OUT, `card-sources-${label}.png`), fullPage: false });
  check(`no page errors (${errors.length})`, errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL CARD SOURCES CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

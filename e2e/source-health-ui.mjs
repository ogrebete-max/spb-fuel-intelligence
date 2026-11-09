// Источники, которые отвечают, но без новых отметок (9.11.2026).
//
// The owner: «меня волнуют источники… нужна достоверная информация». The app
// said «ответили 29 из 30» while benzinradar.ru's newest mark was from 15 Sep
// and almost all of азсрадар.рф's from September. Now such a feed is named: a
// calm banner when nothing failed, the warning one as before when something
// did, and its own section in «Состояние источников». WebKit (iPhone) and
// Chromium (Android).
//   node e2e/source-health-ui.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const SITE = fileURLToPath(new URL('../site', import.meta.url));
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9143;

const now = Date.now();
const baseMeta = JSON.parse(fs.readFileSync(path.join(SITE, 'static-data', 'meta.json'), 'utf8'));
baseMeta.snapshot_at = new Date(now).toISOString();
const quiet = [
  { name: 'benzinradar-analogue', last_mark: '2026-09-15T18:10:08Z' },
  { name: 'azsradar-rf', last_mark: new Date(now - 4 * 3600 * 1000).toISOString() },
];
const off = [{ name: 'yandex-maps', note: 'Яндекс с 6.11 показывает серверам GitHub проверку «вы не робот»' }];
const scenarios = {
  calm: { ok: 29, total: 29, failed: [], off, quiet },
  failing: { ok: 28, total: 29, failed: [{ name: 'tbank-fuel', error: 'IncompleteRead' }], off, quiet },
  clean: { ok: 29, total: 29, failed: [], off, quiet: [] },
  // A build from before the quiet list: the banner stays as it was.
  old: { ok: 29, total: 29, failed: [], off },
};
let current = 'calm';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end('window.SPBFI_REPORT_ENDPOINT = null; window.SPBFI_ANALYTICS_ENDPOINT = null;');
    return;
  }
  if (url.pathname === '/static-data/meta.json') {
    res.writeHead(200, { 'Content-Type': types['.json'] });
    res.end(JSON.stringify({ ...baseMeta, collectors: scenarios[current] }));
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

async function open(context, scenario) {
  current = scenario;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await becomes(page, () => state.meta && state.stations.length > 0, null, 30000);
  const banner = await page.evaluate(() => {
    const node = document.querySelector('#collectorBanner');
    return { hidden: node.hidden, calm: node.classList.contains('calm'), text: node.textContent.replace(/\s+/g, ' ').trim() };
  });
  return { page, errors, banner };
}

async function drawerText(page) {
  await page.click('#collectorDetails');
  await becomes(page, () => /Состояние источников/.test(document.querySelector('#drawerContent')?.textContent || ''), null, 5000);
  return page.evaluate(() => document.querySelector('#drawerContent').textContent.replace(/\s+/g, ' ').trim());
}

async function run(label, browserType, device) {
  console.log(`\n=== ${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });

  let { page, errors, banner } = await open(context, 'calm');
  check(`nothing failed, two feeds quiet: a calm banner «${banner.text.slice(0, 90)}…»`, !banner.hidden && banner.calm
    && banner.text.startsWith('Ответили все источники · без новых отметок: 2')
    && banner.text.includes('Бензинрадар, АЗС радар'));
  let text = await drawerText(page);
  check('the sheet says all answered', text.includes('Все источники ответили'));
  check('and names the quiet feeds with their last mark', text.includes('Отвечают, но новых отметок нет больше 3 часов')
    && /Бензинрадар\s*последняя отметка водителей — 15\.09 в \d\d:\d\d/.test(text)
    && /АЗС радар\s*последняя отметка водителей — сегодня в \d\d:\d\d/.test(text));
  check('the switched-off ones keep their section', text.includes('Не считаются') && text.includes('yandex-maps'));
  await page.screenshot({ path: path.join(OUT, `source-health-${label}.png`), fullPage: false });
  check(`no page errors (${errors.length})`, errors.length === 0);
  await page.close();

  ({ page, errors, banner } = await open(context, 'failing'));
  check(`a feed that failed still gets the warning banner «${banner.text.slice(0, 60)}…»`, !banner.hidden && !banner.calm
    && banner.text.startsWith('Не ответили источники: 1 из 29') && banner.text.includes('tbank-fuel'));
  text = await drawerText(page);
  check('the sheet lists the failed and the quiet apart', text.includes('Не ответили') && text.includes('IncompleteRead')
    && text.includes('Отвечают, но новых отметок нет'));
  check(`no page errors (${errors.length})`, errors.length === 0);
  await page.close();

  for (const scenario of ['clean', 'old']) {
    ({ page, errors, banner } = await open(context, scenario));
    check(`${scenario}: nothing to say, no banner`, banner.hidden);
    check(`no page errors (${errors.length})`, errors.length === 0);
    await page.close();
  }
  await browser.close();
}

try {
  await run('iphone', webkit, devices['iPhone 13']);
  await run('android', chromium, devices['Pixel 7']);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL SOURCE HEALTH CHECKS PASSED');
process.exit(failures.length ? 1 : 0);

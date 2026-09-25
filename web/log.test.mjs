// The work log (25.09.2026) without a browser: what web/log.js writes down,
// what it keeps back, and how it talks to the receiver. The file under test is
// the one the browser loads, read here as text and run in a bare scope with a
// clock, a page and a network of this file's own.
//   node web/log.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./log.js', import.meta.url), 'utf8');

function world({ endpoint = 'https://club.example', webdriver = false, dnt = null, gpc = false, stored = {}, early = null, answer } = {}) {
  let clock = 1_000_000;
  const store = new Map(Object.entries(stored));
  const listeners = {};
  const on = (target) => (name, fn) => { (listeners[`${target}:${name}`] ||= []).push(fn); };
  const fire = (target, name, event = {}) => (listeners[`${target}:${name}`] || []).forEach((fn) => fn(event));
  const calls = [];
  const page = { hidden: false, driving: false };
  const window = {
    SPBFI_LOG_ENDPOINT: endpoint, SPBFI_BUILD: 'abc1234', doNotTrack: null,
    addEventListener: on('window'), matchMedia: () => ({ matches: false }),
    ...(early ? { SPBFI_LOG_EARLY: early } : {}),
  };
  const document = {
    get hidden() { return page.hidden; },
    addEventListener: on('document'),
    getElementById: () => null,
    body: { classList: { contains: (name) => name === 'driving' && page.driving } },
  };
  const navigator = {
    webdriver, doNotTrack: dnt, globalPrivacyControl: gpc, onLine: true, userAgent: 'Mozilla/5.0 (iPhone) test', language: 'ru-RU',
    sendBeacon: (url, blob) => { calls.push({ url, beacon: true, blob }); return true; },
  };
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const fetch = (url, options = {}) => {
    calls.push({ url, ...options });
    return (answer || (() => Promise.resolve({ ok: true, status: url.endsWith('/health') ? 200 : 204 })))(url, options);
  };
  const timers = [];
  const scope = {
    window, document, navigator, localStorage, fetch,
    Date: { now: () => clock },
    performance: { timeOrigin: 999_000, now: () => clock - 999_000 },
    screen: { width: 390, height: 844 }, devicePixelRatio: 3, innerWidth: 390, innerHeight: 664,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}, setInterval: () => 0, PerformanceObserver: undefined, location: { href: 'https://app.example/', origin: 'https://app.example' },
  };
  new Function(...Object.keys(scope), source)(...Object.values(scope));
  const log = window.SPBFILog;
  return {
    log, store, calls, page, fire, timers,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    last: () => log.recent(1)[0],
    named: (name) => log.recent(1500).filter((ev) => ev.e === name),
  };
}

// Where the log is allowed to go. Anything but '' keeps it on the phone.
assert.equal(world().log.blocked(), '');
assert.equal(world({ endpoint: '' }).log.blocked(), 'none', 'no address in config.js (the other browser checks)');
assert.equal(world({ webdriver: true }).log.blocked(), 'robot', 'an automated browser');
assert.equal(world({ dnt: '1' }).log.blocked(), 'dnt', 'Do Not Track');
assert.equal(world({ gpc: true }).log.blocked(), 'dnt', 'Global Privacy Control');
assert.equal(world({ stored: { 'spbfi-analytics-disabled-v1': '1' } }).log.blocked(), 'stats', 'the statistics switched off');
assert.equal(world({ stored: { 'spbfi-log-off-v1': '1' } }).log.blocked(), 'off', '«Отправлять журнал работы» off');

// The launch is dated when the page began to open, and waits to go out.
{
  const w = world();
  const [start] = w.named('start');
  assert.equal(start.t, 999_000);
  assert.equal(start.screen, '390×844@3');
  assert.equal(w.log.pending(), 1);
  // Off, nothing new waits, and what waited stays on the phone.
  w.log.setOff(true);
  w.log.event('tap', { what: 'grade' });
  assert.equal(w.log.pending(), 0);
  assert.equal(w.log.off(), true);
  // On again: only what comes after.
  w.log.setOff(false);
  w.log.event('tap', { what: 'grade' });
  assert.equal(w.log.pending(), 2, 'log_on and the tap');
}

// The install id is one the receiver takes, and it stays.
{
  const w = world();
  const iid = w.store.get('spbfi-log-install-v1');
  assert.match(iid, /^[a-z0-9]{4,40}$/);
  assert.equal(world({ stored: { 'spbfi-log-install-v1': iid } }).store.get('spbfi-log-install-v1'), iid);
  assert.notEqual(world({ stored: { 'spbfi-log-install-v1': 'Not-Valid!' } }).store.get('spbfi-log-install-v1'), 'Not-Valid!');
}

// Small flat fields only; nothing empty.
{
  const w = world();
  w.log.event('x', { s: 'a'.repeat(500), n: 5, bad: NaN, inf: Infinity, no: null, gone: undefined, blank: '', obj: { a: 1 }, yes: false });
  const ev = w.last();
  assert.equal(ev.s.length, 300);
  assert.equal(ev.n, 5);
  assert.equal(ev.yes, false);
  for (const key of ['bad', 'inf', 'no', 'gone', 'blank', 'obj']) assert.equal(key in ev, false, key);
}

// A repeating event: one line a period, the repeats counted.
{
  const w = world();
  const again = () => w.log.event('geo_error', { code: 3 }, { every: 60000, key: 'geo_error:3' });
  assert.equal(again(), true);
  w.tick(20000);
  assert.equal(again(), false);
  w.tick(20000);
  assert.equal(again(), false);
  w.tick(21000);
  assert.equal(again(), true);
  assert.deepEqual(w.named('geo_error').map((ev) => ev.rep ?? 0), [0, 2]);
}

// GPS fixes: a sample, with every oddity at once, and the place rounded.
{
  const w = world();
  const at = (lat, lon, accuracy = 10, extra = {}) => ({ latitude: lat, longitude: lon, accuracy, speed: null, heading: null, ...extra });
  w.log.fix(at(59.93428, 30.33512), { stamp: 1 });
  let fixes = w.named('fix');
  assert.equal(fixes.length, 1, 'the first fix is written');
  assert.equal(fixes[0].at, '59.93,30.34', 'about a kilometre');
  assert.equal(JSON.stringify(fixes).includes('59.934'), false, 'never the exact place');
  // The same fix handed out again is only counted.
  w.tick(1000);
  w.log.fix(at(59.93428, 30.33512), { stamp: 1 });
  // Ordinary fixes wait for their turn: every 30 s.
  for (let i = 0; i < 25; i += 1) {
    w.tick(1000);
    w.log.fix(at(59.93428 + i * 1e-5, 30.33512), { stamp: 10 + i });
  }
  assert.equal(w.named('fix').length, 1, 'nothing odd within 30 s');
  w.tick(5000);
  w.log.fix(at(59.9345, 30.3352), { stamp: 50 });
  fixes = w.named('fix');
  assert.equal(fixes.length, 2, 'the next one after 30 s');
  assert.equal(fixes[1].same, 1, 'with the repeated fix counted');
  // A rough fix is written at once, as odd — and the rough ones after it wait.
  w.tick(3000);
  w.log.fix(at(59.95, 30.40, 900), { stamp: 51 });
  w.tick(3000);
  w.log.fix(at(59.95, 30.40, 800), { stamp: 52 });
  fixes = w.named('fix');
  assert.equal(fixes.length, 3);
  assert.equal(fixes[2].odd, 'acc');
  assert.equal(fixes[2].acc, 900);
  // Clean again, then rough again: a new spell is written at once.
  w.tick(3000);
  w.log.fix(at(59.95, 30.40, 10), { stamp: 53 });
  w.tick(3000);
  w.log.fix(at(59.95, 30.40, 700), { stamp: 54 });
  fixes = w.named('fix');
  assert.equal(fixes.length, 4);
  assert.equal(fixes[3].odds, 2, 'the rough fixes since the line before are counted');
  assert.equal(fixes[3].worst, 800);
  // …but never two lines in two seconds.
  w.tick(500);
  w.log.fix(at(59.95, 30.40, 10), { stamp: 55 });
  w.tick(500);
  w.log.fix(at(59.95, 30.40, 600), { stamp: 56 });
  assert.equal(w.named('fix').length, 4);
  // A fix the app set aside is written with why.
  w.tick(5000);
  w.log.fix(at(59.95, 30.40, 1200), { stamp: 57, skip: 'stale' });
  assert.equal(w.last().skip, 'stale');
  assert.equal(w.last().odd, 'acc,stale');
}

// In the navigator: every 5 s, and a gap in the fixes at once — but not the
// gap of a page that was hidden.
{
  const w = world();
  const at = (lat, accuracy = 8, speed = null) => ({ latitude: lat, longitude: 30.3, accuracy, speed, heading: 90 });
  w.log.fix(at(59.9), { stamp: 1, busy: true, sog: 42.26 });
  assert.equal(w.last().sog, 42.3);
  assert.equal(w.last().hdg, 90);
  w.tick(2000);
  w.log.fix(at(59.9001), { stamp: 2, busy: true });
  w.tick(3100);
  w.log.fix(at(59.9002), { stamp: 3, busy: true });
  assert.equal(w.named('fix').length, 2, 'every 5 s');
  w.tick(8000);
  w.log.fix(at(59.9003), { stamp: 4, busy: true });
  assert.equal(w.last().odd, 'gap');
  assert.equal(w.last().dt, 8000);
  // The phone in a pocket: hidden, then shown; that pause is no gap.
  w.page.hidden = true;
  w.fire('document', 'visibilitychange');
  w.tick(60000);
  w.page.hidden = false;
  w.fire('document', 'visibilitychange');
  w.tick(1000);
  w.log.fix(at(59.9004), { stamp: 5, busy: true });
  assert.equal(w.last().e, 'fix');
  assert.equal(w.last().odd, undefined);
  // The phone's own speed far from the way made between two precise fixes.
  w.tick(5000);
  w.log.fix(at(59.9005, 8, 0), { stamp: 6, busy: true });
  w.tick(2500);
  w.log.fix(at(59.9030, 8, 0), { stamp: 7, busy: true });
  assert.equal(w.named('fix').at(-1).odd, 'speed', '278 m in two and a half seconds while the phone says it stands');
}

// What was pressed: the button's own name, never an id of a station or a person.
{
  const w = world();
  const el = ({ dataset = {}, id = '', classes = [], tag = 'BUTTON', href = '', label = '', inside = [] } = {}) => ({
    dataset, id, tagName: tag, href,
    classList: Object.assign([...classes], { contains: (name) => classes.includes(name) }),
    getAttribute: (name) => (name === 'aria-label' ? label : null),
    closest(selector) {
      if (selector.startsWith('button')) return this;
      return inside.some((where) => selector.includes(where)) ? {} : null;
    },
  });
  const tap = (target) => {
    w.fire('document', 'click', { target });
    return w.last();
  };
  assert.deepEqual(pick(tap(el({ dataset: { drive: 'recenter' } }))), { what: 'drive-recenter', on: 'list' });
  w.page.driving = true;
  assert.deepEqual(pick(tap(el({ dataset: { drive: 'start-mode', mode: 'map' } }))), { what: 'drive-start-mode', v: 'map', on: 'nav' });
  w.page.driving = false;
  assert.deepEqual(pick(tap(el({ dataset: { screen: 'map' } }))), { what: 'screen-map', on: 'list' });
  assert.deepEqual(pick(tap(el({ dataset: { grade: 'AI92' } }))), { what: 'grade', v: 'AI92', on: 'list' });
  assert.deepEqual(pick(tap(el({ dataset: { composeGrade: 'AI95', composeSeen: '0' }, inside: ['#detailDrawer'] }))), { what: 'compose-grade', v: 'AI95', s: '0', on: 'drawer' });
  assert.deepEqual(pick(tap(el({ dataset: { markStation: 'yandex:123', markSeen: '1' } }))), { what: 'mark-seen', v: '1', on: 'list' });
  assert.deepEqual(pick(tap(el({ dataset: { deleteStation: 'yandex:1', deleteAuthor: 'm-abc', deleteAt: '17' } }))), { what: 'delete-station', on: 'list' });
  assert.deepEqual(pick(tap(el({ dataset: { remove: 'm-person', name: 'Ирина' } }))), { what: 'remove', on: 'list' });
  assert.deepEqual(pick(tap(el({ id: 'locateButton' }))), { what: 'locateButton', on: 'list' });
  assert.deepEqual(pick(tap(el({ classes: ['leaflet-marker-icon'], tag: 'DIV', inside: ['#drive'] }))), { what: 'drive-pin', on: 'list' });
  assert.deepEqual(pick(tap(el({ tag: 'A', href: 'https://yandex.ru/maps/?rtext=59.9,30.3' }))), { what: 'link', v: 'yandex.ru', on: 'list' });
  assert.deepEqual(pick(tap(el({ classes: ['card-main'] }))), { what: 'card-main', on: 'list' });
  assert.equal(JSON.stringify(w.log.recent(100)).includes('Ирина'), false, 'a name on a button stays out');
  assert.equal(JSON.stringify(w.log.recent(100)).includes('m-person'), false, 'and a member id');
  assert.equal(JSON.stringify(w.log.recent(100)).includes('yandex:'), false, 'and a station');
}

// What app.js did before the file was in, at its own time and in order.
{
  const w = world({
    early: [
      ['fix', { latitude: 59.9, longitude: 30.3, accuracy: 20 }, { stamp: 1, busy: false, sog: null, skip: '', t: 999_500 }],
      ['event', 'nav_start', { why: 'start' }, { t: 999_600 }],
    ],
  });
  assert.deepEqual(w.log.recent(3).map((ev) => [ev.e, ev.t]), [['start', 999_000], ['fix', 999_500], ['nav_start', 999_600]]);
}

// «Как вас зовут»: trimmed, 40 letters, nothing that could be markup.
{
  const w = world();
  assert.equal(w.log.setWho('  <b>Ирина</b>  '), 'bИрина/b');
  assert.equal(w.log.who(), 'bИрина/b');
  assert.equal(w.log.setWho('а'.repeat(60)).length, 40);
  assert.equal(w.log.setWho(''), '');
  assert.equal(w.store.has('spbfi-log-who-v1'), false);
}

// Sending: the receiver is asked once whether it answers this page, then gets
// the batch as text/plain with the name, the build and the events.
{
  const w = world();
  w.log.setWho('Саша');
  w.log.event('tap', { what: 'grade', v: 'AI95' });
  await w.log.flush();
  const [probe, post] = w.calls;
  assert.equal(probe.url, 'https://club.example/applog/health');
  assert.equal(post.url, 'https://club.example/applog/fuel/log');
  assert.equal(post.mode, 'cors');
  assert.equal(post.headers['Content-Type'], 'text/plain');
  assert.equal(post.credentials, 'omit');
  const body = JSON.parse(post.body);
  assert.equal(body.v, 1);
  assert.equal(body.app, 'abc1234');
  assert.equal(body.who, 'Саша');
  assert.match(body.iid, /^[a-z0-9]{4,40}$/);
  assert.match(body.sid, /^[a-z0-9]{4,40}$/);
  assert.deepEqual(body.events.map((ev) => ev.e), ['start', 'tap']);
  assert.equal(w.log.pending(), 0);
  assert.equal(w.log.route(), 'cors');
  // Nothing new, nothing sent; the question is not asked again.
  await w.log.flush();
  assert.equal(w.calls.length, 2);
}

// A receiver without CORS: the page cannot read its answer, so the batch goes blind.
{
  const w = world({ answer: (url) => (url.endsWith('/health') ? Promise.reject(new TypeError('Load failed')) : Promise.resolve({ ok: false, status: 0, type: 'opaque' })) });
  await w.log.flush();
  assert.equal(w.log.route(), 'blind');
  assert.equal(w.calls[1].mode, 'no-cors');
  assert.equal(w.log.pending(), 0, 'an answer at all counts as delivered');
}

// No receiver at that address: the sending stops for this launch.
{
  const w = world({ answer: () => Promise.resolve({ ok: false, status: 404 }) });
  await w.log.flush();
  assert.equal(w.log.route(), 'off');
  assert.equal(w.calls.length, 1, 'only the question');
}

// A batch the receiver refuses as such is dropped; a busy receiver is tried again later.
{
  const refused = world({ answer: (url) => Promise.resolve(url.endsWith('/health') ? { ok: true, status: 200 } : { ok: false, status: 400 }) });
  await refused.log.flush();
  assert.equal(refused.log.pending(), 0);
  const busy = world({ answer: (url) => Promise.resolve(url.endsWith('/health') ? { ok: true, status: 200 } : { ok: false, status: 503 }) });
  // The batch's own timer, twenty seconds after the launch, finds the receiver busy.
  busy.timers.find((timer) => timer.ms === 20000).fn();
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(busy.log.pending(), 1);
  assert.ok(busy.timers.some((timer) => timer.ms === 60000), 'a minute later, not at once');
}

// The page going away sends what waits by beacon.
{
  const w = world();
  w.log.event('tap', { what: 'aboutButton' });
  w.page.hidden = true;
  w.fire('document', 'visibilitychange');
  const beacon = w.calls.find((call) => call.beacon);
  assert.equal(beacon.url, 'https://club.example/applog/fuel/log');
  assert.equal(w.log.pending(), 0);
}

// «Сообщить о проблеме» goes even with the log's sending off: the person sends it.
{
  const w = world({ stored: { 'spbfi-log-off-v1': '1' } });
  w.log.event('tap', { what: 'problemOpen' });
  const via = await w.log.report('Карта не двигается', { withLog: true });
  assert.equal(via, 'server');
  const post = w.calls.find((call) => call.url.endsWith('/applog/fuel/report'));
  const body = JSON.parse(post.body);
  assert.equal(body.text, 'Карта не двигается');
  assert.equal(body.screen, '390×664@3');
  assert.deepEqual(body.events.map((ev) => ev.e), ['start', 'tap']);
  const bare = await (async () => {
    const x = world();
    await x.log.report('Без журнала', { withLog: false });
    return JSON.parse(x.calls.find((call) => call.url.endsWith('/report')).body);
  })();
  assert.deepEqual(bare.events, []);
  assert.equal(w.named('report_sent')[0].via, 'server');
  assert.equal(w.log.pending(), 0, 'the log itself still stays on the phone');
}

console.log('log.js: all checks passed');

function pick(ev) {
  const { what, v, s, on } = ev;
  return Object.fromEntries(Object.entries({ what, v, s, on }).filter(([, value]) => value !== undefined));
}

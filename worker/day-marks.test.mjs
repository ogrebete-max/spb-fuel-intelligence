// «👁 Свои» for the whole day (16 Sep 2026): people saw three marks in the list
// and took them for everything marked that day. Marks now stay a day, a read
// with ?hours=24 lists them, and every other read keeps its three hours: the
// pipeline's vote, thanks and 👍/👎 see what they saw before. Where a phone
// stood is not given for marks older than those three hours.
import assert from 'node:assert/strict';
import worker from './spbfi-reports.js';
import { FakeD1 } from './fake-d1.mjs';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
}

// SPBFI_STORE=d1 runs the same checks against D1 instead of KV.
const useD1 = process.env.SPBFI_STORE === 'd1';
const storage = () => ({ REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}) });
const base = 'https://spbfi-reports.example';
const OWNER_KEY = 'owner-secret-for-tests-only';
const HOUR = 60 * 60 * 1000;
let calls = 0;

async function call(env, path, { method = 'GET', body, token } = {}) {
  calls += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      // A fresh address per call keeps the per-address limits out of the way.
      'CF-Connecting-IP': `198.18.${Math.floor(calls / 250) % 250}.${calls % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, data: await response.json() };
}

const realNow = Date.now;
async function on(moment, work) {
  Date.now = () => moment;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

async function stored(env) {
  if (env.DB) {
    const row = await env.DB.prepare('SELECT body FROM docs WHERE key = ?').bind('reports').first();
    return row ? JSON.parse(row.body) : [];
  }
  const raw = await env.REPORTS.get('reports');
  return raw == null ? [] : JSON.parse(raw);
}

const mark = (station, seen, extra = {}) => ({ station, grade: 'AI95', seen, lat: 59.93, lon: 30.33, ...extra });
const stations = (reports) => reports.map((report) => report.station).sort();

// ------------------------------------------------------------ a phone outside the club
{
  const env = storage();
  const now = realNow();
  // Oldest first, as a day goes.
  for (const [station, hours] of [['s-old', 25], ['s-twenty', 20], ['s-five', 5], ['s-two', 2], ['s-fresh', 0.2]]) {
    const sent = await on(now - hours * HOUR, () => call(env, '/report', { method: 'POST', body: mark(station, true, { who: `phone-${station}` }) }));
    assert.equal(sent.status, 200, `the mark at ${station} is taken`);
  }
  const three = (await call(env, '/reports')).data;
  assert.equal(three.window_hours, 3);
  assert.deepEqual(stations(three.reports), ['s-fresh', 's-two'], 'a plain read keeps its three hours');
  assert.ok(three.reports.every((report) => report.lat === 59.93 && report.lon === 30.33), 'the pipeline still gets where each mark was made');

  const day = (await call(env, '/reports?hours=24')).data;
  assert.equal(day.window_hours, 24);
  assert.deepEqual(stations(day.reports), ['s-five', 's-fresh', 's-twenty', 's-two'], 'the day lists everything but the mark older than a day');
  const byStation = Object.fromEntries(day.reports.map((report) => [report.station, report]));
  assert.equal(byStation['s-two'].lat, 59.93, 'within three hours the place stays');
  for (const station of ['s-five', 's-twenty']) {
    assert.ok(!('lat' in byStation[station]) && !('lon' in byStation[station]), `${station}: an older mark names the station, not where the phone stood`);
    assert.equal(byStation[station].seen, true);
  }
  assert.deepEqual(stations(await stored(env)), ['s-five', 's-fresh', 's-twenty', 's-two'], 'the store lets go of a mark once it is a day old');
  assert.equal((await call(env, '/reports?hours=6')).data.window_hours, 3, 'anything short of a day is the usual three hours');
}

// ------------------------------------------------------------ inside the club
{
  const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY };
  const owner = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const { code } = (await call(env, '/club/invite', { method: 'POST', token: owner.token })).data;
  const member = (await call(env, '/club/join', { method: 'POST', body: { code, name: 'Ирина', accept: true } })).data;
  assert(owner.token && member.token, 'the owner and a member are in');
  const now = realNow();
  const six = await on(now - 6 * HOUR, () => call(env, '/report', { method: 'POST', token: member.token, body: mark('club-six', false) }));
  assert.equal(six.status, 200);
  const one = await on(now - HOUR, () => call(env, '/report', { method: 'POST', token: member.token, body: mark('club-one', true) }));
  assert.equal(one.status, 200);

  const three = (await call(env, '/club/reports', { token: owner.token })).data;
  assert.deepEqual(stations(three.reports), ['club-one'], 'the club read keeps its three hours');
  const day = (await call(env, '/club/reports?hours=24', { token: owner.token })).data;
  assert.equal(day.window_hours, 24);
  assert.deepEqual(stations(day.reports), ['club-one', 'club-six']);
  const older = day.reports.find((report) => report.station === 'club-six');
  assert.equal(older.name, 'Ирина', 'names come with the day as with the hours');
  assert.ok(!('lat' in older) && !('lon' in older));
  assert.equal(day.reports.find((report) => report.station === 'club-one').lat, 59.93);

  // Thanks still reach only the three hours.
  const thanks = (target) => call(env, '/club/thanks', { method: 'POST', token: owner.token, body: { author: target.who, station: target.station, grade: 'AI95', at: target.at } });
  assert.equal((await thanks(older)).status, 404, 'a mark from six hours ago is listed, not thanked');
  assert.equal((await thanks(day.reports.find((report) => report.station === 'club-one'))).status, 200);

  assert.equal((await call(env, '/club/health')).data.day_marks, true, 'the app knows it may ask for the day');
}

console.log('day marks: ok');

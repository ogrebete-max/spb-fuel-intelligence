// Writes from phones without a member pass (15 Sep 2026 review). While the
// club is open such a phone still marks and subscribes, but it may not speak
// for a member, whose id anyone can read in /reports, nor push a member's phone
// off the notification list; its address never becomes its name; and a mark
// must name a plain station somewhere in Petersburg or the region.
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
const env = { REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}), CLUB_OWNER_KEY: 'owner-secret-for-tests-only' };
const base = 'https://spbfi-reports.example';
// Pushes go nowhere.
globalThis.fetch = async () => new Response(null, { status: 201 });

let calls = 0;
const addresses = new Set();

async function call(path, { method = 'GET', body, token, address } = {}) {
  calls += 1;
  // A fresh address per call keeps the per-address limits out of the way.
  const from = address || `198.18.${Math.floor(calls / 250) % 250}.${calls % 250}`;
  addresses.add(from);
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      'CF-Connecting-IP': from,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, data: await response.json() };
}

// What the worker keeps, read past it: subscriptions are never served.
async function stored(key) {
  if (env.DB) {
    const row = await env.DB.prepare('SELECT body FROM docs WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.body) : null;
  }
  const raw = await env.REPORTS.get(key);
  return raw == null ? null : JSON.parse(raw);
}

// Within one minute of the limiter's clock, whenever the test runs.
async function inOneMinute(work) {
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

const look = (station, extra = {}) => ({ station, grade: 'AI95', seen: true, lat: 59.93, lon: 30.33, ...extra });
const marks = async () => (await call('/reports')).data.reports;
const markAt = async (station) => (await marks()).filter((report) => report.station === station);
const ANON = /^anon-[0-9a-f]{10}$/;

// ------------------------------------------------------------ the club open, with real members
const health = (await call('/club/health')).data;
assert.equal(health.mode, 'test', 'the door is open: phones outside the club mark as before');
assert.equal(health.write_guard, true, 'a deployed server says it guards writes');

const owner = (await call('/club/owner', { method: 'POST', body: { key: env.CLUB_OWNER_KEY, name: 'Егор' } })).data;
assert(owner.token && owner.member?.id, 'the owner is in');
const { code } = (await call('/club/invite', { method: 'POST', token: owner.token })).data;
const sasha = (await call('/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;
assert(sasha.token && sasha.member?.id, 'Саша joined by invitation');

// ------------------------------------------------------------ nobody marks as a member without a pass
{
  const station = 'spbfi-0033b0c90ec7';
  assert.equal((await call('/report', { method: 'POST', token: sasha.token, body: look(station) })).status, 200);
  assert.deepEqual((await markAt(station)).map((report) => report.who), [sasha.member.id], "a member's mark carries the member's id");

  // Her id is public, so a phone without a pass says it is her, and says «нет».
  const forged = await call('/report', { method: 'POST', body: look(station, { who: sasha.member.id, seen: false }) });
  assert.equal(forged.status, 200, 'the mark itself is taken while the club is open');
  const there = await markAt(station);
  assert.equal(there.length, 2, `the forged mark did not replace hers: ${JSON.stringify(there)}`);
  assert.deepEqual(there.find((report) => report.who === sasha.member.id)?.seen, true, 'her «есть» stands');
  const stranger = there.find((report) => report.who !== sasha.member.id);
  assert.match(stranger.who, ANON, 'the forged «нет» is stored under an anonymous id');
  assert.equal(stranger.seen, false);

  // The owner's id as well; and the same phone is the same nobody each time.
  const address = '198.51.100.23';
  await call('/report', { method: 'POST', address, body: look('spbfi-005d05f57238', { who: owner.member.id }) });
  await call('/report', { method: 'POST', address, body: look('spbfi-009f64be4644') });
  const [asOwner] = await markAt('spbfi-005d05f57238');
  const [unnamed] = await markAt('spbfi-009f64be4644');
  assert.match(asOwner.who, ANON, "the owner's id is not taken either");
  assert.equal(unnamed.who, asOwner.who, 'one address, one anonymous id');
  await call('/report', { method: 'POST', address: '198.51.100.24', body: look('spbfi-00a1b2c3d4e5') });
  assert.notEqual((await markAt('spbfi-00a1b2c3d4e5'))[0].who, asOwner.who, 'another address, another id');
}

// ------------------------------------------------------------ a phone outside the club keeps its own id
{
  // The app finds its own marks by the id it sent.
  const station = 'spbfi-01b2c3d4e5f6';
  assert.equal((await call('/report', { method: 'POST', body: look(station, { who: 'k3v9x2qa' }) })).status, 200);
  assert.deepEqual((await markAt(station)).map((report) => report.who), ['k3v9x2qa']);
}

// ------------------------------------------------------------ an address never becomes a name
{
  const v4 = '198.51.100.77';
  const v6 = '2001:db8::7';
  await call('/report', { method: 'POST', address: v4, body: look('spbfi-02b2c3d4e5f6') });
  await call('/report', { method: 'POST', address: v4, body: look('spbfi-03b2c3d4e5f6', { who: '' }) });
  await call('/report', { method: 'POST', address: v4, body: look('spbfi-04b2c3d4e5f6', { who: v4 }) });
  await call('/report', { method: 'POST', address: v6, body: look('spbfi-05b2c3d4e5f6', { who: null }) });
  await call('/report', { method: 'POST', address: v6, body: look('spbfi-06b2c3d4e5f6', { who: v6 }) });
  await call('/subscribe', { method: 'POST', address: v4, body: { subscription: { endpoint: 'https://push.example/v4', keys: { p256dh: 'p', auth: 'a' } } } });
  await call('/subscribe', { method: 'POST', address: v6, body: { subscription: { endpoint: 'https://push.example/v6', keys: { p256dh: 'p', auth: 'a' } }, who: v6 } });
  const names = [...(await marks()).map((report) => report.who), ...(await stored('subscriptions')).map((item) => item.who)];
  for (const who of names) {
    assert(typeof who === 'string' && who, `every mark and subscription names someone: ${JSON.stringify(who)}`);
    assert(![...addresses].some((address) => who.includes(address)), `no address as a name: ${who}`);
    assert(!/^\d{1,3}(\.\d{1,3}){3}$/.test(who) && !who.includes(':') && !who.includes('.'), `nothing shaped like an address: ${who}`);
  }
  const unnamed = await Promise.all(['spbfi-02b2c3d4e5f6', 'spbfi-03b2c3d4e5f6', 'spbfi-04b2c3d4e5f6', 'spbfi-05b2c3d4e5f6', 'spbfi-06b2c3d4e5f6'].map(async (station) => (await markAt(station))[0].who));
  assert(unnamed.every((who) => ANON.test(who)), `phones that name nobody, or name an address, are anonymous: ${unnamed}`);
}

// ------------------------------------------------------------ a mark is of a plain station in Petersburg or the region
{
  const moscow = await call('/report', { method: 'POST', body: look('spbfi-07b2c3d4e5f6', { lat: 55.7558, lon: 37.6173 }) });
  assert.equal(moscow.status, 400, 'a station in Moscow is refused');
  assert.equal(moscow.data.error, 'outside_area');
  const nowhere = await call('/report', { method: 'POST', body: look('spbfi-08b2c3d4e5f6', { lat: 0, lon: 0 }) });
  assert.equal(nowhere.data.error, 'outside_area', 'and one at 0, 0');
  const words = await call('/report', { method: 'POST', body: look('spbfi-09b2c3d4e5f6', { lat: 'север', lon: 'юг' }) });
  assert.equal(words.data.error, 'outside_area', 'and coordinates that are not numbers');
  const memberAway = await call('/report', { method: 'POST', token: sasha.token, body: look('spbfi-10b2c3d4e5f6', { lat: 59.4, lon: 24.75 }) });
  assert.equal(memberAway.status, 400, 'a member is held to the same area');
  // The far ends of the region stay in.
  for (const [town, lat, lon] of [['Выборг', 60.7096, 28.7475], ['Луга', 58.7372, 29.8468], ['Тихвин', 59.6448, 33.5294], ['Подпорожье', 60.9128, 34.1686], ['Кронштадт', 59.9954, 29.7667]]) {
    const station = `spbfi-town-${town.length}${Math.round(lon)}`;
    assert.equal((await call('/report', { method: 'POST', body: look(station, { lat, lon, who: 'k3v9x2qa' }) })).status, 200, `${town} is in the region`);
  }
  assert.equal((await call('/report', { method: 'POST', body: { station: 'spbfi-11b2c3d4e5f6', grade: 'DT', seen: true } })).status, 200, 'a mark without coordinates is still taken');

  for (const station of ['<img src=x onerror=alert(1)>', 'spbfi 12b2c3d4e5f6', 'АЗС-1', '-spbfi', '../stations', 'spbfi-1"><b>']) {
    const bad = await call('/report', { method: 'POST', body: look(station) });
    assert.equal(bad.status, 400, `«${station}» is not a station id`);
    assert.equal(bad.data.error, 'bad_station');
  }
  assert(!(await marks()).some((report) => /[<>" ]|АЗС|^\.|^-/.test(report.station)), 'none of them was stored');
  for (const station of ['s', 'spbfi-0033b0c90ec7', 'osm:node_123.4', 'A1-b2_c3']) {
    assert.equal((await call('/report', { method: 'POST', body: look(station, { who: 'k3v9x2qa' }) })).status, 200, `«${station}» is a plain id`);
  }
}

// ------------------------------------------------------------ limits that do not depend on an address
{
  // One phone outside the club, many addresses (mobile networks change them).
  const statuses = await inOneMinute(async () => {
    const seen = [];
    for (let i = 0; i < 21; i += 1) seen.push((await call('/report', { method: 'POST', body: look(`spbfi-burst-${i}`, { who: 'burst001' }) })).status);
    return seen;
  });
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200), 'twenty marks a minute are fine');
  assert.equal(statuses[20], 429, 'the twenty-first from the same phone waits for the next minute');
  // A member is not held by that limit.
  const member = await inOneMinute(async () => {
    const seen = [];
    for (let i = 0; i < 21; i += 1) seen.push((await call('/report', { method: 'POST', token: sasha.token, body: look(`spbfi-member-${i}`) })).status);
    return seen;
  });
  assert(member.every((status) => status === 200), `a member's marks: ${member}`);

  // Subscriptions from one address: six a minute.
  const address = '198.51.100.99';
  const subscribes = await inOneMinute(async () => {
    const seen = [];
    for (let i = 0; i < 7; i += 1) seen.push((await call('/subscribe', { method: 'POST', address, body: { subscription: { endpoint: `https://push.example/loop-${i}`, keys: { p256dh: 'p', auth: 'a' } }, who: 'loop0001' } })).status);
    return seen;
  });
  assert.deepEqual(subscribes, [200, 200, 200, 200, 200, 200, 429]);
  const unsubscribes = await inOneMinute(async () => {
    const seen = [];
    for (let i = 0; i < 13; i += 1) seen.push((await call('/unsubscribe', { method: 'POST', address, body: { endpoint: `https://push.example/loop-${i % 7}` } })).status);
    return seen;
  });
  assert.deepEqual(unsubscribes, [...Array(12).fill(200), 429]);
}

// ------------------------------------------------------------ outsiders never push a member's phone off the list
{
  const subscription = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'p', auth: 'a' } });
  const rows = async () => (await stored('subscriptions')) || [];
  assert.equal((await call('/subscribe', { method: 'POST', token: sasha.token, body: { subscription: subscription('sasha'), who: sasha.member.id, lat: 59.93, lon: 30.33 } })).status, 200);
  const hers = (await rows()).find((item) => item.endpoint === subscription('sasha').endpoint);
  assert.equal(hers.who, sasha.member.id);
  assert.equal(hers.member, true, 'a subscription made with a pass is a member\'s');

  // A phone without a pass claiming the owner's id is an outsider like the rest.
  await call('/subscribe', { method: 'POST', body: { subscription: subscription('pretender'), who: owner.member.id } });
  const pretender = (await rows()).find((item) => item.endpoint === subscription('pretender').endpoint);
  assert.match(pretender.who, ANON);
  assert.equal(pretender.member, undefined);

  const OUTSIDERS = 305;
  let count = 0;
  for (let i = 0; i < OUTSIDERS; i += 1) {
    const answer = await call('/subscribe', { method: 'POST', body: { subscription: subscription(`stranger-${i}`), who: `stranger${i}`, lat: 59.9, lon: 30.3 } });
    assert.equal(answer.status, 200);
    count = answer.data.count;
  }
  const kept = await rows();
  assert.equal(count, 300, 'the list stays at its cap');
  assert.equal(kept.length, 300);
  assert(kept.some((item) => item.endpoint === subscription('sasha').endpoint && item.who === sasha.member.id), `the member's phone survived ${OUTSIDERS} outsiders`);
  assert(!kept.some((item) => item.endpoint === subscription('pretender').endpoint), 'the pretender made room like any outsider');
  assert(kept.some((item) => item.endpoint === subscription(`stranger-${OUTSIDERS - 1}`).endpoint), 'the newest outsider is on the list');
  assert(!kept.some((item) => item.endpoint === subscription('stranger-0').endpoint), 'the oldest outsiders made room');

  // The member subscribing again, after all of them, is still one row.
  assert.equal((await call('/subscribe', { method: 'POST', token: sasha.token, body: { subscription: subscription('sasha'), who: sasha.member.id } })).data.count, 300);
  assert.equal((await rows()).filter((item) => item.endpoint === subscription('sasha').endpoint).length, 1);
}

console.log(`worker write guard (${useD1 ? 'd1' : 'kv'}): OK`);

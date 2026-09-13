// What happens when several phones write at the same moment. On Workers KV a
// write made through one Cloudflare location is seen by the others up to a
// minute later, so people acting at once overwrite each other; D1 refuses a
// write based on an outdated version and the worker redoes it. Also: moving
// from KV to D1, answers when storage fails, and marks sent late.
import assert from 'node:assert/strict';
import worker from './spbfi-reports.js';
import { FakeD1 } from './fake-d1.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MemoryKV {
  constructor() { this.values = new Map(); this.writes = 0; }
  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.writes += 1; this.values.set(key, String(value)); }
}

// Workers KV as one Cloudflare location sees it: what it has read it keeps
// (for up to a minute in reality, for the whole test here); what it writes it
// sees at once, the other locations do not.
class EdgeKV {
  constructor(origin) { this.origin = origin; this.cache = new Map(); }
  async get(key, options) {
    await pause(2);
    if (!this.cache.has(key)) this.cache.set(key, this.origin.get(key) ?? null);
    const value = this.cache.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) {
    await pause(2);
    this.origin.set(key, String(value));
    this.cache.set(key, String(value));
  }
}

// Another isolate over the same database: its own memory, the same rows.
const isolate = (d1) => ({ prepare: (sql) => d1.prepare(sql), batch: (statements) => d1.batch(statements) });

const base = 'https://spbfi-reports.example';
const origin = 'https://ogrebete-max.github.io';
const OWNER_KEY = 'owner-secret-for-tests-only';
let ip = 0;
let pushes = 0;
globalThis.fetch = async () => { pushes += 1; return new Response(null, { status: 201 }); };

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      'CF-Connecting-IP': `198.18.${Math.floor(ip / 250) % 250}.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, headers: response.headers, data: await response.json() };
}

const realNow = Date.now;
async function later(ms, work) {
  Date.now = () => realNow() + ms;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

async function quietly(work) {
  const log = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = log;
  }
}

// ------------------------------------------------------------ KV: two people join through two locations, one is lost
{
  const store = new Map();
  const east = { REPORTS: new EdgeKV(store), CLUB_OWNER_KEY: OWNER_KEY };
  const west = { REPORTS: new EdgeKV(store), CLUB_OWNER_KEY: OWNER_KEY };
  const owner = (await call(east, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const codes = [];
  for (let i = 0; i < 2; i += 1) codes.push((await call(east, '/club/invite', { method: 'POST', token: owner.token })).data.code);
  // Both locations have served the app lately, so both hold copies of the lists.
  assert.equal((await call(west, '/club/me', { token: owner.token })).status, 200);
  const joins = await Promise.all([
    call(east, '/club/join', { method: 'POST', body: { code: codes[0], name: 'Саша', accept: true } }),
    call(west, '/club/join', { method: 'POST', body: { code: codes[1], name: 'Оля', accept: true } }),
  ]);
  assert.deepEqual(joins.map((joined) => joined.status), [200, 200], 'both are told they are in');
  const members = Object.values(JSON.parse(store.get('club:members'))).map((member) => member.name);
  assert.equal(['Саша', 'Оля'].filter((name) => members.includes(name)).length, 1, `KV keeps only one of them: ${members}`);
  const passes = await later(6 * 60 * 1000, () => Promise.all(joins.map((joined) => call(east, '/club/me', { token: joined.data.token }))));
  assert(passes.some((pass) => pass.status === 401), 'five minutes later the lost one is told the pass no longer works');
}

// ------------------------------------------------------------ D1: everyone who joins stays a member
const d1 = new FakeD1();
const kv = new MemoryKV();
const places = [0, 1, 2].map(() => ({ REPORTS: kv, DB: isolate(d1), CLUB_OWNER_KEY: OWNER_KEY }));
const owner = (await call(places[0], '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
assert.equal((await call(places[1], '/club/health')).data.storage, 'd1');
const codes = [];
for (let i = 0; i < 12; i += 1) codes.push((await call(places[i % 3], '/club/invite', { method: 'POST', token: owner.token })).data.code);
const joined = await Promise.all(codes.map((code, i) => call(places[i % 3], '/club/join', { method: 'POST', body: { code, name: `Гость ${i + 1}`, accept: true } })));
assert(joined.every((result) => result.status === 200), `every join is answered 200: ${joined.map((result) => result.status)}`);
assert.equal((await call(places[1], '/club/members', { token: owner.token })).data.members.length, 13, 'the owner and all twelve guests are members');
const passes = await later(6 * 60 * 1000, () => Promise.all(joined.map((result, i) => call(places[(i + 1) % 3], '/club/me', { token: result.data.token }))));
assert(passes.every((pass) => pass.status === 200), 'every pass still works after the grace period');
assert.equal((await call(places[2], '/club/join', { method: 'POST', body: { code: codes[0], name: 'Хитрец', accept: true } })).data.error, 'invite_used');

// One code, two people at the same moment: exactly one gets in.
{
  const { code } = (await call(places[0], '/club/invite', { method: 'POST', token: owner.token })).data;
  const race = await Promise.all([0, 1].map((i) => call(places[i], '/club/join', { method: 'POST', body: { code, name: `Двойник ${i}`, accept: true } })));
  assert.deepEqual(race.map((result) => result.status).sort(), [200, 409], 'one code lets in exactly one person');
}

// Eight members mark eight stations at once: every mark stays, everyone is paid.
{
  const looks = await Promise.all(joined.slice(0, 8).map((result, i) => call(places[i % 3], '/report', {
    method: 'POST', token: result.data.token,
    body: { station: `st-${i}`, lat: 60.05, lon: 30.3, grades: [{ grade: 'AI92', seen: true }, { grade: 'AI95', seen: false }] },
  })));
  assert(looks.every((look) => look.status === 200 && look.data.accepted === 2), `${looks.map((look) => look.status)}`);
  const reports = (await call(places[0], '/club/reports', { token: owner.token })).data.reports;
  assert.equal(reports.length, 16, 'sixteen grade marks from eight simultaneous looks');
  const litres = await Promise.all(joined.slice(0, 8).map((result) => call(places[1], '/club/me', { token: result.data.token }).then((me) => me.data.profile.liters)));
  assert(litres.every((value) => value === 1), `each look paid one litre: ${litres}`);

  // Six members thank the same mark at once: six thank-yous, twelve litres.
  const target = reports.find((report) => report.station === 'st-0' && report.grade === 'AI92');
  const thanks = await Promise.all(joined.slice(2, 8).map((result, i) => call(places[i % 3], '/club/thanks', {
    method: 'POST', token: result.data.token, body: { station: target.station, grade: target.grade, at: target.at, author: target.who },
  })));
  assert(thanks.every((result) => result.status === 200), `${thanks.map((result) => result.status)}`);
  const author = (await call(places[2], '/club/me', { token: joined[0].data.token })).data.profile;
  assert.equal(author.counts.thanks, 6);
  assert.equal(author.liters, 1 + 6 * 2);
}

// ------------------------------------------------------------ D1: first requests at once agree on the keys
{
  const fresh = new FakeD1({ latencyMs: 10 });
  const shared = new MemoryKV();
  const phones = [0, 1, 2, 3, 4].map(() => ({ REPORTS: shared, DB: isolate(fresh), CLUB_OWNER_KEY: OWNER_KEY }));
  const keys = await Promise.all(phones.map((env) => call(env, '/vapid').then((result) => result.data.publicKey)));
  assert.equal(new Set(keys).size, 1, 'one VAPID key, whichever isolate made it');
  const logins = await Promise.all(phones.map((env) => call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })));
  for (const login of logins) {
    for (const env of phones) assert.equal((await call(env, '/club/me', { token: login.data.token })).status, 200, 'a pass signed anywhere works everywhere');
  }
}

// ------------------------------------------------------------ moving from KV to D1
{
  const legacy = new MemoryKV();
  const before = { REPORTS: legacy };
  const oldKey = (await call(before, '/vapid')).data.publicKey;
  const subscription = (n) => ({ subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } }, who: `phone-${n}` });
  await call(before, '/subscribe', { method: 'POST', body: subscription(1) });
  await call(before, '/report', { method: 'POST', body: { station: 'old-1', grade: 'AI95', seen: true, who: 'phone-1' } });

  let kvWrites = 0;
  const watched = { get: (...args) => legacy.get(...args), put: (...args) => { kvWrites += 1; return legacy.put(...args); } };
  const after = { REPORTS: watched, DB: new FakeD1() };
  assert.equal((await call(after, '/vapid')).data.publicKey, oldKey, 'the VAPID key moves, so existing subscriptions keep working');
  assert.deepEqual((await call(after, '/reports')).data.reports.map((report) => report.station), ['old-1']);

  // While the new version rolls out, the old one still takes some requests.
  await pause(5);
  await call(before, '/report', { method: 'POST', body: { station: 'straggler', grade: 'DT', seen: false, who: 'phone-2' } });
  await call(before, '/subscribe', { method: 'POST', body: subscription(2) });
  assert.deepEqual((await call(after, '/reports')).data.reports.map((report) => report.station).sort(), ['old-1', 'straggler'], 'a mark the old version took is not lost');
  assert.equal((await call(after, '/subscribe', { method: 'POST', body: subscription(3) })).data.count, 3, 'nor is a subscription');

  // An hour on, KV is no longer consulted, and D1 never wrote to it.
  await call(before, '/report', { method: 'POST', body: { station: 'much-later', grade: 'DT', seen: false, who: 'phone-4' } });
  const stations = await later(61 * 60 * 1000, async () => (await call(after, '/reports')).data.reports.map((report) => report.station));
  assert(!stations.includes('much-later'));
  assert.equal(kvWrites, 0, 'with D1 bound nothing is written to KV');
}

// ------------------------------------------------------------ failures come back as JSON the phone can read
{
  class FullKV extends MemoryKV {
    async put() { throw new Error('KV put() limit exceeded for the day.'); }
  }
  const mark = { station: 's', grade: 'AI95', seen: true, who: 'p' };
  const full = await quietly(() => call({ REPORTS: new FullKV() }, '/report', { method: 'POST', body: mark }));
  assert.equal(full.status, 503);
  assert.equal(full.data.error, 'storage_limit');
  assert.equal(full.headers.get('Access-Control-Allow-Origin'), origin, 'with CORS headers, or the phone sees only a network error');

  const down = { REPORTS: new MemoryKV(), DB: new FakeD1({ failure: () => 'D1_ERROR: Network connection lost.' }) };
  const lost = await quietly(() => call(down, '/report', { method: 'POST', body: mark }));
  assert.equal(lost.status, 503);
  assert.equal(lost.data.error, 'worker_error');
  assert.equal(lost.headers.get('Access-Control-Allow-Origin'), origin);

  const jammed = { REPORTS: new MemoryKV(), DB: new FakeD1({ failure: (sql) => (sql.startsWith('INSERT INTO doc_guard') ? 'D1_ERROR: CHECK constraint failed: stale_write: SQLITE_CONSTRAINT' : null) }) };
  const busy = await quietly(() => call(jammed, '/report', { method: 'POST', body: mark }));
  assert.equal(busy.status, 503);
  assert.equal(busy.data.error, 'storage_busy');
}

// ------------------------------------------------------------ marks sent late keep their time
{
  const env = { REPORTS: new MemoryKV(), DB: new FakeD1() };
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
  await call(env, '/subscribe', {
    method: 'POST',
    body: { who: 'listener', subscription: { endpoint: 'https://push.example/listener', keys: { p256dh: b64(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } } },
  });

  const now = Date.now();
  const pushesBefore = pushes;
  const late = await call(env, '/report', { method: 'POST', body: { station: 'late-1', grade: 'AI95', seen: true, who: 'p1', observed_at: now - 20 * 60 * 1000 } });
  assert.equal(late.status, 200);
  const stored = (await call(env, '/reports')).data.reports.find((report) => report.station === 'late-1');
  assert(Math.abs(stored.at - (now - 20 * 60 * 1000)) < 5, 'a mark sent late keeps the time it was made');
  assert.equal(pushes, pushesBefore, 'nobody is pushed about a twenty-minute-old look');
  await call(env, '/report', { method: 'POST', body: { station: 'fresh-1', grade: 'AI95', seen: true, who: 'p1' } });
  assert.equal(pushes, pushesBefore + 1, 'a fresh look is pushed');

  const tooLate = await call(env, '/report', { method: 'POST', body: { station: 'late-2', grade: 'AI95', seen: true, who: 'p1', observed_at: now - 40 * 60 * 1000 } });
  assert.equal(tooLate.status, 410);
  assert.equal(tooLate.data.error, 'too_late');

  await call(env, '/report', { method: 'POST', body: { station: 'ahead', grade: 'AI95', seen: true, who: 'p1', observed_at: Date.now() + 3600000 } });
  assert((await call(env, '/reports')).data.reports.find((report) => report.station === 'ahead').at <= Date.now(), 'a clock running ahead does not date a look in the future');

  // An older look arriving late never replaces a newer one.
  await call(env, '/report', { method: 'POST', body: { station: 'late-3', grade: 'DT', seen: true, who: 'p1' } });
  const stale = await call(env, '/report', { method: 'POST', body: { station: 'late-3', grade: 'DT', seen: false, who: 'p1', observed_at: Date.now() - 5 * 60 * 1000 } });
  assert.equal(stale.data.accepted, 0);
  assert.deepEqual((await call(env, '/reports')).data.reports.filter((report) => report.station === 'late-3').map((report) => report.seen), [true]);
}

// ------------------------------------------------------------ the hero of last week is crowned once, on both stores
for (const [name, makeEnv] of [['kv', () => ({ REPORTS: new MemoryKV() })], ['d1', () => ({ REPORTS: new MemoryKV(), DB: new FakeD1() })]]) {
  const env = { ...makeEnv(), CLUB_OWNER_KEY: OWNER_KEY };
  const weekAgo = -7 * 24 * 60 * 60 * 1000;
  const sasha = await later(weekAgo, async () => {
    const boss = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
    const { code } = (await call(env, '/club/invite', { method: 'POST', token: boss.token })).data;
    const member = (await call(env, '/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;
    await call(env, '/report', { method: 'POST', token: member.token, body: { station: 'hero-1', grade: 'AI95', seen: true } });
    return { ...member, boss: boss.token };
  });
  const boards = await Promise.all([0, 1].map(() => call(env, '/club/leaderboard', { token: sasha.boss })));
  assert(boards.every((board) => board.data.hero_last_week?.name === 'Саша'), `${name}: last week's hero is named`);
  const profile = (await call(env, '/club/me', { token: sasha.token })).data.profile;
  assert(profile.badges.find((badge) => badge.id === 'hero').earned, `${name}: the hero gets the badge`);
  assert.equal((await call(env, '/club/me', { token: sasha.token })).data.news.filter((item) => item.type === 'hero').length, 1, `${name}: crowned once`);
}

console.log('worker storage under concurrency: OK');

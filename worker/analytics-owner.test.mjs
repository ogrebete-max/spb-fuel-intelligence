// Analytics on the club's own server (16 Sep 2026): the owner asked how many
// people open the app. ANALYTICS=on keeps the app's anonymous events as daily
// totals without an admin key, the club's owner reads them with the pass the
// app already holds, and nobody else does. A day's numbers go after 180 days,
// in a database too.
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
const DAY = 24 * 60 * 60 * 1000;
let calls = 0;

async function call(env, path, { method = 'GET', body, token, headers = {} } = {}) {
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
      ...headers,
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

const send = (env, install, names) => call(env, '/analytics/events', {
  method: 'POST',
  body: { install_id: install, session_id: `${install}-session`, events: names.map((event) => ({ event, at: Date.now(), fields: { grade: 'AI95', zone: 'spb_north' } })) },
});
const dayName = (moment) => new Date(moment).toISOString().slice(0, 10);

async function clubOf(env) {
  const owner = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const { code } = (await call(env, '/club/invite', { method: 'POST', token: owner.token })).data;
  const member = (await call(env, '/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;
  assert(owner.token && member.token, 'the owner and a member are in');
  return { owner, member };
}

// ------------------------------------------------------------ off unless asked for
{
  const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY };
  const { owner } = await clubOf(env);
  assert.equal((await call(env, '/analytics/health')).data.collecting, false);
  const sent = await send(env, 'phone-a', ['app_open']);
  assert.equal(sent.status, 202);
  assert.deepEqual([sent.data.accepted, sent.data.disabled], [0, true], 'nothing is kept while analytics are off');
  assert.equal((await call(env, '/analytics/dashboard?days=7', { token: owner.token })).status, 503);
}

// ------------------------------------------------------------ ANALYTICS=on: the owner reads, nobody else
const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, ANALYTICS: 'on' };
const { owner, member } = await clubOf(env);
const health = (await call(env, '/analytics/health')).data;
assert.equal(health.collecting, true);
assert.equal(health.owner_dashboard, true);
assert.equal((await call(env, '/club/health')).data.owner_analytics, true, 'the app knows to offer the panel');

// Every phone counts, in the club or not.
assert.equal((await send(env, 'phone-a', ['app_open', 'station_open', 'report_sent'])).data.accepted, 3);
assert.equal((await send(env, 'phone-b', ['app_open', 'station_open'])).data.accepted, 2);
assert.equal((await send(env, 'phone-a', ['app_open'])).data.accepted, 1, 'the same phone again');

for (const [who, options] of [
  ['nobody', {}],
  ['a member', { token: member.token }],
  ['a guessed analytics key', { headers: { 'X-Analytics-Key': 'guess' } }],
  ['a forged pass', { token: owner.token.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A')) }],
]) {
  assert.equal((await call(env, '/analytics/dashboard?days=7', options)).status, 403, `${who} does not read the numbers`);
}
const read = await call(env, '/analytics/dashboard?days=7', { token: owner.token });
assert.equal(read.status, 200, 'the owner reads them with the pass the app holds');
const today = read.data.trend.find((row) => row.day === dayName(Date.now()));
assert.equal(today?.users, 2, `two phones today: ${JSON.stringify(read.data.trend)}`);
const events = Object.fromEntries(read.data.events.map((row) => [row.key, row.count]));
assert.deepEqual([events.app_open, events.station_open, events.report_sent], [3, 2, 1]);

// Without the club there is no owner, and without a key nobody reads.
{
  const bare = { ...storage(), ANALYTICS: 'on' };
  assert.equal((await send(bare, 'phone-c', ['app_open'])).data.accepted, 1);
  assert.equal((await call(bare, '/analytics/dashboard?days=7', { token: owner.token })).status, 403);
}

// ------------------------------------------------------------ a day's numbers go after 180 days
if (useD1) {
  const keys = async () => (await env.DB.prepare('SELECT key FROM docs WHERE key LIKE ? ORDER BY key').bind('analytics:%').all()).results.map((row) => row.key);
  const dayKey = (moment) => `analytics:v2:${dayName(moment)}`;
  const now = realNow();
  await on(now - 200 * DAY, () => send(env, 'phone-old', ['app_open']));
  await on(now - 100 * DAY, () => send(env, 'phone-old', ['app_open']));
  assert((await keys()).includes(dayKey(now - 200 * DAY)), 'a day stays until it is 180 days old');
  await on(now + DAY, () => send(env, 'phone-a', ['app_open']));
  const kept = await keys();
  assert(!kept.includes(dayKey(now - 200 * DAY)), `a day older than 180 days is gone when a new day begins: ${kept}`);
  for (const moment of [now - 100 * DAY, now, now + DAY]) assert(kept.includes(dayKey(moment)), `younger days stay: ${kept}`);
}

console.log(`analytics for the club's owner (${useD1 ? 'd1' : 'kv'}): OK`);

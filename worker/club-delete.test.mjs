// 🗑 on a mark. A mark made by mistake used to stay: now its author deletes it
// in the first hour, and the owner any mark while it is listed. What the look
// earned its author goes with it, so marking and deleting pays nothing, and
// no count ever drops below zero.
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

const useD1 = process.env.SPBFI_STORE === 'd1';
const storage = () => ({ REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}) });
const OWNER_KEY = 'owner-secret-for-tests-only';
const PUMP = { lat: 59.9386, lon: 30.3141 };
const MINUTE = 60 * 1000;
const BOTH = [{ grade: 'AI95', seen: true }, { grade: 'AI92', seen: false }];
let ip = 0;
globalThis.fetch = async () => new Response(null, { status: 201 });

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`https://spbfi-reports.example${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      'CF-Connecting-IP': `192.0.2.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, data: await response.json() };
}

async function later(ms, action) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await action();
  } finally {
    Date.now = realNow;
  }
}

const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed' };
assert.equal((await call(env, '/club/health')).data.delete_marks, true);
const boss = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
const join = async (name) => {
  const code = (await call(env, '/club/invite', { method: 'POST', token: boss.token })).data.code;
  return (await call(env, '/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
};
const sasha = await join('Саша');
const olya = await join('Оля');

const mark = async (who, station, grades, extra = {}) => {
  const result = await call(env, '/report', { method: 'POST', token: who.token, body: { station, grades, lat: PUMP.lat, lon: PUMP.lon, ...extra } });
  assert.equal(result.status, 200);
  const at = (await call(env, '/club/reports', { token: boss.token })).data.reports.find((report) => report.station === station && report.who === who.member.id).at;
  return { at, paid: result.data.rewards.liters };
};
const remove = (who, body) => call(env, '/club/report/delete', { method: 'POST', token: who.token, body });
const me = async (who) => (await call(env, '/club/me', { token: who.token })).data;
const listed = async (who, station) => (await call(env, '/club/reports', { token: boss.token })).data.reports.filter((report) => report.station === station && report.who === who.member.id);

// The scoreboard as stored, read and changed behind the worker's back.
async function readStats() {
  const raw = env.DB
    ? await env.DB.prepare('SELECT body FROM docs WHERE key = ?').bind('club:stats').first('body')
    : await env.REPORTS.get('club:stats');
  return JSON.parse(raw || '{}');
}

async function writeStats(stats) {
  if (env.DB) await env.DB.prepare('UPDATE docs SET body = ?, version = version + 1 WHERE key = ?').bind(JSON.stringify(stats), 'club:stats').run();
  else await env.REPORTS.put('club:stats', JSON.stringify(stats));
}

// Every count a look can earn, and the 🤝 of every week and day, of everyone.
async function neverBelowZero(label) {
  for (const [id, stats] of Object.entries(await readStats())) {
    const numbers = [
      ...['liters', 'marks', 'blind', 'first_seen', 'scout', 'night'].map((name) => [name, stats[name]]),
      ...Object.entries(stats.weeks || {}),
      ...Object.entries(stats.days || {}),
    ];
    for (const [name, value] of numbers) assert(value >= 0, `${label}: ${id}.${name} is ${value}`);
  }
}

// ------------------------------------------------------------ the author takes a mistake back
const first = await mark(sasha, 'st-1', BOTH, { blind_spot: true });
assert.equal(first.paid, 3, '+1 for the look and +2 for the blind spot');
const paidFor = await me(sasha);
assert.equal(paidFor.profile.liters, 3);
assert(paidFor.news.some((item) => item.type === 'blind_spot' && item.station === 'st-1' && item.at === first.at));

const gone = await remove(sasha, { station: 'st-1', at: first.at });
assert.equal(gone.status, 200);
assert.deepEqual([gone.data.ok, gone.data.removed, gone.data.liters_back], [true, 2, 3], 'both grades of the look, and all it earned');
assert.equal((await listed(sasha, 'st-1')).length, 0, 'the club no longer sees it');
assert(!(await call(env, '/reports')).data.reports.some((report) => report.station === 'st-1'), 'nor does the shared list');
const takenBack = await me(sasha);
assert.deepEqual([takenBack.profile.liters, takenBack.profile.week], [0, 0], 'the 🤝 are taken back');
assert.deepEqual([takenBack.profile.counts.marks, takenBack.profile.counts.blind], [0, 0], 'and so are the counts');
assert(!takenBack.news.some((item) => ['mark', 'blind_spot', 'first_seen'].includes(item.type) && item.station === 'st-1'), 'and the news about them');
assert(!takenBack.news.some((item) => item.type === 'mark_removed'), 'deleting your own mark tells you nothing');
assert.equal((await readStats())[sasha.member.id].paid_looks[`st-1:${first.at}`], undefined, 'what was paid is forgotten');
assert.equal((await remove(sasha, { station: 'st-1', at: first.at })).data.error, 'mark_gone', 'a look is deleted once');
await neverBelowZero('after deleting');

// ------------------------------------------------------------ and cannot farm 🤝 with it
const again = await mark(sasha, 'st-1', BOTH, { blind_spot: true });
assert.equal(again.paid, 3);
assert.equal((await me(sasha)).profile.liters, 3, 'marked again after deleting: paid once in total');

const tooLate = await later(61 * MINUTE, () => remove(sasha, { station: 'st-1', at: again.at }));
assert.deepEqual([tooLate.status, tooLate.data.error], [410, 'delete_too_late'], 'after an hour a member\'s mark stays');
assert.equal((await listed(sasha, 'st-1')).length, 2);
assert.equal((await me(sasha)).profile.liters, 3);

// A look repeated within the hour replaces the first one and earns nothing.
// Deleting the repeat must not make the next look a first one again.
const repeat = await later(5 * MINUTE, () => mark(sasha, 'st-1', BOTH, { blind_spot: true }));
assert.equal(repeat.paid, 0);
const repeatGone = await later(6 * MINUTE, () => remove(sasha, { station: 'st-1', at: repeat.at }));
assert.deepEqual([repeatGone.status, repeatGone.data.removed, repeatGone.data.liters_back], [200, 2, 0]);
const afterRepeat = await later(7 * MINUTE, () => mark(sasha, 'st-1', BOTH, { blind_spot: true }));
assert.equal(afterRepeat.paid, 0, 'the hour\'s first look was paid, and that still counts');
assert.equal((await me(sasha)).profile.liters, 3, 'mark, mark again, delete: still paid once');
await neverBelowZero('after the repeat');

// ------------------------------------------------------------ someone else's mark
const olyaLook = await mark(olya, 'st-2', [{ grade: 'DT', seen: true }]);
assert.equal(olyaLook.paid, 1);
const notYours = await remove(olya, { station: 'st-1', at: afterRepeat.at, author: sasha.member.id });
assert.deepEqual([notYours.status, notYours.data.error], [403, 'not_yours']);
assert.equal((await remove(olya, { station: 'st-1', at: afterRepeat.at })).data.error, 'mark_gone', 'unnamed, the author is Olya herself');
assert.equal((await listed(sasha, 'st-1')).length, 2, 'Sasha\'s look is still there');

// ------------------------------------------------------------ the owner takes down any listed mark
const byOwner = await later(2 * 60 * MINUTE, () => remove(boss, { station: 'st-2', at: olyaLook.at, author: olya.member.id }));
assert.equal(byOwner.status, 200, 'two hours on, the owner still can');
assert.deepEqual([byOwner.data.removed, byOwner.data.liters_back], [1, 1]);
assert.equal((await listed(olya, 'st-2')).length, 0);
const olyaAfter = await me(olya);
assert.deepEqual([olyaAfter.profile.liters, olyaAfter.profile.counts.marks], [0, 0], 'Olya\'s rewards are taken back');
assert(!olyaAfter.news.some((item) => item.type === 'mark' && item.station === 'st-2'));
const told = olyaAfter.news.filter((item) => item.type === 'mark_removed');
assert.equal(told.length, 1, 'and she is told');
assert.deepEqual([told[0].station, told[0].mark_at, told[0].by], ['st-2', olyaLook.at, 'owner']);
assert(told[0].at > olyaLook.at, 'dated when it happened, so a phone that has read its news since the mark still hears it');

const ownerLook = await mark(boss, 'st-3', [{ grade: 'AI95', seen: true }]);
assert.equal((await later(3 * 60 * MINUTE + MINUTE, () => remove(boss, { station: 'st-3', at: ownerLook.at }))).data.error, 'mark_gone', 'past three hours nothing is listed');
assert.equal((await later(90 * MINUTE, () => remove(boss, { station: 'st-3', at: ownerLook.at }))).status, 200, 'the owner\'s own mark, past the hour too');
assert(!(await me(boss)).news.some((item) => item.type === 'mark_removed'));
await neverBelowZero('after the owner');

// ------------------------------------------------------------ nothing drops below zero
// Were the scoreboard to hold less than a look earned (changed by hand, or
// brought back from an older copy), taking it back stops at zero.
const low = await mark(olya, 'st-4', BOTH, { blind_spot: true });
assert.equal(low.paid, 3);
const stats = await readStats();
Object.assign(stats[olya.member.id], { liters: 1, marks: 0, blind: 0, scout: 0, weeks: {}, days: {} });
await writeStats(stats);
const clamped = await remove(olya, { station: 'st-4', at: low.at });
assert.deepEqual([clamped.status, clamped.data.liters_back], [200, 1], 'only what is left is taken back');
assert.equal((await me(olya)).profile.liters, 0);
await neverBelowZero('after taking back more than was left');

// ------------------------------------------------------------ who may not
assert.equal((await remove(sasha, { station: 'st-9', at: afterRepeat.at })).status, 404, 'no such look');
assert.equal((await remove(sasha, { station: 'st-1', at: String(afterRepeat.at + 1) })).data.error, 'mark_gone');
assert.equal((await call(env, '/club/report/delete', { method: 'POST', body: { station: 'st-1', at: afterRepeat.at } })).status, 401, 'members only');
await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: sasha.member.id, banned: true, reason: 'тест' } });
const banned = await remove(sasha, { station: 'st-1', at: afterRepeat.at });
assert.deepEqual([banned.status, banned.data.error], [403, 'banned']);

console.log(`worker club delete (${useD1 ? 'd1' : 'kv'}): OK`);

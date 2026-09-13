// 👍 and 👎 on someone else's mark: only from a member at that pump, only in
// the first hour. 👍 pays the author like a confirmation. 👎 from different
// people add up with no expiry: three warn the author, five take them out of
// the club, and the owner can bring them back with a clean slate.
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
const NEAR = { lat: 59.9395, lon: 30.3141 }; // about 100 m
const EDGE = { lat: 59.9419, lon: 30.3141 }; // about 370 m: GPS drift is forgiven
const FAR = { lat: 59.9476, lon: 30.3141 }; // about a kilometre
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
assert.equal((await call(env, '/club/health')).data.votes, true);
const boss = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
const join = async (name) => {
  const code = (await call(env, '/club/invite', { method: 'POST', token: boss.token })).data.code;
  return (await call(env, '/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
};
const mark = async (who, station, grades = [{ grade: 'AI95', seen: true }]) => {
  const result = await call(env, '/report', { method: 'POST', token: who.token, body: { station, grades, lat: PUMP.lat, lon: PUMP.lon, name: 'Лукойл' } });
  assert.equal(result.status, 200);
  return (await call(env, '/club/reports', { token: boss.token })).data.reports.find((report) => report.station === station && report.who === who.member.id).at;
};
const liters = async (who) => (await call(env, '/club/me', { token: who.token })).data.profile.liters;
const row = async (who) => (await call(env, '/club/members', { token: boss.token })).data.members.find((item) => item.id === who.member.id);

const sasha = await join('Саша');
const olya = await join('Оля');
const at = await mark(sasha, 'st-1', [{ grade: 'AI95', seen: true }, { grade: 'AI92', seen: false }]);
const vote = (who, extra) => call(env, '/club/vote', { method: 'POST', token: who.token, body: { station: 'st-1', at, author: sasha.member.id, lat: NEAR.lat, lon: NEAR.lon, ...extra } });

// ------------------------------------------------------------ who may vote
assert.equal((await vote(sasha, { vote: 'up' })).data.error, 'cannot_vote_self');
assert.equal((await vote(olya, { vote: 'sideways' })).data.error, 'expected_vote');
const far = await vote(olya, { vote: 'up', lat: FAR.lat, lon: FAR.lon });
assert.equal(far.status, 403, 'a kilometre away nobody sees the pump');
assert.equal(far.data.error, 'vote_not_here');
assert.equal((await vote(olya, { vote: 'up', lat: undefined, lon: undefined })).data.error, 'vote_needs_place');
assert.equal((await call(env, '/club/vote', { method: 'POST', body: { station: 'st-1', at, author: sasha.member.id, vote: 'up', ...NEAR } })).status, 401, 'members only');
assert.equal((await vote(olya, { vote: 'up', at: at + 1 })).data.error, 'mark_gone');
assert.equal((await later(61 * 60 * 1000, () => vote(olya, { vote: 'up' }))).data.error, 'vote_too_late', 'after an hour it is history');

// ------------------------------------------------------------ 👍 pays like a confirmation, once
const before = await liters(sasha);
const liked = await vote(olya, { vote: 'up', lat: EDGE.lat, lon: EDGE.lon });
assert.equal(liked.status, 200, 'GPS drift of a few dozen metres is forgiven');
assert.deepEqual([liked.data.up, liked.data.down, liked.data.mine, liked.data.paid], [1, 0, 'up', 3]);
assert.equal(await liters(sasha), before + 3);
const again = await vote(olya, { vote: 'up' });
assert.equal(again.data.up, 1, 'a second 👍 from the same person is the same 👍');
assert.equal(await liters(sasha), before + 3, 'and pays nothing');
const seenByOlya = (await call(env, '/club/reports', { token: olya.token })).data.reports.filter((report) => report.station === 'st-1');
assert.equal(seenByOlya.length, 2);
assert(seenByOlya.every((report) => report.up === 1 && report.down === 0 && report.my_vote === 'up'), 'every grade of the look carries the votes');
assert(( await call(env, '/club/reports', { token: boss.token })).data.reports.filter((report) => report.station === 'st-1').every((report) => report.my_vote === null));

// ------------------------------------------------------------ 👎 from different people
const voters = [];
for (const name of ['Дима', 'Катя', 'Лёша', 'Маша']) voters.push(await join(name));
const [dima, katya, lyosha, masha] = voters;
const news = async () => (await call(env, '/club/me', { token: sasha.token })).data.news.filter((item) => item.type === 'warning');

assert.equal((await vote(dima, { vote: 'down' })).data.down, 1);
assert.equal((await vote(katya, { vote: 'down' })).data.down, 2);
assert.equal((await row(sasha)).refuted_by, 2);
assert.equal((await news()).length, 0, 'two people are not yet a warning');

const changed = await vote(olya, { vote: 'down' });
assert.deepEqual([changed.data.up, changed.data.down], [0, 3], 'a changed mind moves the vote');
assert.equal((await news()).length, 1, 'three people bring a warning');
assert.equal((await row(sasha)).warned, true);
assert.equal((await call(env, '/club/me', { token: sasha.token })).data.refuted_by, 3);

await vote(olya, { vote: 'up' });
assert.equal((await row(sasha)).refuted_by, 2, 'taking a 👎 back takes the person off the count');
assert.equal(await liters(sasha), before + 3, 'coming back to 👍 within the hour pays nothing more');
await vote(olya, { vote: 'down' });
assert.equal((await news()).length, 1, 'a warning is given once');

const at2 = await mark(sasha, 'st-2');
await call(env, '/club/vote', { method: 'POST', token: dima.token, body: { station: 'st-2', at: at2, author: sasha.member.id, vote: 'down', ...NEAR } });
assert.equal((await row(sasha)).refuted_by, 3, 'one person refuting two marks counts once');

await vote(lyosha, { vote: 'down' });
assert.equal((await call(env, '/club/me', { token: sasha.token })).status, 200, 'four people: still inside');
await vote(masha, { vote: 'down' });
const out = await call(env, '/club/me', { token: sasha.token });
assert.equal(out.status, 403, 'five people: out of the club');
assert.equal(out.data.error, 'banned');
assert.match(out.data.reason, /опровергли 5 участников/);
const excluded = await row(sasha);
assert.deepEqual([excluded.banned, excluded.banned_by, excluded.refuted_by], [true, 'votes', 5]);
assert.deepEqual([...excluded.refuted_names].sort(), ['Дима', 'Катя', 'Лёша', 'Маша', 'Оля'].sort(), 'the owner sees who refuted');
assert.equal((await call(env, '/club/me', { token: olya.token })).data.refuted_names, undefined, 'a member does not');
assert(!(await call(env, '/club/reports', { token: boss.token })).data.reports.some((report) => report.who === sasha.member.id), 'their marks stop counting at once');
assert.equal((await vote(olya, { vote: 'up' })).data.error, 'mark_gone');

// ------------------------------------------------------------ the owner brings them back with a clean slate
assert.equal((await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: sasha.member.id, banned: false } })).status, 200);
assert.equal((await call(env, '/club/me', { token: sasha.token })).status, 200);
const back = await row(sasha);
assert.deepEqual([back.banned, back.banned_by, back.refuted_by, back.warned], [false, null, 0, false]);
const fresh = await mark(sasha, 'st-4');
assert.equal((await call(env, '/club/vote', { method: 'POST', token: dima.token, body: { station: 'st-4', at: fresh, author: sasha.member.id, vote: 'down', ...NEAR } })).status, 200);
assert.equal((await row(sasha)).refuted_by, 1, 'counting starts over');

// ------------------------------------------------------------ an owner's ban is labelled as such
await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: masha.member.id, banned: true, reason: 'тест' } });
assert.equal((await row(masha)).banned_by, 'owner');
await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: masha.member.id, banned: false } });

// ------------------------------------------------------------ the owner is never voted out
const ownerAt = await mark(boss, 'st-3');
for (const voter of [olya, dima, katya, lyosha, masha]) {
  await call(env, '/club/vote', { method: 'POST', token: voter.token, body: { station: 'st-3', at: ownerAt, author: 'owner', vote: 'down', ...NEAR } });
}
assert.equal((await call(env, '/club/me', { token: boss.token })).status, 200);

// ------------------------------------------------------------ a vote a day limit keeps a loop from running away
{
  const club = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed' };
  const owner = (await call(club, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
  const code = (await call(club, '/club/invite', { method: 'POST', token: owner.token })).data.code;
  const voter = (await call(club, '/club/join', { method: 'POST', body: { code, name: 'Петя', accept: true } })).data;
  let last = null;
  for (let i = 0; i < 42; i += 1) {
    await call(club, '/report', { method: 'POST', token: owner.token, body: { station: `loop-${i}`, grade: 'AI95', seen: true, lat: PUMP.lat, lon: PUMP.lon } });
    const loopAt = (await call(club, '/club/reports', { token: owner.token })).data.reports.find((report) => report.station === `loop-${i}`).at;
    last = await call(club, '/club/vote', { method: 'POST', token: voter.token, body: { station: `loop-${i}`, at: loopAt, author: 'owner', vote: 'up', ...NEAR } });
  }
  assert.equal(last.data.error, 'too_many_votes');
}

console.log(`worker club votes (${useD1 ? 'd1' : 'kv'}): OK`);

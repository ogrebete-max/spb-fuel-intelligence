import assert from 'node:assert/strict';
import worker from './spbfi-reports.js';

class MemoryKV {
  constructor() { this.values = new Map(); this.writes = 0; }
  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.writes += 1; this.values.set(key, String(value)); }
}

const base = 'https://spbfi-reports.example';
const pending = [];
const ctx = { waitUntil(promise) { pending.push(promise); } };
let ip = 0;
const pushes = [];
globalThis.fetch = async (url) => { pushes.push(String(url)); return new Response(null, { status: 201 }); };

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      'CF-Connecting-IP': `203.0.113.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: response.status, data: await response.json() };
}

const env = { REPORTS: new MemoryKV(), CLUB_OWNER_KEY: 'owner-secret-for-tests-only' };
const owner = (await call(env, '/club/owner', { method: 'POST', body: { key: env.CLUB_OWNER_KEY, name: 'Егор' } })).data;
async function invite(token, name) {
  const { code } = (await call(env, '/club/invite', { method: 'POST', token })).data;
  return (await call(env, '/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
}
const sasha = await invite(owner.token, 'Саша');
const olya = await invite(owner.token, 'Оля');
const mark = (token, station, grade, seen, extra = {}) => call(env, '/report', {
  method: 'POST', token, body: { station, grade, seen, lat: 60.05, lon: 30.3, ...extra },
});

// A first mark pays one litre and the first badge.
const first = await mark(sasha.token, 'st-1', 'AI95', true, { queue: 3 });
assert.equal(first.status, 200);
assert.equal(first.data.rewards.liters, 1);
assert.deepEqual(first.data.rewards.badges.map((badge) => badge.id), ['first_mark']);
assert.equal(first.data.rewards.level.title, 'Новичок');

// More grades at the same station within the hour are the same look: no extra litres.
const sameLook = await mark(sasha.token, 'st-1', 'AI92', true);
assert.equal(sameLook.data.rewards.liters, 0);

// Olya agrees with Sasha: Sasha is paid for being confirmed, once per station,
// not once per grade, and the matching queue counts too.
const agree95 = await mark(olya.token, 'st-1', 'AI95', true, { queue: 4 });
assert.deepEqual(agree95.data.rewards.confirmed, ['Саша']);
const agree92 = await mark(olya.token, 'st-1', 'AI92', true);
assert.deepEqual(agree92.data.rewards.confirmed, [], 'the same confirmer pays an author once per station an hour');

let me = (await call(env, '/club/me', { token: sasha.token })).data;
assert.equal(me.profile.liters, 1 + 3);
assert.equal(me.profile.counts.confirmed, 1);
assert(me.news.some((item) => item.type === 'confirmed' && item.by_name === 'Оля'));

// «Спасибо»: +2 л to the author, once per person per mark, never to yourself.
const reports = (await call(env, '/club/reports', { token: olya.token })).data.reports;
const sashaMark = reports.find((report) => report.name === 'Саша' && report.grade === 'AI95');
assert.equal(sashaMark.thanks, 0);
assert.ok(sashaMark.level_icon);
const thanks = { station: sashaMark.station, grade: sashaMark.grade, at: sashaMark.at, author: sashaMark.who };
const pushesBefore = pushes.length;
assert.equal((await call(env, '/club/thanks', { method: 'POST', token: olya.token, body: thanks })).status, 200);
assert.equal((await call(env, '/club/thanks', { method: 'POST', token: olya.token, body: thanks })).data.error, 'already_thanked');
assert.equal((await call(env, '/club/thanks', { method: 'POST', token: sasha.token, body: thanks })).data.error, 'cannot_thank_self');
assert.equal((await call(env, '/club/thanks', { method: 'POST', token: owner.token, body: { ...thanks, at: 1 } })).data.error, 'mark_gone');
assert.equal(pushes.length, pushesBefore, 'no push without a subscription');
const afterThanks = (await call(env, '/club/reports', { token: olya.token })).data.reports.find((report) => report.at === sashaMark.at && report.who === sashaMark.who);
assert.equal(afterThanks.thanks, 1);
assert.equal(afterThanks.thanked, true);
me = (await call(env, '/club/me', { token: sasha.token })).data;
assert.equal(me.profile.liters, 1 + 3 + 2);
assert(me.news.some((item) => item.type === 'thanks' && item.by_name === 'Оля'));
const since = me.now;
assert.equal((await call(env, `/club/me?since=${since}`, { token: sasha.token })).data.news.length, 0, 'news can be read incrementally');

// «Нет» that saved someone a trip counts for the «Сберёг поездку» badge.
await mark(sasha.token, 'st-2', 'DT', false);
const noMark = (await call(env, '/club/reports', { token: owner.token })).data.reports.find((report) => report.station === 'st-2');
await call(env, '/club/thanks', { method: 'POST', token: owner.token, body: { station: 'st-2', grade: 'DT', at: noMark.at, author: noMark.who } });
me = (await call(env, '/club/me', { token: sasha.token })).data;
assert.equal(me.profile.counts.saved, 1);

// Seeing fuel where the last word was «нет» is worth a bonus.
const back = await mark(olya.token, 'st-2', 'DT', true);
assert.equal(back.data.rewards.liters, 1 + 2);

// Filling a blind spot pays a bonus, once per look.
const blind = await mark(owner.token, 'st-blind', 'AI95', true, { blind_spot: true });
assert.equal(blind.data.rewards.liters, 1 + 2);
assert.equal(blind.data.rewards.blind_spot, true);
const blindAgain = await mark(owner.token, 'st-blind', 'AI92', true, { blind_spot: true });
assert.equal(blindAgain.data.rewards.liters, 0, 'no bonus for another grade of the same look');

// A daily cap keeps tapping from paying.
for (let i = 0; i < 15; i += 1) await mark(olya.token, `spam-${i}`, 'AI95', true);
const olyaMe = (await call(env, '/club/me', { token: olya.token })).data;
assert(olyaMe.profile.liters <= 10 + 2, `mark litres are capped per day, got ${olyaMe.profile.liters}`);

// The owner can thank someone publicly; members cannot.
assert.equal((await call(env, '/club/award', { method: 'POST', token: sasha.token, body: { id: olya.member.id, text: 'Молодец' } })).status, 403);
const award = await call(env, '/club/award', { method: 'POST', token: owner.token, body: { id: sasha.member.id, text: 'За ночной дозор' } });
assert.equal(award.status, 200);
me = (await call(env, '/club/me', { token: sasha.token })).data;
assert(me.profile.badges.find((badge) => badge.id === 'club_award').earned);
assert.equal(me.profile.awards[0].text, 'За ночной дозор');

// The weekly board ranks by this week's litres and hides banned members.
const board = (await call(env, '/club/leaderboard', { token: olya.token })).data;
assert.equal(board.members.length, 3);
assert(board.members[0].week >= board.members[1].week);
assert.equal(board.members.find((row) => row.me).name, 'Оля');
await call(env, '/club/ban', { method: 'POST', token: owner.token, body: { id: olya.member.id, banned: true } });
assert.equal((await call(env, '/club/leaderboard', { token: sasha.token })).data.members.some((row) => row.name === 'Оля'), false);

// A mark now costs two writes: the mark and the club's scoreboard.
const writes = env.REPORTS.writes;
await mark(sasha.token, 'st-9', 'AI98', true);
assert.equal(env.REPORTS.writes - writes, 2);

console.log('worker rewards integration: OK');

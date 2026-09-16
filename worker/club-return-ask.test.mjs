// Back on a new phone with a fresh code (16 Sep 2026). A member who asked a
// friend for a code became a second member with nothing. The owner decided that
// one name is one person, and that whoever gave the code vouches that the phone
// asking is that member. The phone then comes in as them, and the code is not spent.
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
let calls = 0;
globalThis.fetch = async () => new Response(null, { status: 201 });

async function call(path, { method = 'GET', body, token } = {}) {
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
async function later(ms, work) {
  Date.now = () => realNow() + ms;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

const invite = async (token) => (await call('/club/invite', { method: 'POST', token })).data.code;
const join = (code, name, device) => call('/club/join', { method: 'POST', body: { code, name, accept: true, device } });
const askBack = (code, name, device) => call('/club/return/ask', { method: 'POST', body: { code, name, device } });
const statusOf = (ask, secret = ask.secret) => call('/club/return/status', { method: 'POST', body: { id: ask.id, secret } });
const answer = (token, ask, yes) => call('/club/return/answer', { method: 'POST', token, body: { id: ask.id, yes } });
const codeState = async (token, code) => (await call('/club/me', { token })).data.invites.find((item) => item.code === code);
const named = async (token, name) => (await call('/club/members', { token })).data.members.filter((item) => item.name === name);

const owner = (await call('/club/owner', { method: 'POST', body: { key: env.CLUB_OWNER_KEY, name: 'Егор' } })).data;
const sasha = (await join(await invite(owner.token), 'Саша', 'old-phone')).data;
const olya = (await join(await invite(owner.token), 'Оля', 'olya-phone')).data;
assert(sasha.token && olya.token, 'Саша and Оля are in');
assert.equal((await call('/club/health')).data.return_asks, true);
// Саша has something to come back to.
assert.equal((await call('/report', { method: 'POST', token: sasha.token, body: { station: 'spbfi-return-1', grade: 'AI95', seen: true, lat: 59.93, lon: 30.33 } })).status, 200);
const handshakes = (await call('/club/me', { token: sasha.token })).data.profile.liters;
assert(handshakes > 0);

// ------------------------------------------------------------ a fresh code and the same name make no twin
const code = await invite(olya.token);
const twin = await join(code, '  саша ', 'new-phone');
assert.equal(twin.status, 409);
assert.deepEqual([twin.data.error, twin.data.name], ['name_taken', 'Саша'], 'the name is read the way the owner\'s key is');
assert.equal((await named(owner.token, 'Саша')).length, 1, 'still one Саша');
assert.equal((await codeState(olya.token, code)).used_by, null, 'Оля\'s code is not spent');
assert.equal((await join(await invite(owner.token), 'Петя', 'petya-phone')).status, 200, 'a new name joins as before');

// ------------------------------------------------------------ the new phone asks, and only Оля vouches
const ask = (await askBack(code, 'Саша', 'new-phone')).data;
assert.deepEqual([ask.name, ask.by_name], ['Саша', 'Оля']);
assert(ask.id && ask.secret);
assert.equal((await statusOf(ask, 'guess')).status, 404, 'the request answers only the phone that made it');
assert.equal((await statusOf(ask)).data.status, 'pending');
const olyaSees = (await call('/club/me', { token: olya.token })).data;
assert.deepEqual(olyaSees.returns.map((item) => [item.name, item.code]), [['Саша', code]], 'Оля sees who asks, and by which code');
assert(olyaSees.news.some((item) => item.type === 'return_ask' && item.name === 'Саша'), 'and hears about it');
assert.deepEqual((await call('/club/me', { token: owner.token })).data.returns, [], 'the owner has nothing to answer for a code Оля gave');
for (const [who, token] of [['Саша herself', sasha.token], ['the owner', owner.token]]) {
  assert.equal((await answer(token, ask, true)).status, 404, `${who} cannot vouch for a code Оля gave`);
}
const yes = await answer(olya.token, ask, true);
assert.deepEqual([yes.data.status, yes.data.name], ['approved', 'Саша']);
assert.deepEqual((await call('/club/me', { token: olya.token })).data.returns, [], 'answered, it is gone from Оля\'s club');

// ------------------------------------------------------------ the pass: the same member, with everything
const back = (await statusOf(ask)).data;
assert.equal(back.status, 'approved');
assert.equal(back.member.id, sasha.member.id, 'the phone comes in as Саша');
assert.equal((await call('/club/me', { token: back.token })).data.profile.liters, handshakes, 'with every handshake');
assert.equal((await statusOf(ask)).data.status, 'approved', 'a pass lost on a weak connection can be fetched again');
assert.equal((await named(owner.token, 'Саша')).length, 1, 'and still one Саша');
assert.equal((await codeState(olya.token, code)).used_by, null, 'the code is still not spent');
const again = await join(code, 'Саша', 'new-phone');
assert.equal(again.data.member?.id, sasha.member.id, 'the phone is Саша\'s now: the code brings it back without asking');
await later(16 * 60 * 1000, async () => {
  assert.equal((await statusOf(ask)).data.status, 'expired', 'after a quarter of an hour the pass is not handed out');
});

// ------------------------------------------------------------ a no, a day, the owner, a stranger, the banned
{
  const noCode = await invite(olya.token);
  const refused = (await askBack(noCode, 'Саша', 'stranger-phone')).data;
  assert.equal((await answer(olya.token, refused, false)).data.status, 'declined');
  assert.equal((await statusOf(refused)).data.status, 'declined', 'a no stays a no');
  assert.equal((await answer(olya.token, refused, true)).data.status, 'declined', 'and cannot be turned into a yes');

  const slowCode = await invite(olya.token);
  const slow = (await askBack(slowCode, 'Саша', 'slow-phone')).data;
  await later(25 * 60 * 60 * 1000, async () => {
    assert.equal((await statusOf(slow)).data.status, 'expired', 'a request waits a day');
    assert.equal((await answer(olya.token, slow, true)).status, 410, 'and is too late to vouch for after');
  });

  assert.equal((await askBack(await invite(owner.token), 'егор', 'x')).data.error, 'owner_returns_by_key', 'the owner comes back with the key');
  assert.equal((await askBack(await invite(owner.token), 'Никто', 'x')).data.error, 'member_unknown');
  const spent = await invite(owner.token);
  await join(spent, 'Вася', 'vasya-phone');
  assert.equal((await askBack(spent, 'Саша', 'x')).data.error, 'invite_used', 'a spent code vouches for nobody');
  assert.equal((await askBack('ABCD-EFGH', 'Саша', 'x')).data.error, 'invite_unknown');

  await call('/club/ban', { method: 'POST', token: owner.token, body: { id: sasha.member.id, banned: true, reason: 'проверка' } });
  assert.equal((await askBack(await invite(owner.token), 'Саша', 'banned-phone')).data.error, 'banned', 'a banned member does not come back this way');
}

console.log(`coming back on a new phone (${useD1 ? 'd1' : 'kv'}): OK`);

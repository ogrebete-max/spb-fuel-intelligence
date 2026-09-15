// Invitations spread through members, three each. A member who has handed
// out all of theirs asks the owner, who hears about it and grants more with a
// tap. The club's Telegram chat link is set by the owner and reaches members
// only.
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
let ip = 0;
const deliveries = [];
globalThis.fetch = async (url) => { deliveries.push(String(url)); return new Response(null, { status: 201 }); };

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

async function subscription(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    endpoint: `https://push.example/${name}`,
    keys: {
      p256dh: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url'),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
  };
}

const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed' };
const health = (await call(env, '/club/health')).data;
assert.equal(health.invites_more, true);
assert.equal(health.chat, true);
const boss = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
assert.equal((await call(env, '/subscribe', { method: 'POST', token: boss.token, body: { subscription: await subscription('owner') } })).status, 200);
const join = async (name, by) => {
  const code = (await call(env, '/club/invite', { method: 'POST', token: by.token })).data.code;
  return (await call(env, '/club/join', { method: 'POST', body: { code, name, accept: true } })).data;
};
const me = async (who) => (await call(env, '/club/me', { token: who.token })).data;
const row = async (who) => (await call(env, '/club/members', { token: boss.token })).data.members.find((item) => item.id === who.member.id);

// ------------------------------------------------------------ asking for more
const sasha = await join('Саша', boss);
assert.equal((await me(sasha)).invites_left, 3);
assert.equal((await call(env, '/club/invites/more', { method: 'POST', token: sasha.token })).data.error, 'invites_left', 'nobody asks while invitations are left');
assert.equal((await call(env, '/club/invites/more', { method: 'POST', token: boss.token })).data.error, 'owner_has_no_limit');

const friends = [];
for (const name of ['Друг 1', 'Друг 2', 'Друг 3']) friends.push(await join(name, sasha));
assert.equal((await me(sasha)).invites_left, 0);
assert.equal((await call(env, '/club/invite', { method: 'POST', token: sasha.token })).data.error, 'no_invites_left');

deliveries.splice(0);
const asked = await call(env, '/club/invites/more', { method: 'POST', token: sasha.token });
assert.equal(asked.status, 200);
assert.ok(deliveries.includes('https://push.example/owner'), 'the owner hears about it');
assert.ok((await me(sasha)).invites_asked, 'Sasha sees the request is on its way');
const waiting = await row(sasha);
assert.deepEqual([waiting.invites_left, !!waiting.invites_asked], [0, true], 'the owner sees who asks');

deliveries.splice(0);
assert.equal((await call(env, '/club/invites/more', { method: 'POST', token: sasha.token })).status, 200);
assert.equal(deliveries.length, 0, 'asking again at once does not ring the owner twice');

// ------------------------------------------------------------ the owner grants
assert.equal((await call(env, '/club/invites/grant', { method: 'POST', token: sasha.token, body: { id: sasha.member.id } })).status, 403, 'only the owner grants');
const granted = await call(env, '/club/invites/grant', { method: 'POST', token: boss.token, body: { id: sasha.member.id } });
assert.deepEqual([granted.status, granted.data.left], [200, 3]);
const after = await me(sasha);
assert.deepEqual([after.invites_left, after.invites_asked], [3, null]);
assert.ok(after.news.some((item) => item.type === 'invites' && item.count === 3), 'Sasha is told');
assert.equal((await call(env, '/club/invite', { method: 'POST', token: sasha.token })).status, 200, 'and invites again');
assert.equal((await me(sasha)).invites_left, 2);

assert.equal((await call(env, '/club/invites/grant', { method: 'POST', token: boss.token, body: { id: 'owner' } })).status, 404);
await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: friends[0].member.id, banned: true, reason: 'тест' } });
assert.equal((await call(env, '/club/invites/grant', { method: 'POST', token: boss.token, body: { id: friends[0].member.id } })).data.error, 'member_banned');
assert.equal((await call(env, '/club/invites/grant', { method: 'POST', token: boss.token, body: { id: friends[1].member.id, count: 50 } })).data.left, 13, 'no more than ten at once');

// ------------------------------------------------------------ the club chat
assert.equal((await call(env, '/club/settings', { method: 'POST', token: sasha.token, body: { chat_url: 'https://t.me/+abc' } })).status, 403, 'only the owner sets the chat');
for (const wrong of ['https://evil.example/+abc', 'javascript:alert(1)', 'https://t.me/', 'http://t.me/+abc', 'https://t.me/+abc"><script>']) {
  assert.equal((await call(env, '/club/settings', { method: 'POST', token: boss.token, body: { chat_url: wrong } })).data.error, 'bad_chat_url', `refused ${wrong}`);
}
assert.equal((await me(sasha)).chat_url, null);
const set = await call(env, '/club/settings', { method: 'POST', token: boss.token, body: { chat_url: ' t.me/+AbCd_ef-12 ' } });
assert.deepEqual([set.status, set.data.chat_url], [200, 'https://t.me/+AbCd_ef-12'], 'a link pasted without https is completed');
assert.equal((await me(sasha)).chat_url, 'https://t.me/+AbCd_ef-12', 'members get the link');
assert.equal((await me(boss)).chat_url, 'https://t.me/+AbCd_ef-12');
assert.equal((await call(env, '/club/me')).status, 401, 'nobody outside does');
assert.equal((await call(env, '/club/settings', { method: 'POST', token: boss.token, body: { chat_url: '' } })).data.chat_url, null, 'an empty link removes it');
assert.equal((await me(sasha)).chat_url, null);
// The request link for the entry screen: set beside the chat link, read by anyone.
assert.equal((await call(env, '/club/request-link')).data.request_url, null, 'no request link until the owner sets one');
assert.equal((await call(env, '/club/settings', { method: 'POST', token: boss.token, body: { request_url: ' t.me/+Ask_Me-1 ' } })).data.request_url, 'https://t.me/+Ask_Me-1', 'the owner sets the request link');
assert.equal((await me(boss)).chat_url, null, 'saving the request link leaves the chat link alone');
assert.equal((await me(boss)).request_url, 'https://t.me/+Ask_Me-1');
assert.equal((await call(env, '/club/request-link')).data.request_url, 'https://t.me/+Ask_Me-1', 'anyone reads it, with no code yet');
assert.equal((await call(env, '/club/settings', { method: 'POST', token: boss.token, body: { request_url: 'https://example.com/x' } })).data.error, 'bad_chat_url', 'only a Telegram link');
assert.equal((await call(env, '/club/settings', { method: 'POST', token: sasha.token, body: { request_url: 'https://t.me/+x1' } })).status, 403, 'only the owner sets it');

console.log(`worker club invites (${useD1 ? 'd1' : 'kv'}): OK`);

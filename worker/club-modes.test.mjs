// The club opens in stages. As a test (CLUB_OWNER_KEY alone) members see it
// and every other phone keeps the app as it was — marks, the public read and
// pushes, only without names. CLUB_GATE=invite changes nothing but what the
// app offers; CLUB_GATE=closed shuts the door.
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
const base = 'https://spbfi-reports.example';
const OWNER_KEY = 'owner-secret-for-tests-only';
let ip = 0;
const deliveries = [];
globalThis.fetch = async (url, init) => { deliveries.push({ url: String(url), body: init.body }); return new Response(null, { status: 201 }); };

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      'CF-Connecting-IP': `203.0.113.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { status: response.status, data: await response.json() };
}

const utf8 = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// A phone that subscribes for pushes and can read what the worker sends it
// (RFC 8291, the receiving side).
async function phone(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `https://push.example/${name}`;
  return {
    endpoint,
    subscription: { endpoint, keys: { p256dh: Buffer.from(publicRaw).toString('base64url'), auth: Buffer.from(auth).toString('base64url') } },
    async read(body) {
      const bytes = new Uint8Array(body);
      const salt = bytes.slice(0, 16);
      const serverPublic = bytes.slice(21, 21 + bytes[20]);
      const ciphertext = bytes.slice(21 + bytes[20]);
      const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256));
      const ikm = await hkdf(auth, shared, concat(utf8.encode('WebPush: info\0'), publicRaw, serverPublic), 32);
      const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
      let end = padded.length - 1;
      while (end > 0 && padded[end] === 0) end -= 1;
      return JSON.parse(new TextDecoder().decode(padded.slice(0, end)));
    },
  };
}

async function heard(phones) {
  const byEndpoint = Object.fromEntries(phones.map((item) => [item.endpoint, item]));
  const result = {};
  for (const delivery of deliveries.splice(0)) {
    const owner = byEndpoint[delivery.url];
    if (owner) result[delivery.url] = await owner.read(delivery.body);
  }
  return result;
}

// ------------------------------------------------------------ no key: no club
{
  const health = (await call(storage(), '/club/health')).data;
  assert.equal(health.mode, 'off');
  assert.equal(health.club, false);
}

// ------------------------------------------------------------ a test: the club is there for its members only
const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_READER_KEY: 'reader-secret-for-tests' };
const health = (await call(env, '/club/health')).data;
assert.equal(health.mode, 'test');
assert.equal(health.club, false, 'an app that knows only `club` shows no gate during the test');

const owner = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
assert.ok(owner.token, 'the owner gets in during the test');
const invite = async () => (await call(env, '/club/invite', { method: 'POST', token: owner.token })).data.code;
const sasha = (await call(env, '/club/join', { method: 'POST', body: { code: await invite(), name: 'Саша', accept: true } })).data;
const olya = (await call(env, '/club/join', { method: 'POST', body: { code: await invite(), name: 'Оля', accept: true } })).data;
assert.ok(sasha.token && olya.token, 'invited people join during the test');

const stranger = await phone('stranger');
const sashaPhone = await phone('sasha');
const olyaPhone = await phone('olya');
const phones = [stranger, sashaPhone, olyaPhone];
assert.equal((await call(env, '/subscribe', { method: 'POST', body: { subscription: stranger.subscription, who: 'device-stranger' } })).status, 200, 'a phone outside the club still subscribes');
assert.equal((await call(env, '/subscribe', { method: 'POST', token: sasha.token, body: { subscription: sashaPhone.subscription } })).status, 200);
assert.equal((await call(env, '/subscribe', { method: 'POST', token: olya.token, body: { subscription: olyaPhone.subscription } })).status, 200);

const plain = await call(env, '/report', { method: 'POST', body: { station: 'st-plain', grade: 'AI95', seen: true, who: 'device-stranger', name: 'Роснефть' } });
assert.equal(plain.status, 200, 'a phone outside the club still marks');
assert.equal(plain.data.rewards, undefined, 'and is not paid litres');
const plainHeard = await heard(phones);
assert.equal(plainHeard[sashaPhone.endpoint]?.title, '👁 Свой отметил: Роснефть', 'members hear a mark from outside the club');
assert(!(stranger.endpoint in plainHeard), 'the author does not hear their own mark');

// Olya is banned: her pass stops working and her phone hears nothing.
assert.equal((await call(env, '/club/ban', { method: 'POST', token: owner.token, body: { id: olya.member.id, banned: true, reason: 'тест' } })).status, 200);
await call(env, '/subscribe', { method: 'POST', token: olya.token, body: { subscription: olyaPhone.subscription } });
assert.equal((await call(env, '/report', { method: 'POST', token: olya.token, body: { station: 'st-olya', grade: 'DT', seen: true } })).status, 403);
assert.equal((await call(env, '/club/me', { token: olya.token })).status, 403);
deliveries.splice(0);

const look = await call(env, '/report', { method: 'POST', token: owner.token, body: { station: 'st-owner', grade: 'AI92', seen: false, name: 'Лукойл', lat: 60, lon: 30.3 } });
assert.equal(look.status, 200);
assert.ok(look.data.rewards, 'the owner is paid as a member');
const ownerHeard = await heard(phones);
assert.equal(ownerHeard[sashaPhone.endpoint]?.title, '👁 Егор: Лукойл', 'a member hears who marked');
assert.equal(ownerHeard[stranger.endpoint]?.title, '👁 Свой отметил: Лукойл', 'a phone outside the club hears the mark without the name');
assert(!(olyaPhone.endpoint in ownerHeard), 'a banned member hears nothing');

const open = await call(env, '/reports');
assert.equal(open.status, 200, 'the public read works during the test, reader key or not');
assert(open.data.reports.every((report) => report.name === undefined), 'and carries no names');
const inside = (await call(env, '/club/reports', { token: sasha.token })).data.reports;
assert.equal(inside.find((report) => report.station === 'st-owner').name, 'Егор');
assert.equal(inside.find((report) => report.station === 'st-plain').name, '');

// ------------------------------------------------------------ invites open: the same, the app just offers joining
{
  const offered = (await call({ ...env, CLUB_GATE: 'invite' }, '/club/health')).data;
  assert.equal(offered.mode, 'invite');
  assert.equal(offered.club, false);
}

// ------------------------------------------------------------ the door closed
{
  const closed = { ...env, CLUB_GATE: ' Closed ' };
  const shut = (await call(closed, '/club/health')).data;
  assert.equal(shut.mode, 'closed');
  assert.equal(shut.club, true);
  assert.equal((await call(closed, '/report', { method: 'POST', body: { station: 's', grade: 'AI95', seen: true, who: 'x' } })).status, 401);
  assert.equal((await call(closed, '/subscribe', { method: 'POST', body: { subscription: stranger.subscription } })).status, 401);
  assert.equal((await call(closed, '/reports')).status, 401, 'behind a closed door the reader key is required');
  deliveries.splice(0);
  await call(closed, '/report', { method: 'POST', token: sasha.token, body: { station: 'st-closed', grade: 'AI95', seen: true, name: 'Татнефть' } });
  const closedHeard = await heard(phones);
  assert(!(stranger.endpoint in closedHeard), 'behind a closed door a phone outside the club hears nothing');
}

// ------------------------------------------------------------ the owner key forgives what a phone does to a phrase
{
  const keyed = { ...storage(), CLUB_OWNER_KEY: 'Синий ёж ловит кота' };
  for (const typed of ['синий еж ловит кота', '  СИНИЙ  ЁЖ ловит кота ', 'синий\u00a0ёж ловит кота\u200b', 'cиний eж лoвит кoтa']) {
    assert.equal((await call(keyed, '/club/owner', { method: 'POST', body: { key: typed, name: 'Егор' } })).status, 200, `accepted ${JSON.stringify(typed)}`);
  }
  assert.equal((await call(keyed, '/club/owner', { method: 'POST', body: { key: 'синий ёж ловит собаку', name: 'Егор' } })).status, 403, 'other words are still refused');
  assert.equal((await call({ ...storage(), CLUB_OWNER_KEY: '   ' }, '/club/owner', { method: 'POST', body: { key: '', name: 'x' } })).status, 403, 'a blank key never opens the door');
}

console.log(`worker club stages (${useD1 ? 'd1' : 'kv'}): OK`);

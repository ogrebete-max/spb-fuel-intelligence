// A member whose phone forgot the pass gets back in without anyone's help:
// with the same invitation code while it runs, with a short code shown by a
// device still inside, with a passkey (Face ID on an iPhone, a fingerprint or
// the screen lock on Android, Windows Hello), or — the last resort — with a
// code from the owner. None of these may make a twin, spend an invitation or
// let in somebody else.
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
const RP_ID = 'ogrebete-max.github.io';
const ORIGIN = 'https://ogrebete-max.github.io';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
let ip = 0;
globalThis.fetch = async () => new Response(null, { status: 201 });

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      'CF-Connecting-IP': `198.51.100.${ip % 250}`,
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

// ------------------------------------------------------------ a phone's authenticator, as the browser reports it
const utf8 = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (value) => new Uint8Array(Buffer.from(value, 'base64url'));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

function cbor(value) {
  const out = [];
  const head = (major, length) => {
    if (length < 24) out.push((major << 5) | length);
    else if (length < 256) out.push((major << 5) | 24, length);
    else if (length < 65536) out.push((major << 5) | 25, length >> 8, length & 255);
    else out.push((major << 5) | 26, (length >>> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255);
  };
  const put = (item) => {
    if (item instanceof Uint8Array) {
      head(2, item.length);
      out.push(...item);
    } else if (typeof item === 'string') {
      const bytes = utf8.encode(item);
      head(3, bytes.length);
      out.push(...bytes);
    } else if (typeof item === 'number') {
      if (item >= 0) head(0, item);
      else head(1, -1 - item);
    } else if (item instanceof Map) {
      head(5, item.size);
      for (const [key, entry] of item) {
        put(key);
        put(entry);
      }
    } else {
      throw new Error(`cbor: ${typeof item}`);
    }
  };
  put(value);
  return new Uint8Array(out);
}

function toDer(raw) {
  const integer = (bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = [...bytes.slice(start)];
    return body[0] & 0x80 ? [0x02, body.length + 1, 0, ...body] : [0x02, body.length, ...body];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function authenticator({ alg = -7, rpId = RP_ID, credentialId = crypto.getRandomValues(new Uint8Array(20)) } = {}) {
  const keys = alg === -7
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const cose = alg === -7
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64(jwk.x)], [-3, fromB64(jwk.y)]])
    : new Map([[1, 3], [3, -257], [-1, fromB64(jwk.n)], [-2, fromB64(jwk.e)]]);
  const id = b64(credentialId);
  let counter = 0;
  const authData = async (flags, attested = []) => {
    const head = new Uint8Array(37);
    head.set(await sha256(utf8.encode(rpId)), 0);
    head[32] = flags;
    new DataView(head.buffer).setUint32(33, counter++);
    return new Uint8Array([...head, ...attested]);
  };
  const clientData = (type, challenge, origin) => utf8.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    async create(challenge, { origin = ORIGIN } = {}) {
      const attested = [...new Uint8Array(16), credentialId.length >> 8, credentialId.length & 255, ...credentialId, ...cbor(cose)];
      const attestation = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', await authData(0x45, attested)]]));
      return { id, client: b64(clientData('webauthn.create', challenge, origin)), attestation: b64(attestation) };
    },
    async get(challenge, { origin = ORIGIN, tamper = false } = {}) {
      const client = clientData('webauthn.get', challenge, origin);
      const auth = await authData(0x05);
      const signed = new Uint8Array([...auth, ...await sha256(client)]);
      let signature = alg === -7
        ? toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed)))
        : new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, signed));
      if (tamper) {
        signature = signature.slice();
        signature[signature.length - 3] ^= 0x01;
      }
      return { id, client: b64(client), auth: b64(auth), signature: b64(signature), user: '' };
    },
  };
}

// ------------------------------------------------------------ the club
const env = { ...storage(), CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'closed' };
const health = (await call(env, '/club/health')).data;
assert.equal(health.returning, true);
assert.equal(health.passkeys, true);
const boss = (await call(env, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
const invite = async () => (await call(env, '/club/invite', { method: 'POST', token: boss.token })).data.code;
const join = (body) => call(env, '/club/join', { method: 'POST', body });
const members = async () => (await call(env, '/club/members', { token: boss.token })).data;
const challenge = async () => (await call(env, '/club/passkey/challenge')).data.challenge;

// ------------------------------------------------------------ a newcomer still gives a name and accepts the rules
{
  const code = await invite();
  assert.equal((await join({ code, accept: true })).data.error, 'expected_code_and_name');
  assert.equal((await join({ code, name: 'Оля' })).data.error, 'rules_not_accepted');
  assert.equal((await join({ code: 'ZZZZ-ZZZZ', name: 'Оля', accept: true })).data.error, 'invite_unknown');
  assert.equal((await join({ code, name: 'Оля', accept: true })).status, 200);
}

// ------------------------------------------------------------ the same invitation code brings the same person back while it runs
{
  const code = await invite();
  const diesel = (await join({ code, name: 'Дизель', accept: true, device: 'diesel-safari' })).data;
  await call(env, '/club/award', { method: 'POST', token: boss.token, body: { id: diesel.member.id, text: 'За точные отметки' } });

  // The icon on the home screen, or the same phone after its data was cleared.
  const asked = await join({ code, device: 'diesel-icon' });
  assert.equal(asked.status, 409);
  assert.equal(asked.data.error, 'invite_used', 'an app from before this still says the code is spent');
  assert.equal(asked.data.returning, 'Дизель', 'and the new one asks «Это вы — Дизель?»');
  assert.equal(asked.data.token, undefined, 'nothing opens before the answer');
  assert.equal((await join({ code, name: 'Дизель', accept: true, device: 'diesel-icon' })).data.returning, 'Дизель', 'typing the name is not an answer');

  const back = await join({ code, device: 'diesel-icon', returning: true });
  assert.equal(back.status, 200);
  assert.equal(back.data.member.id, diesel.member.id, 'the same member, not a twin');
  assert.equal(back.data.returned, true);
  const me = (await call(env, '/club/me', { token: back.data.token })).data;
  assert.ok(me.profile.liters >= 10, 'with every handshake');
  assert.equal((await members()).members.filter((item) => item.name === 'Дизель').length, 1);
  assert.equal((await join({ code, device: 'diesel-icon' })).data.member?.id, diesel.member.id, 'that phone is known from now on');
  assert.equal((await call(env, '/club/me', { token: diesel.token })).status, 200, 'the first device keeps its pass');

  const lapsed = await later(8 * DAY, () => join({ code, device: 'diesel-computer', returning: true }));
  assert.equal(lapsed.data.error, 'invite_used', 'a week on, the code brings nobody back');
  assert.equal(lapsed.data.returning, undefined);
}

// ------------------------------------------------------------ a device inside shows a code for a computer: once, for ten minutes
{
  const sasha = (await join({ code: await invite(), name: 'Саша', accept: true, device: 'sasha-phone' })).data;
  const before = (await call(env, '/club/me', { token: sasha.token })).data;
  const shown = await call(env, '/club/code', { method: 'POST', token: sasha.token });
  assert.equal(shown.status, 200);
  assert.match(shown.data.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.ok(shown.data.expires - Date.now() <= 10 * MINUTE && shown.data.expires - Date.now() > 9 * MINUTE);
  assert.equal(shown.data.name, 'Саша');
  const after = (await call(env, '/club/me', { token: sasha.token })).data;
  assert.equal(after.invites_left, before.invites_left, 'showing a code spends no invitation');
  assert(!after.invites.some((item) => item.code === shown.data.code), 'and it is not listed as one');
  assert(!(await members()).invites.some((item) => item.code === shown.data.code));

  const computer = await join({ code: shown.data.code, device: 'sasha-computer' });
  assert.equal(computer.status, 200, 'no name, no rules: Sasha is known');
  assert.equal(computer.data.member.id, sasha.member.id);
  assert.equal(computer.data.returned, true);
  assert.equal((await join({ code: shown.data.code, device: 'a-stranger' })).data.error, 'login_code_used', 'it works once');

  const slow = (await call(env, '/club/code', { method: 'POST', token: sasha.token })).data.code;
  assert.equal((await later(11 * MINUTE, () => join({ code: slow, device: 'sasha-tablet' }))).data.error, 'login_code_expired');

  const older = (await call(env, '/club/code', { method: 'POST', token: sasha.token })).data.code;
  const newer = (await call(env, '/club/code', { method: 'POST', token: sasha.token })).data.code;
  assert.equal((await join({ code: older, device: 'sasha-tablet' })).data.error, 'invite_unknown', 'only the latest code works');
  assert.equal((await join({ code: newer, device: 'sasha-tablet' })).status, 200);

  assert.equal((await call(env, '/club/code', { method: 'POST', token: sasha.token, body: { id: boss.member.id } })).status, 403, 'a member makes codes only for themselves');
}

// ------------------------------------------------------------ the owner's code for someone who lost every device
{
  const lost = (await join({ code: await invite(), name: 'Потерял', accept: true, device: 'drowned-phone' })).data;
  const brought = async () => (await members()).members.find((item) => item.role === 'owner').invited;
  const broughtBefore = await brought();
  const made = await call(env, '/club/code', { method: 'POST', token: boss.token, body: { id: lost.member.id } });
  assert.equal(made.status, 200);
  assert.ok(made.data.expires - Date.now() > 6 * DAY, 'it runs for a week');
  const back = await join({ code: made.data.code, device: 'new-phone' });
  assert.equal(back.data.member.id, lost.member.id);
  assert.equal(await brought(), broughtBefore, 'the owner is not credited with bringing them in again');

  await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: lost.member.id, banned: true, reason: 'тест' } });
  assert.equal((await call(env, '/club/code', { method: 'POST', token: boss.token, body: { id: lost.member.id } })).data.error, 'member_banned');
  await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: lost.member.id, banned: false } });
  const pending = (await call(env, '/club/code', { method: 'POST', token: boss.token, body: { id: lost.member.id } })).data.code;
  await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: lost.member.id, banned: true, reason: 'ложные отметки' } });
  const barred = await join({ code: pending, device: 'another-phone' });
  assert.equal(barred.status, 403, 'a code made before a ban lets nobody in');
  assert.equal(barred.data.reason, 'ложные отметки');
}

// ------------------------------------------------------------ passkeys: Face ID, a fingerprint, Windows Hello
{
  const dima = (await join({ code: await invite(), name: 'Дима', accept: true, device: 'dima-phone' })).data;
  const phone = await authenticator();
  const ask = (await call(env, '/club/passkey/challenge')).data;
  assert.equal(ask.rp_id, RP_ID);

  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', body: await phone.create(ask.challenge) })).status, 401, 'saving needs a pass');
  const saved = await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await phone.create(await challenge()) });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.passkeys, 1);
  assert.equal((await call(env, '/club/me', { token: dima.token })).data.passkeys, 1);
  assert.equal((await members()).members.find((item) => item.id === dima.member.id).passkeys, 1);

  // The phone forgot the pass.
  const login = await call(env, '/club/passkey/login', { method: 'POST', body: await phone.get(await challenge()) });
  assert.equal(login.status, 200);
  assert.equal(login.data.member.id, dima.member.id);
  assert.equal(login.data.returned, true);
  assert.equal((await call(env, '/club/me', { token: login.data.token })).status, 200, 'the new pass works');

  const refused = async (body) => (await call(env, '/club/passkey/login', { method: 'POST', body })).status;
  assert.equal(await refused(await phone.get(await challenge(), { origin: 'https://evil.example' })), 403, 'answered to another site');
  assert.equal(await refused(await phone.get(await challenge(), { tamper: true })), 403, 'a changed signature');
  assert.equal(await refused(await phone.get(b64(utf8.encode(`pk.${Date.now().toString(36)}.bm9uY2U.forged-signature`)))), 403, 'a challenge the worker did not make');
  const stale = await challenge();
  assert.equal(await later(6 * MINUTE, async () => refused(await phone.get(stale))), 403, 'a challenge older than five minutes');
  assert.equal(await refused({ ...(await phone.get(await challenge())), client: 'bm90IGpzb24' }), 403, 'garbage instead of client data');
  assert.equal(await refused(await (await authenticator()).get(await challenge())), 404, 'a key the club never saw');

  const elsewhere = await authenticator({ rpId: 'evil.example' });
  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await elsewhere.create(await challenge()) })).status, 400, 'a key made for another site is not saved');
  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await phone.create(await challenge(), { origin: 'https://evil.example' }) })).status, 400);
  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: { ...(await phone.create(await challenge())), attestation: 'oWFhYWI' } })).status, 400, 'a broken attestation');

  const olya = (await join({ code: await invite(), name: 'Оля-2', accept: true, device: 'olya-phone' })).data;
  const thief = await authenticator({ credentialId: fromB64(phone.id) });
  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', token: olya.token, body: await thief.create(await challenge()) })).status, 400, 'nobody takes over another member\'s key');
  assert.equal(await refused(await phone.get(await challenge())), 200, 'and Dima still gets in');

  const hello = await authenticator({ alg: -257 });
  assert.equal((await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await hello.create(await challenge()) })).data.passkeys, 2, 'Windows Hello makes an RSA key');
  const helloLogin = await call(env, '/club/passkey/login', { method: 'POST', body: await hello.get(await challenge()) });
  assert.equal(helloLogin.data.member?.id, dima.member.id);

  for (let i = 0; i < 5; i += 1) {
    await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await (await authenticator()).create(await challenge()) });
  }
  const newest = await authenticator();
  await call(env, '/club/passkey/save', { method: 'POST', token: dima.token, body: await newest.create(await challenge()) });
  assert.equal((await call(env, '/club/me', { token: dima.token })).data.passkeys, 6, 'no more than six keys a member');
  assert.equal(await refused(await phone.get(await challenge())), 404, 'the oldest key makes room');
  assert.equal(await refused(await newest.get(await challenge())), 200, 'the newest one works');

  await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: dima.member.id, banned: true, reason: 'тест' } });
  const banned = await call(env, '/club/passkey/login', { method: 'POST', body: await newest.get(await challenge()) });
  assert.equal(banned.status, 403);
  assert.equal(banned.data.error, 'banned');
  assert.equal(banned.data.reason, 'тест');
  await call(env, '/club/ban', { method: 'POST', token: boss.token, body: { id: dima.member.id, banned: false } });

  assert.equal((await call(env, '/club/remove', { method: 'POST', token: boss.token, body: { id: dima.member.id } })).status, 200);
  assert.equal(await refused(await newest.get(await challenge())), 404, 'removed from the club, the key opens nothing');
}

// ------------------------------------------------------------ removed: no way back but a new invitation
{
  const code = await invite();
  const twin = (await join({ code, name: 'Двойник', accept: true, device: 'twin-phone' })).data;
  const shown = (await call(env, '/club/code', { method: 'POST', token: twin.token })).data.code;
  const owners = (await call(env, '/club/code', { method: 'POST', token: boss.token, body: { id: twin.member.id } })).data.code;
  await call(env, '/club/remove', { method: 'POST', token: boss.token, body: { id: twin.member.id } });
  assert.equal((await join({ code, device: 'twin-icon', returning: true })).data.error, 'invite_used', 'the old invitation brings nobody back');
  assert.equal((await join({ code: shown, device: 'twin-computer' })).data.error, 'invite_unknown');
  assert.equal((await join({ code: owners, device: 'twin-computer' })).data.error, 'invite_unknown');
  assert.equal((await join({ code: await invite(), name: 'Двойник', accept: true, device: 'twin-phone' })).status, 200, 'a new invitation does');
}

console.log(`worker club return (${useD1 ? 'd1' : 'kv'}): OK`);

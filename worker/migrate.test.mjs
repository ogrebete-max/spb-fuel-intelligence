// Moving the club to a server of its own, since phones in Russia no longer
// reach workers.dev. The maintainer copies every document out of the worker
// with requests signed by the maintainer's key, carries each secret over as a
// salted hash, and stops writes while the last copy is taken; the new server
// runs this same file and checks keys against those hashes. D1 only:
// /migrate/ needs it.
import assert from 'node:assert/strict';
import { generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from 'node:crypto';
import worker from './spbfi-reports.js';
import { FakeD1 } from './fake-d1.mjs';

class MemoryKV {
  constructor() { this.values = new Map(); this.writes = 0; }
  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.writes += 1; this.values.set(key, String(value)); }
}

// Another isolate over the same database: its own memory, the same rows.
const isolate = (d1) => ({ prepare: (sql) => d1.prepare(sql), batch: (statements) => d1.batch(statements) });

const base = 'https://spbfi-reports.example';
const origin = 'https://ogrebete-max.github.io';
let ip = 0;
let pushes = 0;
globalThis.fetch = async () => { pushes += 1; return new Response(null, { status: 201 }); };

async function call(env, path, { method = 'GET', body, token, headers = {} } = {}) {
  ip += 1;
  const pending = [];
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      // A fresh address per call keeps the in-memory rate limiters out of the way.
      'CF-Connecting-IP': `198.18.${Math.floor(ip / 250) % 250}.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}

// Whatever the worker would print as a fault is kept here instead.
const logged = [];
async function quietly(work) {
  const log = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    return await work();
  } finally {
    console.error = log;
  }
}

// The maintainer's key pair, and somebody else's.
const maintainer = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const MIGRATE_PUBLIC_KEY = maintainer.publicKey.export({ format: 'jwk' }).x;

// A path signed the way the maintainer's tool signs it: the method, host, path
// and query, the query ending with the time.
function signed(method, pathname, params = {}, { key = maintainer.privateKey, host = new URL(base).host, now = Date.now() } = {}) {
  const query = new URLSearchParams({ ...params, t: String(now) }).toString();
  const sig = sign(null, Buffer.from(`${method} ${host}${pathname}?${query}`), key).toString('base64url');
  return `${pathname}?${query}&sig=${sig}`;
}

const migrate = (env, method, pathname, params, options) => call(env, signed(method, pathname, params, options), { method });

// As pasted from notes: a capital letter, «ё», and a Latin «o» in «кoт».
const OWNER_KEY = 'Зелёный кoт у колонки';
// As typed on a phone: lower case, «е», every letter Cyrillic.
const OWNER_KEY_TYPED = 'зеленый кот у колонки';
assert(/[a-z]/.test(OWNER_KEY) && !/[a-z]/.test(OWNER_KEY_TYPED), 'a Latin letter in one, none in the other');
const READER_KEY = 'reader-secret-for-tests';
const GROUP_KEY = 'group-passphrase-for-tests';
const ANALYTICS_KEY = 'analytics-admin-for-tests';
const SECRETS = [OWNER_KEY, OWNER_KEY_TYPED, READER_KEY, GROUP_KEY, ANALYTICS_KEY];
const CHAT_URL = 'https://t.me/+ClubChatForTests';
const mark = (station) => ({ station, grade: 'AI95', seen: true, lat: 60.0, lon: 30.3 });
const shows = (reports, station) => reports.some((report) => report.station === station);

// ------------------------------------------------------------ the club as it lives on Cloudflare
const oldDb = new FakeD1();
const oldEnv = {
  REPORTS: new MemoryKV(), DB: oldDb, CLUB_OWNER_KEY: OWNER_KEY, CLUB_GATE: 'invite',
  CLUB_READER_KEY: READER_KEY, GROUP_KEY, ANALYTICS_ADMIN_KEY: ANALYTICS_KEY, MIGRATE_PUBLIC_KEY,
};
const owner = (await call(oldEnv, '/club/owner', { method: 'POST', body: { key: OWNER_KEY, name: 'Егор' } })).data;
const { code } = (await call(oldEnv, '/club/invite', { method: 'POST', token: owner.token })).data;
const sasha = (await call(oldEnv, '/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;
assert.ok(owner.token && sasha.token);
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const subscription = {
  endpoint: 'https://push.example/sasha',
  keys: { p256dh: b64(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64(crypto.getRandomValues(new Uint8Array(16))) },
};
assert.equal((await call(oldEnv, '/subscribe', { method: 'POST', token: sasha.token, body: { subscription } })).status, 200);
assert.equal((await call(oldEnv, '/report', { method: 'POST', token: sasha.token, body: mark('st-before') })).status, 200);
assert.equal((await call(oldEnv, '/club/settings', { method: 'POST', token: owner.token, body: { chat_url: CHAT_URL } })).status, 200);
const oldVapid = (await call(oldEnv, '/vapid')).data.publicKey;

// ------------------------------------------------------------ only the maintainer's signature opens /migrate/
{
  const refused = async (path, why, method = 'GET') => {
    const answer = await call(oldEnv, path, { method });
    assert.equal(answer.status, 403, why);
    assert.equal(answer.data.error, 'forbidden', why);
  };
  await refused('/migrate/export', 'without a signature');
  await refused(signed('GET', '/migrate/export', {}, { key: stranger.privateKey }), 'signed with another key');
  await refused(signed('GET', '/migrate/export', {}, { host: 'another-worker.example' }), 'signed for another host');
  await refused(signed('GET', '/migrate/export', {}, { now: Date.now() - 6 * 60 * 1000 }), 'signed six minutes ago');
  await refused(signed('GET', '/migrate/freeze'), 'signed for another method', 'POST');
  const genuine = signed('GET', '/migrate/secret', { name: 'GROUP_KEY', rounds: 1000, salt: randomBytes(16).toString('base64url') });
  assert.equal((await call(oldEnv, genuine)).status, 200);
  await refused(genuine.replace('name=GROUP_KEY', 'name=CLUB_OWNER_KEY'), 'with the query changed after signing');
  const kvOnly = await migrate({ REPORTS: new MemoryKV(), MIGRATE_PUBLIC_KEY }, 'GET', '/migrate/export');
  assert.equal(kvOnly.status, 409);
  assert.equal(kvOnly.data.error, 'needs_d1');
}

// ------------------------------------------------------------ the export: every document and which secrets are set, never a secret
{
  const exported = await migrate(oldEnv, 'GET', '/migrate/export');
  assert.equal(exported.status, 200);
  const keys = exported.data.docs.map((doc) => doc.key);
  for (const key of ['vapid', 'club:secret', 'club:members', 'subscriptions', 'reports', 'club:settings']) assert(keys.includes(key), `the export carries ${key}`);
  assert.deepEqual(keys, [...keys].sort(), 'in the order of their keys');
  assert.deepEqual(Object.keys(exported.data.docs[0]).sort(), ['body', 'key', 'updated_at', 'version']);
  assert.equal(exported.data.frozen, false);
  assert.deepEqual(exported.data.secrets, { CLUB_OWNER_KEY: true, CLUB_READER_KEY: true, GROUP_KEY: true, ANALYTICS_ADMIN_KEY: true });
  assert.deepEqual(exported.data.vars, { CLUB_GATE: 'invite', ORIGIN: null });
  assert.equal(exported.data.analytics_salt, false);
  for (const secret of SECRETS) assert(!exported.text.includes(secret), 'no secret is in the export');
  assert.equal((await migrate({ ...oldEnv, GROUP_KEY: '' }, 'GET', '/migrate/export')).data.secrets.GROUP_KEY, false, 'a secret not set is false');
}

// ------------------------------------------------------------ a secret leaves as the first rounds of its hash
const FIRST = 2000;
const MORE = 20000;
const hashes = {};
{
  const salt = randomBytes(16).toString('base64url');
  const bad = async (params, why) => {
    const answer = await migrate(oldEnv, 'GET', '/migrate/secret', params);
    assert.equal(answer.status, 400, why);
    assert.equal(answer.data.error, 'bad_request', why);
  };
  await bad({ name: 'ORIGIN', rounds: FIRST, salt }, 'not one of the secrets');
  await bad({ name: 'GROUP_KEY', rounds: 999, salt }, 'too few rounds');
  await bad({ name: 'GROUP_KEY', rounds: 100001, salt }, 'more rounds than Cloudflare allows');
  await bad({ name: 'GROUP_KEY', rounds: 1500.5, salt }, 'rounds that are not a whole number');
  await bad({ name: 'GROUP_KEY', rounds: FIRST, salt: randomBytes(15).toString('base64url') }, 'a salt under 16 bytes');
  await bad({ name: 'GROUP_KEY', rounds: FIRST, salt: 'A'.repeat(65) }, 'a salt over 64 characters');
  const unset = await migrate({ ...oldEnv, GROUP_KEY: '' }, 'GET', '/migrate/secret', { name: 'GROUP_KEY', rounds: FIRST, salt });
  assert.equal(unset.status, 404);
  assert.equal(unset.data.error, 'not_set');

  for (const name of ['CLUB_OWNER_KEY', 'CLUB_READER_KEY', 'GROUP_KEY', 'ANALYTICS_ADMIN_KEY']) {
    const saltBytes = randomBytes(16);
    const answer = await migrate(oldEnv, 'GET', '/migrate/secret', { name, rounds: FIRST, salt: saltBytes.toString('base64url') });
    assert.equal(answer.status, 200, name);
    assert.equal(answer.data.name, name);
    assert.equal(answer.data.rounds, FIRST);
    assert(!SECRETS.some((secret) => answer.text.includes(secret)), `${name} itself does not leave`);
    if (name === 'GROUP_KEY') {
      assert.equal(answer.data.first, pbkdf2Sync(GROUP_KEY, saltBytes, FIRST, 32, 'sha256').toString('base64url'), 'plain PBKDF2-SHA-256 over the secret');
    }
    // The maintainer's tool adds the rest of the rounds; only the result goes to the new server.
    const hash = pbkdf2Sync(Buffer.from(answer.data.first, 'base64url'), saltBytes, MORE, 32, 'sha256').toString('base64url');
    hashes[name] = `pbkdf2-sha256.${FIRST}.${MORE}.${saltBytes.toString('base64url')}.${hash}`;
  }
}

// ------------------------------------------------------------ frozen for the last copy: writes stop, reads go on
{
  const frozen = await migrate(oldEnv, 'POST', '/migrate/freeze');
  assert.equal(frozen.status, 200);
  assert.deepEqual(frozen.data, { ok: true, frozen: true });
  assert.deepEqual((await migrate(oldEnv, 'POST', '/migrate/freeze')).data, { ok: true, frozen: true }, 'freezing twice is no error');

  const writes = oldDb.docWrites;
  const marked = await quietly(() => call(oldEnv, '/report', { method: 'POST', token: sasha.token, body: mark('st-frozen') }));
  assert.equal(marked.status, 503);
  assert.equal(marked.data.error, 'moving');
  assert.equal(marked.headers.get('Access-Control-Allow-Origin'), origin, 'with CORS headers, so the phone keeps the mark and sends it again');
  const subscribed = await quietly(() => call(oldEnv, '/subscribe', { method: 'POST', token: sasha.token, body: { subscription } }));
  assert.equal(subscribed.status, 503);
  assert.equal(subscribed.data.error, 'moving');
  assert.equal(oldDb.docWrites, writes, 'nothing is written');
  assert.deepEqual(logged, [], 'writes refused for the move are not logged as faults');

  const open = await call(oldEnv, '/reports');
  assert.equal(open.status, 200);
  assert(shows(open.data.reports, 'st-before') && !shows(open.data.reports, 'st-frozen'));
  // An isolate that has remembered nothing yet reads the club's signing secret while frozen.
  const inside = await call({ ...oldEnv, DB: isolate(oldDb) }, '/club/reports', { token: sasha.token });
  assert.equal(inside.status, 200);
  assert(shows(inside.data.reports, 'st-before'));
  assert.equal((await migrate(oldEnv, 'GET', '/migrate/export')).data.frozen, true);
}

// ------------------------------------------------------------ a write that read before the freeze and commits after it
{
  assert.deepEqual((await migrate(oldEnv, 'POST', '/migrate/unfreeze')).data, { ok: true, frozen: false });
  // The freeze lands between the mark's read and its commit.
  let overtaken = false;
  oldDb.failure = (sql) => {
    if (!overtaken && sql.startsWith('INSERT INTO doc_guard')) {
      overtaken = true;
      const now = Date.now();
      oldDb.db.prepare('INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, 1, ?)').run('meta:frozen', JSON.stringify({ at: now }), now);
    }
    return null;
  };
  const writes = oldDb.docWrites;
  const late = await quietly(() => call(oldEnv, '/report', { method: 'POST', token: sasha.token, body: mark('st-overtaken') }));
  oldDb.failure = null;
  assert(overtaken, 'the freeze came while the mark was being written');
  assert.equal(late.status, 503);
  assert.equal(late.data.error, 'moving');
  assert.equal(oldDb.docWrites, writes, 'nothing is written');
  assert(!shows((await call(oldEnv, '/reports')).data.reports, 'st-overtaken'));
  assert.deepEqual(logged, []);

  assert.deepEqual((await migrate(oldEnv, 'POST', '/migrate/unfreeze')).data, { ok: true, frozen: false }, 'the move is called off');
  assert.equal((await call(oldEnv, '/report', { method: 'POST', token: sasha.token, body: mark('st-after') })).status, 200, 'and marks go in again');
}

// ------------------------------------------------------------ the move: frozen, copied, started on a server of its own
assert.equal((await migrate(oldEnv, 'POST', '/migrate/freeze')).status, 200);
const copy = await migrate(oldEnv, 'GET', '/migrate/export');
assert.equal(copy.data.frozen, true);

const newDb = new FakeD1();
const newEnv = {
  DB: newDb,
  CLUB_OWNER_KEY_HASH: hashes.CLUB_OWNER_KEY,
  CLUB_READER_KEY_HASH: hashes.CLUB_READER_KEY,
  GROUP_KEY_HASH: hashes.GROUP_KEY,
  ANALYTICS_ADMIN_KEY_HASH: hashes.ANALYTICS_ADMIN_KEY,
  CLUB_GATE: 'closed',
  MIGRATE_PUBLIC_KEY,
};
// The worker makes its tables on the first request; the copy then replaces
// whatever it put in them, all but the freeze.
assert.equal((await call(newEnv, '/reports')).status, 401, 'the club is on and its door closed');
newDb.db.exec('DELETE FROM docs');
const insert = newDb.db.prepare('INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, ?, ?)');
for (const doc of copy.data.docs.filter((row) => row.key !== 'meta:frozen')) insert.run(doc.key, doc.body, doc.version, doc.updated_at);

{
  assert.equal((await call(newEnv, '/vapid')).data.publicKey, oldVapid, 'the same VAPID key, so subscribed phones keep hearing pushes');
  const me = await call(newEnv, '/club/me', { token: sasha.token });
  assert.equal(me.status, 200, "a member's pass from Cloudflare works here");
  assert.equal(me.data.chat_url, CHAT_URL);

  assert.equal((await call(newEnv, '/club/owner', { method: 'POST', body: { key: OWNER_KEY_TYPED, name: 'Егор' } })).status, 200, 'the owner key typed plainly matches the hash of the pasted one');
  assert.equal((await call(newEnv, '/club/owner', { method: 'POST', body: { key: 'зеленый кот у заправки', name: 'Егор' } })).status, 403);

  assert.equal((await call(newEnv, '/reports', { headers: { 'X-Reader-Key': READER_KEY } })).status, 200);
  assert.equal((await call(newEnv, '/reports', { headers: { 'X-Reader-Key': 'reader-guess' } })).status, 401);

  // With the door open, a phone outside the club needs the group key.
  const open = { ...newEnv, CLUB_GATE: 'invite' };
  const outside = { subscription: { endpoint: 'https://push.example/outside', keys: subscription.keys }, who: 'phone-outside' };
  assert.equal((await call(open, '/subscribe', { method: 'POST', body: outside, headers: { 'X-Group-Key': GROUP_KEY } })).status, 200);
  assert.equal((await call(open, '/subscribe', { method: 'POST', body: outside, headers: { 'X-Group-Key': 'group-guess' } })).status, 403);
  const before = pushes;
  const look = { station: 'st-outside', grade: 'AI92', seen: true, who: 'phone-outside' };
  assert.equal((await call(open, '/report', { method: 'POST', body: look, headers: { 'X-Group-Key': GROUP_KEY } })).status, 200);
  assert.equal(pushes, before + 1, "the member's phone, subscribed on Cloudflare, hears the new server");
  assert.equal((await call(open, '/report', { method: 'POST', body: look, headers: { 'X-Group-Key': 'group-guess' } })).status, 403);

  const events = { install_id: 'install-1', session_id: 'session-1', events: [{ event: 'app_open', at: Date.now(), fields: {} }] };
  assert.equal((await call(newEnv, '/analytics/events', { method: 'POST', body: events })).data.accepted, 1);
  assert.equal((await call(newEnv, '/analytics/dashboard', { headers: { 'X-Analytics-Key': ANALYTICS_KEY } })).status, 200);
  assert.equal((await call(newEnv, '/analytics/dashboard', { headers: { 'X-Analytics-Key': 'analytics-guess' } })).status, 403);

  assert.equal((await call(newEnv, '/report', { method: 'POST', token: sasha.token, body: mark('st-new-server') })).status, 200, 'writes work after the move');

  const health = (await call({ ...newEnv, DB: Object.assign(isolate(newDb), { kind: 'sqlite' }) }, '/club/health')).data;
  assert.equal(health.migrate, true);
  assert.equal(health.storage, 'sqlite', "the server's adapter names its storage");

  const again = await migrate(newEnv, 'GET', '/migrate/export');
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.secrets, hashes, 'the new server says which secrets it holds as hashes');
}

console.log('worker moving to a server of its own: OK');

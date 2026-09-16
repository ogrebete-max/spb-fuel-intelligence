// The club server as it runs on the VPS: server/main.mjs in a child process on
// a SQLite file in a temporary folder, pushes caught by a stand-in for the push
// service, then a restart, a stop in the middle of a push, a backup and an
// import. Also the pieces on their own: the request handler and the migration
// signature.
//
//   node server/server.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, pbkdf2Sync, randomBytes, verify, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker from '../worker/spbfi-reports.js';
import { backup } from './backup.mjs';
import { clientAddress, createHandler, workerEnv } from './http.mjs';
import { importDump } from './import.mjs';
import { finishHash, signedUrl } from './migrate.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://ogrebete-max.github.io';
const OWNER_KEY = 'ключ владельца для проверки';
// The hash as migrate.mjs makes it: the old server's first rounds, then the rest.
const salt = randomBytes(16);
const OWNER_HASH = finishHash(pbkdf2Sync(Buffer.from(OWNER_KEY), salt, 10000, 32, 'sha256').toString('base64url'), salt.toString('base64url'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spbfi-server-'));
const dbFile = path.join(temp, 'club.sqlite');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ what the worker is told about a request
{
  assert.deepEqual(
    workerEnv({ PATH: '/usr/bin', HOME: '/root', CLUB_GATE: 'closed', CLUB_OWNER_KEY_HASH: 'h', ANALYTICS: 'on', ANALYTICS_SALT: '' }, 'db'),
    { DB: 'db', CLUB_GATE: 'closed', CLUB_OWNER_KEY_HASH: 'h', ANALYTICS: 'on' },
    'the worker gets its own settings and nothing else from the environment',
  );
  assert.equal(clientAddress({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '10.0.0.1, 192.0.2.7' } }), '192.0.2.7', 'behind Caddy the last forwarded address is the visitor');
  assert.equal(clientAddress({ socket: { remoteAddress: '::ffff:192.0.2.9' }, headers: { 'x-forwarded-for': '192.0.2.7' } }), '192.0.2.9', 'from anywhere else the header is not believed');

  const seen = [];
  const logged = [];
  let backgroundDone = false;
  const echo = {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/boom') throw new Error('boom');
      seen.push({ url: request.url, ip: request.headers.get('cf-connecting-ip'), env });
      ctx.waitUntil(pause(300).then(() => { backgroundDone = true; }));
      return Response.json({ ok: true });
    },
  };
  const { handle, drain } = createHandler({ worker: echo, env: () => ({ DB: 'db' }), log: { error: (line) => logged.push(line) } });
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${server.address().port}`;

  const answer = await fetch(`${at}/reports?x=1`, { headers: { 'X-Forwarded-For': '10.0.0.1, 192.0.2.7', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.99' } });
  assert.equal(answer.status, 200);
  assert.equal(backgroundDone, false, 'the answer does not wait for background work');
  assert.equal(seen[0].ip, '192.0.2.7', 'a CF-Connecting-IP sent by the visitor is replaced');
  assert.match(seen[0].url, /^https:\/\/127\.0\.0\.1:\d+\/reports\?x=1$/, 'the scheme is the one Caddy was reached by');
  assert.deepEqual(seen[0].env, { DB: 'db' });
  assert.equal(await drain(5000), true);
  assert.equal(backgroundDone, true, 'drain waits for background work');

  const failed = await fetch(`${at}/boom?sig=do-not-log`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'server_error' });
  assert(logged.some((line) => line.startsWith('GET /boom: Error: boom')), logged.join('\n'));
  assert(!logged.join('\n').includes('do-not-log'), 'the query string stays out of the log');
  server.closeAllConnections();
  server.close();
}

// ------------------------------------------------------------ the migration signature
{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const url = new URL(signedUrl('https://spbfi-reports.example', 'GET', '/migrate/secret', { name: 'CLUB_OWNER_KEY', rounds: 10000, salt: 'c2FsdA' }, privateKey, 1757851200000));
  const [query, sig] = url.search.slice(1).split('&sig=');
  assert.equal(query, 'name=CLUB_OWNER_KEY&rounds=10000&salt=c2FsdA&t=1757851200000');
  assert(verify(null, Buffer.from(`GET spbfi-reports.example/migrate/secret?${query}`), publicKey, Buffer.from(sig, 'base64url')), 'signed over method, host, path and query');
}

// ------------------------------------------------------------ the server in a child process

// Loaded into the server with --import: a push to push.example is answered
// here after PUSH_DELAY_MS and printed, so the test sees when it went out.
const preload = path.join(temp, 'push-mock.mjs');
fs.writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith('https://push.example/')) return original(input, init);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PUSH_DELAY_MS) || 0));
  console.log(\`PUSH \${url}\`);
  return new Response(null, { status: 201 });
};
`);

// Settings from the shell running the test must not leak into the server.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLUB_|GROUP_KEY|ANALYTICS|ORIGIN$|SPBFI_|PORT$|HOST$|PUSH_DELAY_MS$)/i.test(name)));
const children = new Set();
process.on('exit', () => {
  for (const child of children) child.kill();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(server, pattern, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!pattern.test(server.output)) {
    if (Date.now() > deadline || server.child.exitCode !== null) throw new Error(`waited for ${pattern}; the server printed:\n${server.output}`);
    await pause(20);
  }
}

// The push is held back long enough that an answer slowed by a busy machine
// still arrives before it, so "the answer does not wait" is not left to luck.
async function start({ pushDelayMs = 1000 } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(preload).href, 'server/main.mjs'], {
    cwd: ROOT,
    env: { ...inherited, SPBFI_DB: dbFile, PORT: String(port), HOST: '127.0.0.1', CLUB_OWNER_KEY_HASH: OWNER_HASH, CLUB_GATE: 'closed', ORIGIN, PUSH_DELAY_MS: String(pushDelayMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const server = { child, port, output: '' };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (text) => { server.output += text; });
  }
  server.exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  await waitFor(server, /spbfi club server on http:\/\/127\.0\.0\.1:\d+ \(database .+, club closed\)/);
  return server;
}

// Windows has no SIGTERM: kill() ends the process at once there, which also
// shows that what was committed survives a hard stop.
function stop(server) {
  server.child.kill('SIGTERM');
  return server.exited;
}

async function call(server, pathName, { method = 'GET', body, token, visitor = '198.51.100.7', headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathName}`, {
    method,
    headers: {
      Origin: ORIGIN,
      // As Caddy passes a request on: the visitor is the last forwarded address.
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': `10.0.0.1, ${visitor}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { 'X-Member-Token': token } : {}),
      ...headers,
    },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not every answer is JSON.
  }
  return { status: response.status, headers: response.headers, data };
}

const first = await start();
assert(!first.output.includes(OWNER_HASH), 'the start-up line names no secret');

const health = await call(first, '/club/health');
assert.equal(health.status, 200);
assert.equal(health.data.mode, 'closed');
assert.equal(health.data.storage, 'sqlite', 'the worker names the storage it runs on');
assert.equal(health.data.migrate, true, 'the worker offers the signed migration routes');

const preflight = await call(first, '/report', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-member-token' } });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);

// The owner's key as typed on a phone: capitals and stray spaces do not
// matter, a different key does.
assert.equal((await call(first, '/club/owner', { method: 'POST', body: { key: 'не тот ключ', name: 'Егор' }, visitor: '198.51.100.10' })).status, 403);
const owner = await call(first, '/club/owner', { method: 'POST', body: { key: '  Ключ ВЛАДЕЛЬЦА для проверки ', name: 'Егор' }, visitor: '198.51.100.11' });
assert.equal(owner.status, 200, 'the owner signs in with the key');
const ownerToken = owner.data.token;

// Attempts are counted per visitor per calendar minute; a burst straddling
// two minutes would be counted twice over.
if (Date.now() % 60000 > 45000) await pause(60000 - (Date.now() % 60000) + 50);
const attempts = [];
for (let i = 0; i < 6; i += 1) {
  attempts.push((await call(first, '/club/owner', { method: 'POST', body: { key: 'подбор', name: 'x' }, visitor: '203.0.113.66' })).status);
}
assert.deepEqual(attempts, [403, 403, 403, 403, 403, 429], 'the sixth guess in a minute from one visitor is refused');
assert.equal((await call(first, '/club/owner', { method: 'POST', body: { key: 'подбор', name: 'x' }, visitor: '203.0.113.67' })).status, 403, 'another visitor behind the same Caddy is not held back');

// Invite, join, subscribe; the owner marks a station near the member.
const invite = await call(first, '/club/invite', { method: 'POST', token: ownerToken, visitor: '198.51.100.11' });
assert.equal(invite.status, 200);
const joined = await call(first, '/club/join', { method: 'POST', body: { code: invite.data.code, name: 'Саша', accept: true }, visitor: '198.51.100.12' });
assert.equal(joined.status, 200);
const sasha = joined.data;

const phone = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const subscription = {
  endpoint: 'https://push.example/sasha',
  keys: { p256dh: Buffer.from(await webcrypto.subtle.exportKey('raw', phone.publicKey)).toString('base64url'), auth: randomBytes(16).toString('base64url') },
};
assert.equal((await call(first, '/subscribe', { method: 'POST', token: sasha.token, body: { subscription, lat: 59.9343, lon: 30.3351 }, visitor: '198.51.100.12' })).status, 200);
const vapid = (await call(first, '/vapid')).data.publicKey;
assert.equal(typeof vapid, 'string');

const marked = await call(first, '/report', { method: 'POST', token: ownerToken, body: { station: 'nevsky-1', grade: 'AI95', seen: true, lat: 59.9350, lon: 30.3360 }, visitor: '198.51.100.11' });
assert.equal(marked.status, 200);
assert(!first.output.includes('PUSH https://push.example/sasha'), 'the answer does not wait for the push');
await waitFor(first, /PUSH https:\/\/push\.example\/sasha/, 5000);

const tooBig = await call(first, '/report', { method: 'POST', token: ownerToken, body: JSON.stringify({ station: 'x'.repeat(300 * 1024) }), visitor: '198.51.100.11' });
assert.equal(tooBig.status, 413);
assert.equal(tooBig.data?.error, 'body_too_large');

// ------------------------------------------------------------ a restart on the same file
await stop(first);
const second = await start();
assert.equal((await call(second, '/club/me', { token: sasha.token })).status, 200, "a member's pass survives a restart");
assert.equal((await call(second, '/vapid')).data.publicKey, vapid, 'so does the VAPID key the phones subscribed with');

// ------------------------------------------------------------ a backup while the server runs
{
  const dir = path.join(temp, 'backups');
  fs.mkdirSync(dir);
  const planted = path.join(dir, 'club-2000-01-01.sqlite');
  fs.writeFileSync(planted, '');
  const { target, docs } = backup({ file: dbFile, dir });
  assert(fs.existsSync(target), target);
  assert(docs >= 3, `the copy holds the club's documents (${docs})`);
  assert(!fs.existsSync(planted), 'a daily copy older than two weeks is deleted');
}
await stop(second);

// ------------------------------------------------------------ a stop in the middle of a push
if (process.platform !== 'win32') {
  const third = await start({ pushDelayMs: 800 });
  const mark = await call(third, '/report', { method: 'POST', token: ownerToken, body: { station: 'nevsky-2', grade: 'DT', seen: false, lat: 59.9351, lon: 30.3361 }, visitor: '198.51.100.11' });
  assert.equal(mark.status, 200);
  third.child.kill('SIGTERM');
  const { code } = await third.exited;
  assert.equal(code, 0, `a stop waits for the push in flight and exits cleanly:\n${third.output}`);
  assert(third.output.includes('PUSH https://push.example/sasha'), `the push still went out:\n${third.output}`);
}

// ------------------------------------------------------------ an import from an export of a frozen server
{
  const source = new DatabaseSync(dbFile, { readOnly: true });
  const rows = source.prepare('SELECT key, body, version, updated_at FROM docs').all();
  source.close();
  const now = Date.now();
  const dump = { docs: [...rows, { key: 'meta:frozen', body: JSON.stringify({ at: now }), version: 1, updated_at: now }, { key: '', body: '{}' }, { key: 'no-body' }, null] };
  const fresh = new SqliteD1();
  const keys = await importDump(fresh, dump);
  assert.equal(keys.length, rows.length, 'every document but the frozen mark and the malformed rows');
  assert(!keys.includes('meta:frozen'));
  assert.equal(await fresh.prepare('SELECT key FROM docs WHERE key = ?').bind('meta:frozen').first(), null, 'a frozen old server does not freeze the new one');

  const env = workerEnv({ CLUB_OWNER_KEY_HASH: OWNER_HASH, CLUB_GATE: 'closed', ORIGIN }, fresh);
  const ask = (pathName, token) => worker.fetch(new Request(`https://club.example${pathName}`, {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.30', ...(token ? { 'X-Member-Token': token } : {}) },
  }), env, { waitUntil() {} });
  assert.equal((await (await ask('/vapid')).json()).publicKey, vapid, 'the new server signs pushes with the same key');
  assert.equal((await ask('/club/me', sasha.token)).status, 200, 'members keep their passes');
  fresh.close();
}

try {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  // A leftover temporary folder is not a failure of the server.
}
console.log('club server: OK');

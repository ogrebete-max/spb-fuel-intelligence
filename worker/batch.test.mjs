import assert from 'node:assert/strict';
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

// SPBFI_STORE=d1 runs the same checks against D1 instead of KV.
const useD1 = process.env.SPBFI_STORE === 'd1';
const storage = () => ({ REPORTS: new MemoryKV(), ...(useD1 ? { DB: new FakeD1() } : {}) });
const writesOf = (env) => (env.DB ? env.DB.docWrites : env.REPORTS.writes);

// Real KV answers over the network; a small delay is enough for concurrent
// read-modify-write cycles to overlap the way they did on the phones.
class SlowKV extends MemoryKV {
  async get(key, options) { await new Promise((resolve) => setTimeout(resolve, 25)); return super.get(key, options); }
  async put(key, value) { await new Promise((resolve) => setTimeout(resolve, 25)); return super.put(key, value); }
}

const base = 'https://spbfi-reports.example';
const pending = [];
const ctx = { waitUntil(promise) { pending.push(promise); } };
let ip = 0;
globalThis.fetch = async () => new Response(null, { status: 201 });

async function call(env, path, { method = 'GET', body, token } = {}) {
  ip += 1;
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: 'https://ogrebete-max.github.io',
      'CF-Connecting-IP': `192.0.2.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: response.status, data: await response.json() };
}

// ------------------------------------------------------------ the bug, for the record
{
  const env = useD1 ? { REPORTS: new MemoryKV(), DB: new FakeD1({ latencyMs: 25 }) } : { REPORTS: new SlowKV() };
  await Promise.all(['AI92', 'AI95', 'AI98'].map((grade) => call(env, '/report', {
    method: 'POST', body: { station: 'race', grade, seen: false, who: 'phone-1' },
  })));
  const kept = (await call(env, '/reports')).data.reports.length;
  if (useD1) assert.equal(kept, 3, `D1 keeps every concurrent report, kept ${kept}`);
  else assert(kept < 3, `concurrent single-grade reports should lose marks on a slow KV, kept ${kept}`);
}

// ------------------------------------------------------------ one look, one request, one write
{
  const env = storage();
  assert.equal((await call(env, '/reports')).data.batch, true, 'the worker tells the app it takes batches');
  const before = writesOf(env);
  const look = await call(env, '/report', {
    method: 'POST',
    body: {
      station: 'st-1', who: 'phone-1', queue: 12,
      grades: [
        { grade: 'AI92', seen: false }, { grade: 'AI95', seen: false }, { grade: 'AI98', seen: false },
        { grade: 'AI95', seen: true }, { grade: 'GAS', seen: true }, { grade: 'DT' },
      ],
    },
  });
  assert.equal(look.status, 200);
  assert.equal(look.data.accepted, 3, 'duplicates and malformed grades are dropped');
  assert.equal(writesOf(env) - before, 1, 'a whole look is one write');
  const stored = (await call(env, '/reports')).data.reports;
  assert.deepEqual(stored.map((r) => `${r.grade}:${r.seen}:${r.queue}`).sort(), ['AI92:false:12', 'AI95:false:12', 'AI98:false:12']);

  // A later look replaces the same grades, it does not stack.
  await call(env, '/report', { method: 'POST', body: { station: 'st-1', who: 'phone-1', grades: [{ grade: 'AI95', seen: true }] } });
  const after = (await call(env, '/reports')).data.reports.filter((r) => r.station === 'st-1');
  assert.equal(after.length, 3);
  assert.equal(after.find((r) => r.grade === 'AI95').seen, true);

  // The old single-grade body still works, and nonsense is refused.
  assert.equal((await call(env, '/report', { method: 'POST', body: { station: 'st-2', grade: 'DT', seen: true, who: 'phone-2' } })).status, 200);
  assert.equal((await call(env, '/report', { method: 'POST', body: { station: 'st-3', grades: [{ grade: 'GAS', seen: true }] } })).status, 400);
  assert.equal((await call(env, '/report', { method: 'POST', body: { grades: [{ grade: 'AI95', seen: true }] } })).status, 400);
}

// ------------------------------------------------------------ in the club a look pays once and costs two writes
{
  const env = { ...storage(), CLUB_OWNER_KEY: 'owner-secret-for-tests-only' };
  assert.equal((await call(env, '/club/health')).data.batch, true);
  const owner = (await call(env, '/club/owner', { method: 'POST', body: { key: env.CLUB_OWNER_KEY, name: 'Егор' } })).data;
  const { code } = (await call(env, '/club/invite', { method: 'POST', token: owner.token })).data;
  const sasha = (await call(env, '/club/join', { method: 'POST', body: { code, name: 'Саша', accept: true } })).data;

  const before = writesOf(env);
  const look = await call(env, '/report', {
    method: 'POST', token: sasha.token,
    body: { station: 'c-1', lat: 60.05, lon: 30.3, grades: [{ grade: 'AI92', seen: false }, { grade: 'AI95', seen: false }, { grade: 'AI98', seen: false }] },
  });
  assert.equal(look.data.accepted, 3);
  assert.equal(look.data.rewards.liters, 1, 'three grades of one look are one mark');
  assert.equal(writesOf(env) - before, 2, 'the look and the scoreboard: two writes');
  const named = (await call(env, '/club/reports', { token: owner.token })).data.reports.filter((r) => r.station === 'c-1');
  assert.equal(named.length, 3);
  assert(named.every((r) => r.name === 'Саша'));

  // The owner confirms two of those grades in one look: Sasha is paid once.
  const confirm = await call(env, '/report', {
    method: 'POST', token: owner.token,
    body: { station: 'c-1', grades: [{ grade: 'AI92', seen: false }, { grade: 'AI95', seen: false }] },
  });
  assert.deepEqual(confirm.data.rewards.confirmed, ['Саша']);
  const me = (await call(env, '/club/me', { token: sasha.token })).data;
  assert.equal(me.profile.liters, 1 + 3);
}

console.log('worker batch integration: OK');

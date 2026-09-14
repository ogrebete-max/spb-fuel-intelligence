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

const base = 'https://spbfi-reports.example';
const origin = 'https://ogrebete-max.github.io';
const pending = [];
const ctx = { waitUntil(promise) { pending.push(promise); } };
let ip = 0;

async function call(env, path, { method = 'GET', body, token, headers = {} } = {}) {
  ip += 1;
  const response = await worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      // A fresh address per call keeps the in-memory rate limiter out of the way.
      'CF-Connecting-IP': `198.51.100.${ip % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'X-Member-Token': token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: response.status, data: await response.json() };
}

const mark = (station, seen) => ({ station, grade: 'AI95', seen, lat: 60.0, lon: 30.3 });

// ------------------------------------------------------------ without the club nothing changes
{
  const env = storage();
  assert.deepEqual((await call(env, '/club/health')).data, { club: false, mode: 'off', version: 1, batch: true, late_marks: true, forgiving_key: true, rejoin: true, remove: true, returning: true, passkeys: true, votes: true, invites_more: true, chat: true, storage: useD1 ? 'd1' : 'kv' });
  assert.equal((await call(env, '/report', { method: 'POST', body: mark('open-1', true) })).status, 200);
  assert.equal((await call(env, '/club/me')).status, 404, 'club routes stay closed while the club is off');
  const before = writesOf(env);
  const analytics = await call(env, '/analytics/events', {
    method: 'POST', body: { install_id: 'a', session_id: 'b', events: [{ event: 'app_open', at: Date.now(), fields: {} }] },
  });
  assert.equal(analytics.status, 202);
  assert.equal(analytics.data.accepted, 0);
  assert.equal(writesOf(env), before, 'analytics must not spend writes before the dashboard is set up');
}

// ------------------------------------------------------------ the club
// The club with its door closed; the stages before that are in club-modes.test.mjs.
const env = { ...storage(), CLUB_OWNER_KEY: 'owner-secret-for-tests-only', CLUB_GATE: 'closed' };
assert.equal((await call(env, '/club/health')).data.club, true);
assert.equal((await call(env, '/report', { method: 'POST', body: mark('s-1', true) })).status, 401, 'strangers cannot mark');
assert.equal((await call(env, '/subscribe', { method: 'POST', body: {} })).status, 401, 'strangers cannot subscribe');
assert.equal((await call(env, '/club/me')).status, 401);

assert.equal((await call(env, '/club/owner', { method: 'POST', body: { key: 'wrong', name: 'Егор' } })).status, 403);
const owner = await call(env, '/club/owner', { method: 'POST', body: { key: env.CLUB_OWNER_KEY, name: 'Егор' } });
assert.equal(owner.status, 200);
assert.equal(owner.data.member.role, 'owner');
const ownerToken = owner.data.token;

const forged = ownerToken.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'));
assert.equal((await call(env, '/club/me', { token: forged })).status, 401, 'a tampered token is rejected');

const invite1 = await call(env, '/club/invite', { method: 'POST', token: ownerToken });
assert.equal(invite1.status, 200);
assert.match(invite1.data.code, /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
assert.equal(invite1.data.invites_left, null, 'the owner invites without a limit');

assert.equal((await call(env, '/club/join', { method: 'POST', body: { code: invite1.data.code, name: 'Саша' } })).data.error, 'rules_not_accepted');
const typed = invite1.data.code.toLowerCase().replace('-', ' ');
const sasha = await call(env, '/club/join', { method: 'POST', body: { code: typed, name: '  Саша  ', accept: true } });
assert.equal(sasha.status, 200, 'a code typed in lower case with a space still works');
assert.equal(sasha.data.member.name, 'Саша');
assert.equal(sasha.data.member.sponsor, 'owner');
const sashaToken = sasha.data.token;
assert.equal((await call(env, '/club/join', { method: 'POST', body: { code: invite1.data.code, name: 'Другой', accept: true } })).data.error, 'invite_used');

// A plain mark is two KV writes — the mark and the club scoreboard — with no
// rate-limit counter and no dispute record.
const writes = writesOf(env);
assert.equal((await call(env, '/report', { method: 'POST', token: sashaToken, body: mark('s-1', true) })).status, 200);
assert.equal(writesOf(env) - writes, 2, 'one mark must cost two writes');

const publicRead = await call(env, '/reports');
assert.equal(publicRead.data.reports[0].who, sasha.data.member.id);
assert.equal(publicRead.data.reports[0].name, undefined, 'names do not leave the club');
const clubRead = await call(env, '/club/reports', { token: sashaToken });
assert.equal(clubRead.data.reports[0].name, 'Саша');

// Members invite a limited number of people, and the chain is remembered.
const memberCodes = [];
for (let i = 0; i < 3; i += 1) {
  const created = await call(env, '/club/invite', { method: 'POST', token: sashaToken });
  assert.equal(created.status, 200);
  memberCodes.push(created.data.code);
}
assert.equal((await call(env, '/club/invite', { method: 'POST', token: sashaToken })).data.error, 'no_invites_left');
assert.equal((await call(env, '/club/invite/revoke', { method: 'POST', token: sashaToken, body: { code: memberCodes[2] } })).status, 200);
assert.equal((await call(env, '/club/join', { method: 'POST', body: { code: memberCodes[2], name: 'Никто', accept: true } })).data.error, 'invite_unknown');

const olya = await call(env, '/club/join', { method: 'POST', body: { code: memberCodes[0], name: 'Оля', accept: true } });
assert.equal(olya.data.member.sponsor, sasha.data.member.id);
const olyaToken = olya.data.token;
assert.equal((await call(env, '/club/members', { token: olyaToken })).status, 403, 'only the owner sees the member list');

// Olya contradicts Sasha within twenty minutes: recorded for the owner.
assert.equal((await call(env, '/report', { method: 'POST', token: olyaToken, body: mark('s-1', false) })).status, 200);
const list = await call(env, '/club/members', { token: ownerToken });
const sashaRow = list.data.members.find((row) => row.name === 'Саша');
assert.equal(sashaRow.disputed_30d, 1);
assert.equal(sashaRow.disputed_by_people_30d, 1);
assert.equal(sashaRow.marks_3h, 1);
assert.equal(list.data.members.find((row) => row.name === 'Оля').sponsor_name, 'Саша');
assert.equal(list.data.members[0].role, 'owner');

// Banning takes effect at once: the marks go, the token stops working, and a
// code the banned member handed out no longer opens the door.
const olyaInvite = await call(env, '/club/invite', { method: 'POST', token: olyaToken });
assert.equal((await call(env, '/club/ban', { method: 'POST', token: sashaToken, body: { id: olya.data.member.id } })).status, 403);
const ban = await call(env, '/club/ban', { method: 'POST', token: ownerToken, body: { id: olya.data.member.id, banned: true, reason: 'ложные отметки' } });
assert.equal(ban.status, 200);
assert(!(await call(env, '/reports')).data.reports.some((report) => report.who === olya.data.member.id));
const blocked = await call(env, '/report', { method: 'POST', token: olyaToken, body: mark('s-2', true) });
assert.equal(blocked.status, 403);
assert.equal(blocked.data.reason, 'ложные отметки');
assert.equal((await call(env, '/club/join', { method: 'POST', body: { code: olyaInvite.data.code, name: 'Друг Оли', accept: true } })).data.error, 'sponsor_banned');
assert.equal((await call(env, '/club/ban', { method: 'POST', token: ownerToken, body: { id: 'owner' } })).status, 404, 'the owner cannot be banned');

const unban = await call(env, '/club/ban', { method: 'POST', token: ownerToken, body: { id: olya.data.member.id, banned: false } });
assert.equal(unban.data.member.banned, false);
assert.equal((await call(env, '/report', { method: 'POST', token: olyaToken, body: mark('s-2', true) })).status, 200);

// A member just created at another edge is known by signature alone.
assert.equal((await call(env, '/club/me', { token: sashaToken })).status, 200);

// ------------------------------------------------------------ optional reader key
const locked = { ...env, CLUB_READER_KEY: 'reader-secret-for-tests' };
assert.equal((await call(locked, '/reports')).status, 401);
assert.equal((await call(locked, '/reports', { headers: { 'X-Reader-Key': 'reader-secret-for-tests' } })).status, 200);
assert.equal((await call(locked, '/reports', { token: sashaToken })).status, 200);

console.log('worker club integration: OK');

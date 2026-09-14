/**
 * Shared eyewitness reports for SPB Fuel Intelligence — with push.
 *
 * One file, no build step, no dependencies: paste it into a Cloudflare Worker,
 * bind a KV namespace called REPORTS, and it runs. Setup is described in
 * docs/eyewitness-reports.md.
 *
 * It accepts one thing — "I am standing at this station and this grade is
 * there, or is not" — and hands back everything reported in the last few
 * hours. The collector reads that back and the evidence engine weighs it above
 * every remote source, because the person filing it looked at the pump.
 *
 * It also keeps push subscriptions from the group's phones and, when a report
 * arrives, sends a Web Push notification to everyone within reach of that
 * station. Web Push is the browser-native channel (RFC 8030/8291/8292): no
 * accounts, no third-party service, the worker signs and encrypts each
 * message itself. The VAPID key pair it signs with is generated on first use
 * and kept in KV, so nothing has to be pasted into the dashboard for it.
 *
 * Closed club. Membership is by invitation: the owner signs in with the owner
 * key, every member gets a signed token, an invite code lets one person in and
 * remembers who vouched for whom, and the owner can ban. A member whose phone
 * forgot the token gets back in without anyone's help: with a passkey, with
 * the same invite code while it runs, or with a short code shown by a device
 * still inside. Members standing at a pump confirm (👍) or refute (👎)
 * each other's fresh marks; five refutations from different people take the
 * author out of the club until the owner brings them back. A mark made by
 * mistake is deleted by its author in the first hour, or by the owner while it
 * is listed, and the 🤝 it earned go with it. It opens in stages.
 * With CLUB_OWNER_KEY alone it is a test: members see it on their own phones,
 * and for everyone else the app stays as it was. CLUB_GATE=invite offers
 * joining to everyone; CLUB_GATE=closed shuts the door, and only members can
 * file marks, read who filed them and receive pushes. Without CLUB_OWNER_KEY
 * the worker behaves exactly as before.
 *
 * Bindings:
 *   DB                   D1 database (recommended): marks, the club and push subscriptions
 *   REPORTS              KV namespace: storage when there is no DB, and what DB is filled from once
 *   CLUB_OWNER_KEY       secret; turns the club on (as a test) and lets the owner in
 *   CLUB_GATE            optional: "invite" offers joining to everyone, "closed" requires it
 *   CLUB_READER_KEY      optional secret; when set, GET /reports needs it too
 *   GROUP_KEY            legacy shared passphrase, used only without the club
 *   ANALYTICS_ADMIN_KEY  optional secret; without it analytics store nothing
 *   ORIGIN               optional allowed origin; defaults to the GitHub Pages site
 *
 * On the club's own server a secret may be given as <NAME>_HASH instead
 * (CLUB_OWNER_KEY_HASH and so on): a salted hash made while moving there
 * through /migrate/, so the key itself never leaves Cloudflare.
 */

const DEFAULT_ORIGIN = 'https://ogrebete-max.github.io';
const APP_URL = 'https://ogrebete-max.github.io/spb-fuel-intelligence/';
const WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_REPORTS = 4000;
const MAX_PER_MINUTE = 20;
const MAX_SUBSCRIPTIONS = 300;
const NOTIFY_RADIUS_KM = 7;
const GRADES = new Set(['AI92', 'AI95', 'AI98', 'AI100', 'DT', 'LPG']);
const GRADE_LABELS = { AI92: '92', AI95: '95', AI98: '98', AI100: '100', DT: 'ДТ', LPG: 'Газ' };
const ANALYTICS_VERSION = 2;
const ANALYTICS_RETENTION_SECONDS = 180 * 24 * 60 * 60;
const ANALYTICS_EVENTS = new Set([
  'app_open', 'app_error', 'analytics_enabled', 'install_prompt', 'installed',
  'grade_select', 'area_select', 'view_change', 'sort_change', 'status_filter',
  'search_start', 'search_complete', 'search_zero', 'search_failed',
  'locate_start', 'locate_result', 'map_area_search', 'station_open',
  'route_open', 'traffic_open', 'report_sent', 'report_outcome',
  'push_enabled', 'push_disabled',
  // The drive screen: how often it is opened and left, marks and undos from
  // it, «Не та?» and the question at a stop.
  'drive_open', 'drive_close', 'drive_mark', 'drive_undo', 'drive_not_this', 'drive_stop_question',
]);
const ANALYTICS_DIMENSIONS = new Set([
  'area', 'zone', 'grade', 'station', 'status', 'probability', 'trust',
  'age_bucket', 'source_count', 'sources', 'result_count', 'fresh_count',
  'radius_km', 'success', 'seen', 'queue', 'view', 'filter', 'reason',
  'collector_ok', 'collector_failed', 'snapshot_age_bucket', 'installed',
]);

function cors(request, env) {
  const allowed = env.ORIGIN || DEFAULT_ORIGIN;
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Group-Key, X-Analytics-Key, X-Member-Token, X-Reader-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(request, env) },
  });
}

// ---------------------------------------------------------------- storage

// Everything the group shares — marks, push subscriptions, the club's members,
// invites and scoreboard — is a document that a request reads, changes and
// writes back. Workers KV cannot do that safely: a write made at one
// Cloudflare location reaches the others up to a minute later, so two people
// acting at once through different locations overwrite each other (a member
// who has just joined vanishes, a mark or a thank-you is lost), and the free
// plan refuses writes after 1,000 a day. A D1 database bound as DB is
// consistent: each write names the version it was based on, a stale one is
// refused, and the change is redone on what is stored now. Without DB the
// worker keeps using KV as before.
const LEGACY_KEYS = ['vapid', 'subscriptions', 'reports', 'club:secret', 'club:members', 'club:invites', 'club:stats', 'club:flags', 'club:heroes'];
const MOVED_KEY = 'meta:moved-from-kv';
// There while the club is copied to a server of its own: every write is
// refused, so nothing changes between the last copy and the switch.
const FROZEN_KEY = 'meta:frozen';
// While Cloudflare rolls a new version out, the old one keeps answering some
// requests for about a quarter of an hour and still writes to KV. Marks and
// subscriptions it takes in during the first hour are folded in, not lost.
const STRAGGLER_WINDOW_MS = 60 * 60 * 1000;
const STRAGGLER_IDENTITY = {
  reports: (item) => `${item.station}|${item.grade}|${item.who}|${item.at}`,
  subscriptions: (item) => item.endpoint,
};
const WRITE_ATTEMPTS = 8;

class StorageBusy extends Error {
  constructor(keys) {
    super(`kept being overtaken while writing ${keys.join(', ')}`);
    this.name = 'StorageBusy';
  }
}

class Frozen extends Error {
  constructor() {
    super('the club is moving to another server; writes are stopped');
    this.name = 'Frozen';
  }
}

// The club's own server runs this file over SQLite, and its adapter says so.
function storageKind(env) {
  return env.DB ? (typeof env.DB.kind === 'string' ? env.DB.kind : 'd1') : 'kv';
}

function parseDoc(raw, fallback) {
  const fresh = () => (fallback && typeof fallback === 'object' ? structuredClone(fallback) : fallback);
  if (raw == null) return fresh();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // The club secret was once stored as bare text.
    return fallback === null ? raw : fresh();
  }
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : fresh();
  if (fallback && typeof fallback === 'object') return value && typeof value === 'object' ? value : fresh();
  return value;
}

/** Sets up an unused D1 database in place: the tables, then whatever KV held. */
async function createD1(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
    // A write based on an outdated version inserts a 0 here; the check refuses
    // it and the whole batch rolls back.
    env.DB.prepare('CREATE TABLE IF NOT EXISTS doc_guard (ok INTEGER NOT NULL CONSTRAINT stale_write CHECK (ok = 1))'),
  ]);
  const now = Date.now();
  const legacy = env.REPORTS
    ? (await Promise.all(LEGACY_KEYS.map(async (key) => [key, await env.REPORTS.get(key)]))).filter(([, body]) => body != null)
    : [];
  // Nothing already in D1 is overwritten, so two first requests racing here
  // change nothing. The VAPID key moves together with the subscriptions made
  // for it, so phones keep hearing pushes.
  const insert = 'INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING';
  await env.DB.batch([
    ...legacy.map(([key, body]) => env.DB.prepare(insert).bind(key, body, now)),
    env.DB.prepare(insert).bind(MOVED_KEY, JSON.stringify({ at: now, keys: legacy.map(([key]) => key) }), now),
  ]);
}

async function readDocs(env, keys) {
  if (!env.DB) {
    const values = await Promise.all(keys.map((key) => env.REPORTS.get(key)));
    return Object.fromEntries(keys.map((key, index) => [key, { raw: values[index], version: 0 }]));
  }
  const wanted = [...new Set([...keys, MOVED_KEY])];
  const select = () => env.DB.prepare(`SELECT key, body, version FROM docs WHERE key IN (${wanted.map(() => '?').join(', ')})`).bind(...wanted).all();
  let rows = null;
  try {
    rows = (await select()).results;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
  }
  if (!rows?.some((row) => row.key === MOVED_KEY)) {
    await createD1(env);
    rows = (await select()).results;
  }
  const found = new Map(rows.map((row) => [row.key, row]));
  const docs = Object.fromEntries(keys.map((key) => [key, { raw: found.get(key)?.body ?? null, version: Number(found.get(key)?.version || 0) }]));
  await foldStragglers(env, docs, found.get(MOVED_KEY));
  return docs;
}

async function foldStragglers(env, docs, moved) {
  const keys = Object.keys(STRAGGLER_IDENTITY).filter((key) => docs[key]);
  if (!keys.length || !env.REPORTS || !moved) return;
  const movedAt = Number(parseDoc(moved.body, {}).at) || 0;
  if (Date.now() - movedAt > STRAGGLER_WINDOW_MS) return;
  await Promise.all(keys.map(async (key) => {
    const identity = STRAGGLER_IDENTITY[key];
    const current = parseDoc(docs[key].raw, []).filter(Boolean);
    const known = new Set(current.map(identity));
    // Only what the old version took in after the move: what was there before
    // was copied, and may since have been removed on purpose.
    const missing = parseDoc(await env.REPORTS.get(key), []).filter((item) => item && item.at > movedAt && !known.has(identity(item)));
    if (!missing.length) return;
    const raw = JSON.stringify([...current, ...missing]);
    try {
      await writeDocs(env, [{ key, raw, version: docs[key].version }]);
      docs[key] = { raw, version: docs[key].version + 1 };
    } catch (error) {
      if (!staleWrite(error)) throw error;
      // Someone wrote it meanwhile; the next read folds again.
      docs[key] = { ...docs[key], raw };
    }
  }));
}

async function writeDocs(env, changed) {
  if (!env.DB) {
    for (const { key, raw } of changed) {
      if (key.startsWith('analytics:')) await env.REPORTS.put(key, raw, { expirationTtl: ANALYTICS_RETENTION_SECONDS });
      else await env.REPORTS.put(key, raw);
    }
    return;
  }
  const now = Date.now();
  await env.DB.batch([
    // A write that read before the club was frozen and commits after it is
    // refused like a stale one, and its retry finds the club frozen.
    env.DB.prepare('INSERT INTO doc_guard (ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM docs WHERE key = ?)').bind(FROZEN_KEY),
    ...changed.flatMap(({ key, raw, version }) => [
      version
        ? env.DB.prepare('INSERT INTO doc_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM docs WHERE key = ? AND version = ?)').bind(key, version)
        : env.DB.prepare('INSERT INTO doc_guard (ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM docs WHERE key = ?)').bind(key),
      env.DB.prepare('INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, version = excluded.version, updated_at = excluded.updated_at')
        .bind(key, raw, version + 1, now),
    ]),
  ]);
}

function staleWrite(error) {
  return /stale_write|CHECK constraint failed/i.test(String(error?.message || error));
}

/**
 * Reads the documents named in `defaults`, lets `change` edit them in place
 * and writes back the ones it changed, all together. If anyone wrote one of
 * them in the meantime, the write is refused and `change` runs again on what
 * is stored now — so `change` must do nothing but edit and return a result.
 * While the club is frozen for a move it throws Frozen and changes nothing.
 */
async function transact(env, defaults, change) {
  const keys = Object.keys(defaults);
  for (let attempt = 1; ; attempt += 1) {
    const stored = await readDocs(env, [...keys, FROZEN_KEY]);
    if (stored[FROZEN_KEY].raw != null) throw new Frozen();
    const docs = {};
    const before = {};
    for (const key of keys) {
      docs[key] = parseDoc(stored[key].raw, defaults[key]);
      before[key] = JSON.stringify(docs[key]);
    }
    const result = await change(docs);
    const changed = keys
      .map((key) => ({ key, raw: JSON.stringify(docs[key]), version: stored[key].version }))
      .filter(({ key, raw }) => raw !== undefined && raw !== before[key]);
    if (!changed.length) return result;
    try {
      await writeDocs(env, changed);
      return result;
    } catch (error) {
      if (!staleWrite(error)) throw error;
      if (attempt >= WRITE_ATTEMPTS) throw new StorageBusy(keys);
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25 * attempt));
    }
  }
}

async function loadDocs(env, defaults) {
  const keys = Object.keys(defaults);
  const stored = await readDocs(env, keys);
  return Object.fromEntries(keys.map((key) => [key, parseDoc(stored[key].raw, defaults[key])]));
}

async function readDoc(env, key, fallback) {
  return (await loadDocs(env, { [key]: fallback }))[key];
}

// The VAPID pair and the club's signing secret never change once made, so an
// isolate reads each of them once.
const constants = new WeakMap();

function remembered(env, name, load) {
  const holder = env.DB || env.REPORTS;
  let slot = constants.get(holder);
  if (!slot) constants.set(holder, (slot = new Map()));
  if (!slot.has(name)) {
    const pending = load();
    slot.set(name, pending);
    pending.catch(() => slot.delete(name));
  }
  return slot.get(name);
}

async function readAll(env) {
  const cutoff = Date.now() - WINDOW_MS;
  return (await readDoc(env, 'reports', [])).filter((item) => item && item.at > cutoff);
}

// The free KV plan allows 1,000 writes a day. A rate-limit counter kept in KV
// spent one of them on every request, so the counter now lives in the
// isolate's memory: crude, per edge location, and enough to stop a loop.
const hits = new Map();

function limited(request, scope, perMinute) {
  const who = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${scope}:${who}:${Math.floor(Date.now() / 60000)}`;
  const used = (hits.get(key) || 0) + 1;
  if (hits.size > 5000) hits.clear();
  hits.set(key, used);
  return used > perMinute;
}

/** A crude per-address limit; enough to stop a loop, not a security boundary. */
async function overRate(request, env, scope = 'reports') {
  return limited(request, scope, MAX_PER_MINUTE);
}

// ---------------------------------------------------------------- analytics

function analyticsDay(offset = 0) {
  return new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
}

function safeDimension(value, max = 64) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_:.\-]/g, '').slice(0, max) || 'unknown';
}

function finiteNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}

function cleanAnalyticsFields(fields) {
  const clean = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return clean;
  for (const [key, value] of Object.entries(fields)) {
    if (!ANALYTICS_DIMENSIONS.has(key) || value == null) continue;
    if (key === 'sources' && Array.isArray(value)) {
      clean.sources = [...new Set(value.slice(0, 8).map((item) => safeDimension(item, 32)))];
    } else if (['probability', 'trust'].includes(key)) clean[key] = finiteNumber(value, 0, 100);
    else if (['source_count', 'result_count', 'fresh_count', 'radius_km', 'queue', 'collector_ok', 'collector_failed'].includes(key)) clean[key] = finiteNumber(value, 0, 100000);
    else if (typeof value === 'boolean') clean[key] = value;
    else clean[key] = safeDimension(value);
  }
  return clean;
}

async function analyticsSecret(env) {
  if (env.ANALYTICS_SALT) return String(env.ANALYTICS_SALT);
  // Existing deployments need no extra binding to start collecting. The
  // private VAPID component already lives in KV and is never returned here.
  const keys = await vapidKeys(env);
  return keys.privateJwk?.d || JSON.stringify(keys.privateJwk);
}

async function hmacToken(secret, value) {
  const key = await crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, utf8.encode(value));
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function increment(object, key, amount = 1) {
  object[key] = Number(object[key] || 0) + amount;
}

function outcomeSlot(object, key) {
  const slot = object[key] || { total: 0, correct: 0, brier_sum: 0 };
  object[key] = slot;
  return slot;
}

function addOutcome(slot, probability, actual) {
  const predicted = probability >= 0.5;
  slot.total += 1;
  slot.correct += Number(predicted === actual);
  slot.brier_sum += (probability - Number(actual)) ** 2;
}

function trustBucket(score) {
  if (score == null) return 'unknown';
  if (score >= 75) return 'high';
  if (score >= 45) return 'moderate';
  return 'low';
}

function emptyAnalyticsDay(day) {
  return {
    version: ANALYTICS_VERSION, day, updated_at: Date.now(),
    events: {}, users: {}, sessions: {}, hours: {}, areas: {}, zones: {}, grades: {},
    search: { total: 0, success: 0, zero: 0, result_sum: 0, fresh_sum: 0, widened: 0 },
    outcomes: { total: 0, correct: 0, brier_sum: 0, by_status: {}, by_trust: {}, by_age: {}, by_source: {} },
    stations: {},
  };
}

function applyAnalyticsEvent(day, event, userHash, sessionHash) {
  increment(day.events, event.event);
  day.users[userHash] = 1;
  day.sessions[sessionHash] = 1;
  const hour = String(new Date(event.at).getUTCHours()).padStart(2, '0');
  increment(day.hours, hour);
  const fields = event.fields;
  for (const key of ['area', 'zone', 'grade']) {
    if (fields[key]) increment(day[`${key}s`], fields[key]);
  }
  if (fields.station) {
    const station = day.stations[fields.station] || { opens: 0, routes: 0, reports: 0 };
    if (event.event === 'station_open') station.opens += 1;
    if (event.event === 'route_open') station.routes += 1;
    if (event.event === 'report_sent') station.reports += 1;
    day.stations[fields.station] = station;
  }
  if (event.event === 'search_complete') {
    day.search.total += 1;
    day.search.success += Number(fields.success === true || Number(fields.result_count) > 0);
    day.search.zero += Number(Number(fields.result_count) === 0);
    day.search.result_sum += Number(fields.result_count || 0);
    day.search.fresh_sum += Number(fields.fresh_count || 0);
    day.search.widened += Number(Number(fields.radius_km || 0) > 5);
  }
  if (event.event !== 'report_outcome' || fields.reason !== 'on_site' || typeof fields.seen !== 'boolean') return;
  const probability = finiteNumber(fields.probability, 0, 100);
  if (probability == null) return;
  const p = probability / 100;
  addOutcome(day.outcomes, p, fields.seen);
  for (const [dimension, key] of [
    ['by_status', fields.status], ['by_trust', trustBucket(fields.trust)], ['by_age', fields.age_bucket],
  ]) addOutcome(outcomeSlot(day.outcomes[dimension], safeDimension(key)), p, fields.seen);
  for (const source of fields.sources || []) addOutcome(outcomeSlot(day.outcomes.by_source, source), p, fields.seen);
}

async function storeAnalytics(request, env) {
  // Every accepted batch is a KV write. Until the owner has set up the
  // dashboard there is nobody to read the numbers, so nothing is written.
  if (!secretSet(env, 'ANALYTICS_ADMIN_KEY')) return json({ ok: true, accepted: 0, disabled: true }, request, env, 202);
  if (await overRate(request, env, 'analytics')) return json({ error: 'too many events' }, request, env, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'expected JSON' }, request, env, 400); }
  const installId = safeDimension(body.install_id, 80);
  const sessionId = safeDimension(body.session_id, 80);
  if (installId === 'unknown' || sessionId === 'unknown' || !Array.isArray(body.events)) {
    return json({ error: 'expected install_id, session_id and events' }, request, env, 400);
  }
  const events = body.events.slice(0, 24).flatMap((raw) => {
    const name = safeDimension(raw?.event, 32);
    if (!ANALYTICS_EVENTS.has(name)) return [];
    const at = finiteNumber(raw.at, Date.now() - 86400000, Date.now() + 300000) || Date.now();
    return [{ event: name, at, fields: cleanAnalyticsFields(raw.fields) }];
  });
  if (!events.length) return json({ ok: true, accepted: 0 }, request, env, 202);
  const dayName = analyticsDay();
  const secret = await analyticsSecret(env);
  const [userHash, sessionHash] = await Promise.all([
    hmacToken(secret, `${dayName}:user:${installId}`),
    hmacToken(secret, `${dayName}:session:${sessionId}`),
  ]);
  const key = `analytics:v${ANALYTICS_VERSION}:${dayName}`;
  await transact(env, { [key]: null }, (docs) => {
    const day = docs[key] && typeof docs[key] === 'object' ? docs[key] : emptyAnalyticsDay(dayName);
    for (const event of events) applyAnalyticsEvent(day, event, userHash, sessionHash);
    day.updated_at = Date.now();
    docs[key] = day;
  });
  return json({ ok: true, accepted: events.length }, request, env, 202);
}

function publicOutcome(slot = {}) {
  const total = Number(slot.total || 0);
  return {
    total,
    accuracy_percent: total ? Math.round(1000 * Number(slot.correct || 0) / total) / 10 : null,
    brier_score: total ? Math.round(10000 * Number(slot.brier_sum || 0) / total) / 10000 : null,
  };
}

function mergeCounters(target, source) {
  for (const [key, value] of Object.entries(source || {})) increment(target, key, Number(value || 0));
}

function ranked(counter, minimum = 0) {
  return Object.entries(counter || {}).filter(([, count]) => count >= minimum)
    .sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

async function analyticsDashboard(request, env, url) {
  if (!secretSet(env, 'ANALYTICS_ADMIN_KEY')) return json({ error: 'ANALYTICS_ADMIN_KEY is not configured' }, request, env, 503);
  if (!(await secretMatches(request, env, 'ANALYTICS_ADMIN_KEY', request.headers.get('X-Analytics-Key')))) {
    return json({ error: 'forbidden' }, request, env, 403);
  }
  const days = Math.round(finiteNumber(url.searchParams.get('days') || 7, 1, 30));
  const stored = await loadDocs(env, Object.fromEntries([...Array(days)].map((_, index) => [`analytics:v${ANALYTICS_VERSION}:${analyticsDay(index)}`, null])));
  const documents = Object.values(stored).filter((day) => day && typeof day === 'object');
  const total = emptyAnalyticsDay('range');
  const trend = [];
  for (const day of documents) {
    mergeCounters(total.events, day.events); mergeCounters(total.hours, day.hours);
    mergeCounters(total.areas, day.areas); mergeCounters(total.zones, day.zones); mergeCounters(total.grades, day.grades);
    for (const key of ['total', 'success', 'zero', 'result_sum', 'fresh_sum', 'widened']) total.search[key] += Number(day.search?.[key] || 0);
    for (const key of ['total', 'correct', 'brier_sum']) total.outcomes[key] += Number(day.outcomes?.[key] || 0);
    for (const dimension of ['by_status', 'by_trust', 'by_age', 'by_source']) {
      for (const [key, slot] of Object.entries(day.outcomes?.[dimension] || {})) {
        const merged = outcomeSlot(total.outcomes[dimension], key);
        merged.total += Number(slot.total || 0); merged.correct += Number(slot.correct || 0); merged.brier_sum += Number(slot.brier_sum || 0);
      }
    }
    for (const [key, station] of Object.entries(day.stations || {})) {
      const merged = total.stations[key] || { opens: 0, routes: 0, reports: 0 };
      for (const metric of ['opens', 'routes', 'reports']) merged[metric] += Number(station[metric] || 0);
      total.stations[key] = merged;
    }
    trend.push({ day: day.day, users: Object.keys(day.users || {}).length, sessions: Object.keys(day.sessions || {}).length, events: Object.values(day.events || {}).reduce((a, b) => a + b, 0) });
  }
  const dimensionOutcomes = (name) => Object.entries(total.outcomes[name]).map(([key, slot]) => ({ key, ...publicOutcome(slot) })).sort((a, b) => b.total - a.total);
  const searches = total.search.total;
  const opens = Number(total.events.station_open || 0);
  return json({
    version: ANALYTICS_VERSION, days, generated_at: new Date().toISOString(), trend: trend.sort((a, b) => a.day.localeCompare(b.day)),
    totals: {
      daily_active_sum: trend.reduce((sum, item) => sum + item.users, 0),
      sessions: trend.reduce((sum, item) => sum + item.sessions, 0),
      events: Object.values(total.events).reduce((a, b) => a + b, 0),
      searches, search_success_percent: searches ? Math.round(1000 * total.search.success / searches) / 10 : null,
      zero_searches: total.search.zero, widened_searches: total.search.widened,
      station_opens: opens, routes: Number(total.events.route_open || 0),
      route_conversion_percent: opens ? Math.round(1000 * Number(total.events.route_open || 0) / opens) / 10 : null,
      on_site_checks: total.outcomes.total, ...publicOutcome(total.outcomes),
    },
    events: ranked(total.events), areas: ranked(total.areas), grades: ranked(total.grades),
    // A zone is hidden until at least three interactions occurred in the range.
    zones: ranked(total.zones, 3), hours_utc: ranked(total.hours),
    calibration: {
      by_status: dimensionOutcomes('by_status'), by_trust: dimensionOutcomes('by_trust'),
      by_age: dimensionOutcomes('by_age'), by_source: dimensionOutcomes('by_source'),
    },
    top_stations: Object.entries(total.stations).map(([station, value]) => ({ station, ...value })).sort((a, b) => (b.routes + b.opens) - (a.routes + a.opens)).slice(0, 20),
  }, request, env);
}

function constantEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function queueWords(cars) {
  if (cars == null) return null;
  if (cars === 0) return 'нет';
  if (cars <= 5) return 'до 5 машин';
  if (cars <= 20) return 'до 20 машин';
  if (cars <= 50) return 'до 50 машин';
  if (cars <= 100) return 'до 100 машин';
  return 'больше 100 машин';
}

// ---------------------------------------------------------------- base64url

const b64u = {
  encode(bytes) {
    let text = '';
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(text).length % 4)) % 4);
    const raw = atob(padded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  },
};

const utf8 = new TextEncoder();

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------- VAPID keys

async function vapidKeys(env) {
  return remembered(env, 'vapid', async () => {
    const stored = await readDoc(env, 'vapid', null);
    if (stored?.privateJwk && stored.publicJwk) return stored;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const created = {
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      publicKey: b64u.encode(await crypto.subtle.exportKey('raw', pair.publicKey)),
    };
    // Two first requests at once must settle on one pair: phones subscribe
    // with its public half and never hear anything signed with another.
    return transact(env, { vapid: null }, (docs) => {
      if (docs.vapid?.privateJwk && docs.vapid.publicJwk) return docs.vapid;
      docs.vapid = created;
      return created;
    });
  });
}

async function vapidAuthorization(env, endpoint) {
  const keys = await vapidKeys(env);
  const privateKey = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u.encode(utf8.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u.encode(utf8.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: APP_URL,
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------- RFC 8291 encryption

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Encrypts `plaintext` for one subscription: aes128gcm body per RFC 8188/8291. */
async function encryptForSubscription(subscription, plaintext) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(utf8.encode('WebPush: info\0'), uaPublic, localPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(utf8.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const header = concat(salt, recordSize, new Uint8Array([localPublic.length]), localPublic);
  return concat(header, ciphertext);
}

async function sendPush(env, subscription, payload) {
  const body = await encryptForSubscription(subscription, JSON.stringify(payload));
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.byteLength),
      TTL: '1800',
      Urgency: 'high',
      Authorization: await vapidAuthorization(env, subscription.endpoint),
    },
    body,
  });
  return response.status;
}

// ---------------------------------------------------------------- subscriptions

async function readSubscriptions(env) {
  return readDoc(env, 'subscriptions', []);
}

async function notifyGroup(env, report) {
  const subscriptions = await readSubscriptions(env);
  if (!subscriptions.length) return;
  const members = clubEnabled(env) ? await readDoc(env, 'club:members', {}) : null;
  const closed = clubClosed(env);
  const here = report.lat != null && report.lon != null ? { lat: report.lat, lon: report.lon } : null;
  const grade = GRADE_LABELS[report.grade] || report.grade;
  const queue = queueWords(report.queue);
  const body = `${report.summary || `${grade} ${report.seen ? 'есть' : 'нет'}${queue ? `, очередь: ${queue}` : ''}`}${report.address ? ` · ${report.address}` : ''}`;
  // Names stay inside the club: a phone outside it hears the same mark unsigned.
  const payloadFor = (member) => ({
    title: member && report.reporter ? `👁 ${report.reporter}: ${report.name || 'АЗС'}` : `👁 Свой отметил: ${report.name || 'АЗС'}`,
    body,
    station: report.station,
    tag: `spbfi-${report.station}`,
  });
  const dead = new Set();
  await Promise.all(subscriptions.map(async (sub) => {
    if (sub.who && sub.who === report.who) return;
    const member = members?.[sub.who];
    // A banned member's phone hears nothing; behind a closed door neither does
    // a phone outside the club.
    if (member?.banned || (closed && !member)) return;
    if (here && sub.lat != null && sub.lon != null && distanceKm(here, sub) > NOTIFY_RADIUS_KM) return;
    try {
      const status = await sendPush(env, sub, payloadFor(member));
      if (status === 404 || status === 410) dead.add(sub.endpoint);
    } catch {
      // One phone unreachable must not stop the others.
    }
  }));
  if (dead.size) {
    await transact(env, { subscriptions: [] }, (docs) => {
      docs.subscriptions = docs.subscriptions.filter((sub) => !dead.has(sub.endpoint));
    });
  }
}

// ---------------------------------------------------------------- club rewards

// Litres, levels and badges. They pay for usefulness to the others — a mark
// someone else confirms, a thank-you from someone who drove there — far more
// than for taps, so hammering the buttons earns next to nothing.
const LITERS = { mark: 1, confirmed: 3, thanks: 2, first_seen: 2, blind_spot: 2, award: 10 };
const MARK_LITERS_PER_DAY = 10;
const THANKS_PER_DAY = 20;
const CONFIRM_WINDOW_MS = 45 * 60 * 1000;
const SAME_STATION_MS = 60 * 60 * 1000;
// 👍 and 👎 on someone else's mark come only from a member standing at that
// pump while the mark is still news. 👎 from different people add up with no
// expiry: three bring a warning, five take the author out of the club until
// the owner brings them back.
const VOTE_WINDOW_MS = 60 * 60 * 1000;
const VOTE_RADIUS_M = 300;
// GPS under a canopy or between buildings drifts; the app asks for 300 m.
const VOTE_RADIUS_SLACK_M = 100;
const VOTES_PER_DAY = 40;
const REFUTED_WARNING = 3;
const REFUTED_BAN = 5;
// Its author takes a mark back while it is news; the owner, while it is listed.
const DELETE_WINDOW_MS = 60 * 60 * 1000;
const LEVELS = [
  { min: 0, icon: '🔰', title: 'Новичок' },
  { min: 10, icon: '⛽', title: 'Заправщик' },
  { min: 30, icon: '🧭', title: 'Штурман' },
  { min: 70, icon: '🔭', title: 'Разведчик колонок' },
  { min: 150, icon: '🛡️', title: 'Хранитель бака' },
  { min: 300, icon: '🏆', title: 'Легенда трассы' },
];
const BADGES = [
  { id: 'first_mark', icon: '🎯', title: 'Первая отметка', hint: 'Отметить любую АЗС', test: (s) => s.marks >= 1 },
  { id: 'sharp_eye', icon: '👁️', title: 'Зоркий глаз', hint: '10 ваших отметок подтвердили другие', test: (s) => s.confirmed >= 10 },
  { id: 'thanked', icon: '🙏', title: 'Спасибо от своих', hint: 'Получить 10 «спасибо»', test: (s) => s.thanks >= 10 },
  { id: 'trip_saver', icon: '🛟', title: 'Сберёг поездку', hint: '3 «спасибо» за отметки «нет»', test: (s) => s.saved >= 3 },
  { id: 'first_seen', icon: '⚡', title: 'Первым увидел', hint: '3 раза отметить «есть» там, где до вас было «нет»', test: (s) => s.first_seen >= 3 },
  { id: 'scout', icon: '🔭', title: 'Разведчик', hint: '5 отметок там, где три часа никто не отмечался', test: (s) => s.scout >= 5 },
  { id: 'blind_spots', icon: '🔦', title: 'Фонарик', hint: '5 отметок там, где у приложения не было свежих данных', test: (s) => s.blind >= 5 },
  { id: 'queue_master', icon: '🚦', title: 'Знаток очередей', hint: '5 раз другие подтвердили очередь, которую вы указали', test: (s) => s.queue_confirmed >= 5 },
  { id: 'night_watch', icon: '🌙', title: 'Ночной дозор', hint: '5 отметок с 23:00 до 6:00', test: (s) => s.night >= 5 },
  { id: 'whole_city', icon: '🗺️', title: 'Весь город', hint: 'Отметки в 4 разных частях города и области', test: (s) => (s.zones || []).length >= 4 },
  { id: 'generous', icon: '🎁', title: 'Щедрая душа', hint: 'Сказать 10 «спасибо» другим', test: (s) => s.given >= 10 },
  { id: 'sponsor', icon: '🔗', title: 'Поручитель', hint: 'Приглашённый вами сделал 5 отметок', test: (s) => s.sponsor >= 1 },
  { id: 'hero', icon: '🦸', title: 'Герой недели', hint: 'Больше всех рукопожатий за неделю', test: (s) => s.heroes >= 1 },
  { id: 'club_award', icon: '🏅', title: 'Благодарность клуба', hint: 'Её вручает владелец', test: (s) => (s.awards || []).length >= 1 },
];

function emptyStats() {
  return {
    liters: 0, marks: 0, confirmed: 0, thanks: 0, saved: 0, given: 0, scout: 0, first_seen: 0,
    night: 0, queue_confirmed: 0, sponsor: 0, heroes: 0, blind: 0, zones: [], weeks: {}, days: {}, given_days: {},
    badges: {}, awards: [], news: [], thanked: {}, confirms: {}, votes: {}, refuted_by: {}, vote_days: {},
    paid_looks: {},
  };
}

function statsFor(all, id) {
  all[id] = { ...emptyStats(), ...(all[id] || {}) };
  return all[id];
}

// The group lives on Moscow time: a "day" and a "week" end at local midnight.
function moscowDate(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000);
}

function dayKey(ms) {
  return moscowDate(ms).toISOString().slice(0, 10);
}

function weekKey(ms) {
  const date = moscowDate(ms);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function levelFor(liters) {
  let index = 0;
  LEVELS.forEach((level, i) => { if (liters >= level.min) index = i; });
  const next = LEVELS[index + 1];
  return { ...LEVELS[index], rank: index, next: next ? { icon: next.icon, title: next.title, left: next.min - liters, min: next.min } : null };
}

function pushNews(stats, item) {
  stats.news = [...(stats.news || []), item].slice(-30);
}

function addLiters(stats, amount, at, type, extra = {}) {
  const before = levelFor(stats.liters).rank;
  stats.liters += amount;
  const week = weekKey(at);
  stats.weeks[week] = (stats.weeks[week] || 0) + amount;
  for (const key of Object.keys(stats.weeks).sort().slice(0, -8)) delete stats.weeks[key];
  pushNews(stats, { type, liters: amount, at, ...extra });
  const after = levelFor(stats.liters);
  if (after.rank > before) pushNews(stats, { type: 'level', icon: after.icon, title: after.title, at });
  return after.rank > before ? after : null;
}

/**
 * Takes back what a look earned its author, as payMark wrote it down in
 * paid_looks, never below zero; a week or a day no longer kept is skipped.
 * Returns the 🤝 taken back.
 */
function unpayLook(stats, key) {
  const paid = stats.paid_looks?.[key];
  if (!paid) return 0;
  const take = (holder, name, amount) => {
    if (!holder || holder[name] == null || !amount) return 0;
    const before = Number(holder[name]) || 0;
    holder[name] = Math.max(0, before - amount);
    return before - holder[name];
  };
  const back = take(stats, 'liters', paid.liters);
  take(stats.weeks, weekKey(paid.at), paid.liters);
  take(stats.days, paid.day, paid.day_liters);
  for (const name of ['marks', 'blind', 'first_seen', 'scout', 'night']) take(stats, name, paid[name]);
  delete stats.paid_looks[key];
  return back;
}

function awardBadges(stats, at) {
  const fresh = [];
  for (const badge of BADGES) {
    if (!stats.badges[badge.id] && badge.test(stats)) {
      stats.badges[badge.id] = at;
      fresh.push({ id: badge.id, icon: badge.icon, title: badge.title });
      pushNews(stats, { type: 'badge', icon: badge.icon, title: badge.title, at });
    }
  }
  return fresh;
}

function zoneOf(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 59.68 || lat > 60.2 || lon < 29.65 || lon > 30.85) return 'lo_other';
  if (lat >= 60.02) return 'spb_north';
  if (lat <= 59.86) return 'spb_south';
  if (lon <= 30.17) return 'spb_west';
  if (lon >= 30.48) return 'spb_east';
  return 'spb_centre';
}

function queueBucket(cars) {
  if (cars == null) return null;
  if (cars === 0) return 0;
  if (cars <= 5) return 1;
  if (cars <= 20) return 2;
  if (cars <= 50) return 3;
  if (cars <= 100) return 4;
  return 5;
}

function markKey(report) {
  return `${report.station}:${report.grade}:${report.at}`;
}

// One look at a pump may list several grades; 👍 and 👎 are about the look.
function lookKey(report) {
  return `${report.station}:${report.at}`;
}

function profileOf(stats, now = Date.now()) {
  return {
    liters: stats.liters,
    week: stats.weeks[weekKey(now)] || 0,
    level: levelFor(stats.liters),
    counts: { marks: stats.marks, confirmed: stats.confirmed, thanks: stats.thanks, saved: stats.saved, given: stats.given, blind: stats.blind },
    badges: BADGES.map((badge) => ({ id: badge.id, icon: badge.icon, title: badge.title, hint: badge.hint, earned: stats.badges[badge.id] || null })),
    awards: stats.awards || [],
  };
}

/**
 * Pays out for a new mark: to its author for looking, and to everyone whose
 * recent mark it agrees with, because a second pair of eyes is what makes a
 * mark worth trusting. Returns what happened so the phone can celebrate.
 */
async function rewardMark(env, members, reports, looks, options = {}) {
  // A look may list several grades; everything is paid from one read and one
  // write of the scoreboard, redone if another payout got there first.
  return transact(env, { 'club:stats': {} }, (docs) => payMark(docs['club:stats'], members, reports, looks, options));
}

function payMark(all, members, reports, looks, { blindSpot = false } = {}) {
  const batch = Array.isArray(looks) ? looks : [looks];
  const report = batch[0];
  const me = statsFor(all, report.who);
  const at = report.at;
  const result = { liters: 0, confirmed: [], badges: [], level_up: null };
  // Written down per look, so that deleting the look takes back exactly what
  // it earned its author.
  const paid = { at, station: report.station, liters: 0, marks: 0, blind: 0, first_seen: 0, scout: 0, night: 0, day: dayKey(at), day_liters: 0 };
  // Only members' marks count: until the door is closed, marks from phones
  // outside the club share the same list.
  const others = reports.filter((item) => item.who !== report.who && members[item.who] && !members[item.who].banned);
  // One look at a station is one mark, however many grades it lists and
  // however often it is repeated within the hour. The hour's first look counts
  // even after a repeat has replaced it and been deleted; otherwise mark, mark
  // again and delete would pay the next look as a first one.
  const repeat = reports.some((item) => item.who === report.who && item.station === report.station && at - item.at < SAME_STATION_MS)
    || Object.values(me.paid_looks).some((item) => item.station === report.station && item.marks && at - item.at < SAME_STATION_MS);
  if (!repeat) {
    me.marks += 1;
    paid.marks = 1;
    const today = dayKey(at);
    const earned = me.days[today] || 0;
    if (earned < MARK_LITERS_PER_DAY) {
      me.days = { [today]: earned + LITERS.mark };
      paid.day_liters = LITERS.mark;
      result.level_up = addLiters(me, LITERS.mark, at, 'mark', { station: report.station }) || result.level_up;
      result.liters += LITERS.mark;
    }
    if (!others.some((item) => item.station === report.station)) {
      me.scout += 1;
      paid.scout = 1;
    }
    // The phone says the app had nothing fresh here. Taken on trust inside the
    // club, and only for a first look, so it cannot be farmed by re-marking.
    if (blindSpot) {
      me.blind += 1;
      paid.blind = 1;
      result.level_up = addLiters(me, LITERS.blind_spot, at, 'blind_spot', { station: report.station }) || result.level_up;
      result.liters += LITERS.blind_spot;
      result.blind_spot = true;
    }
    const hour = moscowDate(at).getUTCHours();
    if (hour >= 23 || hour < 6) {
      me.night += 1;
      paid.night = 1;
    }
    const zone = zoneOf(report.lat, report.lon);
    if (zone && !me.zones.includes(zone)) me.zones = [...me.zones, zone];
    const sponsorId = members[report.who]?.sponsor;
    if (sponsorId && me.marks >= 5 && !me.sponsor_credited) {
      me.sponsor_credited = true;
      const sponsor = statsFor(all, sponsorId);
      sponsor.sponsor += 1;
      pushNews(sponsor, { type: 'sponsor', by: report.who, at });
      awardBadges(sponsor, at);
    }
  }
  let firstSeenPaid = false;
  for (const look of batch) {
    const sameGrade = others.filter((item) => item.station === look.station && item.grade === look.grade).sort((a, b) => b.at - a.at);
    if (!firstSeenPaid && look.seen && sameGrade[0] && sameGrade[0].seen === false) {
      firstSeenPaid = true;
      me.first_seen += 1;
      paid.first_seen = 1;
      result.level_up = addLiters(me, LITERS.first_seen, at, 'first_seen', { station: look.station }) || result.level_up;
      result.liters += LITERS.first_seen;
    }
    for (const prior of sameGrade) {
      if (prior.seen !== look.seen || at - prior.at > CONFIRM_WINDOW_MS) continue;
      const author = statsFor(all, prior.who);
      // A confirmer pays each author once per station an hour, not once per grade.
      const pairKey = `${look.who}:${look.station}`;
      for (const [key, when] of Object.entries(author.confirms)) if (at - when > SAME_STATION_MS) delete author.confirms[key];
      if (author.confirms[pairKey]) continue;
      author.confirms[pairKey] = at;
      author.confirmed += 1;
      if (queueBucket(prior.queue) != null && queueBucket(prior.queue) === queueBucket(look.queue)) author.queue_confirmed += 1;
      addLiters(author, LITERS.confirmed, at, 'confirmed', { by: look.who, station: look.station, grade: look.grade });
      awardBadges(author, at);
      result.confirmed.push(members[prior.who]?.name || '');
    }
  }
  paid.liters = result.liters;
  // A repeat that earned nothing leaves nothing to take back. A look can be
  // deleted only while it is listed, so older entries are dropped.
  if (paid.marks || paid.first_seen) {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, item] of Object.entries(me.paid_looks)) if (!(item.at > cutoff)) delete me.paid_looks[key];
    me.paid_looks[lookKey(report)] = paid;
  }
  result.badges = awardBadges(me, at);
  result.total = me.liters;
  result.level = levelFor(me.liters);
  return result;
}

async function notifyMember(env, memberId, payload) {
  const subscriptions = (await readSubscriptions(env)).filter((sub) => sub.who === memberId);
  await Promise.all(subscriptions.map((sub) => sendPush(env, sub, payload).catch(() => null)));
}

/** Once a week the member with the most litres last week becomes its hero. */
async function crownLastWeek(env, members) {
  const lastWeek = weekKey(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const crowned = await readDoc(env, 'club:heroes', {});
  if (crowned[lastWeek] !== undefined) return crowned[lastWeek];
  return transact(env, { 'club:heroes': {}, 'club:stats': {} }, (docs) => {
    const heroes = docs['club:heroes'];
    if (heroes[lastWeek] !== undefined) return heroes[lastWeek];
    const all = docs['club:stats'];
    const best = Object.entries(all)
      .filter(([id, stats]) => members[id] && !members[id].banned && (stats.weeks?.[lastWeek] || 0) > 0)
      .sort((a, b) => b[1].weeks[lastWeek] - a[1].weeks[lastWeek])[0];
    heroes[lastWeek] = best ? { id: best[0], liters: best[1].weeks[lastWeek] } : null;
    if (best) {
      const stats = statsFor(all, best[0]);
      stats.heroes += 1;
      pushNews(stats, { type: 'hero', week: lastWeek, liters: heroes[lastWeek].liters, at: Date.now() });
      awardBadges(stats, Date.now());
    }
    return heroes[lastWeek];
  });
}

// ---------------------------------------------------------------- club

const CLUB_VERSION = 1;
// No 0/O, 1/I/L: the code is read aloud and typed on a phone.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_INVITES = 3;
// A member who has handed out theirs asks the owner, at most twice a day.
const INVITES_ASK_MS = 12 * 60 * 60 * 1000;
const INVITES_GRANT = 3;

function invitesWord(count) {
  if (count % 10 === 1 && count % 100 !== 11) return 'приглашение';
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'приглашения';
  return 'приглашений';
}
const FRESH_TOKEN_GRACE_MS = 5 * 60 * 1000;
const DISPUTE_WINDOW_MS = 20 * 60 * 1000;
const MAX_FLAGS = 1000;

function clubEnabled(env) {
  return secretSet(env, 'CLUB_OWNER_KEY');
}

// 'off'; 'test' — only members see the club; 'invite' — everyone is offered
// to join; 'closed' — nothing without membership.
function clubMode(env) {
  if (!clubEnabled(env)) return 'off';
  const gate = String(env.CLUB_GATE || '').trim().toLowerCase();
  return gate === 'invite' || gate === 'closed' ? gate : 'test';
}

function clubClosed(env) {
  return clubMode(env) === 'closed';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function clubSecret(env) {
  return remembered(env, 'club:secret', async () => {
    // Read first: while the club is frozen for a move a transaction is refused
    // even when it would change nothing, and members must still get in to read.
    const stored = await readDoc(env, 'club:secret', null);
    if (typeof stored === 'string' && stored) return stored;
    // Every member's pass is signed with it: two first requests at once must
    // settle on one secret, or some passes would stop working.
    return transact(env, { 'club:secret': null }, (docs) => {
      if (typeof docs['club:secret'] === 'string' && docs['club:secret']) return docs['club:secret'];
      docs['club:secret'] = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
      return docs['club:secret'];
    });
  });
}

async function clubSign(env, value) {
  const key = await crypto.subtle.importKey('raw', utf8.encode(await clubSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, utf8.encode(value));
  return b64u.encode(digest.slice(0, 18));
}

async function issueToken(env, memberId) {
  const issued = Date.now().toString(36);
  return `v1.${memberId}.${issued}.${await clubSign(env, `${memberId}.${issued}`)}`;
}

/**
 * The member behind a request, or null. A banned member is returned as such so
 * the caller can say why. Tokens are signed, so a member who joined a moment
 * ago is recognised even at an edge that has not seen the new member list yet.
 */
async function clubMember(request, env, members = null) {
  const parts = String(request.headers.get('X-Member-Token') || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, id, issued, signature] = parts;
  if (!constantEqual(signature, await clubSign(env, `${id}.${issued}`))) return null;
  const list = members || await readDoc(env, 'club:members', {});
  if (list[id]) return list[id];
  // Only KV can still be missing a member who joined a moment ago; D1 shows
  // every write at once, so there a pass without a member is a pass revoked —
  // on 14 Sep 2026 a removed member kept reading the club for five minutes.
  return !env.DB && Date.now() - parseInt(issued, 36) < FRESH_TOKEN_GRACE_MS ? { id, name: '', role: 'member', pending: true } : null;
}

// Refused as banned, saying who did it: the owner, or five people at the pumps.
function bannedBody(member) {
  return { error: 'banned', reason: member.banned_reason || '', ...(member.banned_by === 'votes' ? { by: 'votes' } : {}) };
}

function inviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normalizeCode(value) {
  const clean = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : '';
}

// The owner types this key on a phone, often pasted from notes or a
// messenger: a capital letter the notes app added, «ё» for «е», a stray or
// non-breaking space, an invisible character, a Latin letter that looks
// Cyrillic. None of that may lock the owner out, so both sides are compared
// in the same plain form.
const LOOKALIKES = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к' };

function ownerKeyForm(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[aceopxyk]/g, (letter) => LOOKALIKES[letter])
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function publicMember(member) {
  return {
    id: member.id, name: member.name, role: member.role, sponsor: member.sponsor || null,
    joined: member.joined || null, banned: !!member.banned, banned_reason: member.banned_reason || '',
  };
}

function inviteAllowance(member, invites) {
  if (member.role === 'owner') return null;
  const spent = Object.values(invites).filter((invite) => invite.by === member.id && !invite.for && (!invite.revoked || invite.used_by)).length;
  return Math.max(0, MEMBER_INVITES + (Number(member.extra_invites) || 0) - spent);
}

// ---------------------------------------------------------------- getting back in
//
// A pass lives in the phone's storage, and storage goes: site data cleared, the
// icon deleted and added again, a new phone, a computer. In a club of a hundred
// people the owner cannot hand out a way back to each of them, so a member
// comes back on their own: with a passkey the phone keeps behind Face ID, a
// fingerprint or the screen lock (iCloud and Google carry it to a new phone),
// with the same invitation code while it runs, or with a short code shown by a
// device that is still inside. A code from the owner is the last resort.
const LOGIN_CODE_MS = 10 * 60 * 1000;
const RETURN_CODE_MS = 7 * 24 * 60 * 60 * 1000;
const PASSKEY_CHALLENGE_MS = 5 * 60 * 1000;
const PASSKEYS_PER_MEMBER = 6;
const MAX_DEVICES = 8;
const fromUtf8 = new TextDecoder();

function appOrigin(env) {
  return env.ORIGIN || DEFAULT_ORIGIN;
}

function knowsDevice(member, device) {
  return !!device && (member.device === device || (member.devices || []).includes(device));
}

function rememberDevice(member, device) {
  if (!device || knowsDevice(member, device)) return;
  member.devices = [...(member.devices || []), device].slice(-MAX_DEVICES);
}

function safeDecode(value, limit = 4096) {
  try {
    return b64u.decode(String(value || '').slice(0, limit));
  } catch {
    return null;
  }
}

function constantBytes(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left[i] ^ right[i];
  return result === 0;
}

/** The part of CBOR (RFC 8949) that WebAuthn uses: definite lengths only. */
function cborDecode(input) {
  const data = new Uint8Array(input);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const need = (count) => {
    if (offset + count > data.length) throw new Error('cbor: truncated');
  };
  const size = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return data[offset++]; }
    if (info === 25) { need(2); offset += 2; return view.getUint16(offset - 2); }
    if (info === 26) { need(4); offset += 4; return view.getUint32(offset - 4); }
    if (info === 27) { need(8); offset += 8; return view.getUint32(offset - 8) * 2 ** 32 + view.getUint32(offset - 4); }
    throw new Error('cbor: unsupported length');
  };
  const item = (depth) => {
    if (depth > 16) throw new Error('cbor: too deep');
    need(1);
    const head = data[offset++];
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 26) { need(4); offset += 4; return view.getFloat32(offset - 4); }
      if (info === 27) { need(8); offset += 8; return view.getFloat64(offset - 8); }
      throw new Error('cbor: unsupported simple value');
    }
    const length = size(info);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) {
      need(length);
      offset += length;
      const chunk = data.subarray(offset - length, offset);
      return major === 2 ? chunk : fromUtf8.decode(chunk);
    }
    if (major === 4 || major === 5) {
      // Every entry takes at least a byte, so a longer count is a lie.
      if (length > data.length - offset) throw new Error('cbor: truncated');
      if (major === 4) return Array.from({ length }, () => item(depth + 1));
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const key = item(depth + 1);
        map.set(key, item(depth + 1));
      }
      return map;
    }
    if (major === 6) return item(depth + 1);
    throw new Error('cbor: unsupported type');
  };
  return item(0);
}

// WebAuthn sends ES256 signatures in DER; WebCrypto verifies the bare r‖s.
function derSignature(signature) {
  const der = new Uint8Array(signature);
  if (der[0] !== 0x30) throw new Error('der: not a sequence');
  let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const raw = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 0x02) throw new Error('der: not an integer');
    const length = der[offset + 1];
    let integer = der.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (integer.length > 32 && integer[0] === 0) integer = integer.subarray(1);
    if (!integer.length || integer.length > 32) throw new Error('der: bad integer');
    raw.set(integer, 32 * (part + 1) - integer.length);
  }
  return raw;
}

// Phones make P-256 keys (ES256); Windows Hello may make RSA (RS256).
function passkeyFromCose(cose) {
  if (!(cose instanceof Map)) return null;
  const [kty, alg, a, b, c] = [cose.get(1), cose.get(3), cose.get(-1), cose.get(-2), cose.get(-3)];
  if (kty === 2 && alg === -7 && a === 1 && b?.length === 32 && c?.length === 32) {
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u.encode(b), y: b64u.encode(c) } };
  }
  if (kty === 3 && alg === -257 && a?.length >= 256 && b?.length) {
    return { alg: -257, jwk: { kty: 'RSA', n: b64u.encode(a), e: b64u.encode(b) } };
  }
  return null;
}

function importPasskey(record) {
  return record.alg === -7
    ? crypto.subtle.importKey('jwk', record.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    : crypto.subtle.importKey('jwk', { ...record.jwk, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

// Stateless: signed and dated, good for five minutes. The app fetches one
// before the person taps, because Safari asks for Face ID only straight from
// a tap, not after a wait for the network.
async function passkeyChallenge(env) {
  const body = `pk.${Date.now().toString(36)}.${b64u.encode(crypto.getRandomValues(new Uint8Array(12)))}`;
  return b64u.encode(utf8.encode(`${body}.${await clubSign(env, body)}`));
}

async function passkeyChallengeOk(env, challenge) {
  let parts;
  try {
    parts = fromUtf8.decode(b64u.decode(challenge)).split('.');
  } catch {
    return false;
  }
  if (parts.length !== 4 || parts[0] !== 'pk') return false;
  const age = Date.now() - parseInt(parts[1], 36);
  if (!(age > -60000 && age <= PASSKEY_CHALLENGE_MS)) return false;
  return constantEqual(parts[3], await clubSign(env, parts.slice(0, 3).join('.')));
}

/** What the browser says it signed: for this site, for our challenge, as asked. */
async function passkeyClient(env, encoded, type) {
  try {
    const bytes = b64u.decode(String(encoded || '').slice(0, 4096));
    const data = JSON.parse(fromUtf8.decode(bytes));
    if (data?.type !== type || data.origin !== appOrigin(env)) return null;
    return (await passkeyChallengeOk(env, data.challenge)) ? { bytes, data } : null;
  } catch {
    return null;
  }
}

/** The authenticator's own data: made for this site, with the person present. */
async function passkeyAuthData(env, bytes) {
  const data = new Uint8Array(bytes || []);
  if (data.length < 37) return null;
  const site = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(new URL(appOrigin(env)).hostname)));
  if (!constantBytes(data.subarray(0, 32), site) || !(data[32] & 0x01)) return null;
  return { data, flags: data[32] };
}

async function clubRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (request.method === 'GET' && path === '/club/health') {
    // `club` still means "the door is closed": an app from before the stages
    // shows its gate only then.
    return json({ club: clubClosed(env), mode: clubMode(env), version: CLUB_VERSION, batch: true, late_marks: true, forgiving_key: true, rejoin: true, remove: true, returning: true, passkeys: true, votes: true, invites_more: true, chat: true, delete_marks: true, migrate: true, drive_events: true, storage: storageKind(env) }, request, env);
  }
  if (!clubEnabled(env)) return json({ error: 'club_disabled' }, request, env, 404);

  if (request.method === 'POST' && path === '/club/owner') {
    if (limited(request, 'club-owner', 5)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    if (!(await secretMatches(request, env, 'CLUB_OWNER_KEY', body.key))) {
      return json({ error: 'wrong_owner_key' }, request, env, 403);
    }
    const owner = await transact(env, { 'club:members': {} }, (docs) => {
      const members = docs['club:members'];
      members.owner = members.owner || { id: 'owner', role: 'owner', joined: Date.now(), sponsor: null };
      members.owner.name = cleanName(body.name) || members.owner.name || 'Владелец';
      members.owner.banned = false;
      return members.owner;
    });
    return json({ token: await issueToken(env, 'owner'), member: publicMember(owner) }, request, env);
  }

  if (request.method === 'POST' && path === '/club/join') {
    if (limited(request, 'club-join', 10)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    const code = normalizeCode(body.code);
    const name = cleanName(body.name);
    // A name and the rules are asked of a newcomer only: someone coming back is
    // known already.
    if (!code) return json({ error: 'expected_code_and_name' }, request, env, 400);
    // The new member and the spent code are written together: two people
    // joining at the same moment both stay members, and one code lets in one.
    const device = String(body.device || '').slice(0, 64);
    const joined = await transact(env, { 'club:members': {}, 'club:invites': {} }, (docs) => {
      const members = docs['club:members'];
      const invite = docs['club:invites'][code];
      const now = Date.now();
      // A phone that has joined already — its answer lost on the way, or its
      // owner trying again with a second code — gets that membership back
      // instead of a twin. On 13 Sep 2026 one person became two members so.
      const again = device ? Object.values(members).find((item) => item.role !== 'owner' && knowsDevice(item, device)) : null;
      if (again?.banned) return { ...bannedBody(again), status: 403 };
      // A phone that joined minutes ago lost the answer on the way; one that
      // joined long ago is coming back.
      if (again) return { member: again, returned: now - (again.joined || 0) > 5 * 60 * 1000 };
      if (!invite || invite.revoked) return { error: 'invite_unknown', status: 404 };
      if (invite.for) {
        // A code for getting back in, shown by the member's own device or made
        // by the owner: it works once and only while it runs.
        const target = members[invite.for];
        if (!target) return { error: 'invite_unknown', status: 404 };
        if (target.banned) return { ...bannedBody(target), status: 403 };
        if (invite.used_by) return { error: 'login_code_used', status: 409 };
        if (invite.expires < now) return { error: 'login_code_expired', status: 410 };
        invite.used_by = target.id;
        invite.used_at = now;
        rememberDevice(target, device);
        return { member: target, returned: true };
      }
      if (invite.used_by) {
        // Whoever joined with this code may enter it again while it runs — in
        // the icon after Safari, on a computer, after the phone was cleared —
        // and is asked first: a code passed on to a friend must not quietly
        // turn the friend into them.
        const target = members[invite.used_by];
        if (!target || target.banned || invite.expires < now) return { error: 'invite_used', status: 409 };
        if (body.returning !== true) return { error: 'invite_used', status: 409, returning: target.name };
        rememberDevice(target, device);
        return { member: target, returned: true };
      }
      if (invite.expires < now) return { error: 'invite_expired', status: 410 };
      if (!name) return { error: 'expected_code_and_name', status: 400 };
      if (body.accept !== true) return { error: 'rules_not_accepted', status: 400 };
      const sponsor = members[invite.by];
      if (!sponsor || sponsor.banned) return { error: 'sponsor_banned', status: 403 };
      let id;
      do {
        id = b64u.encode(crypto.getRandomValues(new Uint8Array(6)));
      } while (members[id]);
      members[id] = { id, name, role: 'member', sponsor: invite.by, joined: now, accepted_rules: now, ...(device ? { device } : {}) };
      invite.used_by = id;
      invite.used_at = now;
      return { member: members[id] };
    });
    if (joined.error) {
      const extra = {
        ...(joined.reason != null ? { reason: joined.reason } : {}),
        ...(joined.by ? { by: joined.by } : {}),
        ...(joined.returning != null ? { returning: joined.returning } : {}),
      };
      return json({ error: joined.error, ...extra }, request, env, joined.status);
    }
    return json({ token: await issueToken(env, joined.member.id), member: publicMember(joined.member), ...(joined.returned ? { returned: true } : {}) }, request, env);
  }

  if (request.method === 'GET' && path === '/club/passkey/challenge') {
    if (limited(request, 'club-passkey', 30)) return json({ error: 'too_many_attempts' }, request, env, 429);
    return json({ challenge: await passkeyChallenge(env), rp_id: new URL(appOrigin(env)).hostname, ttl: PASSKEY_CHALLENGE_MS }, request, env);
  }

  if (request.method === 'POST' && path === '/club/passkey/login') {
    if (limited(request, 'club-join', 10)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    const id = String(body.id || '').slice(0, 1400);
    const client = await passkeyClient(env, body.client, 'webauthn.get');
    const auth = client ? await passkeyAuthData(env, safeDecode(body.auth)) : null;
    if (!id || !client || !auth) return json({ error: 'passkey_failed' }, request, env, 403);
    const { 'club:passkeys': keys, 'club:members': everyone } = await loadDocs(env, { 'club:passkeys': {}, 'club:members': {} });
    const record = keys[id];
    if (!record) return json({ error: 'passkey_unknown' }, request, env, 404);
    let valid = false;
    try {
      const signed = concat(auth.data, await crypto.subtle.digest('SHA-256', client.bytes));
      const signature = b64u.decode(String(body.signature || '').slice(0, 1400));
      const key = await importPasskey(record);
      valid = record.alg === -7
        ? await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derSignature(signature), signed)
        : await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signed);
    } catch {
      valid = false;
    }
    if (!valid) return json({ error: 'passkey_failed' }, request, env, 403);
    const who = everyone[record.member];
    if (!who) {
      // Removed from the club: the key the phone keeps opens nothing now.
      await transact(env, { 'club:passkeys': {} }, (docs) => {
        delete docs['club:passkeys'][id];
      });
      return json({ error: 'passkey_unknown' }, request, env, 404);
    }
    if (who.banned) return json(bannedBody(who), request, env, 403);
    return json({ token: await issueToken(env, who.id), member: publicMember(who), returned: true }, request, env);
  }

  const members = await readDoc(env, 'club:members', {});
  const member = await clubMember(request, env, members);
  if (!member) return json({ error: 'club_required' }, request, env, 401);
  if (member.banned) return json(bannedBody(member), request, env, 403);

  if (request.method === 'GET' && path === '/club/me') {
    const { 'club:invites': invites, 'club:stats': all, 'club:passkeys': keys, 'club:settings': settings } = await loadDocs(env, { 'club:invites': {}, 'club:stats': {}, 'club:passkeys': {}, 'club:settings': {} });
    const mine = Object.entries(invites)
      .filter(([, invite]) => invite.by === member.id && !invite.revoked && !invite.for)
      .map(([code, invite]) => ({
        code, created: invite.created, expires: invite.expires,
        used_by: invite.used_by ? (members[invite.used_by]?.name || '—') : null,
      }))
      .sort((a, b) => b.created - a.created);
    const stats = statsFor(all, member.id);
    const since = Number(url.searchParams.get('since')) || 0;
    const news = (stats.news || []).filter((item) => item.at > since)
      .map((item) => ({ ...item, by_name: item.by ? (members[item.by]?.name || '') : undefined }));
    return json({
      member: publicMember(member), invites: mine, invites_left: inviteAllowance(member, invites),
      passkeys: Object.values(keys).filter((key) => key.member === member.id).length,
      refuted_by: Object.keys(stats.refuted_by || {}).length,
      invites_asked: member.invites_asked || null,
      // The club's chat link reaches members only, from here.
      chat_url: settings.chat_url || null,
      profile: profileOf(stats), news, now: Date.now(),
    }, request, env);
  }

  if (request.method === 'POST' && path === '/club/passkey/save') {
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const body = (await readJson(request)) || {};
    const id = String(body.id || '');
    const client = await passkeyClient(env, body.client, 'webauthn.create');
    let credential = null;
    try {
      const attestation = client ? cborDecode(safeDecode(body.attestation, 32768) || []) : null;
      const auth = attestation instanceof Map ? await passkeyAuthData(env, attestation.get('authData')) : null;
      // After the flags and the counter: 16 bytes naming the authenticator
      // model, the length of the key's id, the id, then the public key.
      if (auth && auth.flags & 0x40 && auth.data.length > 55) {
        const length = (auth.data[53] << 8) | auth.data[54];
        const rawId = auth.data.subarray(55, 55 + length);
        if (id && id.length <= 1400 && rawId.length === length && b64u.encode(rawId) === id) {
          credential = passkeyFromCose(cborDecode(auth.data.subarray(55 + length)));
          if (credential) await importPasskey(credential);
        }
      }
    } catch {
      credential = null;
    }
    if (!credential) return json({ error: 'passkey_failed' }, request, env, 400);
    const saved = await transact(env, { 'club:passkeys': {} }, (docs) => {
      const keys = docs['club:passkeys'];
      if (keys[id] && keys[id].member !== member.id) return null;
      keys[id] = { member: member.id, alg: credential.alg, jwk: credential.jwk, created: keys[id]?.created || Date.now() };
      const mine = Object.entries(keys).filter(([, key]) => key.member === member.id).sort((a, b) => a[1].created - b[1].created);
      for (const [old] of mine.slice(0, -PASSKEYS_PER_MEMBER)) delete keys[old];
      return Math.min(mine.length, PASSKEYS_PER_MEMBER);
    });
    if (saved == null) return json({ error: 'passkey_failed' }, request, env, 400);
    return json({ ok: true, passkeys: saved }, request, env);
  }

  // A way back that needs nobody: a device still inside shows a short code for
  // a computer or a new phone. The owner can make one for someone who has lost
  // every device and has no passkey.
  if (request.method === 'POST' && path === '/club/code') {
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const body = (await readJson(request)) || {};
    const forId = String(body.id || member.id);
    const own = forId === member.id;
    if (!own && member.role !== 'owner') return json({ error: 'owner_only' }, request, env, 403);
    const target = members[forId];
    if (!target || (!own && target.role === 'owner')) return json({ error: 'member_unknown' }, request, env, 404);
    if (target.banned) return json({ error: 'member_banned' }, request, env, 403);
    const made = await transact(env, { 'club:invites': {} }, (docs) => {
      const invites = docs['club:invites'];
      const now = Date.now();
      for (const [code, invite] of Object.entries(invites)) {
        if (!invite.for) continue;
        // Codes for coming back that ran out a day ago are clutter; of the live
        // ones only the latest for a person works.
        if (invite.expires < now - 24 * 60 * 60 * 1000) delete invites[code];
        else if (invite.for === forId && !invite.used_by) invite.revoked = true;
      }
      let code;
      do {
        code = inviteCode();
      } while (invites[code]);
      invites[code] = { by: member.id, for: forId, created: now, expires: now + (own ? LOGIN_CODE_MS : RETURN_CODE_MS) };
      return { code, expires: invites[code].expires };
    });
    return json({ ...made, name: target.name }, request, env);
  }

  // Invitations spread through members, three each. One who has handed out
  // theirs asks the owner for more instead of borrowing someone else's codes,
  // and the owner answers with a tap.
  if (request.method === 'POST' && path === '/club/invites/more') {
    if (member.role === 'owner') return json({ error: 'owner_has_no_limit' }, request, env, 400);
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const now = Date.now();
    const asked = await transact(env, { 'club:members': {}, 'club:invites': {} }, (docs) => {
      const me = docs['club:members'][member.id];
      if (!me) return { error: 'member_unknown', status: 404 };
      if (inviteAllowance(me, docs['club:invites']) > 0) return { error: 'invites_left', status: 409 };
      if (me.invites_asked && now - me.invites_asked < INVITES_ASK_MS) return { at: me.invites_asked, again: true };
      me.invites_asked = now;
      return { at: now };
    });
    if (asked.error) return json({ error: asked.error }, request, env, asked.status);
    if (!asked.again) {
      ctx.waitUntil(notifyMember(env, 'owner', {
        title: `🎟 ${member.name || 'Участник'} просит ещё приглашений`,
        body: 'Свои закончились. Дать ещё: «👥 Клуб» → «Участники» → «🎟 +3 приглашения».',
        tag: `spbfi-invites-${member.id}`,
      }).catch(() => {}));
    }
    return json({ ok: true, asked_at: asked.at }, request, env);
  }

  if (request.method === 'POST' && path === '/club/invite') {
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const created = await transact(env, { 'club:invites': {} }, (docs) => {
      const invites = docs['club:invites'];
      if (inviteAllowance(member, invites) === 0) return { error: 'no_invites_left' };
      // Unused codes that ran out a month ago are only clutter.
      for (const [code, invite] of Object.entries(invites)) {
        if (!invite.used_by && invite.expires < Date.now() - 30 * 24 * 60 * 60 * 1000) delete invites[code];
      }
      let code;
      do {
        code = inviteCode();
      } while (invites[code]);
      invites[code] = { by: member.id, created: Date.now(), expires: Date.now() + INVITE_TTL_MS };
      return { code, expires: invites[code].expires, invites_left: inviteAllowance(member, invites) };
    });
    if (created.error) return json({ error: created.error }, request, env, 403);
    return json(created, request, env);
  }

  if (request.method === 'POST' && path === '/club/invite/revoke') {
    const body = (await readJson(request)) || {};
    const revoked = await transact(env, { 'club:invites': {} }, (docs) => {
      const invite = docs['club:invites'][normalizeCode(body.code)];
      if (!invite || (invite.by !== member.id && member.role !== 'owner')) return { error: 'invite_unknown', status: 404 };
      if (invite.used_by) return { error: 'invite_used', status: 409 };
      invite.revoked = true;
      return { ok: true };
    });
    if (revoked.error) return json({ error: revoked.error }, request, env, revoked.status);
    return json({ ok: true }, request, env);
  }

  if (request.method === 'POST' && path === '/club/thanks') {
    const body = (await readJson(request)) || {};
    const authorId = String(body.author || '');
    if (authorId === member.id) return json({ error: 'cannot_thank_self' }, request, env, 400);
    const target = (await readAll(env)).find((report) => report.who === authorId && report.station === String(body.station || '')
      && report.grade === String(body.grade || '') && report.at === Number(body.at));
    if (!target || !members[authorId] || members[authorId].banned) return json({ error: 'mark_gone' }, request, env, 404);
    const now = Date.now();
    const today = dayKey(now);
    const key = markKey(target);
    const thanked = await transact(env, { 'club:stats': {} }, (docs) => {
      const all = docs['club:stats'];
      if ((all[member.id]?.given_days?.[today] || 0) >= THANKS_PER_DAY) return { error: 'too_many_thanks', status: 429 };
      const thankedBy = all[authorId]?.thanked?.[key] || [];
      if (thankedBy.includes(member.id)) return { error: 'already_thanked', status: 409, thanks: thankedBy.length };
      const giver = statsFor(all, member.id);
      const author = statsFor(all, authorId);
      for (const old of Object.keys(author.thanked)) {
        if (now - Number(old.split(':').pop()) > 3 * 24 * 60 * 60 * 1000) delete author.thanked[old];
      }
      author.thanked[key] = [...thankedBy, member.id];
      author.thanks += 1;
      if (!target.seen) author.saved += 1;
      const levelUp = addLiters(author, LITERS.thanks, now, 'thanks', { by: member.id, station: target.station, grade: target.grade, seen: target.seen });
      awardBadges(author, now);
      giver.given += 1;
      giver.given_days = { [today]: (giver.given_days[today] || 0) + 1 };
      return { thanks: author.thanked[key].length, levelUp, badges: awardBadges(giver, now) };
    });
    if (thanked.error) {
      return json({ error: thanked.error, ...(thanked.thanks != null ? { thanks: thanked.thanks } : {}) }, request, env, thanked.status);
    }
    const grade = GRADE_LABELS[target.grade] || target.grade;
    ctx.waitUntil(notifyMember(env, authorId, {
      title: `🙏 ${member.name || 'Свой'} говорит спасибо`,
      body: `За отметку «${grade} ${target.seen ? 'есть' : 'нет'}» · +${LITERS.thanks} 🤝${thanked.levelUp ? ` · новый уровень: ${thanked.levelUp.icon} ${thanked.levelUp.title}` : ''}`,
      station: target.station,
      tag: `spbfi-thanks-${target.station}`,
    }).catch(() => {}));
    return json({ ok: true, thanks: thanked.thanks, author_name: members[authorId].name, badges: thanked.badges }, request, env);
  }

  if (request.method === 'POST' && path === '/club/vote') {
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const body = (await readJson(request)) || {};
    const authorId = String(body.author || '');
    const vote = body.vote === 'up' || body.vote === 'down' ? body.vote : null;
    if (!vote) return json({ error: 'expected_vote' }, request, env, 400);
    if (authorId === member.id) return json({ error: 'cannot_vote_self' }, request, env, 400);
    const station = String(body.station || '');
    const at = Number(body.at);
    const look = (await readAll(env)).filter((report) => report.who === authorId && report.station === station && report.at === at);
    const author = members[authorId];
    if (!look.length || !author || author.banned) return json({ error: 'mark_gone' }, request, env, 404);
    const now = Date.now();
    if (now - at > VOTE_WINDOW_MS) return json({ error: 'vote_too_late' }, request, env, 410);
    // Only someone who sees the pump can say whether the mark is true. The
    // mark carries where the station is; an old app's mark without it is
    // placed by the voter's app.
    const placed = look.find((report) => report.lat != null && report.lon != null);
    const pump = placed ? { lat: placed.lat, lon: placed.lon } : { lat: Number(body.station_lat), lon: Number(body.station_lon) };
    const here = { lat: Number(body.lat), lon: Number(body.lon) };
    if (![pump.lat, pump.lon, here.lat, here.lon].every(Number.isFinite)) return json({ error: 'vote_needs_place' }, request, env, 400);
    if (distanceKm(here, pump) * 1000 > VOTE_RADIUS_M + VOTE_RADIUS_SLACK_M) return json({ error: 'vote_not_here' }, request, env, 403);
    const key = `${station}:${at}`;
    const today = dayKey(now);
    const outcome = await transact(env, { 'club:stats': {}, 'club:members': {} }, (docs) => {
      const all = docs['club:stats'];
      const voter = statsFor(all, member.id);
      const target = statsFor(all, authorId);
      const record = target.votes[key] || { up: [], down: [] };
      const was = record.up.includes(member.id) ? 'up' : record.down.includes(member.id) ? 'down' : null;
      if (was === vote) return { up: record.up.length, down: record.down.length, mine: vote };
      if ((voter.vote_days[today] || 0) >= VOTES_PER_DAY) return { error: 'too_many_votes', status: 429 };
      voter.vote_days = { [today]: (voter.vote_days[today] || 0) + 1 };
      for (const old of Object.keys(target.votes)) {
        if (now - Number(old.split(':').pop()) > 3 * 24 * 60 * 60 * 1000) delete target.votes[old];
      }
      record.up = record.up.filter((id) => id !== member.id);
      record.down = record.down.filter((id) => id !== member.id);
      record[vote].push(member.id);
      target.votes[key] = record;
      const result = { up: record.up.length, down: record.down.length, mine: vote };
      // Who refuted what: a changed mind takes that 👎 back, and one person
      // refuting several marks still counts as one.
      const refuted = target.refuted_by;
      const looks = (refuted[member.id]?.looks || []).filter((item) => item !== key);
      if (vote === 'down') looks.push(key);
      if (looks.length) refuted[member.id] = { at: refuted[member.id]?.at || now, looks: looks.slice(-20) };
      else delete refuted[member.id];
      result.people = Object.keys(refuted).length;
      if (vote === 'up') {
        // Paid like a second pair of eyes: once per person per station an hour.
        const pair = `${member.id}:${station}`;
        for (const [confirm, when] of Object.entries(target.confirms)) if (now - when > SAME_STATION_MS) delete target.confirms[confirm];
        if (!target.confirms[pair]) {
          target.confirms[pair] = now;
          target.confirmed += 1;
          result.levelUp = addLiters(target, LITERS.confirmed, now, 'confirmed', { by: member.id, station, grade: look[0].grade, seen: look[0].seen });
          awardBadges(target, now);
          result.paid = LITERS.confirmed;
        }
      }
      const record2 = docs['club:members'][authorId];
      if (vote === 'down' && record2 && record2.role !== 'owner' && !record2.banned) {
        if (result.people >= REFUTED_BAN) {
          record2.banned = true;
          record2.banned_reason = `отметки опровергли ${result.people} участников клуба`;
          record2.banned_at = now;
          record2.banned_by = 'votes';
          result.banned = true;
        } else if (result.people >= REFUTED_WARNING && !target.warned_at) {
          target.warned_at = now;
          pushNews(target, { type: 'warning', people: result.people, at: now });
          result.warned = true;
        }
      }
      return result;
    });
    if (outcome.error) return json({ error: outcome.error }, request, env, outcome.status);
    if (outcome.banned) {
      // What the excluded member said stops counting at once, as with the owner's ban.
      await transact(env, { reports: [], subscriptions: [] }, (docs) => {
        docs.reports = docs.reports.filter((report) => report?.who !== authorId);
        docs.subscriptions = docs.subscriptions.filter((sub) => sub?.who !== authorId);
      });
      ctx.waitUntil(notifyMember(env, 'owner', {
        title: `⛔ ${author.name || 'Участник'} выбыл(а) из клуба`,
        body: `Отметки опровергли ${outcome.people} участников. Если это ошибка — «👥 Клуб» → «Участники» → «Вернуть в клуб».`,
        tag: `spbfi-refuted-${authorId}`,
      }).catch(() => {}));
    } else if (outcome.warned) {
      ctx.waitUntil(notifyMember(env, authorId, {
        title: '⚠️ С вашими отметками не согласны',
        body: `${outcome.people} человека на заправках поставили 👎. Отмечайте только то, что видите сами: после ${REFUTED_BAN} — выбывание из клуба.`,
        tag: 'spbfi-warning',
      }).catch(() => {}));
    } else if (outcome.paid) {
      ctx.waitUntil(notifyMember(env, authorId, {
        title: `👍 ${member.name || 'Свой'} подтвердил(а) вашу отметку`,
        body: `На месте всё так · +${outcome.paid} 🤝${outcome.levelUp ? ` · новый уровень: ${outcome.levelUp.icon} ${outcome.levelUp.title}` : ''}`,
        station,
        tag: `spbfi-confirm-${station}`,
      }).catch(() => {}));
    }
    return json({ ok: true, up: outcome.up, down: outcome.down, mine: outcome.mine, ...(outcome.paid ? { paid: outcome.paid } : {}) }, request, env);
  }

  // A mark made by mistake used to stay. Its author deletes it in the first
  // hour, the owner any mark while it is listed, and what the look earned its
  // author goes with it, so marking and deleting pays nothing. Confirmations it
  // paid others, badges and zones stay.
  if (request.method === 'POST' && path === '/club/report/delete') {
    if (limited(request, 'mark-delete', 20)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    const owner = member.role === 'owner';
    const named = String(body.author || '');
    if (named && named !== member.id && !owner) return json({ error: 'not_yours' }, request, env, 403);
    const authorId = named || member.id;
    const station = String(body.station || '');
    const at = Number(body.at);
    const now = Date.now();
    const outcome = await transact(env, { reports: [], 'club:stats': {} }, (docs) => {
      const cutoff = now - WINDOW_MS;
      const look = docs.reports.filter((report) => report && report.at > cutoff && report.who === authorId && report.station === station && report.at === at);
      if (!look.length) return { error: 'mark_gone', status: 404 };
      if (!owner && now - at > DELETE_WINDOW_MS) return { error: 'delete_too_late', status: 410 };
      docs.reports = docs.reports.filter((report) => !look.includes(report));
      const stats = docs['club:stats'][authorId];
      if (!stats) return { removed: look.length, liters_back: 0 };
      const back = unpayLook(stats, lookKey(look[0]));
      stats.news = (stats.news || []).filter((item) => !(['mark', 'blind_spot', 'first_seen'].includes(item.type) && item.station === station && item.at === at));
      // Dated now, not by the mark: a phone asks only for news newer than the
      // last it read, and it read the mark's own news long ago.
      if (authorId !== member.id) pushNews(stats, { type: 'mark_removed', station, at: now, mark_at: at, by: 'owner' });
      return { removed: look.length, liters_back: back };
    });
    if (outcome.error) return json({ error: outcome.error }, request, env, outcome.status);
    return json({ ok: true, removed: outcome.removed, liters_back: outcome.liters_back }, request, env);
  }

  if (request.method === 'GET' && path === '/club/leaderboard') {
    const hero = await crownLastWeek(env, members);
    const all = await readDoc(env, 'club:stats', {});
    const week = weekKey(Date.now());
    const rows = Object.values(members)
      .filter((item) => !item.banned)
      .map((item) => {
        const stats = statsFor(all, item.id);
        const level = levelFor(stats.liters);
        return {
          id: item.id, name: item.name, icon: level.icon, title: level.title,
          week: stats.weeks[week] || 0, liters: stats.liters,
          badges: Object.keys(stats.badges || {}).length, me: item.id === member.id,
        };
      })
      .sort((a, b) => b.week - a.week || b.liters - a.liters);
    return json({
      week, members: rows,
      hero_last_week: hero ? { name: members[hero.id]?.name || '', liters: hero.liters } : null,
      rules: LITERS, mark_liters_per_day: MARK_LITERS_PER_DAY,
    }, request, env);
  }

  if (request.method === 'GET' && path === '/club/reports') {
    const { 'club:stats': clubStats, reports: stored } = await loadDocs(env, { 'club:stats': {}, reports: [] });
    const cutoff = Date.now() - WINDOW_MS;
    const reports = stored
      .filter((report) => report && report.at > cutoff && !members[report.who]?.banned)
      .map((report) => {
        const author = (clubStats[report.who] || {});
        const thankedBy = author.thanked?.[markKey(report)] || [];
        const votes = author.votes?.[lookKey(report)] || { up: [], down: [] };
        return {
          ...report,
          name: members[report.who]?.name || '',
          level_icon: levelFor(author.liters || 0).icon,
          thanks: thankedBy.length,
          thanked: thankedBy.includes(member.id),
          up: votes.up.length,
          down: votes.down.length,
          my_vote: votes.up.includes(member.id) ? 'up' : votes.down.includes(member.id) ? 'down' : null,
        };
      });
    return json({ window_hours: WINDOW_MS / 3600000, count: reports.length, batch: true, late_marks: true, reports }, request, env);
  }

  if (member.role !== 'owner') return json({ error: 'owner_only' }, request, env, 403);

  if (request.method === 'POST' && path === '/club/award') {
    const body = (await readJson(request)) || {};
    const target = members[String(body.id || '')];
    const text = String(body.text || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!target || target.banned) return json({ error: 'member_unknown' }, request, env, 404);
    if (!text) return json({ error: 'expected_text' }, request, env, 400);
    const now = Date.now();
    const { levelUp, liters } = await transact(env, { 'club:stats': {} }, (docs) => {
      const stats = statsFor(docs['club:stats'], target.id);
      stats.awards = [...(stats.awards || []), { text, at: now }].slice(-20);
      const raised = addLiters(stats, LITERS.award, now, 'award', { text });
      awardBadges(stats, now);
      return { levelUp: raised, liters: stats.liters };
    });
    ctx.waitUntil(notifyMember(env, target.id, {
      title: '🏅 Благодарность клуба',
      body: `${text} · +${LITERS.award} 🤝${levelUp ? ` · новый уровень: ${levelUp.icon} ${levelUp.title}` : ''}`,
      tag: 'spbfi-award',
    }).catch(() => {}));
    return json({ ok: true, liters }, request, env);
  }

  if (request.method === 'POST' && path === '/club/invites/grant') {
    const body = (await readJson(request)) || {};
    const id = String(body.id || '');
    const count = Math.max(1, Math.min(10, Math.round(Number(body.count) || INVITES_GRANT)));
    const now = Date.now();
    const granted = await transact(env, { 'club:members': {}, 'club:invites': {}, 'club:stats': {} }, (docs) => {
      const target = docs['club:members'][id];
      if (!target || target.role === 'owner') return { error: 'member_unknown', status: 404 };
      if (target.banned) return { error: 'member_banned', status: 403 };
      target.extra_invites = (Number(target.extra_invites) || 0) + count;
      delete target.invites_asked;
      pushNews(statsFor(docs['club:stats'], id), { type: 'invites', count, at: now });
      return { left: inviteAllowance(target, docs['club:invites']) };
    });
    if (granted.error) return json({ error: granted.error }, request, env, granted.status);
    ctx.waitUntil(notifyMember(env, id, {
      title: `🎟 Владелец дал вам ещё ${count} ${invitesWord(count)}`,
      body: `Теперь можно пригласить: ${granted.left}. «👥 Клуб» → «Создать приглашение».`,
      tag: 'spbfi-invites',
    }).catch(() => {}));
    return json({ ok: true, left: granted.left }, request, env);
  }

  // The club's chat lives in a Telegram group; the owner pastes its invite link.
  if (request.method === 'POST' && path === '/club/settings') {
    const body = (await readJson(request)) || {};
    let link = String(body.chat_url ?? '').trim();
    // Copied from Telegram the link often comes without its scheme.
    if (/^(t\.me|telegram\.me)\//i.test(link)) link = `https://${link}`;
    if (link && !/^https:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_+\-/]{2,160}$/.test(link)) return json({ error: 'bad_chat_url' }, request, env, 400);
    const saved = await transact(env, { 'club:settings': {} }, (docs) => {
      if (link) docs['club:settings'].chat_url = link;
      else delete docs['club:settings'].chat_url;
      return docs['club:settings'].chat_url || null;
    });
    return json({ ok: true, chat_url: saved }, request, env);
  }

  if (request.method === 'GET' && path === '/club/members') {
    const { 'club:stats': ownerStats, 'club:flags': flags, 'club:invites': invites, 'club:passkeys': keys } = await loadDocs(env, { 'club:stats': {}, 'club:flags': [], 'club:invites': {}, 'club:passkeys': {} });
    const reports = await readAll(env);
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const rows = Object.values(members).map((item) => {
      const marks = reports.filter((report) => report.who === item.id);
      const disputes = (Array.isArray(flags) ? flags : []).filter((flag) => flag.target === item.id && flag.at > monthAgo);
      return {
        ...publicMember(item),
        sponsor_name: item.sponsor ? (members[item.sponsor]?.name || '—') : null,
        marks_3h: marks.length,
        last_mark: marks.reduce((latest, report) => Math.max(latest, report.at), 0) || null,
        disputed_30d: disputes.length,
        disputed_by_people_30d: new Set(disputes.map((flag) => flag.by)).size,
        liters: (ownerStats[item.id]?.liters) || 0,
        level_icon: levelFor((ownerStats[item.id]?.liters) || 0).icon,
        invited: Object.values(invites).filter((invite) => invite.by === item.id && invite.used_by && !invite.for).length,
        invites_left: inviteAllowance(item, invites),
        invites_asked: item.invites_asked || null,
        passkeys: Object.values(keys).filter((key) => key.member === item.id).length,
        refuted_by: Object.keys(ownerStats[item.id]?.refuted_by || {}).length,
        // The author sees only how many; the owner, who decides, sees who.
        refuted_names: Object.keys(ownerStats[item.id]?.refuted_by || {}).map((id) => members[id]?.name || '—'),
        warned: !!ownerStats[item.id]?.warned_at,
        banned_by: item.banned ? (item.banned_by || 'owner') : null,
      };
    }).sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : (b.joined || 0) - (a.joined || 0)));
    const active = Object.entries(invites)
      .filter(([, invite]) => !invite.for && !invite.used_by && !invite.revoked && invite.expires > Date.now())
      .map(([code, invite]) => ({ code, by: members[invite.by]?.name || '—', expires: invite.expires }));
    return json({ members: rows, invites: active }, request, env);
  }

  // Removing is not banning. A member who joined twice by mistake, or moved
  // to a new phone, is taken out without a trace and can join again with a
  // new code; nothing tells them they were excluded.
  if (request.method === 'POST' && path === '/club/remove') {
    const body = (await readJson(request)) || {};
    const id = String(body.id || '');
    const removed = await transact(env, { 'club:members': {}, 'club:stats': {} }, (docs) => {
      const target = docs['club:members'][id];
      if (!target || target.role === 'owner') return null;
      delete docs['club:members'][id];
      delete docs['club:stats'][id];
      return publicMember(target);
    });
    if (!removed) return json({ error: 'member_unknown' }, request, env, 404);
    await transact(env, { reports: [], subscriptions: [], 'club:invites': {}, 'club:passkeys': {} }, (docs) => {
      docs.reports = docs.reports.filter((report) => report?.who !== id);
      docs.subscriptions = docs.subscriptions.filter((sub) => sub?.who !== id);
      for (const invite of Object.values(docs['club:invites'])) {
        if ((invite.by === id || invite.for === id) && !invite.used_by) invite.revoked = true;
      }
      // The phone still keeps the passkey; here it stops opening anything.
      for (const [key, record] of Object.entries(docs['club:passkeys'])) {
        if (record.member === id) delete docs['club:passkeys'][key];
      }
    });
    return json({ ok: true, removed }, request, env);
  }

  if (request.method === 'POST' && path === '/club/ban') {
    const body = (await readJson(request)) || {};
    const id = String(body.id || '');
    const changed = await transact(env, { 'club:members': {} }, (docs) => {
      const target = docs['club:members'][id];
      if (!target || target.role === 'owner') return null;
      target.banned = body.banned !== false;
      target.banned_reason = target.banned ? String(body.reason || '').slice(0, 120) : '';
      target.banned_at = target.banned ? Date.now() : null;
      if (target.banned) target.banned_by = 'owner';
      else delete target.banned_by;
      return publicMember(target);
    });
    if (!changed) return json({ error: 'member_unknown' }, request, env, 404);
    if (!changed.banned) {
      // Brought back by the owner, a member starts again with no 👎 against them.
      await transact(env, { 'club:stats': {} }, (docs) => {
        const stats = docs['club:stats'][id];
        if (!stats) return;
        stats.refuted_by = {};
        delete stats.warned_at;
      });
    }
    if (changed.banned) {
      // What a banned member said stops counting at once, not in three hours.
      await transact(env, { reports: [], subscriptions: [] }, (docs) => {
        docs.reports = docs.reports.filter((report) => report?.who !== id);
        docs.subscriptions = docs.subscriptions.filter((sub) => sub?.who !== id);
      });
    }
    return json({ ok: true, member: changed }, request, env);
  }

  return json({ error: 'not found' }, request, env, 404);
}

/**
 * Two members saying opposite things about the same pump within twenty minutes
 * is recorded for the owner. It is not proof of a lie — fuel does run out — so
 * nothing is decided automatically; a member contradicted by several different
 * people is what the owner looks at. Written only when it happens.
 */
async function recordDisputes(env, reports, looks) {
  const batch = Array.isArray(looks) ? looks : [looks];
  const pairs = batch.flatMap((report) => reports
    .filter((item) => item.station === report.station && item.grade === report.grade
      && item.who !== report.who && item.seen !== report.seen && item.at >= report.at - DISPUTE_WINDOW_MS)
    .map((item) => ({ target: item.who, by: report.who, station: report.station, grade: report.grade, at: report.at })));
  if (!pairs.length) return;
  await transact(env, { 'club:flags': [] }, (docs) => {
    docs['club:flags'] = [...docs['club:flags'], ...pairs].slice(-MAX_FLAGS);
  });
}

// ---------------------------------------------------------------- moving to another server
//
// Phones in Russia no longer reach workers.dev, so the club moves to a server
// of its own that runs this same file, and the maintainer copies everything
// out through /migrate/. Nobody is to see the owner's key, and Cloudflare
// never shows a secret's value, so secrets travel as salted hashes: this
// worker does the first rounds, as many as fit in Cloudflare's CPU budget,
// the maintainer's tool adds the rest, and the new server does both when it
// checks a key. Each request is signed with the maintainer's key for its
// host, path and query, and is good for five minutes.

// The maintainer's Ed25519 public key, raw, in base64url. MIGRATE_PUBLIC_KEY
// in the environment replaces it; the tests sign with a pair of their own.
const MIGRATE_PUBLIC_KEY = 'YgzYRO4bdgREQebyo0-yCeMTnLVGGt0uci7As4cgW2U';
const MIGRATE_SIGNED_MS = 5 * 60 * 1000;
const HASHED_SECRETS = ['CLUB_OWNER_KEY', 'CLUB_READER_KEY', 'GROUP_KEY', 'ANALYTICS_ADMIN_KEY'];
// A key checked against its hash costs the server tens of thousands of
// rounds. The answer is kept, so a phone sending the same key with every
// request pays once.
const secretChecks = new Map();

// The owner's key is hashed in the plain form it is compared in.
function secretForm(name, value) {
  return name === 'CLUB_OWNER_KEY' ? ownerKeyForm(value) : String(value ?? '');
}

function secretSet(env, name) {
  return !!(env[name] || env[`${name}_HASH`]);
}

async function pbkdf2(bytes, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256));
}

/**
 * Whether `given` is the secret `name`: compared with its value where that is
 * set, as on Cloudflare, or else with NAME_HASH, written as
 * pbkdf2-sha256.<first rounds>.<more rounds>.<salt>.<hash>.
 */
async function secretMatches(request, env, name, given) {
  const form = secretForm(name, given);
  if (env[name]) {
    const expected = secretForm(name, env[name]);
    return !!expected && !!form && constantEqual(form, expected);
  }
  const stored = String(env[`${name}_HASH`] || '').trim();
  const [scheme, first, more, salt, hash, ...rest] = stored.split('.');
  const rounds = [first, more].map(Number);
  if (scheme !== 'pbkdf2-sha256' || rest.length || !salt || !hash || !form) return false;
  if (!rounds.every((count) => Number.isSafeInteger(count) && count > 0)) return false;
  const memo = `${name}\n${stored}\n${form}`;
  if (!secretChecks.has(memo)) {
    // Every new guess costs those rounds, so a stranger gets thirty a minute.
    if (limited(request, 'secret-check', 30)) return false;
    let matches = false;
    try {
      const bytes = b64u.decode(salt);
      matches = constantEqual(b64u.encode(await pbkdf2(await pbkdf2(utf8.encode(form), bytes, rounds[0]), bytes, rounds[1])), hash);
    } catch {
      // A hash that cannot be read opens nothing.
    }
    if (secretChecks.size >= 256) secretChecks.delete(secretChecks.keys().next().value);
    secretChecks.set(memo, matches);
  }
  return secretChecks.get(memo);
}

/** Signed by the maintainer for this method, host, path and query, within five minutes. */
async function migrateSigned(request, env, url) {
  try {
    const match = /^(.*)&sig=([A-Za-z0-9_-]{86})$/.exec(url.search.slice(1));
    const t = Number(url.searchParams.get('t'));
    if (!match || !(Math.abs(Date.now() - t) <= MIGRATE_SIGNED_MS)) return false;
    const raw = b64u.decode(env.MIGRATE_PUBLIC_KEY || MIGRATE_PUBLIC_KEY);
    let key;
    try {
      key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      // Older workerd knows the curve only by its own name.
      key = await crypto.subtle.importKey('raw', raw, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
    }
    const message = utf8.encode(`${request.method} ${url.host}${url.pathname}?${match[1]}`);
    return await crypto.subtle.verify(key.algorithm, key, b64u.decode(match[2]), message);
  } catch {
    return false;
  }
}

async function migrateRoutes(request, env, url) {
  if (!(await migrateSigned(request, env, url))) return json({ error: 'forbidden' }, request, env, 403);
  if (!env.DB) return json({ error: 'needs_d1' }, request, env, 409);
  // An untouched database gets its tables before anything is read or frozen.
  await readDocs(env, []);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/migrate/export') {
    const { results } = await env.DB.prepare('SELECT key, body, version, updated_at FROM docs ORDER BY key').all();
    return json({
      exported_at: Date.now(),
      frozen: results.some((row) => row.key === FROZEN_KEY),
      docs: results,
      vars: { CLUB_GATE: env.CLUB_GATE || null, ORIGIN: env.ORIGIN || null },
      // Whether each secret is set, never its value; a hash comes from /migrate/secret.
      secrets: Object.fromEntries(HASHED_SECRETS.map((name) => [name, env[name] ? true : env[`${name}_HASH`] || false])),
      analytics_salt: !!env.ANALYTICS_SALT,
    }, request, env);
  }

  // The first rounds of a secret's hash, with the maintainer's salt.
  if (request.method === 'GET' && path === '/migrate/secret') {
    const name = url.searchParams.get('name');
    const rounds = Number(url.searchParams.get('rounds'));
    const salt = url.searchParams.get('salt') || '';
    const saltBytes = /^[A-Za-z0-9_-]{1,64}$/.test(salt) ? safeDecode(salt) : null;
    if (!HASHED_SECRETS.includes(name) || !Number.isInteger(rounds) || rounds < 1000 || rounds > 100000 || !(saltBytes?.length >= 16)) {
      return json({ error: 'bad_request' }, request, env, 400);
    }
    const form = env[name] ? secretForm(name, env[name]) : '';
    if (!form) return json({ error: 'not_set' }, request, env, 404);
    return json({ name, rounds, first: b64u.encode(await pbkdf2(utf8.encode(form), saltBytes, rounds)) }, request, env);
  }

  if (request.method === 'POST' && path === '/migrate/freeze') {
    // Straight into the table: writeDocs refuses every write once the club is
    // frozen, and freezing twice must keep the first moment, not fail.
    const now = Date.now();
    await env.DB.prepare('INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING')
      .bind(FROZEN_KEY, JSON.stringify({ at: now }), now).run();
    return json({ ok: true, frozen: true }, request, env);
  }

  // The move is called off: writes start again.
  if (request.method === 'POST' && path === '/migrate/unfreeze') {
    await env.DB.prepare('DELETE FROM docs WHERE key = ?').bind(FROZEN_KEY).run();
    return json({ ok: true, frozen: false }, request, env);
  }

  return json({ error: 'not found' }, request, env, 404);
}

// ---------------------------------------------------------------- routes

function failureReason(error) {
  if (error instanceof Frozen) return 'moving';
  if (error instanceof StorageBusy) return 'storage_busy';
  const text = String(error?.message || error);
  // KV says "KV put() limit exceeded for the day."; D1 says its daily limits
  // were exceeded. Both come back at 00:00 UTC.
  if (/for the day|daily|per day|quota|limit.*exceeded|exceeded.*limit/i.test(text)) return 'storage_limit';
  // KV takes one write a second to the same key.
  if (/\b429\b|too many requests/i.test(text)) return 'storage_busy';
  return 'worker_error';
}

// A phone that had no signal at the pump sends the mark once it is back, dated
// the moment the person looked. Half an hour late it is still worth knowing;
// later it is history. A push about it goes out only while it is news.
const LATE_MARK_MS = 30 * 60 * 1000;
const LATE_PUSH_MS = 10 * 60 * 1000;

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(request, env) });
  }

  if (!env.DB && !env.REPORTS) {
    return json({ error: 'bind a D1 database as DB or a KV namespace as REPORTS' }, request, env, 500);
  }

  if (url.pathname.startsWith('/migrate/')) {
    return migrateRoutes(request, env, url);
  }

  if (url.pathname.startsWith('/club/')) {
    return clubRoutes(request, env, url, ctx);
  }

  if (request.method === 'GET' && url.pathname === '/analytics/health') {
    return json({ ok: true, version: ANALYTICS_VERSION, storage: 'aggregate-kv', retention_days: 180 }, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/analytics/events') {
    return storeAnalytics(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/analytics/dashboard') {
    return analyticsDashboard(request, env, url);
  }

  if (request.method === 'GET' && (url.pathname === '/reports' || url.pathname === '/')) {
    let reports = await readAll(env);
    if (clubEnabled(env)) {
      const members = await readDoc(env, 'club:members', {});
      // Until the door is closed, phones outside the club read the marks too.
      if (clubClosed(env) && secretSet(env, 'CLUB_READER_KEY') && !(await secretMatches(request, env, 'CLUB_READER_KEY', request.headers.get('X-Reader-Key')))) {
        const member = await clubMember(request, env, members);
        if (!member || member.banned) return json({ error: 'club_required' }, request, env, 401);
      }
      // Names stay inside the club; the public read carries member ids only.
      reports = reports.filter((report) => !members[report.who]?.banned);
    }
    return json({ window_hours: WINDOW_MS / 3600000, count: reports.length, batch: true, late_marks: true, reports }, request, env);
  }

  if (request.method === 'GET' && url.pathname === '/vapid') {
    const keys = await vapidKeys(env);
    return json({ publicKey: keys.publicKey }, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/subscribe') {
    let clubWho = null;
    if (clubEnabled(env)) {
      const member = await clubMember(request, env);
      if (member?.banned) return json(bannedBody(member), request, env, 403);
      if (member) clubWho = member.id;
      else if (clubClosed(env)) return json({ error: 'club_required' }, request, env, 401);
    }
    if (!clubWho && secretSet(env, 'GROUP_KEY') && !(await secretMatches(request, env, 'GROUP_KEY', request.headers.get('X-Group-Key')))) {
      return json({ error: 'wrong group key' }, request, env, 403);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'expected JSON' }, request, env, 400);
    }
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth || !sub.endpoint.startsWith('https://')) {
      return json({ error: 'expected {subscription:{endpoint, keys:{p256dh, auth}}}' }, request, env, 400);
    }
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const count = await transact(env, { subscriptions: [] }, (docs) => {
      const kept = docs.subscriptions.filter((item) => item.endpoint !== sub.endpoint);
      kept.push({
        endpoint: sub.endpoint,
        keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
        who: clubWho || String(body.who || '').slice(0, 32),
        lat: Number.isFinite(lat) ? Math.round(lat * 1e4) / 1e4 : null,
        lon: Number.isFinite(lon) ? Math.round(lon * 1e4) / 1e4 : null,
        at: Date.now(),
      });
      docs.subscriptions = kept.slice(-MAX_SUBSCRIPTIONS);
      return kept.length;
    });
    return json({ ok: true, count }, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/unsubscribe') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'expected JSON' }, request, env, 400);
    }
    const count = await transact(env, { subscriptions: [] }, (docs) => {
      docs.subscriptions = docs.subscriptions.filter((item) => item.endpoint !== body.endpoint);
      return docs.subscriptions.length;
    });
    return json({ ok: true, count }, request, env);
  }

  if (request.method === 'POST' && url.pathname === '/report') {
    let clubMemberRecord = null;
    if (clubEnabled(env)) {
      clubMemberRecord = await clubMember(request, env);
      if (clubMemberRecord?.banned) return json(bannedBody(clubMemberRecord), request, env, 403);
      // Until the door is closed a phone outside the club marks as it always did.
      if (!clubMemberRecord && clubClosed(env)) return json({ error: 'club_required' }, request, env, 401);
    }
    if (!clubMemberRecord && secretSet(env, 'GROUP_KEY') && !(await secretMatches(request, env, 'GROUP_KEY', request.headers.get('X-Group-Key')))) {
      return json({ error: 'wrong group key' }, request, env, 403);
    }
    if (await overRate(request, env)) {
      return json({ error: 'too many reports, try again in a minute' }, request, env, 429);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'expected JSON' }, request, env, 400);
    }
    const station = String(body.station || '').slice(0, 64);
    // One look at a station can list several grades, and they arrive in one
    // request. Separate requests each rewrote the same list and raced: on 13
    // Sep 2026 a member marked 92, 95 and 98 and only 98 survived.
    const wanted = Array.isArray(body.grades) ? body.grades : [{ grade: body.grade, seen: body.seen }];
    const looks = [];
    for (const item of wanted.slice(0, 12)) {
      const grade = String(item?.grade || '');
      if (!GRADES.has(grade) || typeof item?.seen !== 'boolean' || looks.some((look) => look.grade === grade)) continue;
      looks.push({ grade, seen: item.seen });
    }
    if (!station || !looks.length) {
      return json({ error: 'expected {station, grade, seen} or {station, grades: [{grade, seen}]}' }, request, env, 400);
    }
    const now = Date.now();
    const observed = Number(body.observed_at);
    // A phone's clock may run ahead: a look is never dated after it arrived.
    const at = Number.isFinite(observed) && observed > 0 ? Math.min(now, Math.round(observed)) : now;
    if (now - at > LATE_MARK_MS) {
      return json({ error: 'too_late', minutes: Math.round((now - at) / 60000) }, request, env, 410);
    }
    const who = clubMemberRecord?.id || String(body.who || '').slice(0, 32) || (request.headers.get('CF-Connecting-IP') || 'anon');
    // Coordinates travel with the report: our canonical station id is derived
    // from the snapshot and can change when matching improves, but the
    // forecourt does not move.
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const fresh = looks.map(({ grade, seen }) => ({
      station,
      grade,
      seen,
      at,
      who,
      lat: Number.isFinite(lat) ? Math.round(lat * 1e6) / 1e6 : null,
      lon: Number.isFinite(lon) ? Math.round(lon * 1e6) / 1e6 : null,
      queue: typeof body.queue === 'number' ? Math.max(0, Math.min(500, body.queue)) : null,
    }));
    const { before, accepted, count } = await transact(env, { reports: [] }, (docs) => {
      const cutoff = Date.now() - WINDOW_MS;
      const current = docs.reports.filter((item) => item && item.at > cutoff);
      // A mark that arrives late never replaces what the same person has said
      // about the same grade since.
      const taken = fresh.filter((look) => !current.some((item) => item.station === station && item.who === who && item.grade === look.grade && item.at > look.at));
      // One report per person per station and grade: a later look replaces an
      // earlier one rather than stacking into a fake crowd.
      const kept = current.filter((item) => !(item.station === station && item.who === who && taken.some((look) => look.grade === item.grade)));
      kept.push(...taken);
      docs.reports = kept.slice(-MAX_REPORTS);
      return { before: current, accepted: taken, count: docs.reports.length };
    });
    if (!accepted.length) {
      return json({ ok: true, count, accepted: 0, superseded: true }, request, env);
    }
    if (clubMemberRecord) ctx.waitUntil(recordDisputes(env, before, accepted).catch(() => {}));
    // The name and address are only for the notification text; they are not
    // stored, the app resolves the station from its own data.
    const summary = (accepted.length === fresh.length ? String(body.summary || '').slice(0, 120) : '')
      || (accepted.length > 1 ? accepted.map((look) => `${GRADE_LABELS[look.grade] || look.grade} ${look.seen ? 'есть' : 'нет'}`).join(', ') : '');
    const named = {
      ...accepted[0],
      name: String(body.name || '').slice(0, 60),
      address: String(body.address || '').slice(0, 80),
      summary,
      reporter: clubMemberRecord?.name || '',
    };
    if (body.notify !== false && now - at < LATE_PUSH_MS) ctx.waitUntil(notifyGroup(env, named).catch(() => {}));
    let rewards = null;
    if (clubMemberRecord) {
      try {
        rewards = await rewardMark(env, await readDoc(env, 'club:members', {}), before, accepted, { blindSpot: body.blind_spot === true });
      } catch {
        // A failed payout must never lose the mark itself.
        rewards = null;
      }
    }
    return json({ ok: true, count, accepted: accepted.length, ...(rewards ? { rewards } : {}) }, request, env);
  }

  return json({ error: 'not found' }, request, env, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      // Left alone, an exception becomes Cloudflare's own error page without
      // CORS headers: the phone cannot read it, takes it for a lost connection,
      // and the mark silently stays on the phone. A plain answer lets the app
      // tell the person what happened.
      const reason = failureReason(error);
      // Writes refused while the club moves are expected, not a fault to look into.
      if (!(error instanceof Frozen)) console.error(`spbfi-reports ${request.method} ${new URL(request.url).pathname}: ${reason}: ${error?.stack || error}`);
      return json({ error: reason }, request, env, 503);
    }
  },
};

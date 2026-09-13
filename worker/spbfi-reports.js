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
 * Closed club. When CLUB_OWNER_KEY is set, only members can file marks, read
 * who filed them and receive pushes. Membership is by invitation: the owner
 * signs in with the owner key, every member gets a signed token, invite codes
 * are single-use and remember who vouched for whom, and the owner can ban.
 * Without CLUB_OWNER_KEY the worker behaves exactly as before.
 *
 * Bindings:
 *   REPORTS              KV namespace (required)
 *   CLUB_OWNER_KEY       secret; turns the closed club on and lets the owner in
 *   CLUB_READER_KEY      optional secret; when set, GET /reports needs it too
 *   GROUP_KEY            legacy shared passphrase, used only without the club
 *   ANALYTICS_ADMIN_KEY  optional secret; without it analytics store nothing
 *   ORIGIN               optional allowed origin; defaults to the GitHub Pages site
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

async function readAll(env) {
  const raw = await env.REPORTS.get('reports', { type: 'json' });
  const cutoff = Date.now() - WINDOW_MS;
  return Array.isArray(raw) ? raw.filter((item) => item && item.at > cutoff) : [];
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
  if (!env.ANALYTICS_ADMIN_KEY) return json({ ok: true, accepted: 0, disabled: true }, request, env, 202);
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
  const day = (await env.REPORTS.get(key, { type: 'json' })) || emptyAnalyticsDay(dayName);
  for (const event of events) applyAnalyticsEvent(day, event, userHash, sessionHash);
  day.updated_at = Date.now();
  await env.REPORTS.put(key, JSON.stringify(day), { expirationTtl: ANALYTICS_RETENTION_SECONDS });
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
  if (!env.ANALYTICS_ADMIN_KEY) return json({ error: 'ANALYTICS_ADMIN_KEY is not configured' }, request, env, 503);
  if (!constantEqual(request.headers.get('X-Analytics-Key') || '', String(env.ANALYTICS_ADMIN_KEY))) {
    return json({ error: 'forbidden' }, request, env, 403);
  }
  const days = Math.round(finiteNumber(url.searchParams.get('days') || 7, 1, 30));
  const documents = (await Promise.all([...Array(days)].map((_, index) => env.REPORTS.get(`analytics:v${ANALYTICS_VERSION}:${analyticsDay(index)}`, { type: 'json' })))).filter(Boolean);
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
  if (cars <= 20) return '5–20 машин';
  return 'больше 20 машин';
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
  const stored = await env.REPORTS.get('vapid', { type: 'json' });
  if (stored && stored.privateJwk && stored.publicJwk) return stored;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const created = {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    publicKey: b64u.encode(await crypto.subtle.exportKey('raw', pair.publicKey)),
  };
  await env.REPORTS.put('vapid', JSON.stringify(created));
  return created;
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
  const raw = await env.REPORTS.get('subscriptions', { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function notifyGroup(env, report) {
  const subscriptions = await readSubscriptions(env);
  if (!subscriptions.length) return;
  const members = clubEnabled(env) ? await readDoc(env, 'club:members', {}) : null;
  const here = report.lat != null && report.lon != null ? { lat: report.lat, lon: report.lon } : null;
  const grade = GRADE_LABELS[report.grade] || report.grade;
  const queue = queueWords(report.queue);
  const payload = {
    title: report.reporter ? `👁 ${report.reporter}: ${report.name || 'АЗС'}` : `👁 Свой отметил: ${report.name || 'АЗС'}`,
    body: `${report.summary || `${grade} ${report.seen ? 'есть' : 'нет'}${queue ? `, очередь: ${queue}` : ''}`}${report.address ? ` · ${report.address}` : ''}`,
    station: report.station,
    tag: `spbfi-${report.station}`,
  };
  const dead = new Set();
  await Promise.all(subscriptions.map(async (sub) => {
    if (sub.who && sub.who === report.who) return;
    // In the club a phone that is not a member's, or a banned member's, hears nothing.
    if (members && (!members[sub.who] || members[sub.who].banned)) return;
    if (here && sub.lat != null && sub.lon != null && distanceKm(here, sub) > NOTIFY_RADIUS_KM) return;
    try {
      const status = await sendPush(env, sub, payload);
      if (status === 404 || status === 410) dead.add(sub.endpoint);
    } catch {
      // One phone unreachable must not stop the others.
    }
  }));
  if (dead.size) {
    await env.REPORTS.put('subscriptions', JSON.stringify(subscriptions.filter((sub) => !dead.has(sub.endpoint))));
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
  { id: 'sponsor', icon: '🤝', title: 'Поручитель', hint: 'Приглашённый вами сделал 5 отметок', test: (s) => s.sponsor >= 1 },
  { id: 'hero', icon: '🦸', title: 'Герой недели', hint: 'Больше всех литров за неделю', test: (s) => s.heroes >= 1 },
  { id: 'club_award', icon: '🏅', title: 'Благодарность клуба', hint: 'Её вручает владелец', test: (s) => (s.awards || []).length >= 1 },
];

function emptyStats() {
  return {
    liters: 0, marks: 0, confirmed: 0, thanks: 0, saved: 0, given: 0, scout: 0, first_seen: 0,
    night: 0, queue_confirmed: 0, sponsor: 0, heroes: 0, blind: 0, zones: [], weeks: {}, days: {}, given_days: {},
    badges: {}, awards: [], news: [], thanked: {}, confirms: {},
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
  return 3;
}

function markKey(report) {
  return `${report.station}:${report.grade}:${report.at}`;
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
async function rewardMark(env, members, reports, report, { blindSpot = false } = {}) {
  const all = await readDoc(env, 'club:stats', {});
  const me = statsFor(all, report.who);
  const at = report.at;
  const result = { liters: 0, confirmed: [], badges: [], level_up: null };
  const others = reports.filter((item) => item.who !== report.who && !members[item.who]?.banned);
  // One look at a station is one mark, however many grades it lists and
  // however often it is repeated within the hour.
  const repeat = reports.some((item) => item.who === report.who && item.station === report.station && at - item.at < SAME_STATION_MS);
  if (!repeat) {
    me.marks += 1;
    const today = dayKey(at);
    const earned = me.days[today] || 0;
    if (earned < MARK_LITERS_PER_DAY) {
      me.days = { [today]: earned + LITERS.mark };
      result.level_up = addLiters(me, LITERS.mark, at, 'mark', { station: report.station }) || result.level_up;
      result.liters += LITERS.mark;
    }
    if (!others.some((item) => item.station === report.station)) me.scout += 1;
    // The phone says the app had nothing fresh here. Taken on trust inside the
    // club, and only for a first look, so it cannot be farmed by re-marking.
    if (blindSpot) {
      me.blind += 1;
      result.level_up = addLiters(me, LITERS.blind_spot, at, 'blind_spot', { station: report.station }) || result.level_up;
      result.liters += LITERS.blind_spot;
      result.blind_spot = true;
    }
    const hour = moscowDate(at).getUTCHours();
    if (hour >= 23 || hour < 6) me.night += 1;
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
  const sameGrade = others.filter((item) => item.station === report.station && item.grade === report.grade).sort((a, b) => b.at - a.at);
  if (report.seen && sameGrade[0] && sameGrade[0].seen === false) {
    me.first_seen += 1;
    result.level_up = addLiters(me, LITERS.first_seen, at, 'first_seen', { station: report.station }) || result.level_up;
    result.liters += LITERS.first_seen;
  }
  for (const prior of sameGrade) {
    if (prior.seen !== report.seen || at - prior.at > CONFIRM_WINDOW_MS) continue;
    const author = statsFor(all, prior.who);
    // A confirmer pays each author once per station an hour, not once per grade.
    const pairKey = `${report.who}:${report.station}`;
    for (const [key, when] of Object.entries(author.confirms)) if (at - when > SAME_STATION_MS) delete author.confirms[key];
    if (author.confirms[pairKey]) continue;
    author.confirms[pairKey] = at;
    author.confirmed += 1;
    if (queueBucket(prior.queue) != null && queueBucket(prior.queue) === queueBucket(report.queue)) author.queue_confirmed += 1;
    addLiters(author, LITERS.confirmed, at, 'confirmed', { by: report.who, station: report.station, grade: report.grade });
    awardBadges(author, at);
    result.confirmed.push(members[prior.who]?.name || '');
  }
  result.badges = awardBadges(me, at);
  result.total = me.liters;
  result.level = levelFor(me.liters);
  await env.REPORTS.put('club:stats', JSON.stringify(all));
  return result;
}

async function notifyMember(env, memberId, payload) {
  const subscriptions = (await readSubscriptions(env)).filter((sub) => sub.who === memberId);
  await Promise.all(subscriptions.map((sub) => sendPush(env, sub, payload).catch(() => null)));
}

/** Once a week the member with the most litres last week becomes its hero. */
async function crownLastWeek(env, members, all) {
  const lastWeek = weekKey(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const heroes = await readDoc(env, 'club:heroes', {});
  if (heroes[lastWeek] !== undefined) return heroes[lastWeek];
  const best = Object.entries(all)
    .filter(([id, stats]) => members[id] && !members[id].banned && (stats.weeks?.[lastWeek] || 0) > 0)
    .sort((a, b) => b[1].weeks[lastWeek] - a[1].weeks[lastWeek])[0];
  heroes[lastWeek] = best ? { id: best[0], liters: best[1].weeks[lastWeek] } : null;
  if (best) {
    const stats = statsFor(all, best[0]);
    stats.heroes += 1;
    pushNews(stats, { type: 'hero', week: lastWeek, liters: heroes[lastWeek].liters, at: Date.now() });
    awardBadges(stats, Date.now());
    await env.REPORTS.put('club:stats', JSON.stringify(all));
  }
  await env.REPORTS.put('club:heroes', JSON.stringify(heroes));
  return heroes[lastWeek];
}

// ---------------------------------------------------------------- club

const CLUB_VERSION = 1;
// No 0/O, 1/I/L: the code is read aloud and typed on a phone.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_INVITES = 3;
const FRESH_TOKEN_GRACE_MS = 5 * 60 * 1000;
const DISPUTE_WINDOW_MS = 20 * 60 * 1000;
const MAX_FLAGS = 1000;

function clubEnabled(env) {
  return !!env.CLUB_OWNER_KEY;
}

async function readDoc(env, key, fallback) {
  const raw = await env.REPORTS.get(key, { type: 'json' });
  return raw && typeof raw === 'object' ? raw : fallback;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function clubSecret(env) {
  const stored = await env.REPORTS.get('club:secret');
  if (stored) return stored;
  const created = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
  await env.REPORTS.put('club:secret', created);
  return created;
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
  return Date.now() - parseInt(issued, 36) < FRESH_TOKEN_GRACE_MS ? { id, name: '', role: 'member', pending: true } : null;
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
  const spent = Object.values(invites).filter((invite) => invite.by === member.id && (!invite.revoked || invite.used_by)).length;
  return Math.max(0, MEMBER_INVITES - spent);
}

async function clubRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (request.method === 'GET' && path === '/club/health') {
    return json({ club: clubEnabled(env), version: CLUB_VERSION }, request, env);
  }
  if (!clubEnabled(env)) return json({ error: 'club_disabled' }, request, env, 404);

  if (request.method === 'POST' && path === '/club/owner') {
    if (limited(request, 'club-owner', 5)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    if (!constantEqual(String(body.key || ''), String(env.CLUB_OWNER_KEY))) {
      return json({ error: 'wrong_owner_key' }, request, env, 403);
    }
    const members = await readDoc(env, 'club:members', {});
    const owner = members.owner || { id: 'owner', role: 'owner', joined: Date.now(), sponsor: null };
    owner.name = cleanName(body.name) || owner.name || 'Владелец';
    owner.banned = false;
    members.owner = owner;
    await env.REPORTS.put('club:members', JSON.stringify(members));
    return json({ token: await issueToken(env, 'owner'), member: publicMember(owner) }, request, env);
  }

  if (request.method === 'POST' && path === '/club/join') {
    if (limited(request, 'club-join', 10)) return json({ error: 'too_many_attempts' }, request, env, 429);
    const body = (await readJson(request)) || {};
    const code = normalizeCode(body.code);
    const name = cleanName(body.name);
    if (!code || !name) return json({ error: 'expected_code_and_name' }, request, env, 400);
    if (body.accept !== true) return json({ error: 'rules_not_accepted' }, request, env, 400);
    const invites = await readDoc(env, 'club:invites', {});
    const invite = invites[code];
    if (!invite || invite.revoked) return json({ error: 'invite_unknown' }, request, env, 404);
    if (invite.used_by) return json({ error: 'invite_used' }, request, env, 409);
    if (invite.expires < Date.now()) return json({ error: 'invite_expired' }, request, env, 410);
    const members = await readDoc(env, 'club:members', {});
    const sponsor = members[invite.by];
    if (!sponsor || sponsor.banned) return json({ error: 'sponsor_banned' }, request, env, 403);
    let id;
    do {
      id = b64u.encode(crypto.getRandomValues(new Uint8Array(6)));
    } while (members[id]);
    members[id] = { id, name, role: 'member', sponsor: invite.by, joined: Date.now(), accepted_rules: Date.now() };
    invite.used_by = id;
    invite.used_at = Date.now();
    await env.REPORTS.put('club:members', JSON.stringify(members));
    await env.REPORTS.put('club:invites', JSON.stringify(invites));
    return json({ token: await issueToken(env, id), member: publicMember(members[id]) }, request, env);
  }

  const members = await readDoc(env, 'club:members', {});
  const member = await clubMember(request, env, members);
  if (!member) return json({ error: 'club_required' }, request, env, 401);
  if (member.banned) return json({ error: 'banned', reason: member.banned_reason || '' }, request, env, 403);

  if (request.method === 'GET' && path === '/club/me') {
    const invites = await readDoc(env, 'club:invites', {});
    const mine = Object.entries(invites)
      .filter(([, invite]) => invite.by === member.id && !invite.revoked)
      .map(([code, invite]) => ({
        code, created: invite.created, expires: invite.expires,
        used_by: invite.used_by ? (members[invite.used_by]?.name || '—') : null,
      }))
      .sort((a, b) => b.created - a.created);
    const all = await readDoc(env, 'club:stats', {});
    const stats = statsFor(all, member.id);
    const since = Number(url.searchParams.get('since')) || 0;
    const news = (stats.news || []).filter((item) => item.at > since)
      .map((item) => ({ ...item, by_name: item.by ? (members[item.by]?.name || '') : undefined }));
    return json({
      member: publicMember(member), invites: mine, invites_left: inviteAllowance(member, invites),
      profile: profileOf(stats), news, now: Date.now(),
    }, request, env);
  }

  if (request.method === 'POST' && path === '/club/invite') {
    if (member.pending) return json({ error: 'try_again_in_a_minute' }, request, env, 409);
    const invites = await readDoc(env, 'club:invites', {});
    const allowance = inviteAllowance(member, invites);
    if (allowance === 0) return json({ error: 'no_invites_left' }, request, env, 403);
    // Unused codes that ran out a month ago are only clutter.
    for (const [code, invite] of Object.entries(invites)) {
      if (!invite.used_by && invite.expires < Date.now() - 30 * 24 * 60 * 60 * 1000) delete invites[code];
    }
    let code;
    do {
      code = inviteCode();
    } while (invites[code]);
    invites[code] = { by: member.id, created: Date.now(), expires: Date.now() + INVITE_TTL_MS };
    await env.REPORTS.put('club:invites', JSON.stringify(invites));
    return json({ code, expires: invites[code].expires, invites_left: inviteAllowance(member, invites) }, request, env);
  }

  if (request.method === 'POST' && path === '/club/invite/revoke') {
    const body = (await readJson(request)) || {};
    const invites = await readDoc(env, 'club:invites', {});
    const invite = invites[normalizeCode(body.code)];
    if (!invite || (invite.by !== member.id && member.role !== 'owner')) return json({ error: 'invite_unknown' }, request, env, 404);
    if (invite.used_by) return json({ error: 'invite_used' }, request, env, 409);
    invite.revoked = true;
    await env.REPORTS.put('club:invites', JSON.stringify(invites));
    return json({ ok: true }, request, env);
  }

  if (request.method === 'POST' && path === '/club/thanks') {
    const body = (await readJson(request)) || {};
    const authorId = String(body.author || '');
    if (authorId === member.id) return json({ error: 'cannot_thank_self' }, request, env, 400);
    const target = (await readAll(env)).find((report) => report.who === authorId && report.station === String(body.station || '')
      && report.grade === String(body.grade || '') && report.at === Number(body.at));
    if (!target || !members[authorId] || members[authorId].banned) return json({ error: 'mark_gone' }, request, env, 404);
    const all = await readDoc(env, 'club:stats', {});
    const giver = statsFor(all, member.id);
    const today = dayKey(Date.now());
    if ((giver.given_days[today] || 0) >= THANKS_PER_DAY) return json({ error: 'too_many_thanks' }, request, env, 429);
    const author = statsFor(all, authorId);
    const key = markKey(target);
    const thankedBy = author.thanked[key] || [];
    if (thankedBy.includes(member.id)) return json({ error: 'already_thanked', thanks: thankedBy.length }, request, env, 409);
    for (const old of Object.keys(author.thanked)) {
      if (Date.now() - Number(old.split(':').pop()) > 3 * 24 * 60 * 60 * 1000) delete author.thanked[old];
    }
    author.thanked[key] = [...thankedBy, member.id];
    author.thanks += 1;
    if (!target.seen) author.saved += 1;
    const now = Date.now();
    const levelUp = addLiters(author, LITERS.thanks, now, 'thanks', { by: member.id, station: target.station, grade: target.grade, seen: target.seen });
    awardBadges(author, now);
    giver.given += 1;
    giver.given_days = { [today]: (giver.given_days[today] || 0) + 1 };
    const giverBadges = awardBadges(giver, now);
    await env.REPORTS.put('club:stats', JSON.stringify(all));
    const grade = GRADE_LABELS[target.grade] || target.grade;
    ctx.waitUntil(notifyMember(env, authorId, {
      title: `🙏 ${member.name || 'Свой'} говорит спасибо`,
      body: `За отметку «${grade} ${target.seen ? 'есть' : 'нет'}» · +${LITERS.thanks} л${levelUp ? ` · новый уровень: ${levelUp.icon} ${levelUp.title}` : ''}`,
      station: target.station,
      tag: `spbfi-thanks-${target.station}`,
    }).catch(() => {}));
    return json({ ok: true, thanks: author.thanked[key].length, author_name: members[authorId].name, badges: giverBadges }, request, env);
  }

  if (request.method === 'GET' && path === '/club/leaderboard') {
    const all = await readDoc(env, 'club:stats', {});
    const hero = await crownLastWeek(env, members, all);
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
    const clubStats = await readDoc(env, 'club:stats', {});
    const reports = (await readAll(env))
      .filter((report) => !members[report.who]?.banned)
      .map((report) => {
        const author = (clubStats[report.who] || {});
        const thankedBy = author.thanked?.[markKey(report)] || [];
        return {
          ...report,
          name: members[report.who]?.name || '',
          level_icon: levelFor(author.liters || 0).icon,
          thanks: thankedBy.length,
          thanked: thankedBy.includes(member.id),
        };
      });
    return json({ window_hours: WINDOW_MS / 3600000, count: reports.length, reports }, request, env);
  }

  if (member.role !== 'owner') return json({ error: 'owner_only' }, request, env, 403);

  if (request.method === 'POST' && path === '/club/award') {
    const body = (await readJson(request)) || {};
    const target = members[String(body.id || '')];
    const text = String(body.text || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!target || target.banned) return json({ error: 'member_unknown' }, request, env, 404);
    if (!text) return json({ error: 'expected_text' }, request, env, 400);
    const all = await readDoc(env, 'club:stats', {});
    const stats = statsFor(all, target.id);
    const now = Date.now();
    stats.awards = [...(stats.awards || []), { text, at: now }].slice(-20);
    const levelUp = addLiters(stats, LITERS.award, now, 'award', { text });
    awardBadges(stats, now);
    await env.REPORTS.put('club:stats', JSON.stringify(all));
    ctx.waitUntil(notifyMember(env, target.id, {
      title: '🏅 Благодарность клуба',
      body: `${text} · +${LITERS.award} л${levelUp ? ` · новый уровень: ${levelUp.icon} ${levelUp.title}` : ''}`,
      tag: 'spbfi-award',
    }).catch(() => {}));
    return json({ ok: true, liters: stats.liters }, request, env);
  }

  if (request.method === 'GET' && path === '/club/members') {
    const ownerStats = await readDoc(env, 'club:stats', {});
    const reports = await readAll(env);
    const flags = await readDoc(env, 'club:flags', []);
    const invites = await readDoc(env, 'club:invites', {});
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
        invited: Object.values(invites).filter((invite) => invite.by === item.id && invite.used_by).length,
      };
    }).sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : (b.joined || 0) - (a.joined || 0)));
    const active = Object.entries(invites)
      .filter(([, invite]) => !invite.used_by && !invite.revoked && invite.expires > Date.now())
      .map(([code, invite]) => ({ code, by: members[invite.by]?.name || '—', expires: invite.expires }));
    return json({ members: rows, invites: active }, request, env);
  }

  if (request.method === 'POST' && path === '/club/ban') {
    const body = (await readJson(request)) || {};
    const target = members[String(body.id || '')];
    if (!target || target.role === 'owner') return json({ error: 'member_unknown' }, request, env, 404);
    target.banned = body.banned !== false;
    target.banned_reason = target.banned ? String(body.reason || '').slice(0, 120) : '';
    target.banned_at = target.banned ? Date.now() : null;
    await env.REPORTS.put('club:members', JSON.stringify(members));
    if (target.banned) {
      // What a banned member said stops counting at once, not in three hours.
      const reports = await readAll(env);
      const kept = reports.filter((report) => report.who !== target.id);
      if (kept.length !== reports.length) await env.REPORTS.put('reports', JSON.stringify(kept));
      const subscriptions = await readSubscriptions(env);
      const subs = subscriptions.filter((sub) => sub.who !== target.id);
      if (subs.length !== subscriptions.length) await env.REPORTS.put('subscriptions', JSON.stringify(subs));
    }
    return json({ ok: true, member: publicMember(target) }, request, env);
  }

  return json({ error: 'not found' }, request, env, 404);
}

/**
 * Two members saying opposite things about the same pump within twenty minutes
 * is recorded for the owner. It is not proof of a lie — fuel does run out — so
 * nothing is decided automatically; a member contradicted by several different
 * people is what the owner looks at. Written only when it happens.
 */
async function recordDisputes(env, reports, report) {
  const opposed = reports.filter((item) => item.station === report.station && item.grade === report.grade
    && item.who !== report.who && item.seen !== report.seen && item.at >= report.at - DISPUTE_WINDOW_MS);
  if (!opposed.length) return;
  const flags = await readDoc(env, 'club:flags', []);
  const list = Array.isArray(flags) ? flags : [];
  for (const item of opposed) {
    list.push({ target: item.who, by: report.who, station: report.station, grade: report.grade, at: report.at });
  }
  await env.REPORTS.put('club:flags', JSON.stringify(list.slice(-MAX_FLAGS)));
}

// ---------------------------------------------------------------- routes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request, env) });
    }

    if (!env.REPORTS) {
      return json({ error: 'KV namespace REPORTS is not bound' }, request, env, 500);
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
        if (env.CLUB_READER_KEY && !constantEqual(request.headers.get('X-Reader-Key') || '', String(env.CLUB_READER_KEY))) {
          const member = await clubMember(request, env, members);
          if (!member || member.banned) return json({ error: 'club_required' }, request, env, 401);
        }
        // Names stay inside the club; the public read carries member ids only.
        reports = reports.filter((report) => !members[report.who]?.banned);
      }
      return json({ window_hours: WINDOW_MS / 3600000, count: reports.length, reports }, request, env);
    }

    if (request.method === 'GET' && url.pathname === '/vapid') {
      const keys = await vapidKeys(env);
      return json({ publicKey: keys.publicKey }, request, env);
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      let clubWho = null;
      if (clubEnabled(env)) {
        const member = await clubMember(request, env);
        if (!member) return json({ error: 'club_required' }, request, env, 401);
        if (member.banned) return json({ error: 'banned', reason: member.banned_reason || '' }, request, env, 403);
        clubWho = member.id;
      } else if (env.GROUP_KEY && request.headers.get('X-Group-Key') !== env.GROUP_KEY) {
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
      const kept = (await readSubscriptions(env)).filter((item) => item.endpoint !== sub.endpoint);
      kept.push({
        endpoint: sub.endpoint,
        keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
        who: clubWho || String(body.who || '').slice(0, 32),
        lat: Number.isFinite(lat) ? Math.round(lat * 1e4) / 1e4 : null,
        lon: Number.isFinite(lon) ? Math.round(lon * 1e4) / 1e4 : null,
        at: Date.now(),
      });
      await env.REPORTS.put('subscriptions', JSON.stringify(kept.slice(-MAX_SUBSCRIPTIONS)));
      return json({ ok: true, count: kept.length }, request, env);
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'expected JSON' }, request, env, 400);
      }
      const kept = (await readSubscriptions(env)).filter((item) => item.endpoint !== body.endpoint);
      await env.REPORTS.put('subscriptions', JSON.stringify(kept));
      return json({ ok: true, count: kept.length }, request, env);
    }

    if (request.method === 'POST' && url.pathname === '/report') {
      let clubMemberRecord = null;
      if (clubEnabled(env)) {
        clubMemberRecord = await clubMember(request, env);
        if (!clubMemberRecord) return json({ error: 'club_required' }, request, env, 401);
        if (clubMemberRecord.banned) return json({ error: 'banned', reason: clubMemberRecord.banned_reason || '' }, request, env, 403);
      } else if (env.GROUP_KEY && request.headers.get('X-Group-Key') !== env.GROUP_KEY) {
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
      const grade = String(body.grade || '');
      if (!station || !GRADES.has(grade) || typeof body.seen !== 'boolean') {
        return json({ error: 'expected {station, grade, seen}' }, request, env, 400);
      }
      const reports = await readAll(env);
      // One report per person per station and grade: a later look replaces an
      // earlier one rather than stacking into a fake crowd.
      const who = clubMemberRecord?.id || String(body.who || '').slice(0, 32) || (request.headers.get('CF-Connecting-IP') || 'anon');
      const kept = reports.filter((item) => !(item.station === station && item.grade === grade && item.who === who));
      // Coordinates travel with the report: our canonical station id is derived
      // from the snapshot and can change when matching improves, but the
      // forecourt does not move.
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      const report = {
        station,
        grade,
        seen: body.seen,
        at: Date.now(),
        who,
        lat: Number.isFinite(lat) ? Math.round(lat * 1e6) / 1e6 : null,
        lon: Number.isFinite(lon) ? Math.round(lon * 1e6) / 1e6 : null,
        queue: typeof body.queue === 'number' ? Math.max(0, Math.min(500, body.queue)) : null,
      };
      kept.push(report);
      const trimmed = kept.slice(-MAX_REPORTS);
      await env.REPORTS.put('reports', JSON.stringify(trimmed));
      if (clubMemberRecord) ctx.waitUntil(recordDisputes(env, reports, report).catch(() => {}));
      // The name and address are only for the notification text; they are not
      // stored, the app resolves the station from its own data.
      const named = {
        ...report,
        name: String(body.name || '').slice(0, 60),
        address: String(body.address || '').slice(0, 80),
        // A batch of grades from the composer arrives as several reports;
        // the first carries the whole summary and the rest stay silent.
        summary: String(body.summary || '').slice(0, 120),
        reporter: clubMemberRecord?.name || '',
      };
      if (body.notify !== false) ctx.waitUntil(notifyGroup(env, named));
      let rewards = null;
      if (clubMemberRecord) {
        try {
          rewards = await rewardMark(env, await readDoc(env, 'club:members', {}), reports, report, { blindSpot: body.blind_spot === true });
        } catch {
          // A failed payout must never lose the mark itself.
          rewards = null;
        }
      }
      return json({ ok: true, count: trimmed.length, ...(rewards ? { rewards } : {}) }, request, env);
    }

    return json({ error: 'not found' }, request, env, 404);
  },
};

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
 * Bindings:
 *   REPORTS    KV namespace (required)
 *   GROUP_KEY  optional shared passphrase; when set, writing requires it
 *   ORIGIN     optional allowed origin; defaults to the GitHub Pages site
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Group-Key, X-Analytics-Key',
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

/** A crude per-address limit; enough to stop a loop, not a security boundary. */
async function overRate(request, env, scope = 'reports') {
  const who = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = `rate:${scope}:${who}:${Math.floor(Date.now() / 60000)}`;
  const used = Number((await env.REPORTS.get(bucket)) || 0);
  if (used >= MAX_PER_MINUTE) return true;
  await env.REPORTS.put(bucket, String(used + 1), { expirationTtl: 120 });
  return false;
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
  const here = report.lat != null && report.lon != null ? { lat: report.lat, lon: report.lon } : null;
  const grade = GRADE_LABELS[report.grade] || report.grade;
  const queue = queueWords(report.queue);
  const payload = {
    title: `👁 Свой отметил: ${report.name || 'АЗС'}`,
    body: `${report.summary || `${grade} ${report.seen ? 'есть' : 'нет'}${queue ? `, очередь: ${queue}` : ''}`}${report.address ? ` · ${report.address}` : ''}`,
    station: report.station,
    tag: `spbfi-${report.station}`,
  };
  const dead = new Set();
  await Promise.all(subscriptions.map(async (sub) => {
    if (sub.who && sub.who === report.who) return;
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
      const reports = await readAll(env);
      return json({ window_hours: WINDOW_MS / 3600000, count: reports.length, reports }, request, env);
    }

    if (request.method === 'GET' && url.pathname === '/vapid') {
      const keys = await vapidKeys(env);
      return json({ publicKey: keys.publicKey }, request, env);
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      if (env.GROUP_KEY && request.headers.get('X-Group-Key') !== env.GROUP_KEY) {
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
        who: String(body.who || '').slice(0, 32),
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
      if (env.GROUP_KEY && request.headers.get('X-Group-Key') !== env.GROUP_KEY) {
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
      const who = String(body.who || '').slice(0, 32) || (request.headers.get('CF-Connecting-IP') || 'anon');
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
      // The name and address are only for the notification text; they are not
      // stored, the app resolves the station from its own data.
      const named = {
        ...report,
        name: String(body.name || '').slice(0, 60),
        address: String(body.address || '').slice(0, 80),
        // A batch of grades from the composer arrives as several reports;
        // the first carries the whole summary and the rest stay silent.
        summary: String(body.summary || '').slice(0, 120),
      };
      if (body.notify !== false) ctx.waitUntil(notifyGroup(env, named));
      return json({ ok: true, count: trimmed.length }, request, env);
    }

    return json({ error: 'not found' }, request, env, 404);
  },
};

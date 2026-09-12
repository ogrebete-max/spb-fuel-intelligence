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

function cors(request, env) {
  const allowed = env.ORIGIN || DEFAULT_ORIGIN;
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Group-Key',
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
async function overRate(request, env) {
  const who = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = `rate:${who}:${Math.floor(Date.now() / 60000)}`;
  const used = Number((await env.REPORTS.get(bucket)) || 0);
  if (used >= MAX_PER_MINUTE) return true;
  await env.REPORTS.put(bucket, String(used + 1), { expirationTtl: 120 });
  return false;
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

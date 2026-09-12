/**
 * Shared eyewitness reports for SPB Fuel Intelligence.
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
 * Bindings:
 *   REPORTS    KV namespace (required)
 *   GROUP_KEY  optional shared passphrase; when set, writing requires it
 *   ORIGIN     optional allowed origin; defaults to the GitHub Pages site
 */

const DEFAULT_ORIGIN = 'https://ogrebete-max.github.io';
const WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_REPORTS = 4000;
const MAX_PER_MINUTE = 20;
const GRADES = new Set(['AI92', 'AI95', 'AI98', 'AI100', 'DT', 'LPG']);

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

export default {
  async fetch(request, env) {
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
      kept.push({
        station,
        grade,
        seen: body.seen,
        at: Date.now(),
        who,
        lat: Number.isFinite(lat) ? Math.round(lat * 1e6) / 1e6 : null,
        lon: Number.isFinite(lon) ? Math.round(lon * 1e6) / 1e6 : null,
        queue: typeof body.queue === 'number' ? Math.max(0, Math.min(500, body.queue)) : null,
      });
      const trimmed = kept.slice(-MAX_REPORTS);
      await env.REPORTS.put('reports', JSON.stringify(trimmed));
      return json({ ok: true, count: trimmed.length }, request, env);
    }

    return json({ error: 'not found' }, request, env, 404);
  },
};

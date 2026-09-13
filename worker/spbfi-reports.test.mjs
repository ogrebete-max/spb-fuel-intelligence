import assert from 'node:assert/strict';
import worker from './spbfi-reports.js';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
}

const kv = new MemoryKV();
const env = { REPORTS: kv, ANALYTICS_SALT: 'test-only-secret', ANALYTICS_ADMIN_KEY: 'correct-horse-battery-staple' };
const base = 'https://spbfi-reports.example';
const origin = 'https://ogrebete-max.github.io';
const clientId = 'raw-client-id-must-not-be-stored';

const posted = await worker.fetch(new Request(`${base}/analytics/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '192.0.2.1' },
  body: JSON.stringify({
    install_id: clientId,
    session_id: 'session-one',
    events: [
      { event: 'app_open', at: Date.now(), fields: { area: 'spb', zone: 'spb_north', grade: 'AI95' } },
      { event: 'report_outcome', at: Date.now(), fields: { station: 'station-1', grade: 'AI95', status: 'LIKELY_AVAILABLE', probability: 80, trust: 70, age_bucket: '15_45m', sources: ['source-a'], seen: true, reason: 'on_site' } },
      { event: 'unknown_event', at: Date.now(), fields: { query: 'secret address' } },
    ],
  }),
}), env, { waitUntil() {} });
assert.equal(posted.status, 202);
assert.equal((await posted.json()).accepted, 2);
assert(![...kv.values.values()].some((value) => value.includes(clientId)), 'raw client id leaked into KV');
assert(![...kv.values.values()].some((value) => value.includes('secret address')), 'unapproved field leaked into KV');

const forbidden = await worker.fetch(new Request(`${base}/analytics/dashboard?days=7`, {
  headers: { Origin: origin, 'X-Analytics-Key': 'wrong' },
}), env, { waitUntil() {} });
assert.equal(forbidden.status, 403);

const response = await worker.fetch(new Request(`${base}/analytics/dashboard?days=7`, {
  headers: { Origin: origin, 'X-Analytics-Key': env.ANALYTICS_ADMIN_KEY },
}), env, { waitUntil() {} });
assert.equal(response.status, 200);
const dashboard = await response.json();
assert.equal(dashboard.totals.daily_active_sum, 1);
assert.equal(dashboard.totals.on_site_checks, 1);
assert.equal(dashboard.totals.accuracy_percent, 100);
assert.equal(dashboard.totals.brier_score, 0.04);
assert.equal(dashboard.calibration.by_source[0].key, 'source-a');
assert.deepEqual(dashboard.zones, [], 'rare zones must be suppressed');

console.log('worker analytics integration: OK');

(function () {
  'use strict';

  const INSTALL_KEY = 'spbfi-analytics-install-v1';
  const DISABLED_KEY = 'spbfi-analytics-disabled-v1';
  const MAX_QUEUE = 24;
  const FLUSH_MS = 4000;
  const sessionId = makeId();
  const queue = [];
  let timer = null;

  function makeId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function installId() {
    try {
      let id = localStorage.getItem(INSTALL_KEY);
      if (!id) {
        id = makeId();
        localStorage.setItem(INSTALL_KEY, id);
      }
      return id;
    } catch {
      return sessionId;
    }
  }

  function enabled() {
    if (!window.SPBFI_ANALYTICS_ENDPOINT) return false;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return false;
    try { return localStorage.getItem(DISABLED_KEY) !== '1'; } catch { return true; }
  }

  // Deliberately broad zones: exact coordinates and typed addresses never
  // become analytics fields. This is enough to reveal coverage deserts.
  function zoneFor(location) {
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'unknown';
    if (lat < 59.68 || lat > 60.20 || lon < 29.65 || lon > 30.85) return 'lo_other';
    if (lat >= 60.02) return 'spb_north';
    if (lat <= 59.86) return 'spb_south';
    if (lon <= 30.17) return 'spb_west';
    if (lon >= 30.48) return 'spb_east';
    return 'spb_centre';
  }

  function ageBucket(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return 'unknown';
    if (value < 15 * 60) return '0_15m';
    if (value < 45 * 60) return '15_45m';
    if (value < 2 * 3600) return '45m_2h';
    if (value < 6 * 3600) return '2_6h';
    return '6h_plus';
  }

  function predictionFields(station, grade) {
    const value = station?.grades?.[grade] || station?.grade || {};
    const sources = [...new Set((value.evidence || [])
      .filter((row) => row?.fresh && row?.source)
      .map((row) => String(row.source).slice(0, 32)))].slice(0, 8);
    return {
      station: station?.id,
      grade,
      status: value.status,
      probability: value.probability_percent,
      trust: value.trust_score,
      age_bucket: ageBucket(value.age_seconds),
      source_count: value.fresh_provenance_count ?? value.fresh_source_count ?? sources.length,
      sources,
      zone: zoneFor(station?.location),
    };
  }

  function clean(fields) {
    const allowed = new Set([
      'area', 'zone', 'grade', 'station', 'status', 'probability', 'trust',
      'age_bucket', 'source_count', 'sources', 'result_count', 'fresh_count',
      'radius_km', 'success', 'seen', 'queue', 'view', 'filter', 'reason',
      'collector_ok', 'collector_failed', 'snapshot_age_bucket', 'installed',
    ]);
    const out = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (!allowed.has(key) || value == null) continue;
      if (Array.isArray(value)) out[key] = value.map(String).slice(0, 8).map((item) => item.slice(0, 32));
      else if (typeof value === 'string') out[key] = value.slice(0, 64);
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  }

  function track(event, fields = {}) {
    if (!enabled() || !/^[a-z][a-z0-9_]{1,31}$/.test(event)) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ event, at: Date.now(), fields: clean(fields) });
    clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_MS);
  }

  async function flush({ beacon = false } = {}) {
    clearTimeout(timer);
    timer = null;
    if (!enabled() || !queue.length) return;
    const endpoint = `${String(window.SPBFI_ANALYTICS_ENDPOINT).replace(/\/$/, '')}/analytics/events`;
    const events = queue.splice(0, MAX_QUEUE);
    const body = JSON.stringify({ install_id: installId(), session_id: sessionId, events });
    if (beacon && navigator.sendBeacon) {
      // text/plain is CORS-safelisted, so the browser can send it while the
      // page is closing without waiting for an OPTIONS preflight.
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      return;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'omit',
      });
      if (!response.ok && response.status >= 500) queue.unshift(...events);
    } catch {
      queue.unshift(...events.slice(-MAX_QUEUE));
    }
  }

  function setEnabled(value) {
    try { localStorage.setItem(DISABLED_KEY, value ? '0' : '1'); } catch { /* private mode */ }
    if (value) track('analytics_enabled');
    else queue.length = 0;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush({ beacon: true });
  });
  window.addEventListener('pagehide', () => flush({ beacon: true }));
  window.addEventListener('error', () => track('app_error', { reason: 'javascript' }));

  window.SPBFIAnalytics = { track, flush, enabled, setEnabled, zoneFor, ageBucket, predictionFields };
})();

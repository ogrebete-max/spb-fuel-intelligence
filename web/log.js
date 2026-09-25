(function () {
  'use strict';

  /* The work log (журнал работы), 25 Sep 2026. The owner: «логи везде… кто что
     нажимает, кто чем пользуется, кто чем не пользуется, у кого что получается —
     включай всё». The same log as the Ladoga map's (ladoga-fishing-map,
     site/log.js), sent to the same receiver on the club's server: batches to
     /applog/fuel/log, «Сообщить о проблеме» to /applog/fuel/report. The owner
     reads it on the page «Кто чем пользуется».

     What is recorded: the launch; what was pressed — the button's own name,
     never the text of a field; errors; how the phone finds its place (every
     30 s, every 5 s in the navigator, at once when something looks wrong), the
     place rounded to about a kilometre; the navigator's moments; marks that went
     out or did not. No IP address, no phone number; a name only if the person
     typed one into «Как вас зовут».

     The phone keeps the last LOG_MAX events and sends them in small batches. The
     sending follows the app's privacy rules (analytics.js): nothing goes out
     under Do Not Track or Global Privacy Control, with the statistics switched
     off, or with «Отправлять журнал работы» off. The phone still keeps its own
     copy, and it leaves only inside a problem report the person sends.

     The app is on GitHub Pages and the receiver on the club's server, another
     origin. A receiver that answers with CORS lets the app read its answers; one
     that does not still gets every batch, sent «blind» (no-cors), counted as
     delivered once the server answered at all.

     The file loads on its own (async), so a copy hanging on a weak network
     holds nothing up. app.js calls window.SPBFILog when it is there and works
     the same without it; what it does before this file is in waits in
     window.SPBFI_LOG_EARLY with its own time and is taken in below. */
  const LOG_MAX = 1500;
  const BATCH = 300;
  // The receiver keeps the first 600 events of a request.
  const REPORT_EVENTS = 600;
  const REPORT_MINUTES = 40;
  const APP = 'fuel';
  const LOG_KEY = 'spbfi-log-v1';
  const IID_KEY = 'spbfi-log-install-v1';
  const OFF_KEY = 'spbfi-log-off-v1';
  const WHO_KEY = 'spbfi-log-who-v1';
  // analytics.js keeps its switch here: «Отключить статистику» stops this log too.
  const STATS_OFF_KEY = 'spbfi-analytics-disabled-v1';
  // A stored log never grows past this many characters: the phone's storage is
  // shared with marks waiting for a signal, and those matter more.
  const STORE_CHARS = 400000;
  const ERRORS_MAX = 50;

  const S = {
    buf: [], unsent: 0, saveT: 0, sendT: 0, sending: false, failN: 0,
    route: null, routeAt: 0, probing: null,
    iid: '', sid: randomId(5), every: new Map(), errors: 0,
    lastFix: null, fixN: 0, fixLogT: 0, fixKinds: [], odds: 0, worst: 0, gapMax: 0, same: 0, shownAt: Date.now(),
    // The switch as set in this visit, for a browser that keeps no storage.
    off: null,
  };

  function randomId(bytes) {
    try {
      return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  function stored(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  try {
    S.iid = stored(IID_KEY) || '';
    if (!/^[a-z0-9]{4,40}$/.test(S.iid)) {
      S.iid = randomId(8);
      localStorage.setItem(IID_KEY, S.iid);
    }
    const saved = JSON.parse(stored(LOG_KEY) || 'null');
    if (saved && Array.isArray(saved.buf)) {
      S.buf = saved.buf.slice(-LOG_MAX);
      S.unsent = Math.min(Number(saved.unsent) || 0, S.buf.length);
    }
  } catch {
    // Private mode: the log lives in memory for this visit.
  }
  if (!S.iid) S.iid = randomId(8);

  const base = () => String(window.SPBFI_LOG_ENDPOINT || '').replace(/\/$/, '');
  const clip = (value, size) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, size);
  const round1 = (x) => Math.round(x * 10) / 10;
  const round2 = (x) => Math.round(x * 100) / 100;

  // Why nothing goes out, or '' when the log is sent.
  function blocked() {
    if (!base()) return 'none';
    // The automated browser checks, and anything else driven by a program.
    if (navigator.webdriver) return 'robot';
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return 'dnt';
    if (stored(STATS_OFF_KEY) === '1') return 'stats';
    if (isOff()) return 'off';
    return '';
  }

  // «Отправлять журнал работы» switched off.
  function isOff() {
    return S.off ?? stored(OFF_KEY) === '1';
  }

  function setOff(off) {
    S.off = !!off;
    try {
      if (off) localStorage.setItem(OFF_KEY, '1');
      else localStorage.removeItem(OFF_KEY);
    } catch { /* private mode: the switch lasts this visit */ }
    event(off ? 'log_off' : 'log_on');
  }

  // «Как вас зовут»: only what the person typed, and only to tell phones apart.
  function who() {
    return clip(stored(WHO_KEY), 40);
  }

  function setWho(name) {
    const clean = clip(name, 40);
    try {
      if (clean) localStorage.setItem(WHO_KEY, clean);
      else localStorage.removeItem(WHO_KEY);
    } catch { /* private mode */ }
    return clean;
  }

  /* One event: a name and a few small fields. `every` keeps a repeating event
     (a GPS timeout each twenty seconds indoors) to one line per period, with
     the repeats counted in `rep`. `t` is the moment of an event that waited
     for this file (app.js, SPBFI_LOG_EARLY). Says whether a line was written. */
  function event(e, fields = null, { every = 0, key = '', t: at = 0 } = {}) {
    const t = at || Date.now();
    let extra = fields;
    if (every) {
      const name = key || e;
      const last = S.every.get(name);
      if (last && t - last.t < every) {
        last.n += 1;
        return false;
      }
      S.every.set(name, { t, n: 0 });
      if (last?.n) extra = { ...fields, rep: last.n };
    }
    const ev = { t, e };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string') ev[k] = v.slice(0, 300);
        else if (typeof v === 'number') { if (Number.isFinite(v)) ev[k] = v; }
        else if (typeof v === 'boolean') ev[k] = v;
      }
    }
    S.buf.push(ev);
    // What happens while the sending is off stays on the phone for good.
    S.unsent = blocked() ? 0 : S.unsent + 1;
    if (S.buf.length > LOG_MAX) {
      S.buf.splice(0, S.buf.length - LOG_MAX);
      S.unsent = Math.min(S.unsent, S.buf.length);
    }
    saveSoon();
    if (S.unsent) sendSoon();
    return true;
  }

  function saveSoon() {
    if (!S.saveT) S.saveT = setTimeout(save, 4000);
  }

  function save() {
    clearTimeout(S.saveT);
    S.saveT = 0;
    let keep = S.buf;
    let text = JSON.stringify({ buf: keep, unsent: S.unsent });
    while (text.length > STORE_CHARS && keep.length > 50) {
      keep = keep.slice(Math.floor(keep.length / 2));
      text = JSON.stringify({ buf: keep, unsent: Math.min(S.unsent, keep.length) });
    }
    try {
      localStorage.setItem(LOG_KEY, text);
    } catch {
      // Storage full: the newest events only, and the rest lives in memory.
      try { localStorage.setItem(LOG_KEY, JSON.stringify({ buf: keep.slice(-100), unsent: Math.min(S.unsent, 100) })); } catch { /* full */ }
    }
  }

  function sendSoon(ms = 20000) {
    if (S.sendT || S.route === 'off') return;
    S.sendT = setTimeout(() => {
      S.sendT = 0;
      send();
    }, ms);
  }

  function retryLater() {
    S.failN += 1;
    sendSoon(Math.min(600000, 30000 * 2 ** S.failN));
  }

  function payload(events) {
    return {
      v: 1, iid: S.iid, sid: S.sid, app: String(window.SPBFI_BUILD || 'dev').slice(0, 12), who: who(),
      ua: navigator.userAgent.slice(0, 200), sent: Date.now(), events,
    };
  }

  /* Whether the receiver lets this page read its answers: 'cors', 'blind'
     (it takes the batches, but its answer stays unread) or 'off' (no receiver
     at this address). Asked once a launch, and again every ten minutes while
     blind, so a receiver that learns CORS is noticed without a restart. */
  function probe() {
    if (S.route && (S.route !== 'blind' || Date.now() - S.routeAt < 600000)) return Promise.resolve(S.route);
    if (!S.probing) {
      S.probing = fetch(`${base()}/applog/health`, { cache: 'no-store', credentials: 'omit' })
        .then((response) => (response.status === 404 || response.status === 405 ? 'off' : 'cors'))
        .catch(() => 'blind')
        .then((route) => {
          S.route = route;
          S.routeAt = Date.now();
          S.probing = null;
          return route;
        });
    }
    return S.probing;
  }

  async function post(kind, body, route) {
    return fetch(`${base()}/applog/${APP}/${kind}`, {
      method: 'POST',
      body,
      // text/plain is CORS-safelisted: no OPTIONS preflight, even blind.
      headers: { 'Content-Type': 'text/plain' },
      mode: route === 'cors' ? 'cors' : 'no-cors',
      credentials: 'omit',
      keepalive: body.length < 60000,
    });
  }

  // The oldest unsent events in batches; a beacon when the page is going away.
  async function send({ beacon = false } = {}) {
    if (S.sending || !S.unsent || S.route === 'off' || blocked() || navigator.onLine === false) return;
    const events = S.buf.slice(-S.unsent).slice(0, BATCH);
    const body = JSON.stringify(payload(events));
    if (beacon) {
      // A beacon's answer is never read, so CORS does not matter to it.
      if (navigator.sendBeacon && body.length < 60000
        && navigator.sendBeacon(`${base()}/applog/${APP}/log`, new Blob([body], { type: 'text/plain' }))) {
        S.unsent = Math.max(0, S.unsent - events.length);
      }
      save();
      return;
    }
    S.sending = true;
    try {
      const route = await probe();
      if (route === 'off') return;
      const response = await post('log', body, route);
      // A batch the receiver refuses as such (400, 413) is dropped, not sent forever.
      if (route === 'blind' || response.ok || response.status === 400 || response.status === 413) {
        S.unsent = Math.max(0, S.unsent - events.length);
        S.failN = 0;
        save();
        if (S.unsent) sendSoon(2000);
      } else if (response.status === 404 || response.status === 405) {
        S.route = 'off';
      } else {
        retryLater();
      }
    } catch {
      retryLater();
    } finally {
      S.sending = false;
    }
  }

  /* «Сообщить о проблеме»: the person's words, what the screen is, and the last
     forty minutes of the log unless they unticked it. Sent even with the log's
     sending off: the person sends it. Without a server or a network the phone's
     own «Поделиться» takes it (Telegram, mail), or it is saved as a file.
     Resolves to 'server', 'share', 'file' or ''. */
  async function report(text, { withLog = true } = {}) {
    const since = Date.now() - REPORT_MINUTES * 60000;
    const events = withLog ? S.buf.filter((ev) => ev.t >= since).slice(-REPORT_EVENTS) : [];
    const standalone = !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone);
    const body = {
      ...payload(events), kind: 'report', text: String(text || '').slice(0, 2000),
      screen: `${innerWidth}×${innerHeight}@${devicePixelRatio}`, standalone,
    };
    let via = '';
    if (base() && navigator.onLine !== false) {
      try {
        const route = await probe();
        if (route !== 'off') {
          const response = await post('report', JSON.stringify(body), route);
          if (route === 'blind' || response.ok) via = 'server';
        }
      } catch { /* no network */ }
    }
    if (!via) via = await handOver(body);
    event('report_sent', { len: body.text.length, log: withLog, via: via || 'nothing' });
    save();
    return via;
  }

  async function handOver(body) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    let file;
    try {
      // Plain text: Chrome's share sheet takes no JSON file.
      file = new File([JSON.stringify(body, null, 1)], `spbfi-problem-${stamp}.txt`, { type: 'text/plain' });
    } catch {
      return '';
    }
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'СПб Топливо: сообщение о проблеме', text: body.text });
        return 'share';
      }
    } catch (error) {
      if (error?.name === 'AbortError') return '';
    }
    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      return 'file';
    } catch {
      return '';
    }
  }

  function metres(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  /* A fix the app received (app.js, applyFix). Written every 30 s, every 5 s
     while the navigator is open (`busy`), and at once — though not twice in two
     seconds — when a kind of trouble the fix before did not have shows: a gap
     between fixes the page was on screen for (`gap`), a radius over 50 m
     (`acc`), the phone's speed far from the way it made (`speed`). `odds`,
     `worst` and `gapmax` say how many odd fixes, what worst radius and what
     longest gap came since the line before, so the sampling hides nothing.
     `skip` is a fix the app set aside: rough at the start (`coarse`), or a rough
     one after a precise one (`stale`). The place goes out rounded to about a
     kilometre. */
  function fix(coords, { stamp = null, busy = false, sog = null, skip = '', t: at = 0 } = {}) {
    const lat = Number(coords?.latitude);
    const lon = Number(coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const t = at || Date.now();
    const acc = Math.round(Number(coords.accuracy) || 0);
    const prev = S.lastFix;
    // The same fix handed out again from the browser's cache is counted, not measured.
    if (prev && stamp != null && prev.stamp === stamp && prev.lat === lat && prev.lon === lon) {
      S.same += 1;
      return;
    }
    S.lastFix = { lat, lon, t, stamp, acc };
    S.fixN += 1;
    const dt = prev ? t - prev.t : null;
    const d = prev ? metres(prev, { lat, lon }) : null;
    const made = dt && dt >= 900 ? d / (dt / 1000) : null;
    const gps = Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null;
    const kinds = [];
    // Fixes stop while the page is hidden; only a gap on screen is trouble.
    if (dt != null && prev.t >= S.shownAt && dt > (busy ? 5000 : 60000)) kinds.push('gap');
    if (acc > 50) kinds.push('acc');
    if (gps != null && made != null && acc <= 50 && prev.acc <= 50 && Math.abs(made - gps) > Math.max(3, 0.3 * gps)) kinds.push('speed');
    if (skip) kinds.push(skip);
    if (kinds.length) S.odds += 1;
    S.worst = Math.max(S.worst, acc);
    if (kinds.includes('gap')) S.gapMax = Math.max(S.gapMax, dt);
    const fresh = kinds.some((kind) => kind === 'gap' || !S.fixKinds.includes(kind));
    S.fixKinds = kinds;
    const since = t - S.fixLogT;
    if (!(fresh && since >= 2000) && since < (busy ? 5000 : 30000)) return;
    S.fixLogT = t;
    event('fix', {
      acc,
      v: gps == null ? null : round1(gps * 3.6),
      made: made == null ? null : round1(made * 3.6),
      sog: Number.isFinite(sog) ? round1(sog) : null,
      hdg: Number.isFinite(coords.heading) && coords.heading >= 0 ? Math.round(coords.heading) : null,
      dt, d: d == null ? null : Math.round(d), n: S.fixN,
      odd: kinds.join(',') || null, odds: S.odds || null, worst: S.worst > acc ? S.worst : null,
      gapmax: S.gapMax > (dt || 0) ? S.gapMax : null, same: S.same || null,
      skip: skip || null, busy: busy || null,
      at: `${round2(lat)},${round2(lon)}`,
    }, { t });
    S.odds = 0;
    S.worst = 0;
    S.gapMax = 0;
    S.same = 0;
  }

  /* What was pressed: the element's own name. A button of the navigator is
     `drive-<action>`, a screen of the bottom bar `screen-<name>`; otherwise the
     first data-attribute, the id, a map pin or the class. A value goes along
     only when it is one of the app's own words (a grade, a screen, «есть»/«нет»);
     never an id of a station or a person, never text a person typed. */
  const ENUM_KEYS = new Set(['grade', 'mapGrade', 'quickGrade', 'composeGrade', 'composeSeen', 'composeQueue', 'markSeen',
    'area', 'view', 'mode', 'seen', 'status', 'timeline', 'push', 'vote', 'verdict', 'cars']);
  const word = (value) => (value != null && /^[\w-]{1,24}$/.test(value) ? value : undefined);
  const kebab = (key) => key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

  function tapName(el) {
    const d = el.dataset || {};
    if (d.drive) return { what: `drive-${d.drive}`, v: word(d.mode || d.grade || d.seen || d.cars || d.vote) };
    if (d.screen) return { what: `screen-${d.screen}` };
    const keys = Object.keys(d).filter((key) => !/^(name|signature)$|author|At$|^at$/.test(key));
    const known = keys.find((key) => ENUM_KEYS.has(key));
    if (known) return { what: kebab(known), v: word(d[known]), s: known === 'composeGrade' ? word(d.composeSeen) : undefined };
    if (keys.length) return { what: kebab(keys[0]) };
    if (el.id) return { what: el.id };
    if (el.classList?.contains('leaflet-marker-icon')) return { what: el.closest('#drive') ? 'drive-pin' : 'map-pin' };
    if (el.tagName === 'A') {
      try {
        const url = new URL(el.href, location.href);
        return { what: 'link', v: url.origin === location.origin ? url.pathname.split('/').pop() || 'home' : url.hostname };
      } catch { return { what: 'link' }; }
    }
    const name = el.classList?.[0];
    if (name) return { what: name };
    return { what: String(el.getAttribute('aria-label') || el.tagName.toLowerCase()).slice(0, 40) };
  }

  // Where the tap happened: the navigator, the map screen or the list, a drawer over it.
  function whereNow(el) {
    if (el.closest?.('#detailDrawer')) return 'drawer';
    if (el.closest?.('#clubGate')) return 'club';
    const body = document.body;
    if (body?.classList.contains('driving')) return 'nav';
    if (body?.classList.contains('map-screen')) return 'map';
    return 'list';
  }

  document.addEventListener('click', (e) => {
    try {
      const el = e.target?.closest?.('button, a, summary, select, [role="button"], input[type="checkbox"], input[type="radio"], .leaflet-marker-icon, [data-drive], [data-screen]');
      if (!el) return;
      const { what, v, s } = tapName(el);
      event('tap', { what: String(what).slice(0, 60), v, s, on: whereNow(el) });
    } catch { /* a tap is never worth an error */ }
  }, { capture: true, passive: true });

  // The sorting of the list and other choices from a list: their values are the app's own.
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el?.tagName !== 'SELECT') return;
    event('set', { what: el.id || el.name || 'select', v: word(el.value) });
  }, { capture: true, passive: true });

  /* ---------- what is recorded by itself ---------- */
  function errorKey(msg, src, line) {
    return `error:${msg}|${src}|${line}`;
  }

  window.addEventListener('error', (e) => {
    const target = e.target;
    // A script or a style sheet that did not come (the white screen of 17–19 Sep 2026).
    if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      event('load_error', { what: target.tagName.toLowerCase(), src: String(target.src || target.href || '').split('/').pop().split('?')[0] });
      return;
    }
    if (target && target !== window) return;
    if (S.errors >= ERRORS_MAX) return;
    const msg = String(e.message || '').slice(0, 200);
    const src = String(e.filename || '').split('/').pop().split('?')[0];
    if (event('error', { msg, src, line: e.lineno, col: e.colno, stack: String(e.error?.stack || '').slice(0, 400) },
      { every: 60000, key: errorKey(msg, src, e.lineno) })) S.errors += 1;
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    if (S.errors >= ERRORS_MAX) return;
    const msg = `promise: ${String(e.reason?.message || e.reason || '').slice(0, 200)}`;
    if (event('error', { msg, stack: String(e.reason?.stack || '').slice(0, 400) }, { every: 60000, key: errorKey(msg, '', 0) })) S.errors += 1;
  });

  document.addEventListener('visibilitychange', () => {
    event(document.hidden ? 'hidden' : 'visible');
    if (document.hidden) {
      save();
      send({ beacon: true });
    } else {
      S.shownAt = Date.now();
    }
  });
  window.addEventListener('pagehide', () => {
    save();
    send({ beacon: true });
  });
  window.addEventListener('online', () => {
    event('online');
    sendSoon(3000);
  });
  window.addEventListener('offline', () => event('offline'));

  // Long freezes of the page (Chrome, Android): how many and how long, once a minute.
  try {
    let long = { n: 0, ms: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        long.n += 1;
        long.ms += entry.duration;
      }
    }).observe({ type: 'longtask', buffered: true });
    setInterval(() => {
      if (!long.n) return;
      event('slow', { n: long.n, ms: Math.round(long.ms) });
      long = { n: 0, ms: 0 };
    }, 60000);
  } catch { /* not in Safari */ }

  // The panel «Приложение не загрузилось» from index.html is up: the code never came.
  setTimeout(() => { if (document.getElementById('stalledNote')) event('stalled'); }, 8000);

  // Whether this browser lets the app know the place, and when that changes.
  try {
    navigator.permissions?.query({ name: 'geolocation' }).then((status) => {
      event('geo_permission', { state: status.state });
      status.addEventListener?.('change', () => event('geo_permission', { state: status.state, change: true }));
    }).catch(() => {});
  } catch { /* an older browser */ }

  // The launch, at the moment the page began to open.
  event('start', {
    standalone: !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone),
    screen: `${screen.width}×${screen.height}@${devicePixelRatio}`,
    lang: navigator.language, online: navigator.onLine, sw: !!navigator.serviceWorker?.controller, mem: navigator.deviceMemory,
  }, { t: Math.round(performance.timeOrigin || Date.now() - performance.now()) });
  // What app.js did before this file was in, each at its own time.
  const early = Array.isArray(window.SPBFI_LOG_EARLY) ? window.SPBFI_LOG_EARLY.splice(0) : [];
  for (const [kind, ...args] of early) {
    try {
      if (kind === 'fix') fix(...args);
      else event(...args);
    } catch { /* one odd line is not worth the rest */ }
  }

  window.SPBFILog = {
    event, fix, report, blocked, setOff, who, setWho,
    off: isOff,
    // For a look from the browser's console, and for the checks: the newest
    // events, how many wait to go out, and how the receiver answers.
    recent: (n = 50) => S.buf.slice(-n).map((ev) => ({ ...ev })),
    pending: () => S.unsent,
    route: () => S.route,
    flush: () => send(),
  };
})();

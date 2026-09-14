const STATUS = {
  CAN_REFUEL: { short: 'Можно заправиться', color: '#158257' },
  LIKELY_AVAILABLE: { short: 'Скорее есть', color: '#77a827' },
  CONFLICT: { short: 'Данные расходятся', color: '#7856c7' },
  LIMITED: { short: 'Есть ограничения', color: '#d58a13' },
  LIKELY_NOT: { short: 'Скорее нет', color: '#d5653f' },
  CONFIRMED_NO: { short: 'Подтверждено нет', color: '#b8333a' },
  NO_FRESH_DATA: { short: 'Нет свежих данных', color: '#8a9691' },
};
// Propane is deliberately absent: nobody in this group drives on it, and a
// "Газ" chip only invited gas pumps into the list.
const GRADE_LABELS = { AI92: 'АИ-92', AI95: 'АИ-95', AI98: 'АИ-98', AI100: 'АИ-100', DT: 'ДТ' };
const QUEUE_LABELS = {
  lt5: 'до 5 авто', less_than_5: 'до 5 авто',
  '5_20': '5–20 авто', from_5_to_20: '5–20 авто',
  '20_50': '20–50 авто', from_20_to_50: '20–50 авто',
  gt50: 'более 50 авто', more_than_50: 'более 50 авто',
  high: 'большая', reported: 'есть', unknown: 'неизвестна',
};
const AVAILABILITY_LABELS = {
  AVAILABLE: 'Есть', LIKELY: 'Скорее есть', NOT_AVAILABLE: 'Нет', LIKELY_NOT: 'Скорее нет',
  LIMITED: 'Ограничение', QUEUE: 'Очередь', UNKNOWN: 'Неизвестно',
};
const KIND_LABELS = {
  official_stock: 'официальный остаток', crowd_status_yandex: 'отметки в Яндекс Картах', official_relay: 'официальный остаток через ретранслятор', realtime_status: 'текущий статус', crowd_report: 'сообщение водителя',
  crowd_status: 'сообщения водителей', parsed_status: 'распознанный статус', aggregated_status: 'агрегированный статус',
  imported_status: 'импортированный статус', payment_projection: 'прогноз по платежам', payment_prediction: 'прогноз по активности',
  network_claim_aggregated: 'сводный сигнал сети', undated_crowd_summary: 'недатированный сигнал', price: 'цена',
  catalog_price: 'каталожная цена', catalog_fuel: 'ассортимент', catalog_or_stale: 'каталог/устаревшее',
};

const state = {
  grade: 'AI95', area: 'all', view: 'list', search: '', sort: 'go',
  status: null, timeline: null, location: null, bbox: null, meta: null, stations: [], visible: 0, map: null, meLayer: null,
  markers: null, request: 0,
  staticMode: document.querySelector('meta[name="spbfi-static-site"]')?.content === 'true',
  gradesBrief: {},
  marks: {},
  follow: false, watchId: null, accuracy: null,
  locationAt: 0, fixStartedAt: 0, pendingFix: null, locating: false, locationTimer: null, contextTimer: null,
  passed: {}, ownOnly: false, workerBatch: false,
  groupMarks: {}, stationInfo: {}, stationDetails: {}, total: 0,
  club: { enabled: false, mode: 'off', member: null, profile: null, newsTimer: null },
  searchScope: null, radiusKm: 5, searchLabel: null,
};
const staticCache = new Map();
const STATUS_PRIORITY = { CAN_REFUEL: 0, LIMITED: 1, LIKELY_AVAILABLE: 2, CONFLICT: 3, LIKELY_NOT: 4, CONFIRMED_NO: 5, NO_FRESH_DATA: 6 };
const SERVES_NOW = { CAN_REFUEL: 0, LIMITED: 0, LIKELY_AVAILABLE: 0, CONFLICT: 1, NO_FRESH_DATA: 2, LIKELY_NOT: 3, CONFIRMED_NO: 3 };
let installPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const analytics = window.SPBFIAnalytics || { track() {}, predictionFields() { return {}; }, zoneFor() { return 'unknown'; }, ageBucket() { return 'unknown'; }, enabled() { return false; }, setEnabled() {} };
const track = (event, fields = {}) => analytics.track(event, { area: state.area, grade: state.grade, ...fields });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatAge(seconds) {
  if (seconds == null) return 'время неизвестно';
  if (seconds < 90) return 'только что';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч назад`;
  return `${Math.round(seconds / 86400)} дн. назад`;
}

function formatDuration(seconds) {
  if (seconds == null) return 'длительность неизвестна';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86400)} дн.`;
}

function formatSnapshot(seconds, mode) {
  if (seconds == null) return ['Время снимка неизвестно', 'проверяйте evidence'];
  const stale = seconds > 60 * 60;
  // Refreshes are ten minutes apart. Past twenty the data is late and the card
  // must say so plainly instead of a calm green dot.
  if (!stale && seconds > 20 * 60) {
    return ['Данные отстают', `последнее обновление ${formatAge(seconds)} · обычно раз в 10 мин`, false, true];
  }
  const title = stale ? 'Снимок слишком старый для «сейчас»' : mode === 'live_http_snapshot' ? 'Свежий HTTP-снимок' : mode === 'static_github_pages' ? 'Публичный снимок' : 'Снимок Phase 0';
  const subtitle = stale ? `${formatAge(seconds)} · статусы старше 45 мин не подтверждают наличие` : formatAge(seconds);
  return [title, subtitle, stale];
}

async function api(path) {
  if (state.staticMode && path.startsWith('/api/')) return staticApi(path);
  try {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    if (response.ok) return response.json();
    if (!path.startsWith('/api/')) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    if (!path.startsWith('/api/')) throw error;
  }
  return staticApi(path);
}

async function staticJson(relativePath) {
  if (!staticCache.has(relativePath)) {
    // GitHub Pages lets a browser keep a file for ten minutes without asking.
    // A new build announced in meta.json then went unseen for those minutes,
    // and fresh data sat next to a stale list. «no-cache» asks every time and
    // costs a 304 when nothing changed.
    staticCache.set(relativePath, fetch(relativePath, { cache: 'no-cache', headers: { Accept: 'application/json' } }).then(async (response) => {
      if (!response.ok) throw new Error(`Не найден статический файл ${relativePath}`);
      return response.json();
    }));
  }
  return staticCache.get(relativePath);
}

function haversineKm(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}

function staticInArea(station, area) {
  if (!area || area === 'all') return true;
  const address = String(station.address || '').toLowerCase();
  if (area === 'spb') return !['ленинградск', 'всеволож', 'гатчин'].some((token) => address.includes(token));
  if (area === 'lo') return ['ленинградск', 'всеволож', 'гатчин', 'тоснен', 'кировск', 'выборг'].some((token) => address.includes(token));
  return true;
}

async function staticApi(path) {
  state.staticMode = true;
  const url = new URL(path, window.location.origin);
  if (url.pathname === '/api/meta') return staticJson('static-data/meta.json');
  if (url.pathname === '/api/sources') return staticJson('static-data/sources.json');
  if (url.pathname === '/api/grades-brief') return staticJson('static-data/grades-brief.json');
  const detail = url.pathname.match(/^\/api\/stations\/([^/]+)$/);
  if (detail) return staticJson(`static-data/details/${encodeURIComponent(decodeURIComponent(detail[1]))}.json`);
  if (url.pathname !== '/api/stations') throw new Error('Эта функция доступна только в локальном режиме.');

  const p = url.searchParams;
  const grade = p.get('grade') || 'AI95';
  const bundle = await staticJson(`static-data/stations-${grade}.json`);
  const statuses = new Set((p.get('status') || '').split(',').filter(Boolean));
  const timeline = p.get('timeline');
  const area = p.get('area') || 'all';
  const query = (p.get('q') || '').trim().toLocaleLowerCase();
  const bbox = (p.get('bbox') || '').split(',').map(Number);
  const hasBbox = bbox.length === 4 && bbox.every(Number.isFinite);
  const rawLat = p.get('lat');
  const rawLon = p.get('lon');
  const lat = rawLat == null ? NaN : Number(rawLat);
  const lon = rawLon == null ? NaN : Number(rawLon);
  const center = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  const radiusKm = Number(p.get('radius_km'));
  const hasRadius = center && Number.isFinite(radiusKm) && radiusKm > 0;
  const list = [];
  const statusCounts = {};
  let appeared = 0;
  const elapsed = staticElapsedSeconds();
  for (const original of bundle.stations) {
    const station = structuredClone(original);
    expireGrade(station.grade, elapsed);
    const location = station.location;
    if (!staticInArea(station, area)) continue;
    if (query && !`${station.network} ${station.address}`.toLocaleLowerCase().includes(query)) continue;
    if (hasBbox && !(bbox[0] <= location.lon && location.lon <= bbox[2] && bbox[1] <= location.lat && location.lat <= bbox[3])) continue;
    if (center) station.distance_km = Math.round(haversineKm(center, location) * 100) / 100;
    if (hasRadius && station.distance_km > radiusKm) continue;
    const status = station.grade.status;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (station.grade.timeline?.appeared_recent) appeared += 1;
    if (statuses.size && !statuses.has(status)) continue;
    if (timeline === 'appeared' && !station.grade.timeline?.appeared_recent) continue;
    list.push(station);
  }
  const sort = p.get('sort') || 'status';
  list.sort((a, b) => {
    if (sort === 'distance' && center) return (a.distance_km - b.distance_km) || (STATUS_PRIORITY[a.grade.status] - STATUS_PRIORITY[b.grade.status]);
    // "Ближайшие доступные" answers the actual question: the closest station
    // that can currently serve this grade, not the closest station of any kind.
    if (sort === 'nearest_available' && center) return (SERVES_NOW[a.grade.status] - SERVES_NOW[b.grade.status]) || (a.distance_km - b.distance_km);
    if (sort === 'freshness') return (a.grade.age_seconds ?? Number.MAX_SAFE_INTEGER) - (b.grade.age_seconds ?? Number.MAX_SAFE_INTEGER);
    if (sort === 'price') return (a.grade.price_rub ?? Number.MAX_SAFE_INTEGER) - (b.grade.price_rub ?? Number.MAX_SAFE_INTEGER);
    if (sort === 'appeared') return Number(b.grade.timeline?.appeared_recent) - Number(a.grade.timeline?.appeared_recent);
    return (STATUS_PRIORITY[a.grade.status] - STATUS_PRIORITY[b.grade.status]) || ((a.grade.age_seconds ?? Number.MAX_SAFE_INTEGER) - (b.grade.age_seconds ?? Number.MAX_SAFE_INTEGER));
  });
  const offset = Number(p.get('offset') || 0);
  const limit = Number(p.get('limit') || 250);
  return { grade, total: list.length, offset, limit, status_counts: statusCounts, timeline_counts: { appeared }, stations: list.slice(offset, offset + limit) };
}

// A published snapshot keeps ageing in the reader's browser.  Each answer
// carries the TTL of the signal it rests on, so the page can expire exactly
// the answers that went stale instead of blanking the whole map at once.
function staticElapsedSeconds() {
  if (!state.meta?.snapshot_at) return 0;
  return Math.max(0, (Date.now() - new Date(state.meta.snapshot_at).getTime()) / 1000);
}

function expireGrade(grade, elapsed) {
  if (!grade || !elapsed) return grade;
  if (grade.age_seconds != null) grade.age_seconds = Math.round(grade.age_seconds + elapsed);
  if (grade.timeline?.duration_seconds != null) grade.timeline.duration_seconds = Math.round(grade.timeline.duration_seconds + elapsed);
  const ttl = grade.ttl_seconds;
  if (grade.status === 'NO_FRESH_DATA' || ttl == null) return grade;
  if (grade.age_seconds != null && grade.age_seconds > ttl) {
    grade.status = 'NO_FRESH_DATA';
    grade.label = 'НЕТ СВЕЖИХ ДАННЫХ';
    grade.reason = 'Сигнал, на котором держался ответ, устарел уже после публикации снимка.';
    grade.confidence = 'none';
    grade.trust_score = 0;
    grade.trust_tier = 'none';
    grade.trust_label = 'нет данных';
    grade.fresh_provenance_count = 0;
    grade.fresh_source_count = 0;
    if (grade.timeline) grade.timeline = { ...grade.timeline, appeared_recent: false, recent: false };
    return grade;
  }
  // Trust decays with the part of the TTL that has been spent since publishing.
  if (grade.trust_score) {
    const spent = Math.min(1, (grade.age_seconds || 0) / ttl);
    grade.trust_score = Math.max(1, Math.round(grade.trust_score * (1 - 0.35 * spent)));
    grade.trust_tier = grade.trust_tier === 'conflict' ? 'conflict' : grade.trust_score >= 75 ? 'high' : grade.trust_score >= 45 ? 'moderate' : 'low';
    grade.trust_label = { high: 'высокая', moderate: 'средняя', low: 'низкая', conflict: 'противоречивая', none: 'нет данных' }[grade.trust_tier];
  }
  return grade;
}

function formatQueue(queue) {
  if (!queue) return null;
  const raw = typeof queue === 'object' ? (queue.size || queue.label || queue.value) : queue;
  const key = String(raw || '').trim().toLowerCase();
  if (!key || ['none', 'no', 'false', '0', 'no_queue'].includes(key)) return null;
  return QUEUE_LABELS[key] || String(raw || 'есть').replaceAll('_', ' ');
}

function localizeNote(note) {
  if (!note) return '';
  const value = String(note);
  if (/not a stock guarantee/i.test(value)) return 'Прогноз по платежной и каталожной активности, не гарантия физического остатка.';
  if (/relay of the official/i.test(value)) return 'Ретрансляция официальной ленты «Газпромнефти» сторонним сервисом, а не прямое чтение.';
  if (/Aggregated network claim/i.test(value)) return 'Сводное заявление сети; как официальное подтверждено только для «Газпромнефти».';
  if (/missing from the current availability list/i.test(value)) return 'Марка продаётся здесь, но её нет в текущем списке доступного топлива.';
  if (/does not state current stock/i.test(value)) return 'Официальная лента цен; текущий остаток она не сообщает.';
  if (/Configured assortment/i.test(value)) return 'Штатный ассортимент, а не текущий остаток.';
  if (/republished by the channel/i.test(value)) return 'Подтверждения водителей из канала, а не официальное чтение остатка.';
  if (/collected by Yandex Maps/i.test(value)) return 'Отметки водителей в Яндекс Картах, а не официальное чтение остатка.';
  if (/not proof of a specific grade/i.test(value)) return 'Платёж не доказывает наличие конкретной марки топлива.';
  if (/provenance is separate from availability/i.test(value)) return 'Источник цены не подтверждает наличие топлива.';
  return value;
}

async function bootstrap() {
  bindControls();
  state.marks = loadMarks();
  try { state.club.member = JSON.parse(localStorage.getItem(CLUB_MEMBER_KEY) || 'null'); } catch { state.club.member = null; }
  $('#clubButton')?.addEventListener('click', showClub);
  bindSecretClubEntry();
  checkClub();
  // A tapped notification lands here with the station in the URL.
  const wanted = new URLSearchParams(location.search).get('station');
  if (wanted) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openStation(wanted), 600);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.station) openStation(event.data.station);
    });
  }
  // A phone in a car wants "рядом" from the first second, without hunting for a
  // button. If permission was never granted the browser asks once; if it was
  // refused earlier this fails silently and the city list stays.
  const touchDevice = window.matchMedia('(pointer: coarse)').matches;
  if (touchDevice && navigator.geolocation) startFollowing({ manual: false });
  try {
    state.meta = await api('/api/meta');
    // GitHub Pages lets a phone keep the page for ten minutes. Opened in that
    // window after a new build, the app started on the old page and ran it until
    // the two-minute poll noticed. meta.json is fetched fresh, so the build is
    // compared as soon as it is in, and the page reloads onto the new one.
    if (state.meta?.build && window.SPBFI_BUILD && state.meta.build !== window.SPBFI_BUILD && !document.hidden && reloadOnce()) return;
    renderMeta();
    // One small file with every grade for every station; the card shows all six
    // marks without downloading six full bundles.
    api('/api/grades-brief')
      .then((brief) => { state.gradesBrief = brief.stations || {}; renderStations(); })
      .catch(() => { state.gradesBrief = {}; });
    initMap();
    await loadStations();
    const health = state.meta?.collectors || {};
    track('app_open', {
      installed: platformInfo().installed,
      snapshot_age_bucket: analytics.ageBucket(state.meta?.snapshot_age_seconds),
      collector_ok: Number(health.ok || 0),
      collector_failed: Number(health.failed?.length || 0),
    });
  } catch (error) {
    $('#stationList').innerHTML = `<div class="empty-state"><strong>Не удалось загрузить приложение</strong><br>${escapeHtml(error.message)}</div>`;
  }
}

function renderMeta() {
  const frozenAge = state.meta.mode === 'static_github_pages' && state.meta.snapshot_at ? Math.max(0, Math.round((Date.now() - new Date(state.meta.snapshot_at).getTime()) / 1000)) : state.meta.snapshot_age_seconds;
  const [title, subtitle, stale, late] = formatSnapshot(frozenAge, state.meta.mode);
  const stats = state.meta.stats || {};
  const baseline = Number((stats.source_rows || {}).sber || 0);
  $('#snapshotCard').innerHTML = `<span class="pulse ${stale ? 'stale' : late ? 'late' : ''}"></span><span><strong>${title}</strong><small>${subtitle} · ${Number(stats.canonical_stations).toLocaleString('ru-RU')} карточек</small></span>`;
  const live = Object.keys(stats.source_rows || {}).length;
  renderCollectorHealth();
  $('#identityNote').textContent = baseline
    ? `${live} источников в этом снимке; записи одной сети на одной точке объединены, остальные не склеиваются без достаточных признаков. Физический baseline Sber/2GIS: ${baseline.toLocaleString('ru-RU')} точек.`
    : 'Карточки не объединяются только по близости координат.';
  const stamp = $('#buildStamp');
  if (stamp && state.meta.generated_at) {
    stamp.textContent = `сборка ${new Date(state.meta.generated_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  }
  const refresh = $('#refreshButton');
  if (state.staticMode || state.meta.mode === 'static_github_pages') {
    refresh.textContent = 'Автообновление: 10 мин';
    refresh.disabled = true;
    refresh.title = 'Данные обновляются автоматически, примерно раз в 10 минут.';
  }
}

// A source going quiet is the likeliest way this app starts lying, so a failure
// is shown on the page rather than buried in a workflow log.
function renderCollectorHealth() {
  const banner = $('#collectorBanner');
  const health = state.meta?.collectors;
  if (!banner) return;
  if (!health || !health.failed?.length) {
    banner.hidden = true;
    return;
  }
  const names = health.failed.map((item) => item.name).join(', ');
  banner.hidden = false;
  banner.innerHTML = `<strong>Не ответили источники: ${escapeHtml(String(health.failed.length))} из ${escapeHtml(String(health.total))}</strong>`
    + `<span>${escapeHtml(names)}. Остальные ${escapeHtml(String(health.ok))} отработали — ответы построены на них.</span>`
    + `<button type="button" id="collectorDetails">Подробнее</button>`;
  $('#collectorDetails').addEventListener('click', showCollectorHealth);
}

function showCollectorHealth() {
  const health = state.meta?.collectors || { failed: [], ok: 0, total: 0 };
  const rows = health.failed.map((item) => `<div class="source-row"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.error || 'нет ответа')}</small></div>`).join('');
  const off = (health.off || []).map((item) => `<div class="source-row"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.note)}</small></div>`).join('');
  openDrawer(`<h2>Состояние источников</h2>
    <p class="drawer-address">На последнем обновлении ответили ${health.ok} из ${health.total} каналов. Когда источник молчит, его голос просто не учитывается — ответы строятся на остальных, а возраст данных остаётся виден на карточке.</p>
    ${rows ? `<h3 class="section-title">Не ответили</h3><div class="source-list">${rows}</div>` : '<div class="drawer-status" style="--status-color:#158257"><strong>Все источники ответили</strong><p>На последнем обновлении ни один канал не выпал.</p></div>'}
    ${off ? `<h3 class="section-title">Не считаются: заведомо недоступны с сервера</h3><div class="source-list">${off}</div>` : ''}`);
}

function bindControls() {
  // Three separate guards, because each browser honours a different one:
  // Safari's own gesture events, the raw two-finger touchmove, and the
  // double-tap zoom. The map is excluded from all of them and keeps its
  // own pinch and pan.
  const outsideMap = (event) => !event.target.closest?.('#map');
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(name, (event) => {
      if (outsideMap(event)) event.preventDefault();
    }, { passive: false });
  }
  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1 && outsideMap(event)) event.preventDefault();
  }, { passive: false });
  let lastTap = 0;
  document.addEventListener('touchend', (event) => {
    const now = Date.now();
    // A composer is tapped in quick runs: a grade twice for «нет», then the
    // queue. Cancelling the second touchend cancelled its click too, so a
    // double tap on 95 went out as «95 есть». Its buttons cannot zoom (see
    // .mark-composer button in the stylesheet) and keep every tap. The drive
    // screen is tapped the same way: the queue, then «95 есть» right after.
    if (now - lastTap < 320 && outsideMap(event) && !event.target.closest?.('.mark-composer, .drive, .drive-offer')) event.preventDefault();
    lastTap = now;
  }, { passive: false });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('#installButton').hidden = false;
    track('install_prompt');
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('#installButton').hidden = true; track('installed'); });
  // iOS Safari never fires beforeinstallprompt, so the button stays visible
  // everywhere except inside an already installed window.
  const { installed, inAppBrowser } = platformInfo();
  $('#installButton').hidden = installed;
  if (inAppBrowser) $('#installButton').textContent = 'Открыть в Safari';
  $('#installButton').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $('#installButton').hidden = true;
      return;
    }
    showInstallHelp();
  });
  $('#gradePicker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-grade]');
    if (button) chooseGrade(button.dataset.grade);
  });
  $('#driveButton')?.addEventListener('click', () => openDrive('button'));
  $('#driveOfferYes')?.addEventListener('click', () => openDrive('suggestion'));
  $('#driveOfferNo')?.addEventListener('click', silenceDriveOffer);
  bindDrive();
  $('.location-row .segmented').addEventListener('click', (event) => {
    const button = event.target.closest('[data-area]');
    if (!button) return;
    state.area = button.dataset.area;
    $$('[data-area]').forEach((item) => item.classList.toggle('active', item === button));
    leaveOwnOnly();
    track('area_select');
    loadStations();
  });
  $('.view-switch').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    $$('[data-view]').forEach((item) => item.classList.toggle('active', item === button));
    $('#contentGrid').classList.toggle('map-mode', state.view === 'map');
    track('view_change', { view: state.view });
    if (state.map) setTimeout(() => { state.map.invalidateSize(); renderMarkers(); }, 80);
  });
  let searchTimer;
  $('#searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    state.search = event.target.value;
    leaveOwnOnly();
    if (state.searchScope) clearSearchScope({ keepText: true, reload: false });
    // Typing a street used to filter nothing at all until the user guessed to
    // press "Проверить по адресу"; filtering by address now happens as you type, and
    // the button stays for turning the same text into a place on the map.
    searchTimer = setTimeout(loadStations, 250);
    renderSearchContext();
  });
  $('#searchInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    findNearby();
  });
  $('#nearbySearchButton').addEventListener('click', findNearby);
  $('#sortSelect').addEventListener('change', (event) => { state.sort = event.target.value; leaveOwnOnly(); track('sort_change', { filter: state.sort }); loadStations(); });
  $('#locateButton').addEventListener('click', locate);
  $('#mapAreaButton').addEventListener('click', () => {
    const bounds = state.map.getBounds();
    state.bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    // The area is a filter; where the user is stays known, so distances and
    // the position dot survive the change.
    state.search = '';
    state.searchScope = 'map';
    state.searchLabel = 'Показываем АЗС в выбранной области карты.';
    $('#searchInput').value = '';
    renderSearchContext();
    $('#mapAreaButton').style.display = 'none';
    leaveOwnOnly();
    track('map_area_search', { zone: analytics.zoneFor(state.map.getCenter()) });
    loadStations();
  });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#aboutButton').addEventListener('click', showAbout);
  $('#sourcesButton').addEventListener('click', showSources);
  $('#refreshButton').addEventListener('click', refreshData);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
}

// One grade for the whole app: the picker above the list and the plate on the
// drive screen change the same thing, and the list is loaded for it anew.
function chooseGrade(grade) {
  if (!GRADE_LABELS[grade]) return;
  state.grade = grade;
  $$('#gradePicker [data-grade]').forEach((item) => {
    item.classList.toggle('active', item.dataset.grade === grade);
    item.setAttribute('aria-checked', item.dataset.grade === grade);
  });
  state.status = null;
  state.timeline = null;
  leaveOwnOnly();
  track('grade_select');
  loadStations();
}

async function refreshData() {
  if (state.staticMode) return;
  const button = $('#refreshButton');
  button.disabled = true;
  button.textContent = '↻ Получаем данные…';
  $('#snapshotCard').querySelector('strong').textContent = 'Обновляем все каналы';
  $('#snapshotCard').querySelector('small').textContent = 'обычно 20–90 секунд';
  try {
    const response = await fetch('/api/refresh', { method: 'POST', headers: { 'X-SPBFI-Action': 'refresh', Accept: 'application/json' } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    state.meta = result.meta;
    renderMeta();
    await loadStations();
    button.textContent = '✓ Данные обновлены';
    setTimeout(() => { button.textContent = '↻ Обновить данные'; }, 3000);
  } catch (error) {
    renderMeta();
    button.textContent = 'Повторить обновление';
    alert(`Не удалось обновить данные: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- rough location
// On 14 Sep 2026 an iPhone 15 Pro reported ±884 m again and again while its dot
// sat on the right house and an iPhone beside it was precise. With GPS weak or
// jammed, as happens around Petersburg, a phone finds itself by Wi-Fi and
// states a cautious radius; with «Точная геопозиция» off for websites the dot
// itself is off. Only the person can tell which, by looking at the dot. Once
// they confirm it, that radius stops switching off what needs a precise place.
const ROUGH_METRES = 300;
const TRUSTED_METRES = 60;
const TRUST_KEY = 'spbfi-trust-rough-fix-v1';
const TRUST_MS = 12 * 60 * 60 * 1000;
let roughTrustedAt = 0;

function roughTrusted() {
  let stored = 0;
  try { stored = Number(localStorage.getItem(TRUST_KEY) || 0); } catch { /* the session still knows */ }
  return Date.now() - Math.max(stored, roughTrustedAt) < TRUST_MS;
}

// The radius the app acts on. Beyond a kilometre and a half the dot is not a
// house but a district, and no confirmation makes it one.
function effectiveAccuracy(accuracy = state.accuracy) {
  if (accuracy == null) return null;
  return accuracy > ROUGH_METRES && accuracy <= 1500 && roughTrusted() ? TRUSTED_METRES : accuracy;
}

function setRoughTrusted(trusted) {
  roughTrustedAt = trusted ? Date.now() : 0;
  try {
    if (trusted) localStorage.setItem(TRUST_KEY, String(roughTrustedAt));
    else localStorage.removeItem(TRUST_KEY);
  } catch { /* the session still knows */ }
  renderLocateButton();
  if (state.searchScope === 'device') renderSearchContext();
  renderHerePanel();
  refreshVerdicts(null, { force: true });
  refreshNearby();
  renderLocationHelpStatus();
}

function locationSteps() {
  const { iOS, inAppBrowser } = platformInfo();
  const android = /Android/i.test(navigator.userAgent);
  if (inAppBrowser) {
    return { title: 'Открыто внутри мессенджера', steps: ['Во встроенном браузере Telegram и других мессенджеров место определяется хуже. Откройте ссылку в <b>Safari</b> и добавьте приложение на экран «Домой».'] };
  }
  if (iOS) {
    return {
      title: 'iPhone — проверьте по порядку',
      steps: [
        '<b>Точная геопозиция для сайтов.</b> Настройки → Конфиденциальность и безопасность → Службы геолокации → <b>Сайты Safari</b> → «При использовании» и включите <b>«Точная геопозиция»</b>. У «Карт» этот переключатель свой, поэтому в «Картах» место бывает точным, а здесь нет.',
        '<b>Wi-Fi включён</b>, даже без подключения к сети: по сетям вокруг iPhone находит место, когда GPS ловит плохо.',
        'Там же, в «Службах геолокации» → <b>Системные службы</b> → включите <b>«Сети и беспроводная связь»</b>.',
        'Закройте приложение полностью (смахните вверх) и откройте снова.',
      ],
      check: 'Откройте «Карты». Если там синяя точка маленькая и точная, а здесь приложение пишет «приблизительно», — дело в пункте 1. Если и в «Картах» большой светлый круг — дело в сигнале: в Петербурге бывают помехи GPS, тогда помогает включённый Wi-Fi.',
    };
  }
  if (android) {
    return {
      title: 'Android — проверьте по порядку',
      steps: [
        '<b>Точное местоположение для браузера.</b> Настройки → Приложения → Chrome (или ваш браузер) → Разрешения → Местоположение → «Разрешить только во время использования» и включите <b>«Точное местоположение»</b>.',
        '<b>Геолокация Google.</b> Настройки → Местоположение → Службы определения местоположения → «Определение местоположения Google» (или «Точность определения») — включите. Wi-Fi тоже включите, даже без подключения к сети.',
        'Закройте приложение и откройте снова.',
      ],
      check: 'Откройте «Яндекс Карты» или «Google Карты». Если там точка точная, а здесь приложение пишет «приблизительно», — дело в пункте 1. Если и там большой круг — дело в сигнале: в Петербурге бывают помехи GPS, тогда помогает включённый Wi-Fi.',
    };
  }
  return { title: 'Что проверить', steps: ['Разрешите браузеру точное местоположение. Компьютер без GPS определяет место примерно — удобнее искать АЗС по адресу.'] };
}

function showLocationHelp() {
  const guide = locationSteps();
  openDrawer(`<h2>Где вы сейчас</h2>
    <p class="drawer-address">Телефон сообщает погрешность ±${escapeHtml(formatMeters(state.accuracy || 0))}. Бывает, что точка при этом стоит верно: когда GPS ловит плохо, телефон берёт место по Wi-Fi и перестраховывается.</p>
    <div class="drawer-status location-now" style="--status-color:#d58a13"><strong id="locationHelpStatus"></strong></div>
    <div id="locationHelpMap" class="location-help-map" role="img" aria-label="Где вас видит телефон"></div>
    <div class="location-question" id="locationQuestion">
      <strong>Синяя точка стоит там, где вы?</strong>
      <div class="location-answers">
        <button type="button" class="gate-submit" id="locationYes">Да, точка на месте</button>
        <button type="button" class="list-more" id="locationNo">Нет, не там</button>
      </div>
    </div>
    <div id="locationSteps" hidden>
      <h3 class="section-title">${escapeHtml(guide.title)}</h3>
      <ol class="install-steps">${guide.steps.map((step) => `<li>${step}</li>`).join('')}</ol>
      ${guide.check ? `<div class="drawer-status" style="--status-color:#0d5a43"><strong>Как понять, в чём дело</strong><p>${escapeHtml(guide.check)}</p></div>` : ''}
    </div>
    <button type="button" class="list-more" id="locationRecheck">📍 Проверить место ещё раз</button>
    <button type="button" class="list-more" id="locationByAddress">⌕ Искать АЗС по адресу</button>`);
  renderLocationHelpStatus();
  drawLocationHelpMap();
  $('#locationYes').addEventListener('click', () => {
    setRoughTrusted(true);
    $('#locationQuestion').innerHTML = '<strong>✅ Точка верная — так и считаем</strong><p>Приложение больше не называет место неточным: «я на заправке» и 👍/👎 работают. Если окажется, что точка не там, — нажмите «Проверить место ещё раз» или «изменить» под списком.</p>';
  });
  $('#locationNo').addEventListener('click', () => {
    setRoughTrusted(false);
    $('#locationQuestion').hidden = true;
    $('#locationSteps').hidden = false;
    $('#locationSteps').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('#locationRecheck').addEventListener('click', () => {
    if (!state.follow) startFollowing();
    const status = $('#locationHelpStatus');
    if (status) status.textContent = '◌ Проверяем место…';
    refreshLocation({ manual: true, quiet: true });
  });
  $('#locationByAddress').addEventListener('click', () => {
    closeDrawer();
    const input = $('#searchInput');
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus();
  });
}

function drawLocationHelpMap() {
  const holder = $('#locationHelpMap');
  if (!holder) return;
  if (!state.location || typeof L === 'undefined') {
    holder.hidden = true;
    return;
  }
  const map = L.map(holder, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false,
  }).setView([state.location.lat, state.location.lon], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  L.marker([state.location.lat, state.location.lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    interactive: false,
  }).addTo(map);
  // The drawer slides in; the map measures itself once it has.
  setTimeout(() => map.invalidateSize(), 350);
}

function renderLocationHelpStatus(error = null) {
  const status = $('#locationHelpStatus');
  if (!status) return;
  const holder = status.closest('.drawer-status');
  const paint = (color) => holder?.style.setProperty('--status-color', color);
  if (error) {
    paint('#b8333a');
    status.textContent = error.code === 1 ? '⛔ Геолокация для этого сайта запрещена в настройках телефона.' : '⚠️ Телефон сейчас не дал место. Попробуйте ещё раз через несколько секунд.';
    return;
  }
  if (!state.location) {
    status.textContent = '◌ Место ещё не определено.';
    return;
  }
  if (state.accuracy <= ROUGH_METRES) {
    paint('#158257');
    status.textContent = `✅ Сейчас: ±${formatMeters(state.accuracy)} — место точное`;
  } else if (effectiveAccuracy() <= ROUGH_METRES) {
    paint('#158257');
    status.textContent = `✅ Точка подтверждена вами · телефон сообщает ±${formatMeters(state.accuracy)}`;
  } else {
    paint('#d58a13');
    status.textContent = `⚠️ Сейчас: ±${formatMeters(state.accuracy)} по данным телефона`;
  }
}

function formatMeters(metres) {
  return metres >= 1000 ? `${(metres / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км` : `${Math.round(metres)} м`;
}

function renderSearchContext({ waitingAccuracy = null } = {}) {
  const context = $('#searchContext');
  if (state.follow && waitingAccuracy) {
    context.innerHTML = `<strong>Уточняем ваше место…</strong> Пока телефон даёт точность ±${escapeHtml(formatMeters(waitingAccuracy))} — этого мало, чтобы выбрать ближайшие АЗС. <button type="button" class="context-help" data-location-help>Что проверить</button>`;
    context.querySelector('[data-location-help]').addEventListener('click', showLocationHelp);
    return;
  }
  if (state.searchScope === 'place') {
    context.innerHTML = `<strong>Рядом с: ${escapeHtml(state.searchLabel)}</strong> · радиус ${state.radiusKm} км по прямой <button type="button" data-clear-scope>Сбросить</button>`;
  } else if (state.searchScope === 'device') {
    const age = state.locationAt ? Math.round((Date.now() - state.locationAt) / 1000) : null;
    const fresh = age == null ? '' : age < 20 ? ' · место обновлено только что' : ` · место обновлено ${formatAge(age)}`;
    const confirmed = state.accuracy > ROUGH_METRES && effectiveAccuracy() <= ROUGH_METRES;
    const precision = !state.accuracy ? ''
      : confirmed ? ' · точка подтверждена вами <button type="button" class="context-link" data-location-help>изменить</button>'
        : ` · ±${formatMeters(state.accuracy)}`;
    const coarse = effectiveAccuracy() > ROUGH_METRES
      ? '<span class="context-warn">⚠️ Телефон даёт место приблизительно: ближайшие АЗС могут быть не те, а «я на заправке» и 👍/👎 не заработают. <button type="button" class="context-help" data-location-help>Что делать</button></span>'
      : '';
    context.innerHTML = `<strong>Рядом с вами</strong> · ближайшие сверху${fresh}${precision} <button type="button" data-clear-scope>Весь город</button>${coarse}`;
  } else if (state.searchScope === 'far') {
    context.innerHTML = `<strong>В ${RADIUS_LADDER[RADIUS_LADDER.length - 1]} км от вас АЗС нет</strong> · приложение знает заправки Петербурга и Ленобласти, показываем все, ближайшие сверху <button type="button" data-clear-scope>Весь город</button>`;
  } else if (state.searchScope === 'map') {
    context.innerHTML = `<strong>${escapeHtml(state.searchLabel)}</strong> <button type="button" data-clear-scope>Сбросить</button>`;
  } else if (state.search.trim()) {
    context.textContent = 'Ищем точное совпадение по сети или адресу АЗС. Нажмите «Проверить по адресу», если это адрес места.';
  } else {
    context.textContent = 'Введите адрес, посёлок или название АЗС. Ввод фильтрует список; «Проверить по адресу» ищет вокруг этого места, расширяя радиус, пока не найдётся из чего выбрать.';
  }
  context.querySelector('[data-clear-scope]')?.addEventListener('click', () => {
    leaveOwnOnly();
    clearSearchScope({ keepText: false, reload: true });
  });
  context.querySelectorAll('[data-location-help]').forEach((button) => button.addEventListener('click', showLocationHelp));
}

function clearSearchScope({ keepText = false, reload = true } = {}) {
  // Leaving "рядом" means the whole city again: the watch stops with it, so
  // the button, the dot and the list all agree on what mode this is.
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.follow = false;
  document.body.classList.remove('following');
  state.location = null;
  state.accuracy = null;
  renderMe();
  state.bbox = null;
  state.searchScope = null;
  state.searchLabel = null;
  if (!keepText) {
    state.search = '';
    $('#searchInput').value = '';
  }
  renderLocateButton();
  renderSearchContext();
  if (reload) loadStations();
}

// The snapshot already knows where two thousand stations are and what their
// addresses say, so a place we actually serve is resolved from our own data.
// Nominatim does not index every village around the city — "Мистолово" is not
// in it at all — and it is only asked about places we have never heard of.
function localPlaceMatch(query) {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 3) return null;
  const hits = state.stations.filter((station) =>
    `${station.network} ${station.address}`.toLocaleLowerCase().includes(needle));
  if (!hits.length) return null;
  const lat = hits.reduce((sum, item) => sum + item.location.lat, 0) / hits.length;
  const lon = hits.reduce((sum, item) => sum + item.location.lon, 0) / hits.length;
  return {
    query,
    label: `${query} — по адресам ${hits.length} ${plural(hits.length, 'АЗС', 'АЗС', 'АЗС')} в наших данных`,
    location: { lat, lon },
    local: true,
  };
}

async function geocodePlace(query) {
  const local = localPlaceMatch(query);
  if (local) return local;
  const path = `/api/geocode?q=${encodeURIComponent(query)}`;
  try {
    return await api(path);
  } catch (localError) {
    // GitHub Pages has no private server. This is an explicit button action,
    // not autocomplete; the request is constrained to our SPB/LO viewbox.
    const params = new URLSearchParams({
      q: query, format: 'jsonv2', limit: '5', countrycodes: 'ru',
      viewbox: '29.50,60.35,31.10,59.60', bounded: '1', addressdetails: '0',
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Сервис поиска места временно недоступен. Переместите карту вручную.');
    const rows = await response.json();
    const row = rows.find((item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)));
    if (!row) {
      throw new Error(`«${query}» не нашлось ни среди адресов АЗС, ни в справочнике мест. Попробуйте соседнюю улицу или переместите карту и нажмите «Искать в этой области».`);
    }
    return { query, label: row.display_name || query, location: { lat: Number(row.lat), lon: Number(row.lon) } };
  }
}

async function findNearby() {
  const query = $('#searchInput').value.trim();
  if (query.length < 3) return alert('Введите адрес, посёлок или название АЗС — например, «Невский проспект», «Мурино» или «Газпромнефть».');
  leaveOwnOnly();
  track('search_start', { reason: 'place' });
  const button = $('#nearbySearchButton');
  button.disabled = true;
  button.textContent = 'Ищем место…';
  $('#searchContext').textContent = 'Находим место, затем ищем ближайшие АЗС…';
  try {
    const place = await geocodePlace(query);
    if (!Number.isFinite(place.location?.lat) || !Number.isFinite(place.location?.lon)) throw new Error('Сервис поиска вернул неполные координаты.');
    state.location = place.location;
    state.bbox = null;
    state.search = '';
    state.searchScope = 'place';
    state.searchLabel = place.label;
    state.radiusKm = 5;
    state.sort = 'nearest_available';
    $('#sortSelect').value = 'nearest_available';
    if (state.map) state.map.setView([place.location.lat, place.location.lon], 13);
    renderSearchContext();
    await loadStationsWideningRadius();
    track('search_complete', {
      reason: 'place', success: state.total > 0, result_count: state.total,
      fresh_count: state.stations.filter((item) => item.grade?.status !== 'NO_FRESH_DATA').length,
      radius_km: state.radiusKm, zone: analytics.zoneFor(place.location),
    });
    if (!state.total) track('search_zero', { reason: 'place', radius_km: state.radiusKm, zone: analytics.zoneFor(place.location) });
  } catch (error) {
    $('#searchContext').textContent = error.message;
    track('search_failed', { reason: 'geocoder' });
  } finally {
    button.disabled = false;
    button.textContent = '⌕ Проверить по адресу';
  }
}

// Five kilometres around a village may hold two stations and no answer; the
// radius widens until there is something to choose from.
const RADIUS_LADDER = [5, 10, 20];
const FAR_RECHECK_MS = 10 * 60 * 1000;
const MIN_NEARBY = 8;

async function loadStationsWideningRadius() {
  for (const km of RADIUS_LADDER) {
    state.radiusKm = km;
    await loadStations({ silent: km !== RADIUS_LADDER[0] });
    if (state.stations.length >= MIN_NEARBY) break;
  }
  // The data covers Petersburg and the region. Far from both, every widening
  // ends empty and «рядом» used to leave the person looking at nothing.
  if (!state.stations.length && state.searchScope === 'device') {
    state.searchScope = 'far';
    state.farCheckedAt = Date.now();
    await loadStations({ silent: true });
  }
  renderSearchContext();
}

// "Рядом" is a mode, not a button press. A navigator does not ask you to tap
// "my position" every kilometre: once you allow location it follows you, keeps
// the list sorted by what is closest, and re-queries as you move. iOS also hands
// out a coarse cached fix first, so a single getCurrentPosition would happily
// show the other end of the city; watchPosition keeps improving instead.
const REQUERY_METRES = 150;
// A fix this rough cannot tell one district from the next; the list waits a
// little for a better one before it moves.
const COARSE_METRES = 1000;
const COARSE_WAIT_MS = 12000;
// Watches stall in messenger browsers and whenever iOS suspends the page, so
// a fresh fix is asked for on return and every so often while on screen.
const LOCATION_REFRESH_MS = 45000;
// Stations passed this close are offered for a mark for a while afterwards:
// at 50 km/h there is no time to find the right card while driving past.
const PASSED_METRES = 250;
const PASSED_KEEP_MS = 15 * 60 * 1000;

function locate() {
  // Asked for from inside «Свои», "рядом" means the nearby list itself.
  if (leaveOwnOnly()) loadStations();
  // With "рядом" already on, the button means "update my place now". People
  // pressed it for exactly that and it used to switch the mode off; leaving is
  // the "Весь город" link.
  if (state.follow) {
    // A rough place does not get better by pressing again and again: the
    // person is asked whether the dot is right, or shown what to switch on.
    if (state.location && !state.locating && effectiveAccuracy() > ROUGH_METRES) {
      showLocationHelp();
      return;
    }
    refreshLocation({ manual: true });
    return;
  }
  startFollowing({ manual: true });
}

function renderLocateButton() {
  const button = $('#locateButton');
  if (!button) return;
  button.classList.remove('coarse');
  if (!state.follow) {
    button.innerHTML = '<span aria-hidden="true">⌖</span> Рядом со мной';
    return;
  }
  if (state.locating || !state.location) {
    button.innerHTML = '<span aria-hidden="true">◌</span> Определяем место…';
    return;
  }
  const coarse = effectiveAccuracy() > ROUGH_METRES;
  const confirmed = !coarse && state.accuracy > ROUGH_METRES;
  button.classList.toggle('coarse', coarse);
  button.innerHTML = coarse
    ? `<span aria-hidden="true">⚠️</span> Место приблизительное · ±${formatMeters(state.accuracy)} · что делать`
    : `<span aria-hidden="true">📍</span> Вы здесь · ${confirmed ? 'точка подтверждена' : `±${formatMeters(state.accuracy)}`} · обновить`;
}

function liveDistanceKm(station) {
  if (state.location && station?.location) return haversineKm(state.location, station.location);
  return station?.distance_km ?? null;
}

function notePassedStations(here, accuracy) {
  if (effectiveAccuracy(accuracy) > ROUGH_METRES) return;
  const now = Date.now();
  for (const station of state.stations) {
    if (!station.location) continue;
    const metres = haversineKm(here, station.location) * 1000;
    if (metres <= PASSED_METRES) {
      // The drive screen asks about a station at the next stop only when the
      // car went past it at speed and close enough to see the pumps.
      const fast = metres <= DRIVE_PASS_METRES && (currentSpeed() ?? 0) > DRIVING_KMH;
      state.passed[station.id] = {
        at: now, network: station.network, address: station.address, location: station.location,
        fastAt: fast ? now : state.passed[station.id]?.fastAt || 0,
      };
    }
  }
  for (const [id, item] of Object.entries(state.passed)) {
    if (now - item.at > PASSED_KEEP_MS) delete state.passed[id];
  }
}

function applyFix(coords, { force = false, stamp = null } = {}) {
  const here = { lat: coords.latitude, lon: coords.longitude };
  const accuracy = Math.round(coords.accuracy || 0);
  const firstFix = !state.location;
  if (firstFix && accuracy > COARSE_METRES && Date.now() - state.fixStartedAt < COARSE_WAIT_MS) {
    state.pendingFix = coords;
    renderSearchContext({ waitingAccuracy: accuracy });
    return;
  }
  // A quick low-power answer can land after a precise one and drag the radius
  // back to hundreds of metres for the very same spot.
  if (!firstFix && accuracy > ROUGH_METRES && state.accuracy != null && state.accuracy <= 100
    && Date.now() - state.locationAt < 60000 && haversineKm(state.location, here) * 1000 < accuracy) {
    return;
  }
  const previous = state.location;
  const previousAccuracy = state.accuracy;
  const moved = !previous || haversineKm(previous, here) * 1000 > REQUERY_METRES;
  // A much sharper fix of the same spot still changes which stations are near.
  const sharper = Boolean(previousAccuracy && previousAccuracy > 300 && accuracy < previousAccuracy / 2);
  state.location = here;
  state.accuracy = accuracy;
  state.locationAt = Date.now();
  state.pendingFix = null;
  // Speed and heading first: a station passed at speed is noted with them.
  noteMotion(coords, stamp);
  notePassedStations(here, accuracy);
  renderMe();
  renderLocateButton();
  refreshVerdicts();
  refreshNearby();
  driveAfterFix();
  if (firstFix) {
    state.bbox = null;
    state.search = '';
    state.status = null;
    state.timeline = null;
    state.searchScope = 'device';
    state.searchLabel = null;
    state.radiusKm = 5;
    state.sort = 'nearest_available';
    $('#searchInput').value = '';
    $('#sortSelect').value = 'nearest_available';
    if (state.map) state.map.setView([here.lat, here.lon], 13);
    renderSearchContext();
    loadStationsWideningRadius();
    renderGroupFeed();
    refreshPushLocation();
    track('locate_result', { success: true, zone: analytics.zoneFor(here), reason: accuracy > 300 ? 'coarse' : 'precise' });
    return;
  }
  if ((moved || sharper || force) && state.searchScope === 'device') {
    loadStations({ silent: true });
  } else if (state.searchScope === 'far' && moved && Date.now() - (state.farCheckedAt || 0) > FAR_RECHECK_MS) {
    // Now and then see whether the phone has come within reach of the stations.
    state.searchScope = 'device';
    state.radiusKm = RADIUS_LADDER[0];
    loadStationsWideningRadius();
  } else {
    renderSearchContext();
    renderHerePanel();
  }
  if (moved) refreshPushLocation();
}

function refreshLocation({ manual = false, quiet = false } = {}) {
  if (!navigator.geolocation) return;
  // A background refresh still waiting for the GPS must never swallow a tap:
  // the person pressed the button because the place looked wrong.
  if (state.locating && !manual) return;
  const token = (state.locateToken || 0) + 1;
  state.locateToken = token;
  state.locating = true;
  if (manual) renderLocateButton();
  setTimeout(() => {
    if (state.locateToken === token && state.locating) {
      state.locating = false;
      renderLocateButton();
      if (quiet) renderLocationHelpStatus({ code: 3 });
    }
  }, 17000);
  // Two requests at once: a quick one that may reuse a fix from the last half
  // minute, and a precise fresh one. A brand-new high-accuracy fix can take
  // many seconds indoors or never come at all; the quick answer is shown
  // straight away and the precise one sharpens it when it arrives.
  let answered = false;
  let pending = 2;
  let saidRough = null;
  // Said at once, so a tap never meets silence (the precise request can take
  // its full fifteen seconds); a precise answer that comes later replaces the
  // banner rather than stacking a second one.
  const tell = () => {
    if (!manual) return;
    if (quiet) {
      renderLocationHelpStatus();
      return;
    }
    const rough = effectiveAccuracy() > ROUGH_METRES;
    if (saidRough === false || saidRough === rough) return;
    saidRough = rough;
    const confirmed = !rough && state.accuracy > ROUGH_METRES;
    showToast(
      rough ? `⚠️ Место приблизительное · ±${formatMeters(state.accuracy)}` : `📍 Место обновлено${confirmed ? '' : ` · ±${formatMeters(state.accuracy)}`}`,
      rough ? 'Нажмите — покажу, что проверить.' : 'Ближайшие АЗС — наверху списка.',
      null,
      { key: 'location', onClick: rough ? showLocationHelp : null },
    );
  };
  const onFix = ({ coords, timestamp }) => {
    pending -= 1;
    if (state.locateToken !== token) {
      applyFix(coords, { stamp: timestamp });
      return;
    }
    applyFix(coords, { force: manual && !answered, stamp: timestamp });
    if (!answered) {
      answered = true;
      state.locating = false;
      renderLocateButton();
    }
    tell();
  };
  const onError = (error) => {
    pending -= 1;
    if (answered || pending > 0 || state.locateToken !== token) return;
    state.locating = false;
    renderLocateButton();
    if (quiet) {
      renderLocationHelpStatus(error);
    } else if (manual) {
      showToast('Не удалось обновить место', error.code === 1
        ? 'Геолокация запрещена для этого сайта в настройках телефона.'
        : 'Нет сигнала. Попробуйте ещё раз через несколько секунд.', null, { key: 'location' });
    }
  };
  navigator.geolocation.getCurrentPosition(onFix, onError, { enableHighAccuracy: false, maximumAge: 30000, timeout: 6000 });
  navigator.geolocation.getCurrentPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: manual ? 0 : 20000, timeout: 15000 });
}

function startFollowing({ manual = false } = {}) {
  if (!navigator.geolocation) {
    if (manual) alert('Геолокация не поддерживается этим браузером.');
    return;
  }
  if (manual) track('locate_start');
  state.follow = true;
  state.fixStartedAt = Date.now();
  state.pendingFix = null;
  document.body.classList.add('following');
  renderLocateButton();
  // A fix's own time tells a new fix from the same one handed out again.
  const onFix = ({ coords, timestamp }) => applyFix(coords, { stamp: timestamp });
  const onError = (error) => {
    // Only a refusal ends following. A timeout or a moment without signal is
    // ordinary on the road, and switching the mode off then left people with
    // a list for a place they had long since left.
    if (error.code !== 1) {
      renderLocateButton();
      return;
    }
    state.follow = false;
    document.body.classList.remove('following');
    renderLocateButton();
    if (manual) {
      alert('Доступ к геолокации запрещён. Разрешите его для этого сайта в настройках телефона, иначе «рядом» работать не будет.');
    }
    track('locate_result', { success: false, reason: 'denied' });
  };
  // A cached fix within a minute appears instantly; the watch then refines it.
  navigator.geolocation.getCurrentPosition(onFix, onError, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  // If only coarse fixes came during the wait, use the best of them anyway.
  setTimeout(() => {
    if (state.follow && !state.location && state.pendingFix) applyFix(state.pendingFix);
  }, COARSE_WAIT_MS + 200);
  if (!state.locationTimer) {
    state.locationTimer = setInterval(() => {
      if (state.follow && !document.hidden) refreshLocation();
    }, LOCATION_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (state.follow && !document.hidden) refreshLocation();
    });
  }
  if (!state.contextTimer) {
    state.contextTimer = setInterval(() => {
      if (state.searchScope === 'device' && !document.hidden) renderSearchContext();
    }, 15000);
  }
}

function stopFollowing() {
  clearSearchScope({ keepText: false, reload: true });
}

async function loadStations({ silent = false } = {}) {
  const requestId = ++state.request;
  if (!silent || !state.stations.length) {
    $('#stationList').innerHTML = '<div class="loading-state">Собираем доказательства по АЗС…</div>';
  }
  const params = new URLSearchParams({ grade: state.grade, area: state.area, sort: state.sort, limit: '500' });
  if (state.search.trim()) params.set('q', state.search.trim());
  if (state.status) params.set('status', state.status);
  if (state.timeline) params.set('timeline', state.timeline);
  if (state.location) {
    params.set('lat', state.location.lat);
    params.set('lon', state.location.lon);
    if (state.searchScope === 'device' || state.searchScope === 'place') params.set('radius_km', state.radiusKm);
  }
  if (state.bbox) params.set('bbox', state.bbox.join(','));
  try {
    const data = await api(`/api/stations?${params}`);
    if (requestId !== state.request) return;
    state.stations = data.stations;
    state.total = Number(data.total || 0);
    $('#resultCount').textContent = data.total.toLocaleString('ru-RU');
    $('#resultNoun').textContent = `${plural(data.total, 'карточка', 'карточки', 'карточек')} АЗС`;
    renderStatusStrip(data.status_counts, data.timeline_counts);
    renderStations();
    renderMarkers();
    if (state.club.member) renderGroupFeed();
    renderDrive();
  } catch (error) {
    $('#stationList').innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message)}</div>`;
  }
}

function renderStatusStrip(counts, timelineCounts = {}) {
  const strip = $('#statusStrip');
  const appeared = timelineCounts.appeared || 0;
  const temporalChip = `<button class="status-chip timeline-filter ${state.timeline === 'appeared' ? 'active' : ''}" style="--status-color:#0d5a43" data-timeline="appeared" ${appeared ? '' : 'disabled'}>✦ Появилось недавно · ${appeared}</button>`;
  strip.innerHTML = ownChip() + temporalChip + Object.entries(STATUS).map(([key, item]) => {
    const count = counts[key] || 0;
    // A chip reading "· 0" must not be clickable: selecting it empties the
    // list and looks exactly like a broken page.
    const disabled = count === 0 && state.status !== key ? 'disabled' : '';
    return `<button class="status-chip ${state.status === key ? 'active' : ''}" style="--status-color:${item.color}" data-status="${key}" ${disabled}>${item.short} · ${count}</button>`;
  }).join('');
  strip.onclick = (event) => {
    if (event.target.closest('[data-own]')) {
      toggleOwnOnly();
      return;
    }
    const temporal = event.target.closest('[data-timeline]');
    const button = temporal ? null : event.target.closest('[data-status]');
    if (!temporal && !button) return;
    // Pressed from inside «Свои», a chip means "show me this", never "switch it off".
    const leaving = leaveOwnOnly();
    if (temporal) {
      state.timeline = !leaving && state.timeline === temporal.dataset.timeline ? null : temporal.dataset.timeline;
      track('status_filter', { filter: state.timeline || 'all' });
      loadStations();
      return;
    }
    state.status = !leaving && state.status === button.dataset.status ? null : button.dataset.status;
    track('status_filter', { filter: state.status || 'all' });
    loadStations();
  };
}

const TRUST_COLORS = { high: '#158257', moderate: '#d58a13', low: '#b8333a', conflict: '#7856c7', none: '#8a9691' };

const YANDEX_SENSE = {
  AVAILABLE: 'есть', LIKELY: 'скорее есть', LIMITED: 'есть с ограничением',
  QUEUE: 'есть, очередь', NOT_AVAILABLE: 'нет', LIKELY_NOT: 'скорее нет',
  UNKNOWN: 'не уверен',
};

// Yandex is what people compare against anyway. Showing its verdict beside
// ours — with its age and how many drivers stand behind it — is the one thing
// this app can do that neither app does alone.
function yandexLine(grade) {
  const y = grade.yandex;
  if (!y) return null;
  const said = YANDEX_SENSE[y.availability] || y.availability;
  const when = y.age_seconds != null ? formatAge(y.age_seconds) : 'время неизвестно';
  const signals = y.confirmations
    ? `${y.confirmations} ${plural(y.confirmations, 'подтверждение', 'подтверждения', 'подтверждений')}`
    : 'без подтверждений';
  return { text: `Яндекс: ${said} · ${when} · ${signals}`, agrees: y.agrees, stale: !y.fresh };
}

function yandexPanel(grade) {
  const line = yandexLine(grade);
  if (!line) {
    return `<div class="yandex-panel neutral"><strong>Яндекс Карты</strong><p>По этой АЗС у них нет данных о топливе — сравнивать не с чем.</p></div>`;
  }
  const y = grade.yandex;
  const verdict = line.agrees === true ? 'Совпадает с нашим ответом'
    : line.agrees === false ? 'Расходится с нашим ответом'
    : 'Прямого вердикта нет';
  const tone = line.agrees === true ? 'agree' : line.agrees === false ? 'disagree' : 'neutral';
  const stale = line.stale
    ? '<p class="yandex-stale">Их сигнал старше нашего окна свежести: он не создаёт вердикта, но снижает нашу уверенность.</p>'
    : '';
  return `<div class="yandex-panel ${tone}">
    <strong>Яндекс Карты · ${escapeHtml(verdict)}</strong>
    <p>${escapeHtml(line.text)}</p>
    ${stale}
    <p class="yandex-note">Это второе мнение из другого сообщества водителей. Наш ответ по ${escapeHtml(GRADE_LABELS[state.grade])} — ${escapeHtml(STATUS[grade.status].short.toLowerCase())}, ${grade.probability_percent}% за наличие по ${(grade.votes || []).length} ${plural((grade.votes || []).length, 'источнику', 'источникам', 'источникам')}.</p>
  </div>`;
}

function votePanel(grade) {
  const votes = grade.votes || [];
  if (!votes.length) return '';
  const chance = grade.probability_percent;
  const rows = votes.map((vote) => {
    const positive = vote.direction > 0;
    const share = Math.round(Math.min(100, (vote.weight / 1.2) * 100));
    const note = vote.expired ? ' · просрочен, учтён с понижением' : '';
    return `<div class="vote-row${vote.expired ? ' expired' : ''}">
      <span class="vote-side ${positive ? 'yes' : 'no'}">${positive ? 'за' : 'против'}</span>
      <span class="vote-name">${escapeHtml(vote.source || '')}<small>${escapeHtml(KIND_LABELS[vote.kind] || vote.kind || '')} · ${escapeHtml(formatAge(vote.age_seconds))}${note}</small></span>
      <span class="vote-bar"><span style="width:${Math.max(6, share)}%"></span></span>
    </div>`;
  }).join('');
  return `<div class="vote-panel">
    <div class="trust-head"><span class="trust-kicker">Как считался ответ</span><strong>${chance}% за то, что топливо есть</strong></div>
    <p>Голоса всех свежих источников, взвешенные по типу сигнала, его возрасту и числу подтверждений. Копии одного и того же upstream считаются один раз. Недавно просроченный сигнал против ответа не создаёт своего вердикта, но снижает уверенность.</p>
    <div class="vote-list">${rows}</div>
  </div>`;
}

function trustPanel(grade) {
  const score = Number(grade.trust_score || 0);
  const tier = grade.trust_tier || 'none';
  const sources = grade.fresh_source_count ?? grade.fresh_provenance_count ?? 0;
  const independent = grade.independent_agreeing_count ?? 0;
  const total = grade.source_count ?? 0;
  const rows = [
    ['Свежих источников', `${sources} из ${total}`],
    ['Независимо подтвердили', String(independent)],
    ['Возраст сигнала', formatAge(grade.age_seconds)],
  ];
  return `<div class="trust-panel" style="--trust-color:${TRUST_COLORS[tier]}">
    <div class="trust-head"><span class="trust-kicker">Достоверность ответа</span><strong>${score}% · ${escapeHtml(grade.trust_label || 'нет данных')}</strong></div>
    <div class="trust-bar"><span style="width:${Math.max(2, Math.min(100, score))}%"></span></div>
    <dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <p>Это оценка качества данных: тип сигнала, число независимых источников и то, сколько времени прошло. Она не измеряет остаток в резервуаре.</p>
  </div>`;
}

const GRADE_MARK = {
  CAN_REFUEL: { sign: '✓', tone: 'yes' },
  LIKELY_AVAILABLE: { sign: '✓', tone: 'likely' },
  LIMITED: { sign: '✓', tone: 'limited' },
  CONFLICT: { sign: '?', tone: 'conflict' },
  LIKELY_NOT: { sign: '✕', tone: 'no' },
  CONFIRMED_NO: { sign: '✕', tone: 'no' },
  NO_FRESH_DATA: { sign: '—', tone: 'unknown' },
};
const RISK_TONE = { low: '#158257', medium: '#d58a13', high: '#b8333a' };
const DECISION_TONE = { GO: '#158257', GO_WITH_WAIT: '#77a827', RISKY: '#d58a13', UNKNOWN: '#8a9691', NO: '#b8333a' };

// Chips answer one question — which grades this station has — so they carry no
// price. Rounding it to whole roubles printed "71₽" beside a footer reading
// "70,90 ₽/л", and two different numbers for one price is what made the card
// look wrong. The price is stated once, exactly, with its source count.
function gradeChips(station) {
  const brief = (state.gradesBrief || {})[station.id] || {};
  return Object.keys(GRADE_LABELS).map((grade) => {
    const status = grade === state.grade
      ? station.grade.status
      : (brief[grade]?.s || 'NO_FRESH_DATA');
    const mark = GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA;
    const selected = grade === state.grade ? ' selected' : '';
    const label = GRADE_LABELS[grade].replace('АИ-', '');
    const hint = `${GRADE_LABELS[grade]}: ${STATUS[status]?.short || ''}`;
    return `<span class="grade-chip ${mark.tone}${selected}" title="${escapeHtml(hint)}">${mark.sign} ${escapeHtml(label)}</span>`;
  }).join('');
}

function timelineBadge(timeline) {
  if (!timeline || ['NO_HISTORY', 'OBSERVED', 'OUTDATED_HISTORY', 'APPEARING_UNCONFIRMED'].includes(timeline.state)) return null;
  if (timeline.state === 'FLAPPING') return { text: '〰 Сигналы мигают', tone: 'negative' };
  if (['JUST_APPEARED', 'RECENTLY_APPEARED'].includes(timeline.state)) return { text: `✦ ${timeline.label}`, tone: 'fresh' };
  if (timeline.state === 'RECENTLY_DISAPPEARED') return { text: timeline.label, tone: 'negative' };
  if (timeline.state === 'OBSERVED_AVAILABLE' || timeline.state === 'AVAILABLE_CONTINUOUS') return { text: `Есть непрерывно ${formatDuration(timeline.duration_seconds)}`, tone: 'stable' };
  if (timeline.state === 'OBSERVED_UNAVAILABLE' || timeline.state === 'UNAVAILABLE_CONTINUOUS') return { text: `Нет непрерывно ${formatDuration(timeline.duration_seconds)}`, tone: 'negative' };
  return null;
}

function factsFor(station) {
  const grade = station.grade;
  const advice = grade.advice || {};
  return advice.summary || (grade.status === 'NO_FRESH_DATA' ? 'нет свежего сигнала по этой марке' : '');
}

function metaFor(station) {
  const grade = station.grade;
  const votes = (grade.votes || []).length;
  const parts = [];
  if (votes) parts.push(`${votes} ${plural(votes, 'источник', 'источника', 'источников')} проголосовали`);
  // A source that never says when it saw anything cannot be presented as
  // minutes old just because we polled it a minute ago.
  parts.push(grade.source_note || (grade.undated_only ? 'источник не сообщает времени' : formatAge(grade.age_seconds)));
  if (grade.price_rub != null) {
    const sources = grade.price_sources ?? 0;
    const value = `${grade.price_rub.toFixed(2).replace('.', ',')} ₽/л`;
    parts.push(sources >= 2
      ? `${GRADE_LABELS[state.grade]} ${value} по ${sources} ${plural(sources, 'источнику', 'источникам', 'источникам')}`
      : `${GRADE_LABELS[state.grade]} ${value} — цена не подтверждена`);
  }
  return parts.join(' · ');
}

function handshakes(count) {
  return `${count} ${plural(Number(count) || 0, 'рукопожатие', 'рукопожатия', 'рукопожатий')}`;
}

function plural(count, one, few, many) {
  const tail = count % 10;
  const hundred = count % 100;
  if (hundred >= 11 && hundred <= 14) return many;
  if (tail === 1) return one;
  if (tail >= 2 && tail <= 4) return few;
  return many;
}


// A phone should not receive 500 detailed cards at once: the list renders in
// pages and grows on demand.
const PAGE_SIZE = 40;

function resetFilters() {
  // «Рядом» is a filter as well. Left running, the next fix from the phone put
  // the radius back a second later, and a phone far from any station we know
  // was sent straight back to an empty list (13 Sep 2026).
  clearSearchScope({ keepText: false, reload: false });
  state.ownOnly = false;
  state.search = '';
  state.status = null;
  state.timeline = null;
  state.area = 'all';
  state.bbox = null;
  state.location = null;
  state.searchScope = null;
  state.searchLabel = null;
  state.sort = 'status';
  $('#searchInput').value = '';
  $('#sortSelect').value = 'status';
  $$('[data-area]').forEach((item) => item.classList.toggle('active', item.dataset.area === 'all'));
  renderSearchContext();
  loadStations();
}

// Confirming from the forecourt is the one observation nobody else has: the
// driver is looking at the pump. It is kept on this device — the published site
// is a static file and has nowhere to send it — and it outranks every remote
// source for the person who made it, because they saw it themselves.
const MARK_STORE = 'spbfi-marks-v1';
const MARK_TTL_MS = 3 * 3600 * 1000;

function loadMarks() {
  try {
    const raw = JSON.parse(localStorage.getItem(MARK_STORE) || '{}');
    const now = Date.now();
    for (const [station, grades] of Object.entries(raw)) {
      for (const [grade, mark] of Object.entries(grades)) {
        if (now - mark.at > MARK_TTL_MS) delete grades[grade];
      }
      if (!Object.keys(grades).length) delete raw[station];
    }
    return raw;
  } catch {
    return {};
  }
}

function saveMark(stationId, grade, seen, queue = null, { render = true, notify = true, summary = '', blindSpot = false, share = true } = {}) {
  const station = state.stationDetails[stationId] || state.stations.find((item) => item.id === stationId);
  const onSite = !!(state.location && station?.location && haversineKm(state.location, station.location) <= 0.5);
  track('report_sent', { station: stationId, grade, seen, queue, reason: onSite ? 'on_site' : 'remote', zone: analytics.zoneFor(station?.location) });
  if (onSite) track('report_outcome', { ...analytics.predictionFields(station, grade), seen, queue, reason: 'on_site' });
  const marks = loadMarks();
  marks[stationId] = marks[stationId] || {};
  marks[stationId][grade] = { seen, at: Date.now(), queue };
  try {
    localStorage.setItem(MARK_STORE, JSON.stringify(marks));
  } catch {
    // Private mode or a full quota: the mark simply is not kept.
  }
  state.marks = marks;
  state.groupMarks = state.groupMarks || {};
  state.groupMarks[stationId] = state.groupMarks[stationId] || {};
  state.groupMarks[stationId][grade] = { seen, at: Date.now(), queue, people: [myId()], names: state.club.member?.name ? [state.club.member.name] : [] };
  if (render) {
    renderStations();
    renderHerePanel();
    renderGroupFeed();
  }
  return share ? shareMark(stationId, grade, seen, queue, { notify, summary, blindSpot }) : Promise.resolve('kept');
}

// Sharing is optional. With no endpoint configured the mark stays on this
// device and everything else works exactly as before.
const DEVICE_ID = 'spbfi-device-v1';
const GROUP_KEY = 'spbfi-group-key-v1';

function deviceId() {
  let id = localStorage.getItem(DEVICE_ID);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(DEVICE_ID, id); } catch { /* nothing to keep it in */ }
  }
  return id;
}

// Reports from one phone go out one at a time. The worker kept every mark in
// one list and rewrote it on each report, so three grades sent at once raced
// and only the last survived (13 Sep 2026: 92, 95 and 98 marked, 98 kept). A
// worker that says it takes batches gets a whole look in one request; an older
// one gets the grades one after another.
let reportQueue = Promise.resolve();

// What the worker says when it could not store something, in words for people.
const STORAGE_ERRORS = {
  storage_limit: 'У клуба на сегодня кончился бесплатный лимит записей. В 03:00 по Москве он обнулится.',
  storage_busy: 'Сервер клуба перегружен. Попробуйте ещё раз через минуту.',
  worker_error: 'На сервере клуба сбой. Попробуйте ещё раз через минуту.',
  moving: 'Сервер клуба переезжает. Через несколько минут всё заработает.',
};

// A mark that could not go out — no signal at the pump, the server down for a
// moment — waits on the phone and is sent once the connection is back, dated
// the moment it was made. A worker that says it takes late marks keeps them
// for half an hour; an older one dates a mark on arrival, so for it a mark
// waits five minutes at most.
const OUTBOX_KEY = 'spbfi-outbox-v1';
const OUTBOX_LATE_MS = 30 * 60 * 1000;
const OUTBOX_LEGACY_MS = 5 * 60 * 1000;
let outboxWarned = false;
let outboxFlushing = false;

function shareMark(stationId, grade, seen, queue = null, options = {}) {
  return shareLook(stationId, [{ grade, seen }], queue, options);
}

/** Sends a look. Resolves to 'sent', 'queued' (waits for a connection), 'refused' or 'kept' (nowhere to send). */
function shareLook(stationId, looks, queue = null, { notify = true, summary = '', blindSpot = false } = {}) {
  const endpoint = window.SPBFI_REPORT_ENDPOINT;
  if (!endpoint || !looks.length) return Promise.resolve('kept');
  const known = state.stations.find((item) => item.id === stationId) || state.stationInfo[stationId];
  const place = known?.location || (known?.lat != null ? { lat: known.lat, lon: known.lon } : null);
  const common = {
    station: stationId, who: myId(), lat: place?.lat, lon: place?.lon,
    name: known?.network || '', address: shortAddress(known?.address || ''),
    observed_at: Date.now(),
    ...(queue != null ? { queue } : {}),
  };
  const bodies = looks.length === 1 || state.workerBatch
    ? [{
      ...common,
      ...(looks.length === 1 ? looks[0] : { grades: looks }),
      notify, summary, ...(blindSpot ? { blind_spot: true } : {}),
    }]
    : looks.map((look, index) => ({
      ...common, ...look,
      notify: notify && index === 0, summary: index === 0 ? summary : '',
      ...(blindSpot && index === 0 ? { blind_spot: true } : {}),
    }));
  // A newer look makes a waiting older one about the same grades pointless.
  trimOutbox(stationId, looks.map((look) => look.grade));
  const run = async () => {
    for (const [index, body] of bodies.entries()) {
      const outcome = await postReport(endpoint, body);
      if (outcome === 'sent') continue;
      if (outcome === 'retry') {
        bodies.slice(index).forEach(waitInOutbox);
        warnWaiting();
        return 'queued';
      }
      return 'refused';
    }
    return 'sent';
  };
  reportQueue = reportQueue.then(run, run);
  return reportQueue;
}

/** One report to the worker: 'sent', 'retry' (worth another go later) or 'refused'. */
async function postReport(endpoint, body) {
  let legacyKey = '';
  try { legacyKey = localStorage.getItem(GROUP_KEY) || ''; } catch { /* nothing stored */ }
  let response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, '')}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...memberHeaders(), ...(legacyKey ? { 'X-Group-Key': legacyKey } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    // No signal, or the worker could not be reached at all.
    return 'retry';
  }
  let data = {};
  try { data = await response.json(); } catch { /* not JSON */ }
  if (response.ok) {
    if (data.rewards) celebrate(data.rewards);
    return 'sent';
  }
  if (response.status === 401 || response.status === 403) {
    // The club may have been switched on after this page was opened.
    if (!state.club.enabled) {
      checkClub();
      return 'refused';
    }
    if (!handleClubRejection({ status: response.status, data })) {
      showToast('Отметка не отправлена', 'Она сохранена только на этом телефоне.');
    }
    return 'refused';
  }
  if (data.error === 'storage_limit') {
    showToast('Отметка не ушла к своим', `${STORAGE_ERRORS.storage_limit} На этом телефоне отметка сохранена.`);
    return 'refused';
  }
  if (data.error === 'moving' && !outboxWarned) {
    // Writes stop for a few minutes while the club's server moves; the mark
    // waits here and goes to the new address once the app has it.
    outboxWarned = true;
    showToast('Сервер клуба переезжает', 'Отметка сохранена на телефоне и уйдёт сама через несколько минут.');
  }
  // Too many at once, or the server busy or down: worth another go shortly.
  return response.status === 429 || response.status >= 500 ? 'retry' : 'refused';
}

function loadOutbox() {
  try {
    const items = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(items) ? items.filter((body) => body?.station && Number.isFinite(body.observed_at)) : [];
  } catch {
    return [];
  }
}

function storeOutbox(items) {
  try {
    if (items.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-20)));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch { /* nothing to keep it in */ }
}

function waitInOutbox(body) {
  storeOutbox([...loadOutbox(), body]);
}

function trimOutbox(stationId, grades) {
  const waiting = loadOutbox();
  const kept = waiting.flatMap((body) => {
    if (body.station !== stationId) return [body];
    if (!Array.isArray(body.grades)) return grades.includes(body.grade) ? [] : [body];
    const left = body.grades.filter((look) => !grades.includes(look.grade));
    return left.length ? [{ ...body, grades: left }] : [];
  });
  if (JSON.stringify(kept) !== JSON.stringify(waiting)) storeOutbox(kept);
}

function warnWaiting() {
  if (!outboxWarned) {
    outboxWarned = true;
    showToast('Нет связи со своими', 'Отметка сохранена на телефоне и уйдёт сама, как только появится интернет.');
  }
  renderGroupFeed();
}

function flushOutbox() {
  const endpoint = window.SPBFI_REPORT_ENDPOINT;
  if (!endpoint || outboxFlushing || !loadOutbox().length) return reportQueue;
  outboxFlushing = true;
  const run = async () => {
    let sent = 0;
    let expired = 0;
    try {
      for (;;) {
        const [body] = loadOutbox();
        if (!body) break;
        const key = JSON.stringify(body);
        const drop = () => storeOutbox(loadOutbox().filter((item) => JSON.stringify(item) !== key));
        if (Date.now() - body.observed_at > (state.workerLateMarks ? OUTBOX_LATE_MS : OUTBOX_LEGACY_MS)) {
          drop();
          expired += 1;
          continue;
        }
        const outcome = await postReport(endpoint, body);
        if (outcome === 'retry') break;
        drop();
        if (outcome === 'sent') sent += 1;
      }
    } finally {
      outboxFlushing = false;
    }
    if (sent) showToast(`✔ ${sent === 1 ? 'Отметка ушла' : `Отметки ушли (${sent})`} к своим`, 'Связь появилась — отправлено со временем, когда вы отмечали.');
    else if (expired) showToast('Отметка так и не ушла', 'Связи долго не было, и отметка устарела. На этом телефоне она сохранена.');
    if (!loadOutbox().length) outboxWarned = false;
    renderGroupFeed();
  };
  reportQueue = reportQueue.then(run, run);
  return reportQueue;
}

function outboxNote() {
  const waiting = loadOutbox().length;
  if (!waiting) return '';
  const words = waiting === 1
    ? 'Ваша отметка ждёт связи и уйдёт сама'
    : `${waiting} ${plural(waiting, 'отметка ждёт', 'отметки ждут', 'отметок ждут')} связи и уйдут сами`;
  return `<div class="feed-outbox">⏳ ${escapeHtml(words)}, как только появится интернет.</div>`;
}

window.addEventListener('online', () => flushOutbox());

// Marks the group filed in the last 45 minutes, read straight from the
// worker. The pipeline folds the same reports into the vote ten minutes
// later; reading them here means a mark is visible to everyone at once.
const GROUP_MARK_TTL_MS = 45 * 60 * 1000;

async function pollGroupMarks() {
  const endpoint = window.SPBFI_REPORT_ENDPOINT;
  if (!endpoint) return;
  try {
    // Members read the club's copy, with names; anyone else the anonymous one.
    const inside = state.club.enabled && !!clubToken();
    const response = await fetch(`${endpoint.replace(/\/$/, '')}${inside ? '/club/reports' : '/reports'}`, { cache: 'no-store', headers: inside ? memberHeaders() : {} });
    if (!response.ok) {
      if (inside && (response.status === 401 || response.status === 403)) {
        let data = {};
        try { data = await response.json(); } catch { /* not JSON */ }
        handleClubRejection({ status: response.status, data });
      }
      return;
    }
    const payload = await response.json();
    state.workerBatch = payload.batch === true;
    state.workerLateMarks = payload.late_marks === true;
    flushOutbox();
    const cutoff = Date.now() - OWN_WINDOW_MS;
    const marks = {};
    for (const report of payload.reports || []) {
      if (!report || report.at < cutoff || !report.station || !report.grade) continue;
      const slot = (marks[report.station] = marks[report.station] || {});
      const current = slot[report.grade];
      const people = new Set(current?.people || []);
      people.add(report.who || '?');
      const names = new Set(current?.names || []);
      if (report.name) names.add(`${report.level_icon ? `${report.level_icon} ` : ''}${report.name}`);
      if (!current || report.at > current.at) {
        slot[report.grade] = {
          seen: !!report.seen, at: report.at, queue: report.queue, people: [...people], names: [...names],
          who: report.who, authorName: report.name || '', thanks: report.thanks || 0, thanked: !!report.thanked,
          up: report.up || 0, down: report.down || 0, myVote: report.my_vote || null,
        };
      } else {
        current.people = [...people];
        current.names = [...names];
      }
    }
    // What this device filed stays visible even before the worker echoes it
    // back (or if the shared word was wrong and it never will).
    for (const [stationId, grades] of Object.entries(loadMarks())) {
      for (const [grade, mine] of Object.entries(grades)) {
        if (mine.at < cutoff) continue;
        const slot = (marks[stationId] = marks[stationId] || {});
        if (!slot[grade] || slot[grade].at < mine.at) {
          slot[grade] = { seen: mine.seen, at: mine.at, queue: mine.queue ?? null, people: [myId()], names: state.club.member?.name ? [state.club.member.name] : [] };
        }
      }
    }
    const changed = JSON.stringify(marks) !== JSON.stringify(state.groupMarks || {});
    const previous = state.groupMarks || {};
    state.groupMarks = marks;
    if (changed && state.stations.length) renderStations();
    renderGroupFeed();
    updateOwnChip();
    if (state.ownOnly && changed) renderMarkers();
    if (changed) announceNewMarks(previous, marks);
    if (changed) renderDrive();
  } catch {
    // Offline or the worker is down; the pipeline's copy still arrives.
    renderGroupFeed();
  }
}

// Name and place for a station that may not be in the loaded list: the
// details file already exists for every station, so one small fetch per
// reported station is enough.
async function stationInfo(id) {
  if (state.stationInfo[id]) return state.stationInfo[id];
  const local = state.stations.find((item) => item.id === id);
  if (local) {
    state.stationInfo[id] = { network: local.network, address: local.address, lat: local.location.lat, lon: local.location.lon };
    return state.stationInfo[id];
  }
  try {
    const station = await api(`/api/stations/${encodeURIComponent(id)}`);
    state.stationInfo[id] = { network: station.network, address: station.address, lat: Number(station.location.lat), lon: Number(station.location.lon) };
  } catch {
    state.stationInfo[id] = { network: 'АЗС', address: '' };
  }
  return state.stationInfo[id];
}

// What the group has seen, at the top of the page, whichever district the
// reader is in: the one block that does not depend on filters or the list.
async function renderGroupFeed() {
  const box = $('#groupFeed');
  if (!box) return;
  const now = Date.now();
  const order = Object.keys(GRADE_LABELS);
  const entries = Object.entries(state.groupMarks || {}).map(([stationId, grades]) => {
    const items = Object.entries(grades)
      .filter(([grade, mark]) => GRADE_LABELS[grade] && now - mark.at <= GROUP_MARK_TTL_MS)
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    if (!items.length) return null;
    const latest = Math.max(...items.map(([, mark]) => mark.at));
    const queue = items.map(([, mark]) => mark.queue).find((value) => value != null);
    const people = new Set(items.flatMap(([, mark]) => mark.people || [])).size;
    const names = [...new Set(items.flatMap(([, mark]) => mark.names || []))].filter(Boolean);
    return { stationId, items, latest, queue, people, names };
  }).filter(Boolean).sort((a, b) => b.latest - a.latest).slice(0, 8);
  if (!entries.length) {
    box.innerHTML = `${clubJoinLine()}${outboxNote()}<div class="feed-empty">👁 <strong>Свои сообщают:</strong> за последние 45 минут отметок нет. Видите АЗС — откройте её карточку и отметьте, что на колонках.${pushButton()}</div>${ownLink()}${scoutHint()}`;
    bindPushButton(box);
    bindScout(box);
    bindOwnLink(box);
    bindClubJoinLine(box);
    return;
  }
  await Promise.all(entries.map((entry) => stationInfo(entry.stationId)));
  const cards = entries.map((entry) => {
    const info = state.stationInfo[entry.stationId] || {};
    const distance = state.location && info.lat != null ? formatDistance(haversineKm(state.location, { lat: info.lat, lon: info.lon })) : '';
    const grades = entry.items.map(([grade, mark]) => `<span class="feed-grade ${mark.seen ? 'yes' : 'no'}">${escapeHtml(GRADE_LABELS[grade].replace('АИ-', ''))} ${mark.seen ? '✓' : '✗'}</span>`).join('');
    const queue = queueWords(entry.queue);
    const who = entry.names.length ? entry.names.join(', ') : entry.people > 1 ? `${entry.people} ${plural(entry.people, 'человек', 'человека', 'человек')}` : null;
    const meta = [who, formatAge((now - entry.latest) / 1000), distance || null].filter(Boolean).join(' · ');
    return `<div class="feed-item" role="button" tabindex="0" data-feed-station="${escapeHtml(entry.stationId)}">
      <span class="feed-title"><strong>${escapeHtml(displayNetwork(info.network))}</strong><span class="feed-meta">${escapeHtml(meta)}</span></span>
      <span class="feed-address">${escapeHtml(shortAddress(info.address || ''))}</span>
      <span class="feed-grades">${grades}${queue ? `<span class="feed-queue">очередь: ${escapeHtml(queue)}</span>` : ''}</span>
      ${thanksButton(entry.stationId)}
      ${verdictButtons(entry.stationId)}
    </div>`;
  }).join('');
  box.innerHTML = `<div class="feed-head">👁 Свои сообщают <small>за последние 45 минут · это самые точные данные в приложении</small>${pushButton()}</div>${clubJoinLine()}${outboxNote()}<div class="feed-list">${cards}</div>${ownLink()}${scoutHint()}`;
  box.querySelectorAll('[data-feed-station]').forEach((item) => {
    item.addEventListener('click', (event) => {
      if (event.target.closest('.thanks-button, .look-votes')) return;
      openStation(item.dataset.feedStation);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.target.closest('.thanks-button, .look-votes')) openStation(item.dataset.feedStation);
    });
  });
  bindThanks(box);
  bindVerdicts(box);
  bindScout(box);
  bindOwnLink(box);
  bindPushButton(box);
  bindClubJoinLine(box);
}

// A mark someone else just filed nearby is worth interrupting for: a banner
// slides in at the top while the app is open, with a buzz where the phone
// allows it. (Nothing arrives while the app is closed — that needs a push
// channel, which is a separate decision.)
const ANNOUNCE_RADIUS_KM = 7;
const seenAnnouncements = new Set();

async function announceNewMarks(previous, marks) {
  const me = myId();
  const fresh = [];
  for (const [stationId, grades] of Object.entries(marks)) {
    for (const [grade, mark] of Object.entries(grades)) {
      if (!GRADE_LABELS[grade]) continue;
      const before = previous[stationId]?.[grade];
      const isNew = !before || mark.at > before.at;
      const mine = (mark.people || []).length === 1 && mark.people[0] === me;
      const key = `${stationId}:${grade}:${mark.at}`;
      if (!isNew || mine || seenAnnouncements.has(key)) continue;
      seenAnnouncements.add(key);
      fresh.push({ stationId, grade, mark });
    }
  }
  if (!fresh.length) return;
  // The first poll after opening is catch-up, not news.
  if (!Object.keys(previous).length) return;
  const byStation = new Map();
  for (const item of fresh) {
    const slot = byStation.get(item.stationId) || [];
    slot.push(item);
    byStation.set(item.stationId, slot);
  }
  for (const [stationId, items] of byStation) {
    const info = await stationInfo(stationId);
    const distanceKm = state.location && info.lat != null ? haversineKm(state.location, { lat: info.lat, lon: info.lon }) : null;
    if (distanceKm != null && distanceKm > ANNOUNCE_RADIUS_KM) continue;
    const grades = items.map(({ grade, mark }) => `${GRADE_LABELS[grade].replace('АИ-', '')} ${mark.seen ? 'есть' : 'нет'}`).join(', ');
    const queue = queueWords(items.map(({ mark }) => mark.queue).find((value) => value != null));
    const where = [shortAddress(info.address || ''), distanceKm != null ? formatDistance(distanceKm) : null].filter(Boolean).join(' · ');
    const names = [...new Set(items.flatMap(({ mark }) => mark.names || []))].filter(Boolean);
    showToast(`👁 ${names.length ? names.join(', ') : 'Свой отметил'}: ${info.network || 'АЗС'} — ${grades}${queue ? `, очередь: ${queue}` : ''}`, where, stationId);
  }
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

function showToast(title, subtitle, stationId, { key = '', onClick = null } = {}) {
  const stack = $('#toastStack');
  if (!stack) return;
  // Five taps on «обновить» stacked five identical banners over the whole
  // screen (14 Sep 2026). A banner of the same kind, or with the same words,
  // replaces the one before it, and three are all a phone screen shows.
  const signature = key || `${title}\n${subtitle || ''}`;
  stack.querySelectorAll('.toast').forEach((old) => { if (old.dataset.signature === signature) old.remove(); });
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'toast';
  toast.dataset.signature = signature;
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}`;
  toast.addEventListener('click', () => {
    toast.remove();
    if (onClick) onClick();
    else if (stationId) openStation(stationId);
  });
  stack.prepend(toast);
  [...stack.querySelectorAll('.toast')].slice(3).forEach((extra) => extra.remove());
  setTimeout(() => toast.classList.add('show'), 20);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 12000);
}

// Push: the phone hears about a mark with the app closed. Web Push is the
// browser's own channel; the worker signs and encrypts each message and the
// phone's push service delivers it. On iPhone this exists only for the app
// installed on the home screen (iOS 16.4+), never for a Safari tab.
const PUSH_FLAG = 'spbfi-push-v1';
// Each location update is a KV write on a plan with 1,000 a day, so only a
// real move after a real pause is worth one.
const PUSH_LOCATION_MS = 30 * 60 * 1000;
const PUSH_LOCATION_KM = 2;
let pushLocationSentAt = 0;
let pushLocationSentFrom = null;

function pushSupported() {
  return !!(window.SPBFI_REPORT_ENDPOINT && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
}

function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function pushState() {
  if (!window.SPBFI_REPORT_ENDPOINT) return 'unavailable';
  if (!pushSupported()) return platformInfo().iOS && !standalone() ? 'install-first' : 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(PUSH_FLAG) === 'on' && Notification.permission === 'granted' ? 'on' : 'off';
}

async function postSubscription(subscription) {
  const endpoint = window.SPBFI_REPORT_ENDPOINT.replace(/\/$/, '');
  const response = await fetch(`${endpoint}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...memberHeaders() },
    body: JSON.stringify({ subscription: subscription.toJSON(), who: myId(), lat: state.location?.lat, lon: state.location?.lon }),
  });
  if (response.status === 401 || response.status === 403) {
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    handleClubRejection({ status: response.status, data });
    throw new Error('уведомления получают только участники клуба');
  }
  if (!response.ok) throw new Error(`приёмник ответил ${response.status}`);
  pushLocationSentAt = Date.now();
  pushLocationSentFrom = state.location ? { ...state.location } : null;
}

async function enablePush() {
  const status = pushState();
  if (status === 'install-first') {
    alert('На iPhone уведомления работают только у приложения на главном экране: Поделиться → «На экран „Домой“», затем откройте его оттуда и нажмите эту кнопку снова.');
    return;
  }
  if (status === 'unavailable') {
    alert('Этот браузер не умеет push-уведомления. На телефоне установите приложение на главный экран.');
    return;
  }
  if (status === 'denied') {
    alert('Уведомления запрещены для этого сайта в настройках телефона. Разрешите их там и нажмите снова.');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { renderGroupFeed(); return; }
    const registration = await navigator.serviceWorker.ready;
    const vapid = await (await fetch(`${window.SPBFI_REPORT_ENDPOINT.replace(/\/$/, '')}/vapid`, { cache: 'no-store' })).json();
    const raw = atob(String(vapid.publicKey).replace(/-/g, '+').replace(/_/g, '/'));
    const applicationServerKey = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const subscription = (await registration.pushManager.getSubscription()) || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await postSubscription(subscription);
    localStorage.setItem(PUSH_FLAG, 'on');
    showToast('🔔 Уведомления включены', 'Когда свой отметит АЗС в 7 км от вас, телефон сообщит — даже с закрытым приложением.');
  } catch (error) {
    alert(`Не удалось включить уведомления: ${error.message}`);
  }
  renderGroupFeed();
}

async function disablePush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch(`${window.SPBFI_REPORT_ENDPOINT.replace(/\/$/, '')}/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {});
      await subscription.unsubscribe();
    }
  } catch { /* nothing to undo */ }
  localStorage.removeItem(PUSH_FLAG);
  renderGroupFeed();
}

// The worker only wakes phones near the station; it needs to know roughly
// where each phone is.
async function refreshPushLocation() {
  if (pushState() !== 'on' || !state.location || Date.now() - pushLocationSentAt < PUSH_LOCATION_MS) return;
  if (pushLocationSentFrom && haversineKm(pushLocationSentFrom, state.location) < PUSH_LOCATION_KM) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await postSubscription(subscription);
  } catch { /* next fix tries again */ }
}

function pushButton() {
  const status = pushState();
  if (status === 'unavailable') return '';
  if (status === 'on') return '<button type="button" class="push-button on" data-push="off">🔔 Уведомления включены</button>';
  return '<button type="button" class="push-button" data-push="on">🔔 Уведомлять о своих</button>';
}

function bindPushButton(root) {
  root.querySelectorAll('[data-push]').forEach((button) => button.addEventListener('click', () => (button.dataset.push === 'on' ? enablePush() : disablePush())));
}

// ---------------------------------------------------------------- club rewards

// Litres, levels, badges and thank-yous. The server keeps the score; the
// phone's job is to make earning it feel good and to say thanks easily.
const NEWS_KEY = 'spbfi-club-news-at-v1';
// Merged into CLUB_ERRORS once that table exists (see the club section).
const REWARD_ERRORS = {
  already_thanked: 'Вы уже сказали спасибо за эту отметку.',
  cannot_thank_self: 'Себе спасибо сказать нельзя 🙂',
  mark_gone: 'Этой отметки уже нет: она устарела или её удалили.',
  too_many_thanks: 'На сегодня хватит «спасибо» — завтра можно снова.',
  expected_text: 'Напишите, за что благодарность.',
  member_unknown: 'Такого участника нет.',
};

function burst(symbol = '⛽') {
  // Nothing flies over the drive screen: there only the sheet and the target move.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('driving')) return;
  const layer = document.createElement('div');
  layer.className = 'burst';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 16; i += 1) {
    const piece = document.createElement('span');
    piece.textContent = symbol;
    piece.style.left = `${6 + Math.random() * 88}%`;
    piece.style.animationDelay = `${Math.random() * 0.45}s`;
    piece.style.fontSize = `${20 + Math.random() * 20}px`;
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2800);
}

let celebration = null;
let celebrationTimer = null;

// A composer sends one request per grade; the answers are gathered and shown
// as one moment instead of five banners.
function celebrate(rewards) {
  celebration = celebration || { liters: 0, confirmed: new Set(), badges: [], levelUp: null, total: null, level: null };
  celebration.liters += rewards.liters || 0;
  (rewards.confirmed || []).filter(Boolean).forEach((name) => celebration.confirmed.add(name));
  celebration.badges.push(...(rewards.badges || []));
  celebration.levelUp = rewards.level_up || celebration.levelUp;
  if (rewards.total != null) celebration.total = rewards.total;
  if (rewards.level) celebration.level = rewards.level;
  clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(() => {
    const moment = celebration;
    celebration = null;
    if (moment.level && moment.total != null) {
      state.club.profile = { ...(state.club.profile || {}), liters: moment.total, level: moment.level };
      renderClubButton();
    }
    if (moment.levelUp) {
      burst('🎉');
      showToast(`🎉 Новый уровень: ${moment.levelUp.icon} ${moment.levelUp.title}`, `У вас ${handshakes(moment.total)}. Своим с вами везёт!`);
    }
    moment.badges.forEach((badge, index) => {
      setTimeout(() => {
        burst(badge.icon);
        showToast(`${badge.icon} Новый значок: ${badge.title}`, 'Все значки — в разделе «Клуб».');
      }, 700 * (index + 1));
    });
    if (moment.confirmed.size) {
      showToast(`✅ Вы подтвердили: ${[...moment.confirmed].join(', ')}`, 'Им +3 🤝 за точность — спасибо, что проверили.');
    }
    if (moment.liters > 0 && !moment.levelUp) {
      const next = moment.level?.next;
      showToast(`+${moment.liters} 🤝 спасибо за отметку`, next ? `Всего ${handshakes(moment.total)} · до «${next.title}» ещё ${next.left} 🤝` : `Всего ${handshakes(moment.total)}`);
    }
  }, 900);
}

function newsSince() {
  try { return Number(localStorage.getItem(NEWS_KEY)) || 0; } catch { return 0; }
}

// What happened to this member while the app was closed or in the background:
// thanks, confirmations, badges. Replayed as banners, once.
function handleNews(news = [], now = Date.now()) {
  const since = newsSince();
  try { localStorage.setItem(NEWS_KEY, String(now)); } catch { /* nothing to keep it in */ }
  if (!since) return;
  const all = news.filter((item) => item.at > since && !['mark', 'first_seen'].includes(item.type));
  // A warning is never folded into a summary of good news.
  const warning = all.filter((item) => item.type === 'warning').pop();
  if (warning) {
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    showToast('⚠️ С вашими отметками не согласны', `${warning.people} ${plural(warning.people, 'человек', 'человека', 'человек')} на заправках поставили 👎. Отмечайте только то, что видите сами: после пяти — выбывание из клуба.`);
  }
  // Nor is a mark the owner took down. The phone forgets its own copy of it,
  // which would otherwise go on showing what nobody else sees.
  const removed = all.filter((item) => item.type === 'mark_removed');
  if (removed.length) {
    removed.forEach((item) => forgetLook({ station: item.station, author: myId(), at: item.mark_at }));
    redrawMarks();
    showToast('🗑 Владелец удалил вашу отметку', 'Её больше не видят свои.', removed[removed.length - 1].station);
  }
  const items = all.filter((item) => !['warning', 'mark_removed'].includes(item.type));
  if (!items.length) return;
  if (items.length > 3) {
    const count = (type) => items.filter((item) => item.type === type).length;
    const liters = items.reduce((sum, item) => sum + (item.liters || 0), 0);
    const parts = [
      count('thanks') && `${count('thanks')} ${plural(count('thanks'), 'спасибо', 'спасибо', 'спасибо')}`,
      count('confirmed') && `${count('confirmed')} ${plural(count('confirmed'), 'подтверждение', 'подтверждения', 'подтверждений')}`,
      count('badge') && `${count('badge')} ${plural(count('badge'), 'значок', 'значка', 'значков')}`,
    ].filter(Boolean).join(', ');
    burst('⛽');
    showToast(`🤝 Пока вас не было: +${liters}`, parts || 'Загляните в «Клуб».');
    return;
  }
  items.forEach((item, index) => {
    setTimeout(() => {
      if (item.type === 'thanks') showToast(`🙏 ${item.by_name || 'Свой'} говорит спасибо`, `За отметку «${GRADE_LABELS[item.grade] || ''} ${item.seen ? 'есть' : 'нет'}» · +${item.liters} 🤝`, item.station);
      else if (item.type === 'confirmed') showToast(`✅ ${item.by_name || 'Свой'} подтвердил(а) вашу отметку`, `+${item.liters} 🤝 за точность`, item.station);
      else if (item.type === 'badge') { burst(item.icon); showToast(`${item.icon} Новый значок: ${item.title}`, 'Все значки — в разделе «Клуб».'); }
      else if (item.type === 'level') { burst('🎉'); showToast(`🎉 Новый уровень: ${item.icon} ${item.title}`, 'Так держать!'); }
      else if (item.type === 'award') { burst('🏅'); showToast('🏅 Благодарность клуба', `${item.text} · +${item.liters} 🤝`); }
      else if (item.type === 'hero') { burst('🦸'); showToast('🦸 Вы — герой прошлой недели!', `${handshakes(item.liters)} за неделю. Спасибо от всего клуба.`); }
      else if (item.type === 'sponsor') showToast('🤝 Ваш приглашённый стал активным', 'Значок «Поручитель» — ваш.');
      else if (item.type === 'invites') { burst('🎟'); showToast('🎟 Вам дали ещё приглашения', `+${item.count} от владельца · «👥 Клуб» → «Создать приглашение»`); }
    }, 600 * index);
  });
}

async function pollClubNews() {
  if (!state.club.enabled || !state.club.member || document.hidden) return;
  try {
    const result = await clubCall(`/club/me?since=${newsSince()}`, { timeout: 6000 });
    if (handleClubRejection(result) || !result.ok) return;
    state.club.profile = result.data.profile || state.club.profile;
    renderClubButton();
    handleNews(result.data.news, result.data.now);
  } catch { /* next tick */ }
}

// Six in ten cards have no fresh signal at all, and in the oblast seven in
// ten. Pointing a member at the nearest of those is the cheapest way to make
// the whole map better.
function scoutHint() {
  if (!state.club.enabled || !state.club.member || !state.location) return '';
  const near = state.stations
    .filter((station) => station.distance_km != null && station.distance_km <= 5 && ['NO_FRESH_DATA', 'CONFLICT'].includes(station.grade?.status))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, 3);
  if (!near.length) return '';
  const items = near.map((station) => `<button type="button" class="scout-item" data-scout-station="${escapeHtml(station.id)}">${escapeHtml(shortNetwork(station.network))} · ${escapeHtml(formatDistance(station.distance_km))}</button>`).join('');
  return `<div class="scout-hint"><strong>🔦 Нужны глаза рядом</strong><span>По ${escapeHtml(GRADE_LABELS[state.grade])} здесь у приложения нет свежих данных. Будете мимо — отметьте: <b>+2 🤝</b> бонусом.</span><div class="scout-list">${items}</div></div>`;
}

function bindScout(root) {
  root.querySelectorAll('[data-scout-station]').forEach((button) => {
    button.addEventListener('click', () => openStation(button.dataset.scoutStation));
  });
}

// ---------------------------------------------------------------- «Свои» tab

// Everything the group marked in the worker's three-hour window, in one list
// and on the map, ordered fresh first and then by distance, with how stale
// each mark has become said in words.
const OWN_WINDOW_MS = 3 * 60 * 60 * 1000;
const OWN_TIERS = [
  { max: 45, key: 'fresh', icon: '🟢', label: 'свежая' },
  { max: 90, key: 'aging', icon: '🟡', label: 'протухает' },
  { max: 180, key: 'stale', icon: '⚪', label: 'устарела — нужна новая отметка' },
];

function ownTier(ageMinutes) {
  return OWN_TIERS.find((tier) => ageMinutes <= tier.max) || OWN_TIERS[OWN_TIERS.length - 1];
}

function ownEntries() {
  const now = Date.now();
  const order = Object.keys(GRADE_LABELS);
  return Object.entries(state.groupMarks || {}).map(([stationId, grades]) => {
    const items = Object.entries(grades)
      .filter(([grade, mark]) => GRADE_LABELS[grade] && now - mark.at <= OWN_WINDOW_MS)
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    if (!items.length) return null;
    const latest = Math.max(...items.map(([, mark]) => mark.at));
    return {
      stationId,
      items,
      latest,
      tier: ownTier((now - latest) / 60000),
      queue: items.map(([, mark]) => mark.queue).find((value) => value != null),
      names: [...new Set(items.flatMap(([, mark]) => mark.names || []))].filter(Boolean),
    };
  }).filter(Boolean);
}

function ownChip() {
  const count = ownEntries().length;
  if (!count && !state.ownOnly) return '';
  return `<button class="status-chip own-filter ${state.ownOnly ? 'active' : ''}" style="--status-color:#1f7a4d" data-own="1">👁 Свои · ${count}</button>`;
}

function updateOwnChip() {
  const strip = $('#statusStrip');
  if (!strip) return;
  const existing = strip.querySelector('[data-own]');
  const html = ownChip();
  if (existing && html) existing.outerHTML = html;
  else if (existing) existing.remove();
  else if (html) strip.insertAdjacentHTML('afterbegin', html);
}

function ownLink() {
  const count = ownEntries().length;
  return count ? `<button type="button" class="feed-all" data-own-open>Все отметки своих за 3 часа · ${count} →</button>` : '';
}

function bindOwnLink(root) {
  root.querySelector('[data-own-open]')?.addEventListener('click', () => {
    if (!state.ownOnly) toggleOwnOnly();
    $('#stationList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function toggleOwnOnly() {
  state.ownOnly = !state.ownOnly;
  track('status_filter', { filter: state.ownOnly ? 'own' : 'all' });
  if (state.ownOnly) {
    // One view at a time: a status chip left lit inside «Свои» looked pressed
    // and did nothing.
    state.status = null;
    state.timeline = null;
    $$('#statusStrip .status-chip.active:not([data-own])').forEach((chip) => chip.classList.remove('active'));
    updateOwnChip();
    renderOwnList();
    renderMarkers();
  } else {
    loadStations();
  }
}

// «Свои» is a view of its own. Every other filter used to change quietly
// underneath it: on 13 Sep 2026 a laptop lit up «Появилось недавно» and
// «Можно заправиться» while the list stayed on the one station the group had
// marked, and it all applied at once only when «Свои» was pressed again.
// Touching any other filter now leaves the view first.
function leaveOwnOnly() {
  if (!state.ownOnly) return false;
  state.ownOnly = false;
  updateOwnChip();
  return true;
}

// «Показать все АЗС» means leave, never toggle: tapped twice while the list was
// still redrawing, it switched «Свои» straight back on.
function leaveOwnView() {
  if (leaveOwnOnly()) loadStations();
}

async function renderOwnList() {
  const list = $('#stationList');
  if (!list) return;
  const entries = ownEntries();
  $('#resultCount').textContent = entries.length.toLocaleString('ru-RU');
  $('#resultNoun').textContent = `${plural(entries.length, 'АЗС', 'АЗС', 'АЗС')} с отметками своих`;
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><strong>За три часа свои ничего не отмечали</strong><br>Как только кто-то отметит АЗС, она появится здесь.<br><button type="button" class="list-more" id="ownBack">Показать все АЗС</button></div>`;
    $('#ownBack').addEventListener('click', leaveOwnView);
    return;
  }
  await Promise.all(entries.map((entry) => stationInfo(entry.stationId)));
  if (!state.ownOnly) return;
  const now = Date.now();
  const withDistance = entries.map((entry) => {
    const info = state.stationInfo[entry.stationId] || {};
    const km = state.location && info.lat != null ? haversineKm(state.location, { lat: info.lat, lon: info.lon }) : null;
    return { ...entry, info, km };
  }).sort((a, b) => {
    const tiers = OWN_TIERS.indexOf(a.tier) - OWN_TIERS.indexOf(b.tier);
    if (tiers) return tiers;
    if (a.km != null && b.km != null && Math.abs(a.km - b.km) > 0.3) return a.km - b.km;
    return b.latest - a.latest;
  });
  const back = '<div class="own-bar"><span>Только отметки своих за 3 часа</span><button type="button" class="own-back" data-own-back>Показать все АЗС</button></div>';
  list.innerHTML = back + withDistance.map((entry) => {
    const grades = entry.items.map(([grade, mark]) => `<span class="feed-grade ${mark.seen ? 'yes' : 'no'}">${escapeHtml(GRADE_LABELS[grade].replace('АИ-', ''))} ${mark.seen ? '✓' : '✗'}</span>`).join('');
    const queue = queueWords(entry.queue);
    const who = entry.names.length ? ` · ${escapeHtml(entry.names.join(', '))}` : '';
    return `<article class="station-card own-card ${entry.tier.key}" data-nearby-station="${escapeHtml(entry.stationId)}">
      <button type="button" class="card-main own-main" data-own-station="${escapeHtml(entry.stationId)}">
        <span class="card-topline"><strong class="network">${escapeHtml(displayNetwork(entry.info.network))}</strong><span class="distance">${escapeHtml(formatDistance(entry.km))}</span></span>
        <span class="address">${escapeHtml(shortAddress(entry.info.address || ''))}</span>
        <span class="feed-grades">${grades}${queue ? `<span class="feed-queue">очередь: ${escapeHtml(queue)}</span>` : ''}</span>
        <span class="own-age ${entry.tier.key}">${entry.tier.icon} ${escapeHtml(entry.tier.label)} · ${escapeHtml(formatAge((now - entry.latest) / 1000))}${who}</span>
      </button>
      <div class="card-actions">${thanksButton(entry.stationId)}${verdictButtons(entry.stationId)}${ownerDeleteButtons(entry.stationId)}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-own-station]').forEach((button) => button.addEventListener('click', () => openStation(button.dataset.ownStation)));
  list.querySelector('[data-own-back]').addEventListener('click', leaveOwnView);
  bindThanks(list);
  bindVerdicts(list);
  paintNearby();
}

function renderOwnMarkers() {
  const now = Date.now();
  for (const entry of ownEntries()) {
    const info = state.stationInfo[entry.stationId];
    if (!info || info.lat == null) continue;
    const grades = entry.items.map(([grade, mark]) => `<i class="${mark.seen ? 'yes' : 'no'}">${escapeHtml(GRADE_LABELS[grade].replace('АИ-', ''))}</i>`).join('');
    const icon = L.divIcon({
      className: '',
      html: `<div class="fuel-pin labelled own-pin ${entry.tier.key}"><span class="fuel-marker"></span><span class="pin-label"><b>${entry.tier.icon} ${escapeHtml(shortNetwork(info.network))}</b><span class="pin-grades">${grades}</span><em>${escapeHtml(formatAge((now - entry.latest) / 1000))}</em></span></div>`,
      iconSize: [20, 20], iconAnchor: [10, 20],
    });
    const marker = L.marker([info.lat, info.lon], { icon, stationId: entry.stationId });
    marker.on('click', () => openStation(entry.stationId));
    marker.addTo(state.markers);
  }
  paintNearby();
}

function thankTargets(stationId) {
  const grades = (state.groupMarks || {})[stationId] || {};
  const me = myId();
  const byAuthor = new Map();
  for (const [grade, mark] of Object.entries(grades)) {
    // A mark without a name came from outside the club: nobody to thank.
    if (!mark.who || !mark.authorName || mark.who === me || !GRADE_LABELS[grade] || Date.now() - mark.at > OWN_WINDOW_MS) continue;
    const known = byAuthor.get(mark.who);
    if (!known || mark.at > known.at) {
      byAuthor.set(mark.who, { station: stationId, grade, at: mark.at, author: mark.who, name: mark.authorName, thanks: mark.thanks || 0, thanked: !!mark.thanked });
    }
  }
  return [...byAuthor.values()];
}

function thanksButton(stationId) {
  if (!state.club.enabled || !state.club.member) return '';
  const targets = thankTargets(stationId);
  if (!targets.length) return '';
  const done = targets.every((target) => target.thanked);
  const count = targets.reduce((sum, target) => sum + target.thanks, 0);
  const names = targets.map((target) => target.name).filter(Boolean).join(', ');
  return `<button type="button" class="thanks-button${done ? ' done' : ''}" data-thanks-station="${escapeHtml(stationId)}"${done ? ' disabled' : ''}>
    🙏 ${done ? 'Спасибо сказано' : `Спасибо${names ? `, ${escapeHtml(names)}` : ''}`}${count ? ` · ${count}` : ''}
  </button>`;
}

function bindThanks(root) {
  root.querySelectorAll('[data-thanks-station]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      sendThanks(button.dataset.thanksStation, button);
    });
  });
}

async function sendThanks(stationId, button) {
  const targets = thankTargets(stationId).filter((target) => !target.thanked);
  if (!targets.length) return;
  button.disabled = true;
  const thanked = [];
  let problem = null;
  for (const target of targets) {
    const result = await clubCall('/club/thanks', { method: 'POST', body: { station: target.station, grade: target.grade, at: target.at, author: target.author } }).catch(() => null);
    if (result && handleClubRejection(result)) return;
    const slot = state.groupMarks?.[stationId]?.[target.grade];
    if (result?.ok || result?.data?.error === 'already_thanked') {
      if (slot) {
        slot.thanked = true;
        slot.thanks = result.data.thanks ?? slot.thanks + 1;
      }
      if (result.ok) thanked.push(target.name || 'своему');
      (result.data?.badges || []).forEach((badge) => { burst(badge.icon); showToast(`${badge.icon} Новый значок: ${badge.title}`, 'За то, что благодарите своих.'); });
    } else {
      problem = clubMessage(result);
    }
  }
  if (thanked.length) {
    burst('🙏');
    showToast(`🙏 Спасибо отправлено: ${thanked.join(', ')}`, 'Им +2 🤝. Такие мелочи и держат клуб.');
  } else if (problem) {
    showToast('Не получилось', problem);
  }
  renderGroupFeed();
  const replacement = thanksButton(stationId);
  if (button.isConnected) {
    const holder = document.createElement('div');
    holder.innerHTML = replacement;
    if (holder.firstElementChild) {
      button.replaceWith(holder.firstElementChild);
      bindThanks(button.parentElement || document);
    } else {
      button.remove();
    }
  }
}

// ---------------------------------------------------------------- 👍 and 👎
// Someone else's fresh mark is confirmed or refuted only by a member at that
// pump. The buttons are shown to the whole club, so it is plain where they
// work; within 300 metres and in the first hour they come alive.
const VOTE_WINDOW_MS = 60 * 60 * 1000;
const VOTE_RADIUS_METRES = 300;

// What the club sees at a station, as looks: the grades one member marked at
// one moment, none older than `maxAge`.
function stationLooks(stationId, maxAge) {
  const grades = (state.groupMarks || {})[stationId] || {};
  const me = myId();
  const looks = new Map();
  for (const [grade, mark] of Object.entries(grades)) {
    // A mark without a name came from a phone outside the club (possible until
    // the door is closed): there is nobody to confirm or refute.
    if (!mark.who || !mark.authorName || !GRADE_LABELS[grade] || Date.now() - mark.at > maxAge) continue;
    const key = `${mark.who}:${mark.at}`;
    const look = looks.get(key) || { station: stationId, at: mark.at, author: mark.who, name: mark.authorName, mine: mark.who === me, up: mark.up || 0, down: mark.down || 0, myVote: mark.myVote || null, grades: [] };
    look.grades.push(`${GRADE_LABELS[grade].replace('АИ-', '')} ${mark.seen ? 'есть' : 'нет'}`);
    looks.set(key, look);
  }
  return [...looks.values()];
}

function voteTargets(stationId) {
  const latest = new Map();
  for (const look of stationLooks(stationId, VOTE_WINDOW_MS)) {
    if (!latest.has(look.author) || latest.get(look.author).at < look.at) latest.set(look.author, look);
  }
  return [...latest.values()].sort((a, b) => b.at - a.at);
}

function stationPlace(stationId) {
  const info = state.stationInfo[stationId];
  if (info?.lat != null) return { lat: Number(info.lat), lon: Number(info.lon) };
  const local = state.stations.find((item) => item.id === stationId);
  return local?.location ? { lat: Number(local.location.lat), lon: Number(local.location.lon) } : null;
}

function atPumpForVote(stationId) {
  const pump = stationPlace(stationId);
  if (!pump || !state.location || Date.now() - (state.locationAt || 0) > 5 * 60 * 1000 || (effectiveAccuracy() || 0) > 500) return false;
  return haversineKm(state.location, pump) * 1000 <= VOTE_RADIUS_METRES;
}

function verdictInner(stationId) {
  if (!state.club.enabled || !state.club.member || !state.club.features?.votes) return '';
  const here = atPumpForVote(stationId);
  return voteTargets(stationId).map((look) => {
    if (look.mine) {
      const tally = look.up || look.down ? `<p class="look-vote-own">Вашу отметку оценили на месте: 👍 ${look.up} · 👎 ${look.down}</p>` : '';
      return `${tally}${deleteButton(look, '🗑 Удалить отметку')}`;
    }
    const button = (vote, icon, count, title) => `<button type="button" class="look-vote-button ${vote}${look.myVote === vote ? ' mine' : ''}${here ? '' : ' away'}" data-verdict="${vote}" aria-pressed="${look.myVote === vote}" title="${title}">${icon} <b>${count}</b></button>`;
    return `<div class="look-vote" data-verdict-author="${escapeHtml(look.author)}" data-verdict-at="${look.at}">
      <span class="look-vote-label">На месте так? ${look.name ? `<b>${escapeHtml(look.name)}</b>: ` : ''}${escapeHtml(look.grades.join(', '))}</span>
      ${button('up', '👍', look.up, 'Подтверждаю: вижу то же самое')}
      ${button('down', '👎', look.down, 'Опровергаю: на колонках другое')}
      ${deleteButton(look, '🗑 Удалить')}
      <small class="look-vote-hint${here ? ' here' : ''}">${here ? 'Вы на этой заправке: всё так — 👍, неправда — 👎' : '👍 👎 — только на этой заправке, в первый час после отметки'}</small>
    </div>`;
  }).join('');
}

function verdictButtons(stationId) {
  const inner = verdictInner(stationId);
  return inner ? `<div class="look-votes" data-verdicts-station="${escapeHtml(stationId)}" data-here="${atPumpForVote(stationId)}">${inner}</div>` : '';
}

function bindVerdicts(root) {
  root.querySelectorAll('.look-votes [data-verdict]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const look = button.closest('.look-vote');
      const station = button.closest('.look-votes').dataset.verdictsStation;
      sendVerdict({ station, author: look.dataset.verdictAuthor, at: Number(look.dataset.verdictAt) }, button.dataset.verdict, button);
    });
  });
  root.querySelectorAll('[data-delete-at]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteLook({ station: button.dataset.deleteStation, author: button.dataset.deleteAuthor, at: Number(button.dataset.deleteAt) }, button);
    });
  });
}

// Every copy on screen — the feed, the «Свои» list, an open card — follows a
// vote or the phone arriving at the pump. Redrawn only when something changed,
// so a finger on the way to a button does not lose it.
function refreshVerdicts(stationId = null, { force = false } = {}) {
  document.querySelectorAll('.look-votes').forEach((holder) => {
    const id = holder.dataset.verdictsStation;
    if (stationId && id !== stationId) return;
    const here = String(atPumpForVote(id));
    if (!force && holder.dataset.here === here) return;
    holder.dataset.here = here;
    holder.innerHTML = verdictInner(id);
    bindVerdicts(holder);
  });
}

// Where the phone is now, not where it was when the app last looked.
function placeForVote() {
  if (state.location && Date.now() - (state.locationAt || 0) < 60 * 1000) return Promise.resolve({ ...state.location, accuracy: state.accuracy || 0 });
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude, accuracy: Math.round(position.coords.accuracy || 0) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  });
}

async function sendVerdict(target, vote, button) {
  const look = voteTargets(target.station).find((item) => item.author === target.author && item.at === target.at);
  if (!look || look.myVote === vote) return;
  const buttons = [...(button.closest('.look-vote')?.querySelectorAll('[data-verdict]') || [button])];
  const release = () => buttons.forEach((item) => { item.disabled = false; });
  buttons.forEach((item) => { item.disabled = true; });
  const place = await placeForVote();
  const pump = stationPlace(target.station);
  const metres = place && pump ? haversineKm(place, pump) * 1000 : null;
  if (metres == null || metres > VOTE_RADIUS_METRES) {
    release();
    const why = !pump
      ? 'Приложение не нашло, где эта АЗС. Откройте её карточку и попробуйте оттуда.'
      : !place
        ? 'Приложение не знает, где вы. Разрешите доступ к геопозиции: оценить отметку может только тот, кто сейчас сам видит колонки.'
        : `Вы в ${formatDistance(metres / 1000)} от неё. Оценить отметку может только тот, кто сейчас сам видит колонки.`;
    showToast('👍 👎 — только на этой заправке', why);
    return;
  }
  if (vote === 'down' && !confirm(`Опровергнуть отметку${look.name ? ` «${look.name}»` : ''}: ${look.grades.join(', ')}?\n\nСтавьте 👎, только если сами видите на колонках другое. Пять 👎 от разных людей — и автор выбывает из клуба.`)) {
    release();
    return;
  }
  const result = await clubCall('/club/vote', {
    method: 'POST',
    body: { station: target.station, at: target.at, author: target.author, vote, lat: place.lat, lon: place.lon, accuracy: place.accuracy, station_lat: pump.lat, station_lon: pump.lon },
  }).catch(() => null);
  release();
  if (result && handleClubRejection(result)) return;
  if (!result?.ok) {
    showToast('Не получилось', result ? clubMessage(result) : 'Нет связи с клубом. Попробуйте ещё раз.');
    return;
  }
  for (const mark of Object.values(state.groupMarks?.[target.station] || {})) {
    if (mark.who === target.author && mark.at === target.at) Object.assign(mark, { up: result.data.up, down: result.data.down, myVote: result.data.mine });
  }
  if (vote === 'up') {
    burst('👍');
    showToast(`👍 Подтверждено${look.name ? `: ${look.name}` : ''}`, result.data.paid ? `Автору +${result.data.paid} 🤝 за точность. Спасибо, что проверили на месте.` : 'Спасибо, что проверили на месте.', target.station);
  } else {
    showToast('👎 Отметка опровергнута', 'Отметьте, как на самом деле: откройте карточку этой АЗС.', target.station);
  }
  refreshVerdicts(target.station, { force: true });
}

// ---------------------------------------------------------------- 🗑
// A mark made by mistake could not be taken back. Its author deletes it in the
// first hour, the owner any mark while it is listed, and the worker takes back
// the 🤝 it earned, so a mark sent and deleted pays nothing.
const DELETE_WINDOW_MS = 60 * 60 * 1000;
// The phone dates its own copy of a mark a moment before the report goes out.
const OWN_COPY_SLACK_MS = 5000;

function deleteButton(look, label) {
  const owner = state.club.member?.role === 'owner';
  if (!state.club.features?.delete_marks || !(owner || (look.mine && Date.now() - look.at <= DELETE_WINDOW_MS))) return '';
  return `<button type="button" class="look-delete" data-delete-station="${escapeHtml(look.station)}" data-delete-author="${escapeHtml(look.author)}" data-delete-at="${look.at}">${escapeHtml(label)}</button>`;
}

// In «Свои» the owner reaches marks older than an hour too. A look still fresh
// enough for 👍 and 👎 has its 🗑 next to them already.
function ownerDeleteButtons(stationId) {
  if (!state.club.enabled || state.club.member?.role !== 'owner') return '';
  const offered = new Set(voteTargets(stationId).map((look) => `${look.author}:${look.at}`));
  const looks = stationLooks(stationId, OWN_WINDOW_MS).filter((look) => !offered.has(`${look.author}:${look.at}`));
  return looks.map((look) => deleteButton(look, looks.length > 1 ? `🗑 Удалить: ${look.name}` : '🗑 Удалить')).join('');
}

async function deleteLook(target, button) {
  const look = stationLooks(target.station, OWN_WINDOW_MS).find((item) => item.author === target.author && item.at === target.at);
  if (!look || !confirm(`Удалить отметку «${look.mine ? '' : `${look.name}: `}${look.grades.join(', ')}»? Её перестанут видеть свои.`)) return;
  // An open card would go on showing the look, so it is drawn again.
  const inCard = !!button.closest('#drawerContent');
  button.disabled = true;
  const result = await clubCall('/club/report/delete', { method: 'POST', body: target }).catch(() => null);
  button.disabled = false;
  if (result && handleClubRejection(result)) return;
  if (!result?.ok) {
    showToast('Не получилось', result ? clubMessage(result) : 'Нет связи с клубом. Попробуйте ещё раз.');
    return;
  }
  forgetLook(target);
  redrawMarks();
  if (inCard) openStation(target.station);
  showToast('Отметка удалена', result.data.liters_back > 0 ? `Вернули ${result.data.liters_back} 🤝` : '');
}

// Gone from this phone at once and for good: from what the club showed, and
// from the phone's own memory of its marks, which would otherwise bring the
// look back on the next read.
function forgetLook({ station, author, at }) {
  const mine = author === myId();
  const sameLook = (mark) => (mark.who ? mark.who === author && mark.at === at : mine && Math.abs(mark.at - at) < OWN_COPY_SLACK_MS);
  const shown = state.groupMarks?.[station] || {};
  for (const [grade, mark] of Object.entries(shown)) if (sameLook(mark)) delete shown[grade];
  if (!mine) return;
  const marks = loadMarks();
  for (const [grade, mark] of Object.entries(marks[station] || {})) if (sameLook(mark)) delete marks[station][grade];
  try {
    localStorage.setItem(MARK_STORE, JSON.stringify(marks));
  } catch {
    // Private mode or a full quota: nothing was kept to forget.
  }
  state.marks = marks;
}

// Everything that shows marks: the feed, the list or «Свои» with its pins, the chip.
function redrawMarks() {
  renderGroupFeed();
  updateOwnChip();
  if (state.stations.length || state.ownOnly) renderStations();
  if (state.ownOnly) renderMarkers();
  renderDrive();
}

function profileCard(profile) {
  if (!profile?.level) return '';
  const { level, counts = {} } = profile;
  const span = level.next ? level.next.min - level.min : 1;
  const progress = level.next ? Math.round(100 * (profile.liters - level.min) / span) : 100;
  return `<section class="tank-card">
      <div class="tank-head">
        <span class="tank-icon">${level.icon}</span>
        <span class="tank-title"><small>Ваш уровень</small><strong>${escapeHtml(level.title)}</strong></span>
        <span class="tank-liters"><b>${profile.liters}</b><small>${plural(profile.liters, 'рукопожатие', 'рукопожатия', 'рукопожатий')}</small></span>
      </div>
      <div class="tank-bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(4, Math.min(100, progress))}%"></i></div>
      <p class="tank-next">${level.next ? `До уровня ${level.next.icon} «${escapeHtml(level.next.title)}» — ещё ${level.next.left} 🤝` : 'Высший уровень. Вы — легенда клуба!'} · за неделю ${profile.week} 🤝</p>
      <div class="tank-counts">
        <span><b>${counts.marks || 0}</b>отметок</span>
        <span><b>${counts.confirmed || 0}</b>подтвердили</span>
        <span><b>${counts.thanks || 0}</b>спасибо</span>
        <span><b>${counts.saved || 0}</b>сберёг поездок</span>
      </div>
    </section>`;
}

// Folded: fourteen badge tiles pushed «Пригласить» and «Участники» a screen
// and a half down on a phone, and the owner opens the club for those.
function badgesSection(profile) {
  if (!profile?.badges) return '';
  const earned = profile.badges.filter((badge) => badge.earned).length;
  const badges = profile.badges.map((badge) => `<div class="badge${badge.earned ? ' earned' : ''}">
      <span class="badge-icon">${badge.icon}</span><b>${escapeHtml(badge.title)}</b>
      <small>${badge.earned ? `получен ${formatDay(badge.earned)}` : escapeHtml(badge.hint)}</small>
    </div>`).join('');
  const awards = (profile.awards || []).length
    ? `<h3 class="section-title">Благодарности клуба</h3><div class="source-list">${profile.awards.map((award) => `<div class="source-row"><strong>🏅 ${escapeHtml(award.text)}</strong><small>${formatDay(award.at)}</small></div>`).join('')}</div>`
    : '';
  return `<details class="badges-fold"><summary>Значки · ${earned} из ${profile.badges.length}</summary>
    <div class="badge-grid">${badges}</div>
    ${awards}</details>
    <details class="earn-help">
      <summary>Как заработать рукопожатия 🤝</summary>
      <ul>
        <li><b>+1 🤝</b> — отметка АЗС (одна за час на одной заправке, до 10 в день)</li>
        <li><b>+3 🤝</b> — другой участник подтвердил вашу отметку</li>
        <li><b>+2 🤝</b> — вам сказали «спасибо»</li>
        <li><b>+2 🤝</b> — первым увидели «есть» там, где было «нет»</li>
        <li><b>+2 🤝</b> — отметка там, где у приложения не было свежих данных 🔦</li>
        <li><b>+10 🤝</b> — благодарность от владельца клуба</li>
      </ul>
      <p>Рукопожатия — не бензин и не деньги: так клуб отмечает пользу своим, а не количество нажатий. Ложная отметка не окупается: её не подтвердят, а владелец видит споры.</p>
    </details>`;
}

async function loadLeaderboard() {
  const box = $('#clubBoard');
  if (!box) return;
  const result = await clubCall('/club/leaderboard').catch(() => null);
  if (!box.isConnected || !result?.ok) return;
  const medals = ['🥇', '🥈', '🥉'];
  const rows = result.data.members.map((row, index) => `<div class="board-row${row.me ? ' me' : ''}">
      <span class="board-rank">${row.week ? (medals[index] || index + 1) : '·'}</span>
      <span class="board-name">${row.icon} ${escapeHtml(row.name)}${row.me ? ' <em>вы</em>' : ''}</span>
      <span class="board-week"><b>${row.week}</b> 🤝</span>
      <small class="board-meta">всего ${row.liters} 🤝 · значков ${row.badges}</small>
    </div>`).join('');
  const hero = result.data.hero_last_week
    ? `<p class="board-hero">🦸 Герой прошлой недели — <b>${escapeHtml(result.data.hero_last_week.name)}</b>, ${handshakes(result.data.hero_last_week.liters)}</p>`
    : '';
  box.innerHTML = `<h3 class="section-title">Рукопожатия недели</h3>${hero}<div class="board">${rows}</div>`;
}

// ---------------------------------------------------------------- club

// The app becomes a closed club once the worker says so: marks, names and
// pushes belong to members, membership is by invitation, and the owner can
// exclude anyone. Until the worker has the club switched on nothing changes.
const CLUB_TOKEN_KEY = 'spbfi-club-token-v1';
const CLUB_MEMBER_KEY = 'spbfi-club-member-v1';
const CLUB_RULES = [
  'Клуб — только для своих. Приглашайте тех, за кого ручаетесь сами. Код приглашения — только для того, кого пригласили: не пересылайте его дальше.',
  'Отмечайте только то, что видите своими глазами прямо сейчас. Не пересказывайте чаты и слухи.',
  'Не уверены — не отмечайте. Лучше промолчать, чем отправить своих на пустую заправку.',
  'Ложную отметку опровергают 👎 — их ставят только на самой заправке. Пять 👎 от разных людей, и автор выбывает из клуба, пока владелец не вернёт. Кто пригласил — отвечает за приглашённого.',
  'Не показывайте приложение и отметки посторонним и не выкладывайте их в общие чаты.',
];

// Until the worker takes 👍 and 👎, rule four says what actually happens.
function clubRules() {
  if (state.club.features?.votes) return CLUB_RULES;
  return CLUB_RULES.map((rule, index) => (index === 3 ? 'За ложные отметки владелец исключает из клуба. Кто пригласил — отвечает за приглашённого.' : rule));
}
const CLUB_ERRORS = {
  invite_unknown: 'Такого кода нет. Проверьте буквы: в кодах не бывает О, 0, I и 1.',
  invite_used: 'Этим кодом уже вступили. Если это были вы — войдите через «🔑 Я уже в клубе» или попросите код для входа у владельца клуба.',
  login_code_used: 'Этот код для входа уже сработал. Новый покажет телефон, где вы в клубе: «👥 Клуб» → «Войти на другом устройстве».',
  login_code_expired: 'Срок кода для входа истёк. Новый покажет телефон, где вы в клубе: «👥 Клуб» → «Войти на другом устройстве».',
  passkey_failed: 'Не получилось проверить вход. Попробуйте ещё раз.',
  passkey_unknown: 'Этот вход больше не действует — возможно, вас удалили из клуба. Попросите у своих новое приглашение.',
  member_banned: 'Участник исключён. Сначала верните его в клуб.',
  member_unknown: 'Такого участника в клубе уже нет.',
  not_your_code: 'Тогда этот код не ваш: им уже вступил другой человек. Попросите своё приглашение у того, кто вас пригласил.',
  expected_vote: 'Не получилось отправить оценку. Обновите приложение.',
  cannot_vote_self: 'Свою отметку оценивать нельзя.',
  vote_too_late: 'Отметке больше часа — подтверждать или опровергать её уже поздно.',
  vote_not_here: '👍 и 👎 — только на этой заправке: оценить отметку может тот, кто сейчас сам видит колонки.',
  vote_needs_place: 'Чтобы оценить отметку, приложению нужно видеть, что вы на заправке. Разрешите доступ к геопозиции.',
  too_many_votes: 'На сегодня оценок достаточно — завтра можно снова.',
  not_yours: 'Это чужая отметка: удалить её может только владелец клуба.',
  delete_too_late: 'Отметке больше часа — удалить её теперь может только владелец клуба.',
  invites_left: 'У вас ещё есть приглашения — просить больше пока не нужно.',
  owner_has_no_limit: 'У владельца приглашения не кончаются.',
  bad_chat_url: 'Нужна ссылка на группу в Telegram — она начинается с https://t.me/',
  invite_expired: 'Срок кода истёк: он действует 7 дней. Попросите новый.',
  sponsor_banned: 'Пригласивший исключён из клуба, поэтому код недействителен.',
  rules_not_accepted: 'Чтобы вступить, нужно принять правила клуба.',
  expected_code_and_name: 'Введите код приглашения и имя.',
  wrong_owner_key: 'Ключ владельца не подошёл. Нажмите «Показать» и сверьте слова с сохранёнными.',
  too_many_attempts: 'Слишком много попыток. Подождите минуту.',
  no_invites_left: 'Приглашения закончились. Новые может выдать владелец клуба.',
  try_again_in_a_minute: 'Клуб ещё запоминает вас. Попробуйте через минуту.',
  owner_only: 'Это может только владелец клуба.',
};
Object.assign(CLUB_ERRORS, REWARD_ERRORS, STORAGE_ERRORS);

function clubUrl(path) {
  return `${String(window.SPBFI_REPORT_ENDPOINT || '').replace(/\/$/, '')}${path}`;
}

function clubToken() {
  try { return localStorage.getItem(CLUB_TOKEN_KEY) || ''; } catch { return ''; }
}

function memberHeaders() {
  const token = clubToken();
  return token ? { 'X-Member-Token': token } : {};
}

function myId() {
  return state.club.member?.id || deviceId();
}

function forgetClub() {
  try {
    localStorage.removeItem(CLUB_TOKEN_KEY);
    localStorage.removeItem(CLUB_MEMBER_KEY);
  } catch { /* nothing stored */ }
  state.club.member = null;
  renderClubButton();
}

async function clubCall(path, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const response = await fetch(clubUrl(path), {
      method,
      cache: 'no-store',
      signal: controller?.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...memberHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clubMessage(result, fallback) {
  return CLUB_ERRORS[result?.data?.error] || fallback || `Не получилось (${result?.status || 'нет связи'}).`;
}

// ---------------------------------------------------------------- getting back in
// The pass lives in the phone's storage and goes with it: site data cleared, the
// icon deleted, a new phone. A member comes back without anybody's help — by
// Face ID or a fingerprint (a passkey kept by the phone's own account), with the
// same invitation code while it runs, or with a code from a device still inside.
const PASSKEY_KEY = 'spbfi-club-passkey-v1';
const PASSKEY_FRESH_MS = 4 * 60 * 1000;
let passkeyChallenge = null;
let passkeyTimer = null;

function bytesFromB64u(value) {
  const clean = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function b64uFromBytes(buffer) {
  let raw = '';
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function passkeysOffered() {
  return !!(state.club.features?.passkeys && window.PublicKeyCredential && navigator.credentials?.get);
}

// What the device itself calls its lock.
function unlockWords() {
  const ua = navigator.userAgent;
  if (platformInfo().iOS) return 'Face ID';
  if (/Android/i.test(ua)) return 'отпечатку или PIN-коду';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  if (/Macintosh/i.test(ua)) return 'Touch ID';
  return 'ключу доступа';
}

function hasRememberedLogin(member) {
  try {
    return !!member && localStorage.getItem(PASSKEY_KEY) === member.id;
  } catch {
    return false;
  }
}

async function canRememberLogin() {
  if (!passkeysOffered() || !navigator.credentials?.create) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function freshChallenge() {
  return passkeyChallenge && Date.now() - passkeyChallenge.at < PASSKEY_FRESH_MS ? passkeyChallenge : null;
}

// Fetched ahead of the tap: Safari asks for Face ID only straight from a tap,
// and a tap that first waits for the network is not one any more.
async function preparePasskey() {
  if (!passkeysOffered()) return null;
  if (freshChallenge()) return passkeyChallenge;
  try {
    const result = await clubCall('/club/passkey/challenge', { timeout: 8000 });
    if (!result.ok || !result.data?.challenge) return null;
    passkeyChallenge = { value: result.data.challenge, rpId: result.data.rp_id || location.hostname, at: Date.now() };
    return passkeyChallenge;
  } catch {
    return null;
  }
}

function keepPasskeyReady() {
  preparePasskey();
  if (passkeyTimer) return;
  passkeyTimer = setInterval(() => {
    if (document.querySelector('#gatePasskey, #gateRememberButton, #clubRemember:not([hidden])')) preparePasskey();
  }, 3 * 60 * 1000);
}

// With a challenge at hand the phone's prompt opens within the tap itself;
// without one it is fetched first, and Safari may then want a second tap.
async function withChallenge(ask) {
  const ready = freshChallenge() || await preparePasskey();
  if (!ready) throw Object.assign(new Error('no challenge'), { name: 'NetworkError' });
  return ask(ready);
}

async function loginWithPasskey(button) {
  const error = $('#gateError');
  if (error) error.textContent = '';
  let assertion = null;
  try {
    assertion = await withChallenge((challenge) => navigator.credentials.get({
      publicKey: { challenge: bytesFromB64u(challenge.value), rpId: challenge.rpId, userVerification: 'preferred', timeout: 120000 },
    }));
  } catch (failure) {
    if (error) {
      error.textContent = failure?.name === 'NetworkError'
        ? 'Нет связи с клубом. Проверьте интернет и нажмите ещё раз.'
        : `Не получилось войти по ${unlockWords()}. Если вы отменили — нажмите ещё раз. Если вход не запоминали — введите тот же код приглашения или код для входа со своего другого устройства.`;
      error.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return;
  }
  if (!assertion) return;
  const response = assertion.response;
  enterClub('/club/passkey/login', {
    id: b64uFromBytes(assertion.rawId),
    client: b64uFromBytes(response.clientDataJSON),
    auth: b64uFromBytes(response.authenticatorData),
    signature: b64uFromBytes(response.signature),
    user: response.userHandle ? b64uFromBytes(response.userHandle) : '',
  }, button, { busy: '⏳ Входим в клуб…', passkey: true });
}

async function rememberLogin(button, onDone) {
  const member = state.club.member;
  const note = button.parentElement?.querySelector('.remember-note');
  if (!member) return;
  if (note) note.textContent = '';
  button.disabled = true;
  try {
    const credential = await withChallenge((challenge) => navigator.credentials.create({
      publicKey: {
        challenge: bytesFromB64u(challenge.value),
        rp: { id: challenge.rpId, name: 'Топливо СПб' },
        user: { id: new TextEncoder().encode(member.id), name: member.name || 'Участник клуба', displayName: `${member.name || 'Участник'} · Топливо СПб` },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        attestation: 'none',
        timeout: 120000,
      },
    }));
    if (!credential) throw Object.assign(new Error('no credential'), { name: 'NotAllowedError' });
    const result = await clubCall('/club/passkey/save', {
      method: 'POST',
      timeout: 20000,
      body: { id: b64uFromBytes(credential.rawId), client: b64uFromBytes(credential.response.clientDataJSON), attestation: b64uFromBytes(credential.response.attestationObject) },
    });
    if (handleClubRejection(result)) return;
    if (!result.ok) throw Object.assign(new Error('not saved'), { name: 'SaveError', result });
    try { localStorage.setItem(PASSKEY_KEY, member.id); } catch { /* the club keeps the key anyway */ }
    onDone(result.data.passkeys || 1);
  } catch (failure) {
    button.disabled = false;
    if (!note) return;
    if (failure?.name === 'NetworkError') note.textContent = 'Нет связи с клубом. Попробуйте ещё раз.';
    else if (failure?.name === 'SaveError') note.textContent = clubMessage(failure.result);
    else if (failure?.name === 'NotAllowedError') note.textContent = 'Не запомнили: окно закрыли или телефон не разрешил. Можно попробовать ещё раз.';
    else note.textContent = `На этом устройстве запомнить вход не получилось${/Android/i.test(navigator.userAgent) ? ' (нужны Google-аккаунт и блокировка экрана)' : ''}. Ничего страшного: вернуться поможет тот же код приглашения или код для входа со своего другого устройства.`;
  }
}

function loginCodeCard(code, title, expires, hint) {
  return `<div class="club-code"><span>${escapeHtml(title)}</span><b>${escapeHtml(code)}</b><small>${escapeHtml(expires)}</small>
    <button type="button" class="gate-submit secondary" data-code-share="${escapeHtml(code)}">Отправить или скопировать код</button>
    <small>${escapeHtml(hint)}</small></div>`;
}

function loginSection(passkeys) {
  if (!state.club.features?.returning) return '';
  const unlock = unlockWords();
  return `<div class="drawer-status club-login" style="--status-color:#2563eb">
      <strong>🔑 Если приложение сбросится</strong>
      <p id="clubLoginState">${passkeys
        ? `Вход по ${unlock} запомнен${passkeys > 1 ? ` (ключей: ${passkeys})` : ''}. Если приложение сбросится или смените телефон — на экране входа нажмите «🔑 Я уже в клубе».`
        : `Запомните вход — и если приложение сбросится или смените телефон, вернётесь по ${unlock}, без нового приглашения.`}</p>
      <button type="button" class="list-more" id="clubRemember" hidden>🔑 Запомнить вход на этом устройстве</button>
      <small class="remember-note" role="status"></small>
      <button type="button" class="list-more" id="clubDeviceCode">💻 Войти на другом устройстве</button>
      <div id="clubDeviceCodeResult"></div>
    </div>`;
}

function bindLoginSection() {
  const remember = $('#clubRemember');
  if (remember && !hasRememberedLogin(state.club.member)) {
    canRememberLogin().then((can) => {
      if (!can || !remember.isConnected) return;
      remember.hidden = false;
      keepPasskeyReady();
    });
  }
  remember?.addEventListener('click', () => rememberLogin(remember, (count) => {
    remember.hidden = true;
    const line = $('#clubLoginState');
    if (line) line.textContent = `✅ Вход по ${unlockWords()} запомнен${count > 1 ? ` (ключей: ${count})` : ''}. Если приложение сбросится — на экране входа нажмите «🔑 Я уже в клубе».`;
    burst('🔑');
  }));
  $('#clubDeviceCode')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const box = $('#clubDeviceCodeResult');
    button.disabled = true;
    try {
      const result = await clubCall('/club/code', { method: 'POST' });
      if (handleClubRejection(result)) return;
      if (!result.ok) {
        box.innerHTML = `<p class="gate-error">${escapeHtml(clubMessage(result))}</p>`;
        return;
      }
      box.innerHTML = loginCodeCard(result.data.code, 'Код для входа на другом устройстве', 'действует 10 минут, один раз',
        'На компьютере или новом телефоне откройте приложение, введите код в поле «Код приглашения» и нажмите «Вступить в клуб». Имя и правила вводить не нужно — клуб вас узнает.');
      bindInviteButtons(box);
    } catch {
      box.innerHTML = '<p class="gate-error">Нет связи с клубом. Попробуйте ещё раз.</p>';
    } finally {
      button.disabled = false;
    }
  });
}

function inviteFromUrl() {
  const clean = String(new URLSearchParams(location.search).get('invite') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : '';
}

// Any club call answered with "not a member" or "banned" lands here, so the
// phone never keeps pretending to be inside.
// What a phone whose pass stopped working can do about it.
function wayBackIn() {
  if (!state.club.features?.returning) return 'Попросите у своих новое приглашение.';
  return 'Если вы в клубе — войдите снова: «🔑 Я уже в клубе», тот же код приглашения или код с другого своего устройства. Не получается — попросите у своих новое приглашение.';
}

function handleClubRejection(result) {
  if (!state.club.enabled) return false;
  const banned = result.status === 403 && result.data?.error === 'banned';
  if (result.status !== 401 && !banned) return false;
  forgetClub();
  const byVotes = banned && result.data?.by === 'votes';
  if (state.club.mode !== 'closed') {
    // Until the door is closed a phone that is no longer inside simply goes
    // back to the ordinary app.
    state.club.enabled = false;
    renderGroupFeed();
    showToast(
      byVotes ? 'Вы выбыли из клуба' : banned ? 'Владелец клуба закрыл вам доступ' : 'Вход в клуб на этом телефоне больше не действует',
      banned ? `${result.data.reason ? `${byVotes ? '' : 'Причина: '}${result.data.reason}. ` : ''}Приложение работает как раньше.` : wayBackIn(),
    );
    return true;
  }
  if (banned) showClubGate({ banned: result.data.reason || '', bannedBy: result.data.by || 'owner' });
  else showClubGate({ notice: `Вход на этом телефоне больше не действует. ${wayBackIn()}` });
  return true;
}

async function checkClub() {
  if (!window.SPBFI_REPORT_ENDPOINT) return;
  let health;
  try {
    health = await clubCall('/club/health', { timeout: 6000 });
  } catch {
    // The worker is unreachable. A saved membership keeps working offline and
    // nobody is locked out of the station list because of a network hiccup.
    state.club.healthFailed = true;
    return;
  }
  state.club.healthFailed = !health.ok;
  state.club.mode = clubModeFrom(health);
  state.club.features = health.ok ? (health.data || {}) : {};
  // Until the door is closed only the phones that joined are inside; for
  // everyone else the app stays exactly as it was.
  state.club.enabled = state.club.mode === 'closed' || (state.club.mode !== 'off' && !!clubToken());
  renderGroupFeed();
  if (!state.club.enabled) {
    renderClubButton();
    // An invitation link, or the owner's, still opens the door on request.
    const wanted = new URLSearchParams(location.search).get('club');
    if (state.club.mode !== 'off' && (inviteFromUrl() || wanted === 'owner' || wanted === 'join')) showClubGate({ mode: wanted === 'owner' ? 'owner' : 'join' });
    return;
  }
  if (!clubToken()) {
    showClubGate();
    return;
  }
  try {
    const me = await clubCall('/club/me', { timeout: 6000 });
    if (handleClubRejection(me)) return;
    if (me.ok) {
      state.club.member = me.data.member;
      state.club.profile = me.data.profile || null;
      try { localStorage.setItem(CLUB_MEMBER_KEY, JSON.stringify(me.data.member)); } catch { /* nothing to keep it in */ }
      handleNews(me.data.news, me.data.now);
    }
  } catch { /* offline with a saved membership: let them in */ }
  if (!$('#clubGate .gate-welcome')) hideClubGate();
  renderClubButton();
  pollGroupMarks();
  if (!state.club.newsTimer) {
    state.club.newsTimer = setInterval(pollClubNews, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollClubNews(); });
  }
}

function clubModeFrom(health) {
  if (!health?.ok) return 'off';
  if (health.data?.club === true) return 'closed';
  return ['test', 'invite'].includes(health.data?.mode) ? health.data.mode : 'off';
}

// Quick taps reach the page as touches but the browser merges them into a
// single click, so the taps are counted from the pointer itself; a finger that
// slid was scrolling, not tapping.
function onFiveTaps(element, action) {
  if (!element) return;
  let taps = [];
  let down = null;
  element.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY, at: Date.now() };
  });
  element.addEventListener('pointercancel', () => { down = null; });
  element.addEventListener('pointerup', (event) => {
    const tapped = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 12 && Date.now() - down.at < 700;
    down = null;
    if (!tapped) return;
    const now = Date.now();
    taps = [...taps.filter((at) => now - at < 3000), now];
    if (taps.length < 5) return;
    taps = [];
    action();
  });
}

// While the club is a test nobody else is shown a way in: five taps on the
// page title open it. People shown the owner's sign-in first tried to type
// their invitation into it (14 Sep 2026), so the invitation comes first and
// the owner's way in is five more taps, on the title of that screen.
function bindSecretClubEntry() {
  onFiveTaps($('#heroTitle'), openClubEntry);
}

async function openClubEntry() {
  if (state.club.enabled && state.club.member) {
    showClub();
    return;
  }
  // «Клуб пока не включён» was said to a phone that had simply not reached the
  // club yet on a weak connection. It asks again before saying anything.
  const known = () => ['test', 'invite', 'closed'].includes(state.club.mode);
  if (!known()) {
    await checkClub();
    if ($('#clubGate') && !$('#clubGate').hidden) return;
    if (state.club.enabled && state.club.member) {
      showClub();
      return;
    }
    if (state.club.healthFailed) {
      showToast('Нет связи с клубом', 'Проверьте интернет и попробуйте ещё раз.', null, { key: 'club-entry' });
      return;
    }
    if (!known()) {
      showToast('Клуб пока не включён', 'Его включает владелец в настройках сервера.', null, { key: 'club-entry' });
      return;
    }
  }
  showClubGate({ mode: 'join' });
}

function clubJoinLine() {
  if (state.club.enabled) return '';
  // While the club is a test the line is offered only where the invitation
  // cannot follow on its own: an iPhone's home-screen app keeps its storage
  // apart from Safari, so a person who opened the link there and installed the
  // app has only the icon and a code — and needs a door to put it in.
  const offered = state.club.mode === 'invite' || (state.club.mode === 'test' && platformInfo().iOS && standalone());
  if (!offered) return '';
  return '<div class="feed-club-join">👥 Есть приглашение в клуб своих? <button type="button" data-club-join>Вступить</button></div>';
}

function bindClubJoinLine(root) {
  root.querySelector('[data-club-join]')?.addEventListener('click', () => showClubGate({ mode: 'join' }));
}

function showWelcome(member, owner, { returned = false } = {}) {
  const gate = $('#clubGate');
  if (!gate) return;
  const name = escapeHtml(member?.name || '');
  const title = owner ? 'Вы вошли как владелец клуба' : returned ? `С возвращением${name ? `, ${name}` : ''}!` : `${name ? `${name}, вы` : 'Вы'} в клубе!`;
  const lead = owner
    ? 'Вверху справа появилась кнопка клуба — с вашим уровнем 🔰 и рукопожатиями 🤝. В ней приглашения и участники.'
    : returned
      ? 'Вы снова в клубе — тем же участником, со всеми рукопожатиями 🤝. Кнопка клуба — вверху справа.'
      : 'Теперь ваши отметки видят свои — с вашим именем. Вверху справа появилась кнопка клуба — с вашим уровнем 🔰 и рукопожатиями 🤝. В ней приглашения и правила.';
  // Asked right away, while the person is here: the day the phone forgets the
  // pass is the day nobody remembers where the invitation went.
  gate.innerHTML = `<div class="gate-card gate-welcome">
      <span class="gate-welcome-icon" aria-hidden="true">🤝</span>
      <p class="gate-kicker">Готово</p>
      <h1>${title}</h1>
      <p class="gate-lead">${lead}</p>
      ${owner || returned ? '' : '<p class="gate-lead">Отмечайте только то, что видите на колонках своими глазами.</p>'}
      <div class="gate-remember" id="gateRemember" hidden>
        <strong>🔑 Запомните вход</strong>
        <p>Если приложение сбросится или появится новый телефон, вы вернётесь по ${unlockWords()} — без нового приглашения и не спрашивая владельца.</p>
        <button type="button" class="gate-submit" id="gateRememberButton">🔑 Запомнить вход</button>
        <small class="remember-note" role="status"></small>
      </div>
      <button type="button" class="gate-submit" id="gateDone">Начать</button>
    </div>`;
  gate.hidden = false;
  gate.scrollTop = 0;
  document.body.classList.add('club-locked');
  burst('🤝');
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
  $('#gateDone').addEventListener('click', () => {
    hideClubGate();
    renderGroupFeed();
  });
  if (hasRememberedLogin(member)) return;
  canRememberLogin().then((can) => {
    const box = $('#gateRemember');
    if (!can || !box) return;
    box.hidden = false;
    $('#gateDone').classList.add('secondary');
    $('#gateDone').textContent = 'Позже — начать';
    keepPasskeyReady();
  });
  $('#gateRememberButton').addEventListener('click', (event) => rememberLogin(event.currentTarget, () => {
    const box = $('#gateRemember');
    if (box) box.innerHTML = `<strong>✅ Вход запомнен</strong><p>Если приложение сбросится — на экране входа нажмите «🔑 Я уже в клубе» и подтвердите ${unlockWords()}.</p>`;
    const done = $('#gateDone');
    if (done) {
      done.classList.remove('secondary');
      done.textContent = 'Начать';
    }
    burst('🔑');
  }));
}

function hideClubGate() {
  const gate = $('#clubGate');
  if (gate) {
    gate.hidden = true;
    gate.innerHTML = '';
  }
  document.body.classList.remove('club-locked');
}

function showClubGate({ notice = '', banned = null, bannedBy = 'owner', mode = 'join' } = {}) {
  const gate = $('#clubGate');
  if (!gate) return;
  closeDrawer();
  const code = inviteFromUrl();
  const { iOS, inAppBrowser } = platformInfo();
  // On an iPhone the home-screen app keeps its own storage: a login made in
  // Safari does not follow the icon. The code has to be typed in the app.
  const installFirst = iOS && !standalone() && mode === 'join';
  const rules = `<div class="gate-rules"><strong>Правила клуба</strong><ol>${clubRules().map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol></div>`;
  const alertBox = banned != null
    ? (bannedBy === 'votes'
      ? `<div class="gate-alert"><strong>Вы выбыли из клуба.</strong> ${escapeHtml(banned ? `${banned.charAt(0).toUpperCase()}${banned.slice(1)}` : 'Ваши отметки опровергли пять участников')}. Вернуть в клуб может владелец.</div>`
      : `<div class="gate-alert"><strong>Владелец клуба закрыл вам доступ.</strong>${banned ? ` Причина: ${escapeHtml(banned)}.` : ''}</div>`)
    : notice ? `<div class="gate-alert">${escapeHtml(notice)}</div>` : '';
  // Once installed, the app opens the door itself: the gate when the club is
  // closed, the «Есть приглашение?» line before that.
  const install = installFirst ? `<div class="gate-install">
      <strong>Сначала установите приложение</strong>
      <p>Вход в ${inAppBrowser ? 'этом браузере' : 'Safari'} не переносится в приложение на экране «Домой», поэтому код вводится уже в нём.</p>
      <ol>${inAppBrowser ? '<li>Откройте эту ссылку в <b>Safari</b>.</li>' : ''}<li>Нажмите «Поделиться» — квадрат со стрелкой вверх.</li><li>Выберите <b>«На экран „Домой“»</b> и нажмите «Добавить».</li><li>Откройте приложение с иконки: оно ${state.club.mode === 'closed' ? 'сразу попросит код' : 'предложит вступить — строчка «Есть приглашение?» вверху'}. Введите код там.</li></ol>
      ${code ? `<p class="gate-code-line">Ваш код: <b>${escapeHtml(code)}</b><button type="button" id="gateCopyCode">Скопировать</button></p>` : ''}
    </div>` : '';
  const form = mode === 'owner'
    ? `<form id="gateOwnerForm" class="gate-form">
        <div class="gate-field"><label for="gateOwnerKey">Ключ владельца</label>
          <div class="gate-secret"><input id="gateOwnerKey" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required><button type="button" class="gate-show" id="gateShowKey" aria-pressed="false">👁 Показать</button></div>
        </div>
        <label>Ваше имя в клубе<input id="gateOwnerName" maxlength="24" autocomplete="given-name" placeholder="Как вас называть"></label>
        <button type="submit" class="gate-submit">Войти как владелец</button>
        <small id="gateError" role="alert"></small>
      </form>
      <button type="button" class="gate-link" id="gateBack">← Вход по приглашению</button>`
    : `<form id="gateJoinForm" class="gate-form"${installFirst ? ' hidden' : ''}>
        <label>Код приглашения<input id="gateCode" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX" value="${escapeHtml(code)}" required><small>Можно вставить сюда всё сообщение с приглашением — код найдётся сам.${state.club.features?.returning ? ' Уже были в клубе? Подойдёт тот же код (неделю) или код для входа со своего телефона — имя и правила тогда не нужны.' : ''}</small></label>
        <label>Как вас называть<input id="gateName" maxlength="24" autocomplete="given-name" placeholder="Например, Саша"><small>Имя видят только участники — рядом с вашими отметками.</small></label>
        ${rules}
        <label class="gate-accept"><input type="checkbox" id="gateAccept"><span>Принимаю правила и отмечаю только то, что вижу сам</span></label>
        <button type="submit" class="gate-submit">Вступить в клуб</button>
        <small id="gateError" role="alert"></small>
      </form>
      ${installFirst ? rules : ''}
      ${passkeysOffered() && !installFirst ? `<div class="gate-return">
          <strong class="gate-return-title">Уже были в клубе?</strong>
          <button type="button" class="gate-submit secondary" id="gatePasskey">🔑 Войти по ${unlockWords()}</button>
          <small>Если вход запоминали на этом или другом своём устройстве. Или введите выше тот же код приглашения.</small>
        </div>` : ''}`;
  // Until the door is closed the gate is an offer, not a wall.
  const dismiss = state.club.mode !== 'closed' ? '<button type="button" class="gate-close" id="gateClose">Не сейчас ✕</button>' : '';
  gate.innerHTML = `<div class="gate-card">
      ${dismiss}
      <span class="brand-mark" aria-hidden="true"><span></span></span>
      <p class="gate-kicker">${mode === 'owner' ? 'Вход для владельца клуба' : 'Закрытый клуб'}</p>
      <h1 id="gateTitle">Топливо СПб — для своих</h1>
      <p class="gate-lead">${mode === 'owner'
        ? 'Этот вход — только для владельца. Если вам прислали приглашение, нажмите внизу «← Вход по приглашению».'
        : 'Вход только по приглашению участника. Отметки здесь ставят люди, за которых кто-то поручился, — поэтому им можно верить.'}</p>
      ${alertBox}${install}${form}
    </div>`;
  gate.hidden = false;
  gate.scrollTop = 0;
  document.body.classList.add('club-locked');
  // A long phrase pasted on a phone is easier to check when it can be seen.
  $('#gateShowKey')?.addEventListener('click', (event) => {
    const input = $('#gateOwnerKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? '🙈 Скрыть' : '👁 Показать';
    event.currentTarget.setAttribute('aria-pressed', String(show));
  });
  $('#gateClose')?.addEventListener('click', () => {
    hideClubGate();
    if (/[?&](club|invite)=/.test(location.search)) history.replaceState(null, '', location.pathname);
  });
  $('#gateCopyCode')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try { await navigator.clipboard.writeText(code); button.textContent = 'Скопировано'; } catch { button.textContent = code; }
  });
  // The owner's way in is not on the card, where invited people took it for
  // theirs: five quick taps on its title.
  onFiveTaps($('#gateTitle'), () => showClubGate({ notice, banned, bannedBy, mode: 'owner' }));
  $('#gateBack')?.addEventListener('click', () => showClubGate({ notice, banned, bannedBy, mode: 'join' }));
  // An invitation copied from a messenger arrives as one long message; the code
  // inside it is picked out, so nobody has to copy it letter by letter.
  $('#gateCode')?.addEventListener('input', (event) => {
    const found = codeIn(event.target.value);
    if (found) event.target.value = found;
  });
  $('#gatePasskey')?.addEventListener('click', (event) => loginWithPasskey(event.currentTarget));
  if ($('#gatePasskey')) keepPasskeyReady();
  // A name and the rules matter to a newcomer only. The club knows who that is,
  // so someone coming back with their own code is not stopped here.
  $('#gateJoinForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    enterClub('/club/join', { code: $('#gateCode').value, name: $('#gateName').value, accept: $('#gateAccept').checked, device: deviceId() }, event.target.querySelector('.gate-submit'));
  });
  $('#gateOwnerForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    enterClub('/club/owner', { key: $('#gateOwnerKey').value, name: $('#gateOwnerName').value }, event.target.querySelector('.gate-submit'));
  });
}

async function enterClub(path, body, button, { busy = '', passkey = false } = {}) {
  const error = $('#gateError');
  if (error) error.textContent = '';
  button.disabled = true;
  // Without a sign of life a person taps the button, sees nothing and gives up.
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  button.textContent = busy || (path === '/club/owner' ? '⏳ Проверяем ключ…' : '⏳ Вступаем в клуб…');
  let retry = null;
  try {
    // A slow mobile connection must not lose a sign-in that is only a second late.
    const result = await clubCall(path, { method: 'POST', body, timeout: 20000 });
    if (!result.ok || !result.data?.token) {
      const returning = result.data?.returning;
      if (returning && !body.returning) {
        // The code has let someone in already. If that was this person — the
        // icon after Safari, a cleared phone, a computer — they come back as
        // themselves; a friend it was passed on to does not become them.
        if (confirm(`Этим кодом уже вступил(а) «${returning}». Это вы?\n\nНажмите «OK», чтобы вернуться в клуб как «${returning}» — со всеми рукопожатиями.`)) retry = { ...body, returning: true };
        else if (error) error.textContent = CLUB_ERRORS.not_your_code;
        return;
      }
      // The code was accepted and only the name is missing: say that, not
      // «введите код и имя» over a code that is plainly there.
      const nameless = result.data?.error === 'expected_code_and_name' && path === '/club/join' && String(body.code || '').trim() && !String(body.name || '').trim();
      if (error) error.textContent = nameless ? 'Код принят. Напишите, как вас называть.' : clubMessage(result);
      return;
    }
    try {
      localStorage.setItem(CLUB_TOKEN_KEY, result.data.token);
      localStorage.setItem(CLUB_MEMBER_KEY, JSON.stringify(result.data.member));
      if (passkey) localStorage.setItem(PASSKEY_KEY, result.data.member.id);
    } catch {
      if (error) error.textContent = 'Телефон не даёт сохранить вход. Если открыт частный режим Safari, откройте приложение обычным способом.';
      return;
    }
    // Asks the browser not to clear the pass when the phone runs short of space.
    navigator.storage?.persist?.().catch(() => {});
    state.club.member = result.data.member;
    state.club.enabled = true;
    if (/[?&](club|invite)=/.test(location.search)) history.replaceState(null, '', location.pathname);
    renderClubButton();
    // The gate used to close quietly with a toast at the top; a member took
    // that for nothing happening and joined a second time.
    showWelcome(result.data.member, path === '/club/owner', { returned: !!result.data.returned });
    // Profile, news and the club's copy of the marks, as on any later start.
    checkClub();
  } catch (failure) {
    const reason = failure?.name === 'AbortError' ? 'сервер клуба не ответил за 20 секунд' : 'запрос не дошёл до сервера клуба';
    if (error) error.textContent = `Нет связи с клубом: ${reason}. Проверьте интернет и попробуйте ещё раз.`;
  } finally {
    button.disabled = false;
    button.textContent = label;
    delete button.dataset.label;
    if (error?.isConnected && error.textContent) error.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (retry) enterClub(path, retry, button, { busy: '⏳ Возвращаем вас в клуб…' });
  }
}

function renderClubButton() {
  // Inside the club, or once its door is closed, the app says whose it is.
  const tag = $('#brandTag');
  if (tag) tag.textContent = state.club.mode === 'closed' || (state.club.enabled && state.club.member) ? 'закрытый клуб своих' : 'Санкт-Петербург';
  const button = $('#clubButton');
  if (!button) return;
  button.hidden = !(state.club.enabled && state.club.member);
  const profile = state.club.profile;
  const icon = button.querySelector('[aria-hidden]');
  const label = button.querySelector('.club-label');
  if (icon) icon.textContent = profile?.level?.icon || '👥';
  if (label) label.textContent = profile ? ` ${profile.liters} 🤝` : ' Клуб';
  button.setAttribute('aria-label', profile ? `Клуб: ${profile.level.title}, ${handshakes(profile.liters)}` : 'Клуб');
}

function formatDay(ms) {
  return ms ? new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';
}

function codeIn(text) {
  const value = String(text || '');
  if (value.replace(/[^A-Za-z0-9]/g, '').length <= 8) return '';
  const match = value.toUpperCase().match(/\b([A-HJKMNP-Z2-9]{4})-([A-HJKMNP-Z2-9]{4})\b/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function inviteText(code) {
  const link = `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
  return `Приглашаю в закрытый клуб «Топливо СПб»: где сейчас есть бензин — по отметкам своих.\n\n`
    + `Ссылка: ${link}\n`
    + `Код: ${code}\n\n`
    + 'Android: откройте ссылку, напишите имя, отметьте правила и нажмите «Вступить в клуб». '
    + 'Потом в меню браузера (⋮) — «Добавить на главный экран» или «Установить приложение».\n\n'
    + 'iPhone: откройте ссылку в Safari → «Поделиться» → «На экран „Домой“» → откройте приложение с иконки и введите код уже там.\n\n'
    + 'Можно вставить это сообщение целиком в поле кода — приложение само найдёт код.\n'
    + 'Код — только для вас и действует 7 дней. Пожалуйста, не пересылайте его дальше.';
}

// A code sent on its own can be copied whole from any messenger.
async function shareCode(code, button) {
  if (navigator.share) {
    try {
      await navigator.share({ text: code });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(code);
    if (button) button.textContent = 'Код скопирован';
  } catch {
    prompt('Скопируйте код:', code);
  }
}

async function shareInvite(code, button) {
  const text = inviteText(code);
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    if (button) button.textContent = 'Приглашение скопировано';
  } catch {
    prompt('Скопируйте приглашение:', text);
  }
}

function askInvitesButton(askedAt) {
  const waiting = askedAt && Date.now() - askedAt < 12 * 60 * 60 * 1000;
  return `<button type="button" class="list-more" id="clubAskInvites"${waiting ? ' disabled' : ''}>${waiting ? '🎟 Запрос отправлен владельцу' : '🎟 Попросить ещё приглашений у владельца'}</button>`;
}

function chatSettings(url) {
  return `<div class="drawer-status club-chat-settings" style="--status-color:#229ed9">
      <strong>💬 Чат клуба</strong>
      <p>${url
        ? 'Кнопку «Чат клуба в Telegram» видят только участники.'
        : 'Создайте закрытую группу в Telegram, в её настройках откройте «Пригласительные ссылки», скопируйте ссылку и вставьте сюда. Кнопку «Чат клуба» увидят только участники.'}</p>
      <input id="clubChatUrl" class="club-chat-input" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://t.me/+..." value="${escapeHtml(url || '')}">
      <button type="button" class="list-more" id="clubChatSave">Сохранить ссылку</button>
      <small class="remember-note" id="clubChatNote" role="status"></small>
    </div>`;
}

async function showClub() {
  openDrawer('<div class="loading-state">Загружаем клуб…</div>');
  let me;
  try {
    me = await clubCall('/club/me');
  } catch {
    $('#drawerContent').innerHTML = '<div class="empty-state">Нет связи с клубом. Попробуйте позже.</div>';
    return;
  }
  if (handleClubRejection(me)) return;
  if (!me.ok) {
    $('#drawerContent').innerHTML = `<div class="empty-state">${escapeHtml(clubMessage(me))}</div>`;
    return;
  }
  const { member, invites = [], invites_left: left, profile } = me.data;
  state.club.member = member;
  state.club.profile = profile || state.club.profile;
  renderClubButton();
  const owner = member.role === 'owner';
  const inviteRows = invites.length ? invites.map((invite) => {
    const open = !invite.used_by && invite.expires > Date.now();
    const status = invite.used_by ? `вступил(а): ${escapeHtml(invite.used_by)}` : open ? `ждёт до ${formatDay(invite.expires)}` : 'срок истёк';
    return `<div class="source-row club-invite-row"><strong>${escapeHtml(invite.code)}</strong><span>${status}</span>${open
      ? `<span><button type="button" class="club-small" data-invite-share="${escapeHtml(invite.code)}">Отправить</button><button type="button" class="club-small" data-code-share="${escapeHtml(invite.code)}">Код</button><button type="button" class="club-small" data-invite-revoke="${escapeHtml(invite.code)}">Отозвать</button></span>` : ''}</div>`;
  }).join('') : '<p class="drawer-address">Вы ещё никого не приглашали.</p>';
  $('#drawerContent').innerHTML = `
    <h2>Клуб «Топливо СПб»</h2>
    <p class="drawer-address">Вы в клубе как <b>${escapeHtml(member.name)}</b>${owner ? ' · владелец' : ''}.</p>
    ${me.data.chat_url ? `<a class="list-more club-chat" href="${escapeHtml(me.data.chat_url)}" target="_blank" rel="noopener noreferrer">💬 Чат клуба в Telegram</a>` : ''}
    ${profileCard(profile)}
    ${me.data.refuted_by ? `<div class="drawer-status" style="--status-color:#b8333a"><strong>👎 Ваши отметки опровергли: ${me.data.refuted_by} ${plural(me.data.refuted_by, 'человек', 'человека', 'человек')}${owner ? '' : ' из 5'}</strong><p>Так решили участники, которые сами были на тех заправках. ${owner ? 'Владельца из клуба не выводят, но это повод перепроверить.' : 'Отмечайте только то, что видите на колонках: после пяти разных людей — выбывание из клуба.'}</p></div>` : ''}
    <div class="drawer-status" style="--status-color:#0d5a43">
      <strong>Пригласить человека</strong>
      <p>Только того, за кого ручаетесь: за ложные отметки исключают, а пригласивший отвечает за приглашённого. Код пускает одного человека и действует 7 дней.${owner ? '' : ` Осталось приглашений: <b>${Number(left) || 0}</b>.`}</p>
      <button type="button" class="list-more" id="clubInvite"${!owner && !left ? ' disabled' : ''}>Создать приглашение</button>
      ${!owner && !left && state.club.features?.invites_more ? askInvitesButton(me.data.invites_asked) : ''}
      <div id="clubInviteResult"></div>
    </div>
    ${owner && state.club.features?.chat ? chatSettings(me.data.chat_url) : ''}
    <h3 class="section-title">Мои приглашения</h3>
    <div class="source-list">${inviteRows}</div>
    ${owner ? '<h3 class="section-title">Участники</h3><div id="clubMembers" class="source-list"><div class="loading-state">Загружаем участников…</div></div>' : ''}
    <div id="clubBoard"></div>
    ${badgesSection(profile)}
    ${loginSection(me.data.passkeys || 0)}
    <details class="club-howto">
      <summary>Как пользоваться клубом</summary>
      <ol>
        <li><b>Видите АЗС</b> — откройте её карточку и отметьте, что есть на колонках и какая очередь. Отметка живёт 45 минут и сразу видна всем своим.</li>
        ${state.club.features?.votes ? '<li><b>Вы на заправке, которую отметил другой?</b> Всё так — 👍, неправда — 👎. Вдали от заправки эти кнопки не работают: оценивает только тот, кто видит колонки сам.</li>' : ''}
        <li><b>Отметка помогла</b> — скажите 🙏 «Спасибо». Автору +2 🤝.</li>
        ${state.club.features?.passkeys ? '<li><b>Запомните вход 🔑</b> — если приложение сбросится или смените телефон, вернётесь по Face ID или отпечатку.</li>' : ''}
        ${state.club.features?.returning ? '<li><b>Вылетели, а вход не запоминали</b> — введите тот же код приглашения (он пускает вас неделю) или код с другого своего устройства: «👥 Клуб» → «Войти на другом устройстве».</li>' : ''}
        ${state.club.features?.invites_more && !owner ? '<li><b>Приглашения кончились</b> — «🎟 Попросить ещё приглашений у владельца» в разделе «Пригласить человека».</li>' : ''}
        ${me.data.chat_url ? '<li><b>Вопросы и новости</b> — в чате клуба: кнопка «💬 Чат клуба в Telegram» вверху.</li>' : ''}
      </ol>
    </details>
    <h3 class="section-title">Правила клуба</h3>
    <ol class="club-rules">${clubRules().map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol>
    <button type="button" class="list-more club-leave" id="clubLeave">Выйти из клуба на этом устройстве</button>`;
  $('#clubInvite')?.addEventListener('click', createInvite);
  bindInviteButtons($('#drawerContent'));
  bindLoginSection();
  $('#clubAskInvites')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const result = await clubCall('/club/invites/more', { method: 'POST' }).catch(() => null);
    if (result && handleClubRejection(result)) return;
    if (!result?.ok) {
      button.disabled = false;
      showToast('Не получилось', result ? clubMessage(result) : 'Нет связи с клубом. Попробуйте ещё раз.');
      return;
    }
    button.textContent = '🎟 Запрос отправлен владельцу';
    showToast('🎟 Запрос отправлен', 'Владелец получит уведомление и сможет дать ещё приглашений.');
  });
  $('#clubChatSave')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const note = $('#clubChatNote');
    button.disabled = true;
    const result = await clubCall('/club/settings', { method: 'POST', body: { chat_url: $('#clubChatUrl').value } }).catch(() => null);
    button.disabled = false;
    if (result && handleClubRejection(result)) return;
    if (!result?.ok) {
      note.textContent = result ? clubMessage(result) : 'Нет связи с клубом. Попробуйте ещё раз.';
      return;
    }
    $('#clubChatUrl').value = result.data.chat_url || '';
    note.textContent = result.data.chat_url ? '✅ Сохранено: участники видят кнопку «💬 Чат клуба в Telegram».' : 'Ссылка убрана.';
  });
  loadLeaderboard();
  $('#clubLeave').addEventListener('click', () => {
    // It used to say a new invitation would be needed, which scared people
    // into staying signed in on shared devices; the way back is spelled out.
    const way = owner
      ? 'Вернуться можно ключом владельца: пять быстрых касаний по заголовку «Топливо СПб — для своих» на экране входа.'
      : me.data.passkeys
        ? `Вернуться можно по ${unlockWords()}: на экране входа — «🔑 Я уже в клубе».`
        : state.club.features?.returning
          ? 'Вход по Face ID или отпечатку не запомнен. Вернуться помогут код для входа с другого вашего устройства, тот же код приглашения (неделю) или код от владельца.'
          : 'Чтобы вернуться, понадобится новое приглашение.';
    if (!confirm(`Выйти из клуба на этом устройстве? ${way}`)) return;
    forgetClub();
    closeDrawer();
    if (state.club.mode === 'closed') {
      showClubGate();
    } else {
      state.club.enabled = false;
      renderGroupFeed();
      pollGroupMarks();
    }
  });
  if (owner) loadClubMembers();
}

function bindInviteButtons(root) {
  root.querySelectorAll('[data-invite-share]').forEach((button) => {
    button.addEventListener('click', () => shareInvite(button.dataset.inviteShare, button));
  });
  root.querySelectorAll('[data-code-share]').forEach((button) => {
    button.addEventListener('click', () => shareCode(button.dataset.codeShare, button));
  });
  root.querySelectorAll('[data-invite-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm(`Отозвать приглашение ${button.dataset.inviteRevoke}? По нему уже нельзя будет вступить.`)) return;
      const result = await clubCall('/club/invite/revoke', { method: 'POST', body: { code: button.dataset.inviteRevoke } }).catch(() => null);
      if (result && handleClubRejection(result)) return;
      if (!result?.ok) {
        alert(clubMessage(result));
        return;
      }
      showClub();
    });
  });
}

async function createInvite(event) {
  const button = event.currentTarget;
  const box = $('#clubInviteResult');
  button.disabled = true;
  try {
    const result = await clubCall('/club/invite', { method: 'POST' });
    if (handleClubRejection(result)) return;
    if (!result.ok) {
      box.innerHTML = `<p class="gate-error">${escapeHtml(clubMessage(result))}</p>`;
      return;
    }
    const { code, expires } = result.data;
    box.innerHTML = `<div class="club-code"><span>Код приглашения</span><b>${escapeHtml(code)}</b><small>действует до ${formatDay(expires)}</small>
      <button type="button" class="gate-submit" data-invite-share="${escapeHtml(code)}">1. Отправить приглашение</button>
      <button type="button" class="gate-submit secondary" data-code-share="${escapeHtml(code)}">2. Отправить код отдельным сообщением</button>
      <small>Код отдельным сообщением легко скопировать и вставить в приложение.</small></div>`;
    bindInviteButtons(box);
  } catch {
    box.innerHTML = '<p class="gate-error">Нет связи с клубом. Попробуйте ещё раз.</p>';
  } finally {
    button.disabled = false;
  }
}

async function loadClubMembers() {
  const box = $('#clubMembers');
  const result = await clubCall('/club/members').catch(() => null);
  if (!box) return;
  if (!result?.ok) {
    box.innerHTML = `<p class="drawer-address">${escapeHtml(clubMessage(result, 'Не удалось загрузить участников.'))}</p>`;
    return;
  }
  const rows = result.data.members.map((item) => {
    const facts = [
      item.role === 'owner' ? 'владелец' : `пригласил(а): ${escapeHtml(item.sponsor_name || '—')}`,
      `в клубе с ${formatDay(item.joined)}`,
      `${item.level_icon || '🔰'} ${item.liters || 0} 🤝`,
      `отметок за 3 ч: ${item.marks_3h}`,
      item.invited ? `привёл(а): ${item.invited}` : null,
      item.passkeys ? '🔑 вход запомнен' : null,
      item.refuted_by ? `👎 опровергли: ${item.refuted_by} ${plural(item.refuted_by, 'человек', 'человека', 'человек')} из 5${item.refuted_names?.length ? ` (${item.refuted_names.map(escapeHtml).join(', ')})` : ''}${item.warned ? ', предупреждён(а)' : ''}` : null,
      item.role !== 'owner' && item.invites_left != null ? `приглашений осталось: ${item.invites_left}` : null,
    ].filter(Boolean).join(' · ');
    const disputed = item.disputed_30d
      ? `<span class="club-flag">Противоположные отметки: ${item.disputed_30d} ${plural(item.disputed_30d, 'раз', 'раза', 'раз')} (${item.disputed_by_people_30d} ${plural(item.disputed_by_people_30d, 'человек', 'человека', 'человек')}) за 30 дней</span>`
      : '';
    const action = item.role === 'owner' ? '' : item.banned
      ? `<button type="button" class="club-small" data-unban="${escapeHtml(item.id)}">Вернуть в клуб</button><button type="button" class="club-small" data-remove="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Удалить</button>`
      : `<button type="button" class="club-small" data-award="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">🏅 Наградить</button>${state.club.features?.invites_more ? `<button type="button" class="club-small${item.invites_asked ? ' asked' : ''}" data-grant="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">🎟 +3 приглашения</button>` : ''}${state.club.features?.returning ? `<button type="button" class="club-small" data-login-code="${escapeHtml(item.id)}">🔑 Код для входа</button>` : ''}<button type="button" class="club-small danger" data-ban="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Исключить</button><button type="button" class="club-small" data-remove="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Удалить</button>`;
    return `<div class="source-row club-member${item.banned ? ' banned' : ''}"><strong>${escapeHtml(item.name)}${item.banned ? (item.banned_by === 'votes' ? ' — выбыл(а) по 👎' : ' — исключён(а)') : ''}</strong><small>${facts}</small>${disputed}${item.invites_asked && !item.banned ? '<span class="club-flag ask">🎟 Просит ещё приглашений</span>' : ''}${item.banned && item.banned_reason ? `<small>Причина: ${escapeHtml(item.banned_reason)}</small>` : ''}${action}</div>`;
  }).join('');
  const invites = result.data.invites.length
    ? `<p class="drawer-address">Неиспользованные приглашения: ${result.data.invites.map((invite) => `${escapeHtml(invite.code)} (${escapeHtml(invite.by)})`).join(', ')}</p>`
    : '';
  box.innerHTML = rows + invites;
  box.querySelectorAll('[data-ban]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt(`Исключить «${button.dataset.name}» из клуба? Его отметки сразу перестанут учитываться. Причина — её увидит исключённый:`, 'ложные отметки');
      if (reason === null) return;
      const res = await clubCall('/club/ban', { method: 'POST', body: { id: button.dataset.ban, banned: true, reason } }).catch(() => null);
      if (!res?.ok) {
        alert(clubMessage(res));
        return;
      }
      loadClubMembers();
      pollGroupMarks();
    });
  });
  box.querySelectorAll('[data-award]').forEach((button) => {
    button.addEventListener('click', async () => {
      const text = prompt(`Благодарность клуба для «${button.dataset.name}». Коротко — за что:`, 'За точные отметки');
      if (!text) return;
      const res = await clubCall('/club/award', { method: 'POST', body: { id: button.dataset.award, text } }).catch(() => null);
      if (!res?.ok) {
        alert(clubMessage(res));
        return;
      }
      showToast(`🏅 ${button.dataset.name} получает благодарность клуба`, `${text} · +10 🤝`);
      loadClubMembers();
      loadLeaderboard();
    });
  });
  // Removing is not excluding: for someone who joined twice by mistake or
  // changed phones. They see no ban and can join again with a new code.
  box.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm(`Удалить «${button.dataset.name}» из клуба? Это не исключение: его отметки уберутся, а вступить заново он сможет по новому коду.`)) return;
      const res = await clubCall('/club/remove', { method: 'POST', body: { id: button.dataset.remove } }).catch(() => null);
      if (!res?.ok) {
        alert(clubMessage(res));
        return;
      }
      showToast(`«${button.dataset.name}» удалён из клуба`, 'Пришлите новый код — он сможет вступить заново.');
      loadClubMembers();
      pollGroupMarks();
    });
  });
  box.querySelectorAll('[data-grant]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const res = await clubCall('/club/invites/grant', { method: 'POST', body: { id: button.dataset.grant, count: 3 } }).catch(() => null);
      if (res && handleClubRejection(res)) return;
      if (!res?.ok) {
        button.disabled = false;
        alert(clubMessage(res));
        return;
      }
      showToast(`🎟 «${button.dataset.name}»: +3 приглашения`, `Теперь может пригласить: ${res.data.left}.`);
      loadClubMembers();
    });
  });
  // The last resort, for someone who lost every device and never saved a
  // passkey: they come back as themselves, not as a new member.
  box.querySelectorAll('[data-login-code]').forEach((button) => {
    button.addEventListener('click', async () => {
      const res = await clubCall('/club/code', { method: 'POST', body: { id: button.dataset.loginCode } }).catch(() => null);
      if (res && handleClubRejection(res)) return;
      if (!res?.ok) {
        alert(clubMessage(res));
        return;
      }
      const holder = document.createElement('div');
      holder.innerHTML = loginCodeCard(res.data.code, `Код для входа: ${res.data.name}`, `действует до ${formatDay(res.data.expires)}, один раз`,
        'Отправьте код этому участнику отдельным сообщением. Он откроет приложение, введёт код в поле «Код приглашения» и вернётся в клуб собой — со всеми рукопожатиями.');
      button.closest('.club-member')?.append(holder);
      bindInviteButtons(holder);
      button.disabled = true;
    });
  });
  box.querySelectorAll('[data-unban]').forEach((button) => {
    button.addEventListener('click', async () => {
      const res = await clubCall('/club/ban', { method: 'POST', body: { id: button.dataset.unban, banned: false } }).catch(() => null);
      if (!res?.ok) {
        alert(clubMessage(res));
        return;
      }
      loadClubMembers();
    });
  });
}

function groupMarkFor(stationId, grade) {
  const mark = (state.groupMarks || {})[stationId]?.[grade];
  if (!mark || Date.now() - mark.at > GROUP_MARK_TTL_MS) return null;
  return mark;
}

// The group's own fresh look at the pump outranks every feed; the card must say
// so in plain words, not bury it in the vote list. A live mark from the worker
// wins over the pipeline's copy when it is newer.
function eyewitnessLine(grade, stationId, { brief = false } = {}) {
  const live = stationId ? groupMarkFor(stationId, state.grade) : null;
  const piped = grade?.eyewitness;
  const liveAge = live ? (Date.now() - live.at) / 1000 : null;
  let seen;
  let ageSeconds;
  let people = 1;
  let names = [];
  let queue = null;
  if (live && (!piped || !piped.fresh || liveAge <= (piped.age_seconds ?? Infinity))) {
    seen = live.seen;
    ageSeconds = liveAge;
    people = live.people.length;
    names = (live.names || []).filter(Boolean);
    queue = live.queue;
  } else if (piped && piped.fresh) {
    seen = piped.seen;
    ageSeconds = piped.age_seconds;
    queue = piped.queue;
  } else {
    return null;
  }
  const ago = ageSeconds != null ? formatAge(ageSeconds) : 'только что';
  const queueText = queue != null && queue !== '' ? `, очередь: ${queueWords(queue)}` : '';
  const crowd = names.length ? ` (${names.join(', ')})` : people > 1 ? ` (${people} ${plural(people, 'человек', 'человека', 'человек')})` : '';
  return {
    tone: seen ? 'yes' : 'no',
    text: `👁 Свои видели ${ago}${crowd}: ${GRADE_LABELS[state.grade]} ${seen ? 'есть' : 'нет'}${queueText}${brief ? '' : ' — самая точная отметка'}`,
  };
}

function markFor(stationId, grade) {
  return (state.marks || {})[stationId]?.[grade] || null;
}

function markLine(stationId, grade) {
  const mark = markFor(stationId, grade);
  if (!mark) return null;
  const ago = formatAge((Date.now() - mark.at) / 1000);
  return `Вы отметили ${ago}: ${GRADE_LABELS[grade]} ${mark.seen ? 'есть' : 'нет'}`;
}

// A driver passing a station can confirm or refute it from the car window; a
// person standing at the pump is just the closest case. Cards this near get
// the buttons directly, so nobody has to hunt for "where do I report".
const NEARBY_REPORT_METRES = 400;

function markButtons(stationId, { compact = false } = {}) {
  return `<div class="mark-row${compact ? ' compact' : ''}">
    <span>${compact ? 'Вы рядом — подтвердите:' : 'Вы на месте — что на колонке?'}</span>
    <button type="button" class="mark yes" data-mark-station="${escapeHtml(stationId)}" data-mark-seen="1">${escapeHtml(GRADE_LABELS[state.grade])} есть</button>
    <button type="button" class="mark no" data-mark-station="${escapeHtml(stationId)}" data-mark-seen="0">${escapeHtml(GRADE_LABELS[state.grade])} нет</button>
  </div>`;
}

// Standing at a station a person sees every pump at once, so the drawer
// asks about every grade and the queue together and sends it in one go.
// At the worst stations the queue runs to a hundred cars and more.
const QUEUE_CHOICES = [[0, 'нет'], [3, 'до 5'], [12, 'до 20'], [35, 'до 50'], [75, 'до 100'], [150, 'больше 100']];

function queueWords(cars) {
  if (cars == null || cars === '') return null;
  const n = Number(cars);
  if (n === 0) return 'нет';
  if (n <= 5) return 'до 5 машин';
  if (n <= 20) return 'до 20 машин';
  if (n <= 50) return 'до 50 машин';
  if (n <= 100) return 'до 100 машин';
  return 'больше 100 машин';
}

function markComposer(stationId) {
  const rows = Object.keys(GRADE_LABELS).map((grade) => `<div class="compose-row">
      <b>${escapeHtml(GRADE_LABELS[grade])}</b>
      <button type="button" class="mark yes" data-compose-grade="${grade}" data-compose-seen="1">есть</button>
      <button type="button" class="mark no" data-compose-grade="${grade}" data-compose-seen="0">нет</button>
    </div>`).join('');
  const queue = QUEUE_CHOICES.map(([cars, label]) => `<button type="button" class="queue-chip" data-compose-queue="${cars}">${label}</button>`).join('');
  return `<div class="mark-composer" data-compose-station="${escapeHtml(stationId)}">
    <div class="compose-grades">${rows}</div>
    <div class="compose-queue"><span>Очередь:</span>${queue}</div>
    <button type="button" class="compose-send" disabled>Отправить своим</button>
  </div>`;
}

// On a card near the station there is no room, and no time, for five rows of
// buttons: one chip per grade, tapped once for "есть" and twice for "нет".
function quickComposer(stationId) {
  const chips = Object.keys(GRADE_LABELS).map((grade) => `<button type="button" class="quick-grade" data-quick-grade="${grade}" aria-pressed="false">${escapeHtml(GRADE_LABELS[grade].replace('АИ-', ''))}</button>`).join('');
  const queue = QUEUE_CHOICES.map(([cars, label]) => `<button type="button" class="queue-chip" data-compose-queue="${cars}">${label}</button>`).join('');
  return `<div class="mark-composer quick" data-compose-station="${escapeHtml(stationId)}">
    <span class="quick-title">Вы рядом. Нажмите марку: один раз — <b>есть</b>, второй — <b>нет</b></span>
    <div class="quick-grades">${chips}</div>
    <div class="compose-queue"><span>Очередь:</span>${queue}</div>
    <button type="button" class="compose-send" disabled>Отправить своим</button>
  </div>`;
}

// What a person has pressed in a composer lives here, not in its buttons. The
// «Вы у АЗС» panel is drawn again on every fix and the list on every poll, and
// each redraw wiped the chips pressed so far: from the road the buttons
// «sometimes work, sometimes don't, then reset» (14 Sep 2026). One draft per
// station, shared by the panel, the card and the station's drawer, until it is
// sent. A draft nobody touched for ten minutes no longer says what is on the
// pumps and is dropped.
const composeDrafts = new Map();
const DRAFT_KEEP_MS = 10 * 60 * 1000;

function composeDraft(stationId, { touch = false } = {}) {
  const now = Date.now();
  composeDrafts.forEach((draft, id) => {
    if (now - draft.touched > DRAFT_KEEP_MS) composeDrafts.delete(id);
  });
  let draft = composeDrafts.get(stationId) || null;
  if (touch) {
    draft = draft || { chosen: {}, queue: null, touched: now };
    draft.touched = now;
    composeDrafts.set(stationId, draft);
  }
  return draft;
}

// Every composer of the station on screen shows the same draft, so the panel,
// the card beneath it and an open drawer never disagree about what is pressed.
function paintComposers(stationId) {
  document.querySelectorAll('.mark-composer').forEach((box) => {
    if (box.dataset.composeStation === stationId) paintComposer(box);
  });
}

function paintComposer(box) {
  const draft = composeDraft(box.dataset.composeStation);
  const chosen = draft?.chosen || {};
  box.querySelectorAll('[data-quick-grade]').forEach((button) => {
    const value = chosen[button.dataset.quickGrade];
    const label = GRADE_LABELS[button.dataset.quickGrade].replace('АИ-', '');
    button.classList.toggle('yes', value === true);
    button.classList.toggle('no', value === false);
    button.textContent = value === true ? `${label} ✓` : value === false ? `${label} ✕` : label;
    button.setAttribute('aria-pressed', String(value !== undefined));
  });
  box.querySelectorAll('[data-compose-grade]').forEach((button) => {
    const pressed = chosen[button.dataset.composeGrade] === (button.dataset.composeSeen === '1');
    button.classList.toggle('selected', pressed);
    button.setAttribute('aria-pressed', String(pressed));
  });
  box.querySelectorAll('[data-compose-queue]').forEach((button) => {
    const pressed = draft?.queue != null && draft.queue === Number(button.dataset.composeQueue);
    button.classList.toggle('selected', pressed);
    button.setAttribute('aria-pressed', String(pressed));
  });
  const send = box.querySelector('.compose-send');
  if (send) send.disabled = !Object.keys(chosen).length;
}

// A finger on a composer holds off whatever would draw it again. A redraw
// between pointerdown and click lost the tap, and a panel or a card redrawn
// above it moved the next chip away from the thumb. For fifteen seconds after
// the last touch the panel and the list stay as they are and then draw once;
// the draft brings the chips back either way. The drawer lies over the page,
// so what happens beneath it moves nothing and is not held.
const COMPOSER_HOLD_MS = 15000;
let composerTouch = { box: null, at: 0 };
const heldRedraws = new Set();
let heldTimer = null;

function holdComposer(box) {
  composerTouch = { box, at: Date.now() };
}

function releaseComposer(box) {
  if (composerTouch.box === box) composerTouch = { box: null, at: 0 };
}

/** True when `redraw` would rebuild or move a composer under a finger; it then runs by itself once the pause is over. */
function holdRedraw(redraw) {
  const { box, at } = composerTouch;
  const held = !!box?.isConnected && !!box.closest('#contentGrid') && Date.now() - at < COMPOSER_HOLD_MS;
  if (!held) {
    heldRedraws.delete(redraw);
    return false;
  }
  heldRedraws.add(redraw);
  if (!heldTimer) {
    heldTimer = setTimeout(() => {
      heldTimer = null;
      const due = [...heldRedraws];
      heldRedraws.clear();
      due.forEach((run) => run());
    }, at + COMPOSER_HOLD_MS - Date.now() + 50);
  }
  return true;
}

function bindComposer(root) {
  const box = root.querySelector('.mark-composer');
  if (!box) return;
  const stationId = box.dataset.composeStation;
  const send = box.querySelector('.compose-send');
  // Held from the moment the finger lands, not from the click that follows.
  box.addEventListener('pointerdown', () => holdComposer(box));
  const choose = (event, change) => {
    event.stopPropagation();
    holdComposer(box);
    change(composeDraft(stationId, { touch: true }));
    paintComposers(stationId);
  };
  box.querySelectorAll('[data-quick-grade]').forEach((button) => {
    button.addEventListener('click', (event) => choose(event, ({ chosen }) => {
      const grade = button.dataset.quickGrade;
      if (!(grade in chosen)) chosen[grade] = true;
      else if (chosen[grade] === true) chosen[grade] = false;
      else delete chosen[grade];
    }));
  });
  box.querySelectorAll('[data-compose-grade]').forEach((button) => {
    button.addEventListener('click', (event) => choose(event, ({ chosen }) => {
      chosen[button.dataset.composeGrade] = button.dataset.composeSeen === '1';
    }));
  });
  box.querySelectorAll('[data-compose-queue]').forEach((button) => {
    button.addEventListener('click', (event) => choose(event, (draft) => {
      draft.queue = Number(button.dataset.composeQueue);
    }));
  });
  send.addEventListener('click', (event) => {
    event.stopPropagation();
    const draft = composeDraft(stationId);
    const chosen = draft?.chosen || {};
    const queue = draft?.queue ?? null;
    const grades = Object.keys(GRADE_LABELS).filter((grade) => grade in chosen);
    // A draft dropped while the page stood untouched sends nothing.
    if (!grades.length) {
      paintComposers(stationId);
      return;
    }
    composeDrafts.delete(stationId);
    const summary = grades.map((grade) => `${GRADE_LABELS[grade].replace('АИ-', '')} ${chosen[grade] ? 'есть' : 'нет'}`).join(', ');
    const queueText = queue != null ? `, очередь: ${queueWords(queue)}` : '';
    // A look at a station the app knew nothing fresh about is worth a bonus.
    const details = state.stationDetails[stationId];
    const blindSpot = grades.some((grade) => ['NO_FRESH_DATA', 'CONFLICT'].includes(details?.grades?.[grade]?.status || state.gradesBrief?.[stationId]?.[grade]?.s));
    grades.forEach((grade) => saveMark(stationId, grade, chosen[grade], queue, { render: false, share: false }));
    box.innerHTML = `<span class="mark-sent">⏳ Отправляю своим: ${escapeHtml(summary)}${escapeHtml(queueText)}…</span>`;
    // Another composer of this station, on the card under the panel, empties too.
    paintComposers(stationId);
    shareLook(stationId, grades.map((grade) => ({ grade, seen: chosen[grade] })), queue, { summary: summary + queueText, blindSpot })
      .then((outcome) => showSendOutcome(box.querySelector('.mark-sent'), outcome, `${summary}${queueText}`, 'У всех это уже наверху, в «Свои сообщают».'));
    renderGroupFeed();
    // The hold still stands, so a fix does not wipe the line saying where the
    // mark went before it can be read; after these seconds the card says
    // «Вы отметили» and the panel moves on.
    setTimeout(() => {
      releaseComposer(box);
      renderStations();
      renderHerePanel();
    }, 4000);
  });
  paintComposer(box);
}

// The line under the buttons tells the truth about where the mark went.
function showSendOutcome(line, outcome, what, sentNote) {
  if (!line?.isConnected) return;
  if (outcome === 'queued') line.textContent = `⏳ Нет связи. ${what} — сохранено на телефоне и уйдёт само, как только появится интернет.`;
  else if (outcome === 'refused') line.textContent = `Не отправлено: ${what}. Отметка осталась только на этом телефоне.`;
  else line.textContent = `✔ Отправлено своим: ${what}. ${sentNote}`;
  line.classList.toggle('waiting', outcome === 'queued');
  line.classList.toggle('refused', outcome === 'refused');
}

function bindMarkButtons(root) {
  root.querySelectorAll('[data-mark-station]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const seen = button.dataset.markSeen === '1';
      const row = button.closest('.mark-row');
      const what = `${GRADE_LABELS[state.grade]} ${seen ? 'есть' : 'нет'}`;
      if (row) row.innerHTML = `<span class="mark-sent">⏳ Отправляю своим: ${escapeHtml(what)}…</span>`;
      const line = row?.querySelector('.mark-sent');
      const station = state.stations.find((item) => item.id === button.dataset.markStation);
      saveMark(button.dataset.markStation, state.grade, seen, null, { blindSpot: ['NO_FRESH_DATA', 'CONFLICT'].includes(station?.grade?.status) })
        .then((outcome) => showSendOutcome(line, outcome, what, 'Они увидят это сразу.'));
    });
  });
}

// Standing at the pump is the one moment when a driver can check us against
// reality. Within this distance the app stops listing options and answers the
// only question that matters there: what do we claim about *this* station.
const AT_STATION_METRES = 220;

// "Россия, Санкт-Петербург, Санкт-Петербург, Богатырский проспект, 23" is what
// a feed says; a driver in the city only needs the street.
function shortAddress(address) {
  return String(address || '')
    .replace(/^(?:(?:Российская Федерация|Россия|РФ|г\.?\s*Санкт-Петербург|Санкт-Петербург|Ленинградская область|Ленинградская обл\.?),\s*)+/i, '')
    .replace(/^[\s,]+/, '');
}

function formatDistance(km) {
  if (km == null) return '';
  return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`;
}

function markedRecently(stationId, minutes = 15) {
  return Object.values((state.marks || {})[stationId] || {}).some((mark) => Date.now() - mark.at < minutes * 60 * 1000);
}

function renderHerePanel() {
  const panel = $('#herePanel');
  if (!panel) return;
  // Every fix lands here while the phone stands at the pump.
  if (holdRedraw(renderHerePanel)) return;
  if (!state.location || !state.stations.length || effectiveAccuracy() > ROUGH_METRES) {
    panel.hidden = true;
    return;
  }
  const nearest = state.stations
    .filter((item) => item.location)
    .map((item) => ({ item, km: liveDistanceKm(item) }))
    .sort((a, b) => a.km - b.km)[0];
  if (nearest && nearest.km * 1000 <= AT_STATION_METRES && !markedRecently(nearest.item.id, 10)) {
    const station = nearest.item;
    const brief = (state.gradesBrief || {})[station.id] || {};
    const rows = Object.keys(GRADE_LABELS).map((grade) => {
      const status = grade === state.grade ? station.grade.status : (brief[grade]?.s || 'NO_FRESH_DATA');
      const mark = GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA;
      return `<div class="here-grade ${mark.tone}"><b>${escapeHtml(GRADE_LABELS[grade])}</b><span>${mark.sign} ${escapeHtml(STATUS[status].short)}</span></div>`;
    }).join('');
    const witness = eyewitnessLine(station.grade, station.id);
    panel.hidden = false;
    panel.innerHTML = `
      <span class="here-kicker">Вы у АЗС · ${escapeHtml(formatDistance(nearest.km))}</span>
      <strong>${escapeHtml(displayNetwork(station.network))}</strong>
      <span class="here-address">${escapeHtml(shortAddress(station.address))}</span>
      <div class="here-grades">${rows}</div>
      ${witness ? `<p class="here-mine group ${witness.tone}">${escapeHtml(witness.text)}</p>` : ''}
      ${quickComposer(station.id)}
      <div class="here-actions"><button type="button" id="hereDetails">Подробнее об этой АЗС</button></div>`;
    $('#hereDetails').addEventListener('click', () => openStation(station.id));
    bindComposer(panel);
    return;
  }
  const recent = Object.entries(state.passed)
    .map(([id, item]) => ({ id, ...item, away: haversineKm(state.location, item.location) * 1000 }))
    .filter((item) => item.away > AT_STATION_METRES && Date.now() - item.at <= PASSED_KEEP_MS && !markedRecently(item.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  if (!recent.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <span class="here-kicker">Недавно проезжали — отметьте, пока помните</span>
    <div class="passed-list">${recent.map((item) => `<button type="button" class="passed-item" data-passed-station="${escapeHtml(item.id)}">
      <strong>${escapeHtml(shortNetwork(item.network))}</strong>
      <span>${escapeHtml(shortAddress(item.address))} · ${escapeHtml(formatAge((Date.now() - item.at) / 1000))}</span>
      <em>Отметить →</em>
    </button>`).join('')}</div>
    <p class="here-note">Отметить можно и позже — на светофоре или с пассажирского места. Не уверены — пропустите.</p>`;
  panel.querySelectorAll('[data-passed-station]').forEach((button) => {
    button.addEventListener('click', () => openStation(button.dataset.passedStation));
  });
}

// ---------------------------------------------------------------- close by
// Pulling up to a pump, or driving past one, the eye has to find its card and
// its pin at once: «📍 Вы здесь» on the station the phone is at, «📍 рядом» on
// the ones within a kilometre. Words and a symbol, not colour alone, so it
// reads in low sun and for someone who cannot tell green from grey.
const NEAR_BADGE_KM = 1;
// A watch can report a fix every second. Repainting on each would only make
// the badges twitch and keep a phone in its holder busy for nothing.
const NEARBY_REFRESH_MS = 2000;
let nearbyPaintedAt = 0;
let nearbyTimer = null;

// Only where the phone is counts. A place found by «Проверить по адресу» has
// no accuracy, and while that search is on, the distances on the cards are
// from the address typed in, not from the driver.
function phonePlace() {
  return state.location && state.accuracy != null && state.searchScope !== 'place' ? state.location : null;
}

// Every station a card or a pin on screen can stand for, and where it is.
function nearbyPlaces() {
  const places = new Map();
  state.stations.forEach((station) => {
    if (station.location) places.set(station.id, station.location);
  });
  if (state.ownOnly) {
    ownEntries().forEach(({ stationId }) => {
      const place = stationPlace(stationId);
      if (place) places.set(stationId, place);
    });
  }
  return places;
}

// The one station the phone is at: the nearest within AT_STATION_METRES, as
// the «Вы у АЗС» panel picks it. Two stations facing each other across a road
// can both be that close, and «Вы здесь» on both would point at neither. A
// rough fix can put the dot on the wrong forecourt, so it names none.
// The drive screen asks for closer than the list does: it says «Вы на АЗС» only
// beside the pumps.
function stationHereId(phone, places, withinMetres = AT_STATION_METRES) {
  if (!phone || effectiveAccuracy() > ROUGH_METRES) return null;
  let best = null;
  places.forEach((place, id) => {
    const metres = haversineKm(phone, place) * 1000;
    if (metres <= withinMetres && (!best || metres < best.metres)) best = { id, metres };
  });
  return best?.id ?? null;
}

function nearness(stationId, km, hereId) {
  if (km == null) return '';
  if (stationId === hereId) return 'here';
  return km <= NEAR_BADGE_KM ? 'near' : '';
}

// Cards and pins follow the phone in place, the way the 👍/👎 buttons do: a
// class and a few words change and nothing is redrawn, so the list does not
// jump and a finger on its way to a card still lands on it.
function paintNearby() {
  const phone = phonePlace();
  const places = nearbyPlaces();
  const hereId = stationHereId(phone, places);
  document.querySelectorAll('#stationList .station-card[data-nearby-station]').forEach((card) => {
    const id = card.dataset.nearbyStation;
    const place = places.get(id);
    const km = phone && place ? haversineKm(phone, place) : null;
    const nearby = nearness(id, km, hereId);
    card.classList.toggle('is-here', nearby === 'here');
    card.classList.toggle('is-near', nearby === 'near');
    const topline = card.querySelector('.card-topline');
    if (!topline) return;
    const distance = topline.querySelector('.distance');
    const words = nearby === 'here' ? '📍 Вы здесь' : nearby === 'near' ? `📍 рядом · ${formatDistance(km)}` : '';
    let badge = topline.querySelector('.nearby-badge');
    if (words && !badge) {
      badge = document.createElement('span');
      badge.className = 'nearby-badge';
      topline.insertBefore(badge, distance);
    }
    if (!words) badge?.remove();
    else if (badge.textContent !== words) badge.textContent = words;
    // «Вы здесь» beside the distance from when the list was loaded, a few
    // hundred metres back, would contradict itself.
    const figure = formatDistance(km);
    if (distance && km != null && distance.textContent !== figure) distance.textContent = figure;
  });
  // Pins change on the element Leaflet already drew: a new icon would be built
  // under a finger about to tap it, and would restart the pulse on every fix.
  state.markers?.eachLayer((marker) => {
    const element = marker.getElement();
    if (!element) return;
    const { lat, lng } = marker.getLatLng();
    const nearby = phone ? nearness(marker.options.stationId, haversineKm(phone, { lat, lon: lng }), hereId) : '';
    element.classList.toggle('near', nearby !== '');
    element.classList.toggle('here', nearby === 'here');
    // Over the neighbours' labels, still under the phone's own blue dot.
    const lift = nearby === 'here' ? 800 : nearby ? 500 : 0;
    if ((marker.options.zIndexOffset || 0) !== lift) marker.setZIndexOffset(lift);
  });
}

// Called whenever the phone's place changes. Paints at most once per
// NEARBY_REFRESH_MS and always once after the last fix, so the badges settle
// where the phone did.
function refreshNearby() {
  if (nearbyTimer) return;
  nearbyTimer = setTimeout(() => {
    nearbyTimer = null;
    nearbyPaintedAt = Date.now();
    paintNearby();
  }, Math.max(0, nearbyPaintedAt + NEARBY_REFRESH_MS - Date.now()));
}

// Drivers look for the card of the pump they stand at, and «Ближайшие
// доступные» sank it below farther stations with fuel whenever it had no fresh
// data or none. Where the phone is, the station it is at comes first and the
// others within reach of a mark follow by distance; the rest keep the order
// chosen. Worked out when the list is drawn and never as the phone moves in
// between, so a card does not jump while a finger is on its way to it.
function stationOrder() {
  const phone = phonePlace();
  if (!phone) return { stations: state.stations, pinned: 0 };
  const hereId = stationHereId(phone, nearbyPlaces());
  const close = state.stations
    .filter((station) => station.location)
    .map((station) => ({ station, metres: haversineKm(phone, station.location) * 1000 }))
    .filter(({ station, metres }) => station.id === hereId || metres <= NEARBY_REPORT_METRES)
    .sort((a, b) => Number(b.station.id === hereId) - Number(a.station.id === hereId) || a.metres - b.metres)
    .map(({ station }) => station);
  if (!close.length) return { stations: state.stations, pinned: 0 };
  const pinned = new Set(close);
  return { stations: [...close, ...state.stations.filter((station) => !pinned.has(station))], pinned: close.length };
}

function renderStations({ append = false } = {}) {
  // The cards carry composers and lie under the panel, so a finger on either
  // keeps the list as it is until the pause is over. «Показать ещё» is that
  // finger's own request and only adds below.
  if (!append && holdRedraw(renderStations)) return;
  const list = $('#stationList');
  renderHerePanel();
  if (state.ownOnly) {
    renderOwnList();
    return;
  }
  if (!state.stations.length) {
    // Say which filter emptied the list, otherwise a stray map area or status
    // chip looks like a broken application.
    const active = [];
    if (state.searchScope === 'map') active.push('выбранная область карты');
    if (state.searchScope === 'place' || state.searchScope === 'device') active.push(`радиус ${state.radiusKm} км`);
    if (state.search.trim()) active.push(`поиск «${state.search.trim()}»`);
    if (state.status) active.push(`статус «${STATUS[state.status].short}»`);
    if (state.timeline) active.push('только недавно появившиеся');
    if (state.area !== 'all') active.push(state.area === 'spb' ? 'только Петербург' : 'только область');
    list.innerHTML = `<div class="empty-state"><strong>Ничего не найдено</strong><br>${
      active.length ? `Активные ограничения: ${escapeHtml(active.join(', '))}.` : 'Данных по этой марке сейчас нет.'
    }<br><button type="button" class="list-more" id="resetFilters">Сбросить все фильтры</button></div>`;
    $('#resetFilters').addEventListener('click', resetFilters);
    return;
  }
  // «Показать ещё» continues the order the list was drawn in.
  if (!append) {
    state.visible = 0;
    state.listOrder = stationOrder();
  }
  const { stations, pinned } = state.listOrder || { stations: state.stations, pinned: 0 };
  const from = state.visible;
  // Pinned cards are all on the first page, however many there are.
  const to = Math.min(stations.length, from + (from ? PAGE_SIZE : Math.max(PAGE_SIZE, pinned)));
  state.visible = to;
  const fragment = document.createDocumentFragment();
  stations.slice(from, to).forEach((station) => {
    const node = $('#stationTemplate').content.cloneNode(true);
    const grade = station.grade;
    const advice = grade.advice || {};
    const card = node.querySelector('.station-card');
    card.dataset.nearbyStation = station.id;
    card.style.setProperty('--status-color', DECISION_TONE[advice.decision] || STATUS[grade.status].color);
    node.querySelector('.network').textContent = displayNetwork(station.network);
    node.querySelector('.address').textContent = shortAddress(station.address);
    node.querySelector('.grade-chips').innerHTML = gradeChips(station);
    node.querySelector('.verdict-text').textContent = advice.label || STATUS[grade.status].short;
    node.querySelector('.verdict-dot').style.background = RISK_TONE[advice.risk] || '#8a9691';
    const chance = grade.probability_percent;
    const waitText = advice.wait_text ? ` · стоять ${advice.wait_text}` : '';
    node.querySelector('.wait').textContent = (chance != null ? ` · ${chance}% за наличие` : '') + waitText;
    const temporal = timelineBadge(grade.timeline);
    if (temporal) {
      const badge = node.querySelector('.timeline-badge');
      badge.hidden = false;
      badge.textContent = temporal.text;
      badge.dataset.tone = temporal.tone;
    }
    const facts = factsFor(station);
    // "Держится 1 мин" is good news and a warning at once; the warning has to
    // be on the card, not hidden in the drawer.
    const caution = advice.caution ? ` ${advice.caution}` : '';
    node.querySelector('.facts').textContent = facts + caution;
    node.querySelector('.meta-line').textContent = metaFor(station);
    const witness = eyewitnessLine(grade, station.id);
    if (witness) {
      const own = document.createElement('span');
      own.className = `own-mark group ${witness.tone}`;
      own.textContent = witness.text;
      node.querySelector('.card-main').insertBefore(own, node.querySelector('.facts'));
    }
    const mine = markLine(station.id, state.grade);
    if (mine && !witness) {
      const own = document.createElement('span');
      own.className = 'own-mark';
      own.textContent = `✔ ${mine}`;
      node.querySelector('.card-main').insertBefore(own, node.querySelector('.meta-line'));
    }
    // Buttons inside the card's own button are invalid HTML: on iPhone a tap on
    // them opened the card or did nothing. They live in a sibling block now.
    const actions = node.querySelector('.card-actions');
    const km = liveDistanceKm(station);
    const near = state.location && effectiveAccuracy() <= 500 && km != null && km * 1000 <= NEARBY_REPORT_METRES;
    if (near && markedRecently(station.id)) {
      const own = Object.values(state.marks[station.id]).sort((a, b) => b.at - a.at)[0];
      actions.innerHTML = `<span class="mark-sent">✔ Вы отметили ${escapeHtml(formatAge((Date.now() - own.at) / 1000))}</span> <button type="button" class="mark-link" data-open-station>Изменить</button>`;
    } else if (near) {
      actions.innerHTML = quickComposer(station.id);
      bindComposer(actions);
    } else {
      actions.innerHTML = '<button type="button" class="mark-link" data-open-station>Видите эту АЗС? Отметить для своих →</button>';
    }
    actions.querySelector('[data-open-station]')?.addEventListener('click', () => openStation(station.id));
    const second = yandexLine(grade);
    if (second && second.agrees === false) {
      const note = document.createElement('span');
      note.className = 'yandex-flag';
      note.textContent = `⚠ ${second.text}`;
      node.querySelector('.card-main').insertBefore(note, node.querySelector('.meta-line'));
    }
    const distance = node.querySelector('.distance');
    distance.textContent = formatDistance(liveDistanceKm(station));
    // Straight line, not the drive: around water and interchanges the road can
    // be far longer, and saying "км" without that is misleading.
    if (station.distance_km != null) distance.title = 'по прямой, дорога может быть заметно длиннее';
    node.querySelector('.card-main').addEventListener('click', () => openStation(station.id));
    fragment.appendChild(node);
  });
  if (append) {
    list.querySelector('.list-more')?.remove();
    list.appendChild(fragment);
  } else {
    list.replaceChildren(fragment);
  }
  paintNearby();
  if (state.visible < stations.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'list-more';
    more.textContent = `Показать ещё ${Math.min(PAGE_SIZE, stations.length - state.visible)} из ${(stations.length - state.visible).toLocaleString('ru-RU')}`;
    more.addEventListener('click', () => renderStations({ append: true }));
    list.appendChild(more);
  }
}

function initMap() {
  if (!window.L) { $('#mapFallback').hidden = false; return; }
  // Required map-data credit is kept in the footer; it no longer obscures stations.
  state.map = L.map('map', {
    zoomControl: false, attributionControl: false, dragging: true,
    scrollWheelZoom: true, touchZoom: true, doubleClickZoom: true,
  }).setView([59.94, 30.32], 10);
  const mapElement = $('#map');
  mapElement.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  mapElement.addEventListener('pointerdown', () => { state.map.dragging.enable(); });
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
  }).addTo(state.map);
  state.markers = L.layerGroup().addTo(state.map);
  state.map.on('moveend', () => { $('#mapAreaButton').style.display = 'block'; renderMarkers(); });
}

function renderMe() {
  if (!state.map || !state.location) {
    if (state.meLayer) { state.meLayer.remove(); state.meLayer = null; }
    return;
  }
  if (state.meLayer) state.meLayer.remove();
  state.meLayer = L.marker([state.location.lat, state.location.lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    interactive: false,
    zIndexOffset: 1000,
  }).addTo(state.map);
}

// From this zoom in, a pin carries the network and every grade coloured by
// status, so the map answers "what is there" without a tap — the thing
// drivers like about Yandex's pins, here with our statuses behind it.
const LABEL_ZOOM = 12;

// Feeds name an unbranded station "other" and some networks by a lower-case
// id; a driver should read a name, not a database value.
function displayNetwork(name) {
  const text = String(name || '').trim();
  if (!text || /^(other|прочие|независимая)/i.test(text)) return 'АЗС';
  return text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);
}

function shortNetwork(name) {
  const head = String(name || '').split(',')[0].replace(/\s*АЗС\s*$/i, '').trim().slice(0, 16);
  if (!head || /^(other|прочие|независимая)/i.test(head)) return 'АЗС';
  // Some feeds name the network by a lower-case id ("gazprom").
  return head.charAt(0).toLocaleUpperCase('ru-RU') + head.slice(1);
}

function pinLabel(station) {
  const brief = (state.gradesBrief || {})[station.id] || {};
  const grades = Object.keys(GRADE_LABELS).map((grade) => {
    const status = grade === state.grade ? station.grade.status : (brief[grade]?.s || 'NO_FRESH_DATA');
    const tone = (GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA).tone;
    return `<i class="${tone}">${escapeHtml(GRADE_LABELS[grade].replace('АИ-', ''))}</i>`;
  }).join('');
  const queue = station.grade.queue?.label ? `<em>очередь: ${escapeHtml(station.grade.queue.label)}</em>` : '';
  const witness = eyewitnessLine(station.grade, station.id);
  const eye = witness ? `<em class="pin-eye ${witness.tone}">👁 свои: ${witness.tone === 'yes' ? 'есть' : 'нет'}</em>` : '';
  return `<span class="pin-label"><b>${escapeHtml(shortNetwork(station.network))}</b><span class="pin-grades">${grades}</span>${eye || queue}</span>`;
}

function renderMarkers() {
  if (!state.map || !state.markers) return;
  renderMe();
  state.markers.clearLayers();
  if (state.ownOnly) {
    renderOwnMarkers();
    return;
  }
  const labelled = state.map.getZoom() >= LABEL_ZOOM;
  const bounds = labelled ? state.map.getBounds().pad(0.3) : null;
  state.stations.forEach((station) => {
    const status = STATUS[station.grade.status];
    const withLabel = labelled && bounds.contains([station.location.lat, station.location.lon]);
    const icon = L.divIcon({
      className: '',
      html: `<div class="fuel-pin${withLabel ? ' labelled' : ''}" style="--marker:${status.color}"><span class="fuel-marker"></span>${withLabel ? pinLabel(station) : ''}</div>`,
      iconSize: [20, 20], iconAnchor: [10, 20],
    });
    const marker = L.marker([station.location.lat, station.location.lon], { icon, stationId: station.id });
    marker.bindPopup(`<div class="popup-title">${escapeHtml(station.network)}</div><div>${escapeHtml(shortAddress(station.address))}</div><div class="popup-status" style="--popup-color:${status.color}">${escapeHtml(station.grade.label)}</div><button class="popup-open" onclick="window.openFuelStation('${station.id}')">Открыть и отметить</button>`);
    marker.addTo(state.markers);
  });
  paintNearby();
}

// ---------------------------------------------------------------- motion
// How fast the phone goes and which way, from the same fixes the list follows.
// A browser gives speed and heading only now and then (never on a computer,
// nor in a test), so both are also worked out from the fixes themselves. The
// drive screen needs them to know that the car moves, which way is ahead and
// when it has stopped.
const MOTION_KEEP_MS = 60 * 1000;
// Speed is measured over at least this long: a fix wanders by a few metres,
// and between two fixes a second apart that alone reads as walking pace.
const MOTION_WINDOW_MS = 4000;
// No fix for this long after driving is a tunnel or a lost signal, not a stop.
const MOTION_STALE_MS = 12000;
// A fix rougher than this says nothing about speed.
const MOTION_MAX_ACCURACY = 100;
// Faster than any car in town: the fix jumped, the phone did not.
const MOTION_JUMP_KMH = 250;
// Standing, fixes wander in every direction, and a heading taken from them
// would spin the map: only from fixes this far apart, above this speed.
const HEADING_MIN_METRES = 15;
const HEADING_MIN_KMH = 10;
const DRIVING_KMH = 15;
const MOVING_KMH = 5;
const STILL_KMH = 3;
const motion = { fixes: [], speed: null, heading: null, fastSince: 0, slowSince: 0, stillSince: 0 };

function bearingDegrees(from, to) {
  const rad = Math.PI / 180;
  const y = Math.sin((to.lon - from.lon) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lon - from.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// How far `bearing` lies to the right of `heading`, from -180 to 180 degrees.
function turnFrom(heading, bearing) {
  return ((bearing - heading + 540) % 360) - 180;
}

function noteMotion(coords, stamp = null) {
  const accuracy = Number(coords.accuracy) || 0;
  if (accuracy > MOTION_MAX_ACCURACY) return;
  const now = Date.now();
  const fix = { lat: coords.latitude, lon: coords.longitude, at: now, stamp, accuracy };
  const last = motion.fixes[motion.fixes.length - 1];
  // The same fix handed out again from the browser's cache is no news. Its
  // time is only compared, never subtracted: WebKit has given it in microseconds.
  if (last && stamp != null && last.stamp === stamp) return;
  if (last) {
    const metres = haversineKm(last, fix) * 1000;
    if (metres > 50 && (metres / Math.max(0.001, (now - last.at) / 1000)) * 3.6 > MOTION_JUMP_KMH) {
      motion.fixes = [];
      motion.speed = null;
    }
  }
  motion.fixes = [...motion.fixes.filter((item) => now - item.at <= MOTION_KEEP_MS), fix];
  let speed = Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed * 3.6 : null;
  if (speed == null) {
    const reference = [...motion.fixes].reverse().find((item) => now - item.at >= MOTION_WINDOW_MS);
    if (reference) {
      const metres = haversineKm(reference, fix) * 1000;
      // Within the fixes' own spread the phone may just as well be standing.
      speed = metres < Math.max(reference.accuracy, accuracy) / 2 ? 0 : (metres / ((now - reference.at) / 1000)) * 3.6;
    }
  }
  motion.speed = speed;
  if (speed != null && speed > HEADING_MIN_KMH) {
    let heading = Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : null;
    if (heading == null) {
      const back = [...motion.fixes].reverse().find((item) => item !== fix && haversineKm(item, fix) * 1000 >= HEADING_MIN_METRES);
      if (back) heading = bearingDegrees(back, fix);
    }
    // Half way towards each new reading: a turn shows within seconds, and one
    // stray fix does not swing the map.
    if (heading != null) motion.heading = motion.heading == null ? heading : (motion.heading + turnFrom(motion.heading, heading) / 2 + 360) % 360;
  }
  motion.fastSince = speed != null && speed > DRIVING_KMH && !document.hidden ? motion.fastSince || now : 0;
  motion.slowSince = speed != null && speed <= MOVING_KMH ? motion.slowSince || now : 0;
  motion.stillSince = speed != null && speed < STILL_KMH ? motion.stillSince || now : 0;
}

// The speed to act on now. A phone standing still may go without fixes for a
// while; one that was driving has lost its signal, and its speed is unknown.
function currentSpeed(now = Date.now()) {
  const last = motion.fixes[motion.fixes.length - 1];
  if (!last || motion.speed == null) return null;
  return now - last.at <= MOTION_STALE_MS || motion.speed <= MOVING_KMH ? motion.speed : null;
}

// An unknown speed counts as moving: buttons come only once the car is known to stand.
function movingNow(now = Date.now()) {
  const speed = currentSpeed(now);
  return speed == null || speed > MOVING_KMH;
}

function slowFor(now = Date.now()) {
  return !movingNow(now) && motion.slowSince ? now - motion.slowSince : 0;
}

function stillFor(now = Date.now()) {
  const speed = currentSpeed(now);
  return speed != null && speed < STILL_KMH && motion.stillSince ? now - motion.stillSince : 0;
}

// ---------------------------------------------------------------- «За рулём»
// A screen for the minutes of looking for fuel on the road: the stations ahead
// with the number of one's grade, a sheet that says more as the car comes
// closer, «Вы на АЗС» with two huge buttons once it stands at the pumps, and a
// question at the next stop about a station just passed. The ordinary page
// stays as it was underneath. A glance is all a driver may give the screen,
// so there are buttons only while the car stands.
const DRIVE_RADIUS_METRES = 5000;
const DRIVE_AHEAD_DEGREES = 60;
const DRIVE_BIG_PINS = 3;
const DRIVE_LINE_METRES = 1200;
// «Вы на АЗС» is said only beside the pumps, after standing there a while:
// a traffic light next to a station is not a visit.
const DRIVE_AT_METRES = 100;
const DRIVE_STAND_MS = 20000;
const DRIVE_PASS_METRES = 150;
const DRIVE_ASK_STILL_MS = 3000;
const DRIVE_ASK_WITHIN_MS = 10 * 60 * 1000;
const DRIVE_ASK_WITHIN_METRES = 3000;
const DRIVE_NEIGHBOUR_METRES = 250;
const DRIVE_OFFER_MS = 30000;
const DRIVE_UNDO_MS = 5000;
const DRIVE_ZOOM = 15;
const DRIVE_CLOSE_ZOOM = 16;
const DRIVE_THEME_KEY = 'spbfi-drive-theme-v1';
const DRIVE_OFFER_KEY = 'spbfi-drive-offer-off-v1';
// «мало» and «много» are what can be told at a glance from the car; they go
// out as the composer's «до 5» and «до 50».
const DRIVE_QUEUE = [[0, 'нет'], [3, 'мало'], [35, 'много']];
const DRIVE_FALLBACK_PLACE = { lat: 59.94, lon: 30.31 };
const drive = {
  open: false, map: null, markers: new Map(), side: 0, car: null, center: null, zoom: DRIVE_ZOOM, rotation: 0, turned: null,
  ticker: null, heldTimer: null, wakeLock: null, theme: 'auto', themeAt: 0, pick: null, pinnedId: null,
  question: null, asked: new Set(), sent: null, touchAt: 0, kind: '', offered: false, offerOff: false,
  // Stations where a 👍 confirmed someone's mark: that was the look at the pumps.
  confirmed: new Map(),
};

// Where the car is: the phone's own last fix, never an address typed in.
function drivePhone() {
  const phone = phonePlace();
  if (phone) return phone;
  const last = motion.fixes[motion.fixes.length - 1];
  return last ? { lat: last.lat, lon: last.lon } : null;
}

// Sunrise and sunset where the phone is, from the standard solar formulas.
// Only the time of day decides the theme, so a tunnel or a covered car park
// never makes the screen flicker.
function sunTimes(date, place) {
  const rad = Math.PI / 180;
  const dayMs = 86400000;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const J0 = 0.0009;
  const lw = rad * -place.lon;
  const phi = rad * place.lat;
  const days = date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const n = Math.round(days - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));
  const noon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosW = (Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  // Beyond the polar circle the sun can stay up, or down, the whole day.
  if (cosW <= -1) return { polar: 'day' };
  if (cosW >= 1) return { polar: 'night' };
  const set = J2000 + J0 + (Math.acos(cosW) + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const toDate = (j) => new Date((j + 0.5 - J1970) * dayMs);
  return { rise: toDate(noon - (set - noon)), set: toDate(set) };
}

function driveDaylight(now = new Date()) {
  const place = drivePhone() || DRIVE_FALLBACK_PLACE;
  const today = sunTimes(now, place);
  if (today.polar) return { light: today.polar === 'day', next: null };
  const light = now >= today.rise && now < today.set;
  const next = light ? today.set : now < today.rise ? today.rise : sunTimes(new Date(now.valueOf() + 86400000), place).rise;
  return { light, next };
}

function driveThemeNote(sun) {
  if (drive.theme === 'day') return 'Всегда светлая тема.';
  if (drive.theme === 'night') return 'Всегда тёмная тема.';
  if (!sun.next) return sun.light ? 'Авто: солнце сегодня не заходит, тема дневная.' : 'Авто: солнце сегодня не встаёт, тема ночная.';
  const clock = sun.next.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return sun.light
    ? `Авто: сейчас светло, тема дневная. Закат в ${clock} — после него экран сам станет тёмным.`
    : `Авто: сейчас темно, тема ночная. Рассвет в ${clock} — тогда экран сам станет светлым.`;
}

function loadDriveTheme() {
  try {
    const saved = localStorage.getItem(DRIVE_THEME_KEY);
    return ['auto', 'day', 'night'].includes(saved) ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

function applyDriveTheme() {
  const root = $('#drive');
  if (!root) return;
  drive.themeAt = Date.now();
  const sun = driveDaylight();
  root.classList.toggle('is-day', drive.theme === 'day' || (drive.theme === 'auto' && sun.light));
  const note = root.querySelector('[data-drive-theme-note]');
  if (note) note.textContent = driveThemeNote(sun);
}

function setDriveTheme(mode) {
  drive.theme = ['auto', 'day', 'night'].includes(mode) ? mode : 'auto';
  try {
    localStorage.setItem(DRIVE_THEME_KEY, drive.theme);
  } catch {
    // Private mode: the choice lasts until the page is closed.
  }
  applyDriveTheme();
  renderDrive({ force: true });
}

// The screen must not go dark in the holder. The browser lets go of the lock
// whenever the page is hidden, so it is asked for again on the way back.
async function holdScreenOn() {
  if (!drive.open || document.hidden || !navigator.wakeLock?.request) return;
  if (drive.wakeLock && !drive.wakeLock.released) return;
  try {
    drive.wakeLock = await navigator.wakeLock.request('screen');
    if (!drive.open) releaseScreen();
  } catch {
    // Low battery or not allowed: the phone decides, the screen still works.
    drive.wakeLock = null;
  }
}

function releaseScreen() {
  const lock = drive.wakeLock;
  drive.wakeLock = null;
  lock?.release?.().catch(() => {});
}

// Offered once a session, after half a minute above walking pace with the
// app on screen: a passenger scrolling the list would rather be asked than
// switched.
function driveOfferSilenced() {
  if (drive.offerOff) return true;
  try {
    return sessionStorage.getItem(DRIVE_OFFER_KEY) === '1';
  } catch {
    return false;
  }
}

function maybeOfferDrive(now = Date.now()) {
  const box = $('#driveOffer');
  if (!box || drive.open || drive.offered || document.hidden || driveOfferSilenced()) return;
  const speed = currentSpeed(now);
  if (!motion.fastSince || speed == null || speed <= DRIVING_KMH || now - motion.fastSince < DRIVE_OFFER_MS) return;
  drive.offered = true;
  box.hidden = false;
}

function hideDriveOffer() {
  const box = $('#driveOffer');
  if (box) box.hidden = true;
}

function silenceDriveOffer() {
  drive.offerOff = true;
  try {
    sessionStorage.setItem(DRIVE_OFFER_KEY, '1');
  } catch {
    // This page still remembers.
  }
  hideDriveOffer();
}

function driveAfterFix() {
  maybeOfferDrive();
  if (drive.open) renderDrive();
}

// The pins must stand around the car. A list for a typed address or an area
// of the map goes back to «рядом», the way the first fix sets it.
function followPhone() {
  if (!navigator.geolocation) return;
  if (!state.follow) {
    startFollowing({ manual: true });
    return;
  }
  if (!state.location || ['device', 'far'].includes(state.searchScope)) return;
  state.location = null;
  const last = motion.fixes[motion.fixes.length - 1];
  if (last && Date.now() - last.at < 30000) applyFix({ latitude: last.lat, longitude: last.lon, accuracy: last.accuracy }, { stamp: last.stamp });
  else refreshLocation();
}

function bindDrive() {
  const root = $('#drive');
  if (!root) return;
  // A redraw between a finger landing and lifting loses the tap (14 Sep 2026,
  // the composer); the screen waits for it, see renderDrive.
  root.addEventListener('pointerdown', () => { drive.touchAt = Date.now(); });
  root.addEventListener('click', onDriveTap);
  // Scroll events do not bubble; caught on the way down, the two layers that
  // must never scroll are put back at once. The panels scroll their own content.
  root.addEventListener('scroll', (event) => {
    const layer = event.target;
    if ((layer === root || layer.id === 'driveStage') && (layer.scrollTop || layer.scrollLeft)) layer.scrollTo(0, 0);
  }, true);
  window.addEventListener('resize', () => { if (drive.open) renderDrive({ force: true }); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      motion.fastSince = 0;
      return;
    }
    if (!drive.open) return;
    holdScreenOn();
    applyDriveTheme();
    renderDrive({ force: true });
  });
}

function openDrive(reason = 'button') {
  const root = $('#drive');
  if (drive.open || !root) return;
  Object.assign(drive, { open: true, offered: true, theme: loadDriveTheme(), pick: null, pinnedId: null, question: null, sent: null, asked: new Set(), kind: '', kindAt: 0 });
  hideDriveOffer();
  closeDrawer();
  document.body.classList.add('driving');
  root.hidden = false;
  followPhone();
  layoutDrive();
  initDriveMap();
  applyDriveTheme();
  holdScreenOn();
  drive.ticker = setInterval(tickDrive, 1000);
  renderDrive({ force: true });
  track('drive_open', { reason });
}

function closeDrive() {
  const root = $('#drive');
  if (!drive.open || !root) return;
  drive.open = false;
  clearInterval(drive.ticker);
  clearTimeout(drive.heldTimer);
  drive.ticker = null;
  releaseScreen();
  root.hidden = true;
  document.body.classList.remove('driving');
  track('drive_close');
  // The ordinary map lay covered and measures itself again.
  if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
}

// Once a second: standing still brings no fixes, yet «Вы на АЗС», the question
// at a stop and the seconds left to undo all move on.
function tickDrive() {
  if (!drive.open) return;
  if (Date.now() - drive.themeAt > 60000) applyDriveTheme();
  renderDrive();
}

function initDriveMap() {
  if (drive.map || typeof L === 'undefined') return;
  // No gestures at all: the map follows the car and turns with the road.
  drive.map = L.map('driveMap', {
    zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, inertia: false,
    zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
  }).setView([DRIVE_FALLBACK_PLACE.lat, DRIVE_FALLBACK_PLACE.lon], DRIVE_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(drive.map);
}

function driveItem(phone, station, heading) {
  const metres = haversineKm(phone, station.location) * 1000;
  return { station, metres, turn: heading == null ? null : turnFrom(heading, bearingDegrees(phone, station.location)) };
}

// What the screen shows now, and the few things decided on the way: the
// seconds to undo running out, a question put at a stop, «Не та?» let go of
// once the car moves.
function stepDrive(now = Date.now()) {
  const phone = drivePhone();
  const heading = motion.heading;
  const view = { now, phone, heading, speed: currentSpeed(now), around: [], ahead: [], pins: [], focus: null, neighbour: null, kind: 'wait' };
  const moving = movingNow(now);
  if (moving) drive.pinnedId = null;
  if (drive.sent && !drive.sent.undoing && (moving || now - drive.sent.madeAt > DRIVE_UNDO_MS)) drive.sent = null;
  if (!phone) return view;
  // Right after the grade changes the list is still the old grade's, and its
  // answers would be read out under the new grade's number.
  const listed = state.stations[0]?.grade?.grade;
  if (listed && listed !== state.grade && !drive.sent) {
    view.kind = 'loading';
    return view;
  }
  view.around = state.stations
    .filter((station) => station.location)
    .map((station) => driveItem(phone, station, heading))
    .filter((item) => item.metres <= DRIVE_RADIUS_METRES)
    .sort((a, b) => a.metres - b.metres);
  // Until there is a heading, «ahead» is simply the nearest.
  view.ahead = heading == null ? view.around : view.around.filter((item) => Math.abs(item.turn) <= DRIVE_AHEAD_DEGREES);
  view.pins = view.ahead.slice(0, DRIVE_BIG_PINS);
  const itemFor = (id) => {
    const listed = view.around.find((item) => item.station.id === id);
    if (listed) return listed;
    const station = state.stations.find((item) => item.id === id && item.location);
    return station ? driveItem(phone, station, heading) : null;
  };
  if (drive.sent) {
    view.kind = 'sent';
    view.focus = itemFor(drive.sent.stationId);
    return view;
  }
  const rough = effectiveAccuracy() > ROUGH_METRES;
  const hereId = rough ? null : stationHereId(phone, nearbyPlaces(), DRIVE_AT_METRES);
  const atId = drive.pinnedId || hereId;
  if (atId && slowFor(now) >= DRIVE_STAND_MS && !markedRecently(atId, 10) && now - (drive.confirmed.get(atId) || 0) > 10 * 60 * 1000 && itemFor(atId)) {
    view.kind = 'at';
    view.focus = itemFor(atId);
    view.neighbour = view.around.find((item) => item.station.id !== atId && item.metres <= DRIVE_NEIGHBOUR_METRES) || null;
    return view;
  }
  if (drive.question && moving) {
    track('drive_stop_question', { station: drive.question.id, reason: 'moved' });
    drive.question = null;
  }
  if (!drive.question && !rough && stillFor(now) >= DRIVE_ASK_STILL_MS) {
    const passed = Object.entries(state.passed)
      .map(([id, item]) => ({ id, ...item, metres: haversineKm(phone, item.location) * 1000 }))
      .filter((item) => item.fastAt && now - item.fastAt <= DRIVE_ASK_WITHIN_MS && item.metres <= DRIVE_ASK_WITHIN_METRES
        && !drive.asked.has(item.id) && item.id !== hereId && !markedRecently(item.id)
        // A car stopped short of a station has not passed it yet.
        && (heading == null || Math.abs(turnFrom(heading, bearingDegrees(phone, item.location))) > 90))
      .sort((a, b) => b.fastAt - a.fastAt)[0];
    if (passed) {
      drive.question = { id: passed.id, network: passed.network };
      drive.asked.add(passed.id);
      track('drive_stop_question', { station: passed.id, reason: 'shown' });
    }
  }
  if (drive.question) {
    view.kind = 'question';
    view.focus = itemFor(drive.question.id);
    return view;
  }
  if (rough) {
    view.kind = 'rough';
    return view;
  }
  if (!state.stations.length) {
    view.kind = 'loading';
    return view;
  }
  if (!view.around.length) {
    view.kind = 'empty';
    return view;
  }
  const serves = (station) => SERVES_NOW[station.grade?.status] === 0;
  const target = view.ahead[0];
  if (target && target.metres <= NEARBY_REPORT_METRES) {
    view.kind = 'near';
    view.focus = target;
    return view;
  }
  const withGrade = view.ahead.find((item) => serves(item.station));
  if (!withGrade) {
    // Nothing ahead has it: the nearest station that has, wherever it is.
    view.kind = 'none';
    view.focus = state.stations
      .filter((station) => station.location && serves(station))
      .map((station) => driveItem(phone, station, heading))
      .sort((a, b) => a.metres - b.metres)[0] || null;
    return view;
  }
  view.kind = 'line';
  view.focus = target.metres <= DRIVE_LINE_METRES ? target : withGrade;
  return view;
}

function driveGradeLabel(grade = state.grade) {
  return GRADE_LABELS[grade].replace('АИ-', '');
}

// Rounded so the words do not tick over with every fix.
function driveDistance(metres) {
  if (metres >= 950) return `${(Math.round(metres / 100) / 10).toLocaleString('ru-RU')} км`;
  return `${metres >= 100 ? Math.round(metres / 50) * 50 : Math.max(10, Math.round(metres / 10) * 10)} м`;
}

// Which side of the road a station ahead is on, by how far it stands off the
// line of travel: a kilometre out, a forecourt beside the road is only a
// couple of degrees off the heading.
function driveSide(item) {
  if (item?.turn == null) return '';
  const aside = item.metres * Math.sin((item.turn * Math.PI) / 180);
  return aside >= 20 ? ' справа' : aside <= -20 ? ' слева' : '';
}

// Which way to turn for a station anywhere around.
function driveDirection(turn) {
  if (turn == null) return '';
  if (Math.abs(turn) <= 30) return ' впереди';
  if (Math.abs(turn) >= 150) return ' позади';
  return turn > 0 ? ' направо' : ' налево';
}

// «Проехали Неву», «Что с 95 на Роснефти?»: a plain one-word name is declined,
// anything else is named as it is.
const PLAIN_NAME = /^[А-ЯЁ][а-яё]+$/;

function nameAccusative(name) {
  return PLAIN_NAME.test(name) && name.endsWith('а') ? `${name.slice(0, -1)}у` : name;
}

function namePrepositional(name) {
  if (name === 'АЗС') return 'этой АЗС';
  if (PLAIN_NAME.test(name)) {
    if (name.endsWith('ь')) return `${name.slice(0, -1)}и`;
    if (name.endsWith('а')) return `${name.slice(0, -1)}е`;
    if (/[бвгджзклмнпрстфхцчшщ]$/.test(name)) return `${name}е`;
  }
  return `АЗС «${name}»`;
}

// What the app says about one's grade at a station, in words and a tone:
// «нет» is never a colour alone.
function driveSays(station) {
  const label = driveGradeLabel();
  const grade = station.grade || {};
  const limit = grade.limit_liters != null ? `, лимит ${Math.round(grade.limit_liters)} л` : '';
  if (grade.status === 'CAN_REFUEL') return { text: `${label} есть${limit}`, tone: 'yes' };
  if (grade.status === 'LIKELY_AVAILABLE') return { text: `${label} скорее есть${limit}`, tone: 'yes' };
  if (grade.status === 'LIMITED') return { text: `${label} есть${limit || ', с ограничением'}`, tone: 'lim' };
  if (grade.status === 'LIKELY_NOT') return { text: `${label} скорее нет`, tone: 'no' };
  if (grade.status === 'CONFIRMED_NO') return { text: `${label} нет`, tone: 'no' };
  if (grade.status === 'CONFLICT') return { text: `по ${label} данные расходятся`, tone: 'unk' };
  return { text: `по ${label} нет свежих данных`, tone: 'unk' };
}

// An address as a driver needs it: the street and the house, and the place
// when it is not the city. A feed's district, municipality and «МО» chain
// mean nothing from behind the wheel.
const ADDRESS_NOISE = [
  /федерац/i, /^\s*россия\s*$/i, /област/i, /(^|\s)обл\.?(\s|$)/i, /санкт-петербург/i,
  /м\.?\s*р-?н/i, /(^|\s)р-н\.?(\s|$)/i, /(^|\s)район(\s|$)/i, /муниципальн/i, /(^|\s)МО(\s|$|["«])/,
  /поселени/i, /вн\.?\s*тер/i, /внутригородск/i, /(^|\s)округ(\s|$)/i,
  /^\d{6}$/, /\s[сг]\.\s?п\.?$/i, /(^|\s)м\.\s?о\.(\s|$)/i,
];

function driveAddress(address) {
  const parts = shortAddress(address).split(',').map((part) => part.trim())
    .filter((part) => part && !ADDRESS_NOISE.some((pattern) => pattern.test(part)))
    .map((part) => part.replace(/^(г\.\s*п\.|гп|пгт|пос\.|посёлок|поселок|город|г\.|дер\.|деревня)\s+/i, ''));
  return parts.slice(-3).join(', ');
}

// A name as the club shows it, without the level icon in front.
function driveName(mark) {
  return String(mark?.authorName || (mark?.names || [])[0] || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// How old the answer is, who of the group saw it and their 👍, the queue: one
// line from what the app already has.
function driveMeta(station, { witness = true } = {}) {
  const grade = station.grade || {};
  const mark = groupMarkFor(station.id, state.grade);
  const parts = [];
  if (mark && witness) {
    parts.push(`${driveName(mark) || 'Свои'} ${formatAge((Date.now() - mark.at) / 1000)}: ${mark.seen ? 'есть' : 'нет'}${mark.up ? ` · 👍 ${mark.up}` : ''}`);
  } else if (grade.status !== 'NO_FRESH_DATA' && grade.age_seconds != null && !grade.undated_only) {
    parts.push(formatAge(grade.age_seconds));
  }
  const queue = mark?.queue != null ? queueWords(mark.queue) : grade.queue?.label;
  if (queue) parts.push(`очередь ${queue}`);
  return parts.join(' · ');
}

// The letter on a pin: someone of the group looked at it lately.
function driveInitial(stationId) {
  const mark = groupMarkFor(stationId, state.grade);
  if (!mark) return '';
  const name = driveName(mark);
  return name ? name.charAt(0).toLocaleUpperCase('ru-RU') : '👁';
}

function driveChips(station) {
  const brief = (state.gradesBrief || {})[station.id] || {};
  return Object.keys(GRADE_LABELS).map((grade) => {
    const status = grade === state.grade ? station.grade.status : (brief[grade]?.s || 'NO_FRESH_DATA');
    const mark = GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA;
    const tone = { yes: ' ok', likely: ' ok', limited: ' lim', no: ' bad' }[mark.tone] || '';
    const limit = grade === state.grade && station.grade.limit_liters != null ? ` ${Math.round(station.grade.limit_liters)} л` : '';
    const hint = `${GRADE_LABELS[grade]}: ${STATUS[status]?.short || ''}`;
    return `<span class="drive-chip${tone}${grade === state.grade ? ' mine' : ''}" title="${escapeHtml(hint)}">${escapeHtml(driveGradeLabel(grade))} ${mark.sign}${escapeHtml(limit)}</span>`;
  }).join('');
}

function driveMarkButtons(stationId, { huge = false } = {}) {
  const label = escapeHtml(driveGradeLabel());
  const id = escapeHtml(stationId);
  const size = huge ? ' huge' : '';
  return `<div class="drive-row${size}">
      <button type="button" class="drive-btn yes${size}" data-drive="mark" data-station="${id}" data-seen="1">${label} есть</button>
      <button type="button" class="drive-btn no${size}" data-drive="mark" data-station="${id}" data-seen="0">${label} нет</button>
    </div>`;
}

// The sheet over the map and the panel that covers it at the pumps and after
// a mark, as HTML. The speed and the seconds to undo change every second and
// are set apart (see paintDrivePanels), so a button is rebuilt only when what
// it says changes.
function drivePanels(view) {
  const label = escapeHtml(driveGradeLabel());
  const focus = view.focus;
  const station = focus?.station;
  const place = station ? driveAddress(station.address) : '';
  const title = station ? `${escapeHtml(displayNetwork(station.network))}${place ? `, ${escapeHtml(place)}` : ''}` : '';
  const meta = (text) => (text ? `<p class="drive-meta">${escapeHtml(text)}</p>` : '');
  const where = (text) => `<span class="drive-where">${escapeHtml(text)}</span>`;
  if (view.kind === 'wait') {
    return { sheet: `<p class="drive-line">Ищем, где вы…</p>${meta('Разрешите приложению геопозицию: без неё не видно ни дороги, ни заправок впереди.')}` };
  }
  if (view.kind === 'rough') {
    return { sheet: `${where('Место приблизительное')}<p class="drive-line">Телефон даёт место ±${escapeHtml(formatMeters(state.accuracy || 0))}</p>${meta('Заправки впереди могут быть не те, а отметки заработают, когда место станет точным.')}` };
  }
  if (view.kind === 'loading') return { sheet: '<p class="drive-line">Загружаем заправки рядом…</p>' };
  if (view.kind === 'empty') return { sheet: `${where(`В ${DRIVE_RADIUS_METRES / 1000} км заправок нет`)}${meta('Приложение знает заправки Петербурга и области.')}` };
  if (view.kind === 'line') {
    const says = driveSays(station);
    return { sheet: `${where(`Через ${driveDistance(focus.metres)}${driveSide(focus)}`)}
      <p class="drive-line">${escapeHtml(shortNetwork(station.network))} · <span class="drive-${says.tone}">${escapeHtml(says.text)}</span></p>${meta(driveMeta(station))}` };
  }
  if (view.kind === 'near') {
    const witness = eyewitnessLine(station.grade, station.id, { brief: true });
    const mine = markedRecently(station.id) ? markLine(station.id, state.grade) : null;
    const actions = mine ? `<p class="drive-done">✔ ${escapeHtml(mine)}</p>`
      : movingNow(view.now) ? '<p class="drive-lock">🔒 Отметить — на остановке</p>'
        : driveMarkButtons(station.id);
    return { sheet: `${where(`Через ${driveDistance(focus.metres)}${driveSide(focus)}`)}
      <p class="drive-line drive-name">${title}</p>
      <div class="drive-chips">${driveChips(station)}</div>
      ${meta(driveMeta(station, { witness: false }))}
      ${witness ? `<p class="drive-witness ${witness.tone}">${escapeHtml(witness.text)}</p>` : ''}
      ${actions}` };
  }
  if (view.kind === 'none') {
    if (!focus) return { sheet: `${where(`Впереди ${driveGradeLabel()} нет`)}<p class="drive-line">Рядом ${label} нет ни на одной заправке</p>` };
    return { sheet: `${where(`Впереди ${driveGradeLabel()} нет`)}
      <p class="drive-line">Ближайшая с ${label} — ${escapeHtml(shortNetwork(station.network))}, <span class="drive-yes">${escapeHtml(`${driveDistance(focus.metres)}${driveDirection(focus.turn)}`)}</span></p>${meta(driveMeta(station))}` };
  }
  if (view.kind === 'question') {
    const name = shortNetwork(drive.question.network);
    return { sheet: `${where(`Проехали ${nameAccusative(name)}`)}
      <p class="drive-line">Что с ${label} на ${escapeHtml(namePrepositional(name))}?</p>
      <div class="drive-row three">
        <button type="button" class="drive-btn yes" data-drive="answer" data-seen="1">${label} есть</button>
        <button type="button" class="drive-btn no" data-drive="answer" data-seen="0">${label} нет</button>
        <button type="button" class="drive-btn skip" data-drive="skip">не видел</button>
      </div>${meta('Тронетесь — вопрос исчезнет сам')}` };
  }
  if (view.kind === 'at') return { full: driveAtPanel(view, title) };
  if (view.kind === 'sent') return { full: driveSentPanel(title) };
  return {};
}

// Someone else's fresh mark for this grade: at the pumps it is confirmed or
// refuted with 👍 and 👎, the club's own way, rather than marked over.
function driveLook(stationId) {
  if (!state.club.enabled || !state.club.member || !state.club.features?.votes) return null;
  const mark = groupMarkFor(stationId, state.grade);
  if (!mark?.who || !mark.authorName || mark.who === myId()) return null;
  const look = voteTargets(stationId).find((item) => item.author === mark.who && item.at === mark.at);
  return look && !look.myVote ? { look, mark } : null;
}

function driveAtPanel(view, title) {
  const station = view.focus.station;
  const id = escapeHtml(station.id);
  const label = escapeHtml(driveGradeLabel());
  const other = view.neighbour;
  // Two stations across the road from each other are the likeliest mix-up.
  const not = other
    ? `<button type="button" class="drive-not" data-drive="not" data-station="${escapeHtml(other.station.id)}">Не та? Рядом ${escapeHtml(shortNetwork(other.station.network))}, ${escapeHtml(driveDistance(other.metres))} →</button>`
    : '';
  const head = `<span class="drive-where">Вы на АЗС</span><p class="drive-title drive-name">${title}</p>${not}`;
  const said = driveLook(station.id);
  if (said) {
    const { mark } = said;
    const queue = mark.queue != null ? ` · очередь ${escapeHtml(queueWords(mark.queue))}` : '';
    return `${head}
      <div class="drive-said">
        <p class="drive-meta">${escapeHtml(driveName(mark) || 'Свой')} отметил(а) ${escapeHtml(formatAge((Date.now() - mark.at) / 1000))}</p>
        <p class="drive-line"><span class="drive-${mark.seen ? 'yes' : 'no'}">${label} ${mark.seen ? 'есть' : 'нет'}</span>${queue}</p>
      </div>
      <div class="drive-row huge">
        <button type="button" class="drive-btn huge yes" data-drive="vote" data-station="${id}" data-vote="up">👍 Так и есть</button>
        <button type="button" class="drive-btn huge no" data-drive="vote" data-station="${id}" data-vote="down">👎 Уже нет</button>
      </div>`;
  }
  const chosen = composeDraft(station.id)?.queue;
  const queue = DRIVE_QUEUE.map(([cars, word]) => `<button type="button" class="drive-seg-button${chosen === cars ? ' on' : ''}" data-drive="queue" data-station="${id}" data-cars="${cars}" aria-pressed="${chosen === cars}">${word}</button>`).join('');
  return `${head}
    ${driveMarkButtons(station.id, { huge: true })}
    <p class="drive-meta">Очередь, если видно</p>
    <div class="drive-seg">${queue}</div>`;
}

function driveSentPanel(title) {
  const sent = drive.sent;
  const [heading, note] = sent.vote
    ? ['👍 Подтверждено', 'Спасибо, что проверили на месте.']
    : sent.outcome === 'queued' ? ['Сохранено на телефоне', 'Нет связи. Отметка уйдёт своим сама, как только появится интернет.']
      : sent.outcome === 'refused' ? ['Не отправлено', 'Отметка осталась только на этом телефоне.']
        : ['Отправлено своим', ''];
  const undo = sent.undoable && !sent.vote
    ? `<button type="button" class="drive-undo" data-drive="undo"${sent.undoing ? ' disabled' : ''}>Отменить <b data-drive-count></b></button>`
    : '';
  return `<svg class="drive-check${sent.outcome === 'refused' ? ' refused' : ''}" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M19 33 L28 42 L46 23"/></svg>
    <p class="drive-title">${escapeHtml(heading)}</p>
    <p class="drive-meta">${escapeHtml(sent.what)}${title ? ` · ${title}` : ''}</p>
    ${note ? `<p class="drive-meta">${escapeHtml(note)}</p>` : ''}
    ${undo}
    <p class="drive-hint">Потом экран сам вернётся к карте.</p>`;
}

function driveGradesPick() {
  const buttons = Object.keys(GRADE_LABELS).map((grade) => `<button type="button" class="drive-grade${grade === state.grade ? ' on' : ''}" data-drive="grade" data-grade="${grade}" aria-pressed="${grade === state.grade}">${escapeHtml(driveGradeLabel(grade))}</button>`).join('');
  return `<span class="drive-where">Моя марка</span><div class="drive-grades">${buttons}</div>
    <button type="button" class="drive-pick-close" data-drive="pick-close">Готово</button>`;
}

function driveThemePick() {
  const modes = [['auto', 'Авто'], ['day', '☀️ День'], ['night', '🌙 Ночь']]
    .map(([mode, word]) => `<button type="button" data-drive="theme-mode" data-mode="${mode}" aria-pressed="${drive.theme === mode}">${word}</button>`).join('');
  return `<span class="drive-where">Тема экрана</span><div class="drive-switch">${modes}</div>
    <p class="drive-meta" data-drive-theme-note>${escapeHtml(driveThemeNote(driveDaylight()))}</p>
    <button type="button" class="drive-pick-close" data-drive="pick-close">Готово</button>`;
}

function renderDrive({ force = false } = {}) {
  if (!drive.open) return;
  const now = Date.now();
  const view = stepDrive(now);
  const plate = $('#drivePlateGrade');
  if (plate && plate.textContent !== driveGradeLabel()) plate.textContent = driveGradeLabel();
  const speed = $('#driveSpeed');
  const shown = view.speed == null ? '—' : String(Math.round(view.speed));
  if (speed && speed.textContent !== shown) speed.textContent = shown;
  // A finger that has just landed keeps its button where it is: a redraw
  // before it lifts would lose the tap. The screen catches up a moment later;
  // a redraw asked for by a tap itself comes after that tap and goes ahead.
  if (!force && now - drive.touchAt < 1000) {
    clearTimeout(drive.heldTimer);
    drive.heldTimer = setTimeout(() => renderDrive(), 1000 - (now - drive.touchAt) + 30);
  } else {
    paintDrivePanels(view);
  }
  layoutDrive();
  paintDriveMap(view);
}

function setDriveHtml(box, html) {
  if (box.driveHtml !== html) {
    box.innerHTML = html;
    box.driveHtml = html;
  }
  box.hidden = !html;
}

function paintDrivePanels(view) {
  const sheet = $('#driveSheet');
  const full = $('#driveFull');
  const pick = $('#drivePick');
  if (!sheet || !full || !pick) return;
  const panels = drivePanels(view);
  const picked = drive.pick === 'grades' ? driveGradesPick() : drive.pick === 'theme' ? driveThemePick() : '';
  // Banners are not shown over this screen, so a failure it must tell about
  // heads whichever panel is up for a few seconds.
  const flash = drive.flash && view.now < drive.flash.until ? `<p class="drive-flash" role="status">${escapeHtml(drive.flash.text)}</p>` : '';
  setDriveHtml(pick, picked);
  setDriveHtml(full, picked || !panels.full ? '' : flash + panels.full);
  setDriveHtml(sheet, picked || panels.full || !panels.sheet ? '' : flash + panels.sheet);
  // A panel slides in when it starts saying something else, not on every fix.
  const kind = picked ? `pick-${drive.pick}` : view.kind;
  if (kind !== drive.kind) {
    drive.kind = kind;
    drive.kindAt = view.now;
    [sheet, full, pick].forEach((box) => {
      box.classList.remove('rise');
      if (box.hidden) return;
      void box.offsetWidth;
      box.classList.add('rise');
    });
  }
  $('#drive').dataset.kind = kind;
  const left = drive.sent ? Math.max(0, Math.ceil((DRIVE_UNDO_MS - (view.now - drive.sent.madeAt)) / 1000)) : 0;
  full.querySelectorAll('[data-drive-count]').forEach((count) => {
    const words = left ? `· ${left} с` : '';
    if (count.textContent !== words) count.textContent = words;
  });
}

// The car sits low in the part of the map the panels leave free, so more of
// the road ahead is on screen. The map is a square centred on the car, large
// enough to cover the screen at any turn; it only ever grows, since each new
// size loads the tiles again.
function layoutDrive() {
  const root = $('#drive');
  const holder = $('#driveMap');
  const car = $('#driveCar');
  if (!root || !holder || !car || root.hidden) return;
  // Nothing here scrolls. A browser that scrolled a layer anyway, to bring
  // something into view, moved the plates and the sheet off the screen.
  [root, $('#driveStage')].forEach((layer) => {
    if (layer && (layer.scrollTop || layer.scrollLeft)) layer.scrollTo(0, 0);
  });
  const width = root.clientWidth;
  const height = root.clientHeight;
  const panel = [$('#drivePick'), $('#driveFull'), $('#driveSheet')].find((box) => box && !box.hidden);
  let right = width;
  let bottom = height;
  if (panel) {
    const rect = panel.getBoundingClientRect();
    if (rect.left > width * 0.3) right = rect.left;
    else bottom = Math.max(height * 0.4, rect.top);
  }
  const top = Math.min(118, height * 0.25);
  const x = Math.round(right / 2);
  const y = Math.round(top + (bottom - top) * 0.72);
  const side = Math.max(drive.side, 2 * Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y))) + 64);
  if (side !== drive.side) {
    drive.side = side;
    holder.style.width = `${side}px`;
    holder.style.height = `${side}px`;
    drive.map?.invalidateSize({ pan: false });
    drive.center = null;
  }
  holder.style.left = `${x - side / 2}px`;
  holder.style.top = `${y - side / 2}px`;
  car.style.left = `${x}px`;
  car.style.top = `${y}px`;
  drive.car = { x, y, width, height, top, right, bottom };
}

// The station the sheet is about is always on the map: the closest zoom at
// which its pin fits above the car and inside the edges. It goes out at once
// and in only with room to spare, a whole step at a time, so it does not flicker.
function driveZoom(view) {
  const { focus, phone } = view;
  const car = drive.car;
  if (!['line', 'near'].includes(view.kind) || !focus || !car) return ['at', 'sent'].includes(view.kind) ? DRIVE_CLOSE_ZOOM : DRIVE_ZOOM;
  const angle = ((bearingDegrees(phone, focus.station.location) - drive.rotation) * Math.PI) / 180;
  const ahead = focus.metres * Math.cos(angle);
  const aside = Math.abs(focus.metres * Math.sin(angle));
  // Metres a pixel must hold for the pin, which stands 50 px tall over its point.
  const room = {
    up: Math.max(40, car.y - car.top - 50),
    down: Math.max(40, car.bottom - car.y - 20),
    side: Math.max(40, Math.min(car.x, car.right - car.x) - 36),
  };
  const needed = Math.max(ahead > 0 ? ahead / room.up : -ahead / room.down, aside / room.side, 0.3);
  const exact = Math.log2((156543.03 * Math.cos((phone.lat * Math.PI) / 180)) / needed);
  const fit = Math.max(12, Math.min(DRIVE_CLOSE_ZOOM, Math.floor(exact)));
  if (fit < drive.zoom) return fit;
  return fit > drive.zoom && exact - drive.zoom >= 1.25 ? drive.zoom + 1 : drive.zoom;
}

function paintDriveMap(view) {
  const map = drive.map;
  if (!map || !view.phone || !drive.car) return;
  drive.zoom = driveZoom(view);
  const moved = !drive.center || drive.center.lat !== view.phone.lat || drive.center.lon !== view.phone.lon;
  if (moved || map.getZoom() !== drive.zoom) {
    map.setView([view.phone.lat, view.phone.lon], drive.zoom, { animate: false });
    drive.center = { lat: view.phone.lat, lon: view.phone.lon };
  }
  // Heading up: the map turns so that the road ahead points up. The heading
  // changes only above 10 km/h, so a car that stops keeps the last turn.
  if (view.heading != null) drive.rotation = view.heading;
  if (drive.turned !== drive.rotation) {
    drive.turned = drive.rotation;
    const holder = $('#driveMap');
    holder.style.transform = `rotate(${-drive.rotation}deg)`;
    holder.style.setProperty('--drive-turn', `${drive.rotation}deg`);
  }
  $('#driveCar').classList.toggle('unknown', view.heading == null);
  paintDrivePins(view);
  paintDriveEdge(view);
}

// Pins change on the elements Leaflet already drew, as on the ordinary map: a
// new icon on every fix would restart the glow and cost a phone in its holder
// for nothing.
function paintDrivePins(view) {
  const map = drive.map;
  const wanted = new Map(view.around.map((item) => [item.station.id, item]));
  const focusId = view.focus?.station.id || null;
  if (view.focus && !wanted.has(focusId)) wanted.set(focusId, view.focus);
  drive.markers.forEach((marker, id) => {
    if (wanted.has(id)) return;
    marker.remove();
    drive.markers.delete(id);
  });
  const big = new Set(view.pins.map((item) => item.station.id));
  if (focusId) big.add(focusId);
  const label = driveGradeLabel();
  wanted.forEach((item, id) => {
    let marker = drive.markers.get(id);
    if (!marker) {
      marker = L.marker([item.station.location.lat, item.station.location.lon], {
        icon: L.divIcon({ className: 'dpin', html: '<span class="dpin-turn"><span class="dpin-body"><b></b><i hidden></i></span></span>', iconSize: [0, 0], iconAnchor: [0, 0] }),
        interactive: false, keyboard: false,
      }).addTo(map);
      drive.markers.set(id, marker);
    }
    const element = marker.getElement();
    if (!element) return;
    const status = item.station.grade?.status || 'NO_FRESH_DATA';
    const isBig = big.has(id);
    element.classList.toggle('big', isBig);
    element.classList.toggle('focus', id === focusId);
    element.classList.toggle('no', (GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA).tone === 'no');
    if (element.dataset.status !== status) element.dataset.status = status;
    if (element.dataset.station !== id) element.dataset.station = id;
    const number = element.querySelector('b');
    if (number.textContent !== label) number.textContent = label;
    const badge = element.querySelector('i');
    const initial = isBig ? driveInitial(id) : '';
    if (badge.textContent !== initial) badge.textContent = initial;
    badge.hidden = !initial;
    const lift = id === focusId ? 800 : isBig ? 400 : 0;
    if ((marker.options.zIndexOffset || 0) !== lift) marker.setZIndexOffset(lift);
  });
}

// The nearest station with one's grade, when nothing ahead has it and the
// station is off the screen: a marker on the edge of the map, towards it.
function paintDriveEdge(view) {
  const edge = $('#driveEdge');
  const map = drive.map;
  if (!edge) return;
  const target = view.kind === 'none' ? view.focus : null;
  if (!target || !map || !drive.car) {
    edge.hidden = true;
    return;
  }
  const { x, y, width, top, right, bottom } = drive.car;
  const point = map.latLngToContainerPoint([target.station.location.lat, target.station.location.lon]);
  const size = map.getSize();
  // The map is turned about its centre, the car: turn the point with it.
  const angle = (-drive.rotation * Math.PI) / 180;
  const dx = point.x - size.x / 2;
  const dy = point.y - size.y / 2;
  const sx = x + dx * Math.cos(angle) - dy * Math.sin(angle);
  const sy = y + dx * Math.sin(angle) + dy * Math.cos(angle);
  const box = { left: 60, right: Math.min(right, width) - 60, top: top + 30, bottom: bottom - 30 };
  if (sx >= box.left && sx <= box.right && sy >= box.top && sy <= box.bottom) {
    edge.hidden = true;
    return;
  }
  // Where the line from the car towards the station leaves the free part of the map.
  const vx = sx - x;
  const vy = sy - y;
  const reach = Math.max(0, Math.min(
    vx > 0 ? (box.right - x) / vx : vx < 0 ? (box.left - x) / vx : Infinity,
    vy > 0 ? (box.bottom - y) / vy : vy < 0 ? (box.top - y) / vy : Infinity,
  ));
  edge.hidden = false;
  edge.style.left = `${Math.round(x + vx * reach)}px`;
  edge.style.top = `${Math.round(y + vy * reach)}px`;
  edge.querySelector('.drive-edge-arrow').style.transform = `rotate(${Math.round((Math.atan2(vy, vx) * 180) / Math.PI)}deg)`;
  edge.querySelector('b').textContent = driveGradeLabel();
  edge.querySelector('small').textContent = driveDistance(target.metres);
}

function onDriveTap(event) {
  const button = event.target.closest('[data-drive]');
  if (!button || button.disabled) return;
  // A panel sliding in moves its buttons under the finger: a tap in those few
  // moments could land on the button below the one meant, «95 нет» for «95 есть».
  const sliding = Date.now() - drive.kindAt < 450 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (sliding && button.closest('.drive-sheet, .drive-full, .drive-pick')) return;
  const { drive: action, station } = button.dataset;
  if (action === 'close') {
    closeDrive();
  } else if (action === 'grades' || action === 'theme') {
    drive.pick = drive.pick === action ? null : action;
    renderDrive({ force: true });
  } else if (action === 'pick-close') {
    drive.pick = null;
    renderDrive({ force: true });
  } else if (action === 'grade') {
    drive.pick = null;
    if (button.dataset.grade !== state.grade) chooseGrade(button.dataset.grade);
    renderDrive({ force: true });
  } else if (action === 'theme-mode') {
    setDriveTheme(button.dataset.mode);
  } else if (action === 'mark') {
    sendDriveMark(station, button.dataset.seen === '1', button.closest('#driveFull') ? 'at_station' : 'near');
  } else if (action === 'answer' && drive.question) {
    const { id } = drive.question;
    drive.question = null;
    sendDriveMark(id, button.dataset.seen === '1', 'question');
  } else if (action === 'skip' && drive.question) {
    track('drive_stop_question', { station: drive.question.id, reason: 'skip' });
    drive.question = null;
    renderDrive({ force: true });
  } else if (action === 'queue') {
    // The composer's own draft: the card under the screen shows the same queue.
    const draft = composeDraft(station, { touch: true });
    const cars = Number(button.dataset.cars);
    draft.queue = draft.queue === cars ? null : cars;
    paintComposers(station);
    renderDrive({ force: true });
  } else if (action === 'not') {
    drive.pinnedId = station;
    track('drive_not_this', { station });
    renderDrive({ force: true });
  } else if (action === 'undo') {
    undoDriveMark(button);
  } else if (action === 'vote') {
    driveVote(station, button.dataset.vote, button);
  }
}

// Through the same path as every mark: kept on the phone, sent to the club,
// waiting for a connection when there is none, under the club's own rules.
function sendDriveMark(stationId, seen, reason) {
  if (!stationId) return;
  const station = state.stations.find((item) => item.id === stationId);
  const grade = state.grade;
  const draft = composeDraft(stationId);
  const queue = reason === 'at_station' ? draft?.queue ?? null : null;
  // Said now, the grade and the queue are no longer a draft; other grades
  // pressed on the card underneath stay pressed.
  if (draft) {
    delete draft.chosen[grade];
    draft.queue = null;
    if (!Object.keys(draft.chosen).length) composeDrafts.delete(stationId);
  }
  const what = `${driveGradeLabel(grade)} ${seen ? 'есть' : 'нет'}${queue != null ? `, очередь: ${queueWords(queue)}` : ''}`;
  const madeAt = Date.now();
  const promise = saveMark(stationId, grade, seen, queue, { summary: what, blindSpot: ['NO_FRESH_DATA', 'CONFLICT'].includes(station?.grade?.status) });
  const sent = {
    stationId, grade, what, madeAt, promise, outcome: null,
    undoable: !!(state.club.enabled && state.club.member && state.club.features?.delete_marks),
  };
  drive.sent = sent;
  promise.then((outcome) => {
    sent.outcome = outcome;
    if (drive.sent === sent) renderDrive({ force: true });
  });
  paintComposers(stationId);
  track('drive_mark', { station: stationId, seen, queue, reason });
  renderDrive({ force: true });
}

// «Отменить» takes the mark back the way 🗑 does: the club deletes it and takes
// back its 🤝. A mark still waiting for a connection simply never leaves.
async function undoDriveMark(button) {
  const sent = drive.sent;
  if (!sent || sent.undoing || !sent.undoable) return;
  sent.undoing = true;
  button.disabled = true;
  const done = (undone, at = sent.madeAt) => {
    if (drive.sent === sent) drive.sent = null;
    if (undone) {
      forgetLook({ station: sent.stationId, author: myId(), at });
      // The phone's own copy is dated by the phone's clock.
      if (at !== sent.madeAt) forgetLook({ station: sent.stationId, author: myId(), at: sent.madeAt });
      redrawMarks();
    }
    track('drive_undo', { station: sent.stationId, success: undone });
    renderDrive({ force: true });
  };
  const outcome = await sent.promise;
  if (outcome !== 'sent') {
    trimOutbox(sent.stationId, [sent.grade]);
    done(true);
    return;
  }
  // The club dates a mark by its own clock, and a delete names that moment.
  const read = await clubCall('/club/reports').catch(() => null);
  if (read && handleClubRejection(read)) {
    done(false);
    return;
  }
  const report = (read?.data?.reports || [])
    .filter((item) => item.who === myId() && item.station === sent.stationId && item.grade === sent.grade && Math.abs(item.at - sent.madeAt) < 60000)
    .sort((a, b) => b.at - a.at)[0];
  const result = report
    ? await clubCall('/club/report/delete', { method: 'POST', body: { station: sent.stationId, author: myId(), at: report.at } }).catch(() => null)
    : null;
  if (result && handleClubRejection(result)) {
    done(false);
    return;
  }
  if (!result?.ok) drive.flash = { text: 'Отметку не удалось отменить. Её можно удалить в карточке АЗС: 🗑 в первый час.', until: Date.now() + 8000 };
  done(!!result?.ok, report?.at);
}

async function driveVote(stationId, vote, button) {
  const found = driveLook(stationId);
  if (!found) return;
  const { look } = found;
  await sendVerdict({ station: stationId, author: look.author, at: look.at }, vote, button);
  const after = voteTargets(stationId).find((item) => item.author === look.author && item.at === look.at);
  // «Уже нет» asks first and may be cancelled; «Так и есть» that did not count failed.
  if (vote === 'up' && after?.myVote !== vote) drive.flash = { text: '👍 не ушёл: нет связи с клубом. Попробуйте ещё раз.', until: Date.now() + 8000 };
  if (after?.myVote === vote) {
    track('drive_mark', { station: stationId, seen: vote === 'up', reason: 'vote' });
    // A confirmation reads like a mark sent. After «Уже нет» the two buttons
    // come back, to say what is on the pumps now.
    if (vote === 'up') {
      drive.confirmed.set(stationId, Date.now());
      drive.sent = { stationId, grade: state.grade, vote: true, what: `${driveGradeLabel()} есть`, madeAt: Date.now(), promise: Promise.resolve('sent'), outcome: 'sent', undoable: false };
    }
  }
  renderDrive({ force: true });
}

window.openFuelStation = openStation;
async function openStation(id) {
  openDrawer('<div class="loading-state">Загружаем доказательства…</div>');
  try {
    const station = await api(`/api/stations/${encodeURIComponent(id)}`);
    state.stationDetails[id] = station;
    // A card opened from a push or a link may be for a station outside the
    // loaded list; 👍 and 👎 on it still need to know where the pump is.
    if (!state.stationInfo[id] && station.location) {
      state.stationInfo[id] = { network: station.network, address: station.address, lat: Number(station.location.lat), lon: Number(station.location.lon) };
    }
    if (state.staticMode) {
      const elapsed = staticElapsedSeconds();
      Object.values(station.grades).forEach((value) => expireGrade(value, elapsed));
    }
    const selected = station.grades[state.grade];
    track('station_open', analytics.predictionFields(station, state.grade));
    const status = STATUS[selected.status];
    const lat = Number(station.location.lat);
    const lon = Number(station.location.lon);
    const routeUrl = `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`;
    // Yandex's traffic layer is the one thing we cannot reproduce: a red
    // approach road is a queue nobody has typed in yet.
    const trafficUrl = `https://yandex.ru/maps/?l=trf&ll=${lon},${lat}&z=16`;
    const gradeCells = Object.entries(station.grades).filter(([grade]) => GRADE_LABELS[grade]).map(([grade, value]) => `<div class="grade-cell" style="--cell-color:${STATUS[value.status].color}"><b>${GRADE_LABELS[grade]}</b><small>${STATUS[value.status].short}</small></div>`).join('');
    const timeline = selected.timeline || {};
    const transition = timeline.last_transition;
    const confidenceLabels = { high: 'высокая', medium: 'средняя', low: 'низкая' };
    const timelinePanel = ['NO_HISTORY', 'OUTDATED_HISTORY', 'FLAPPING', 'APPEARING_UNCONFIRMED'].includes(timeline.state) ? `<div class="timeline-panel neutral"><strong>${escapeHtml(timeline.label)}</strong><p>${escapeHtml(timeline.description)}</p></div>` : `<div class="timeline-panel ${timeline.recent ? 'fresh' : ''}"><span class="timeline-kicker">История статуса</span><strong>${escapeHtml(timeline.label)}</strong><p>${escapeHtml(timeline.description)}</p><dl><div><dt>Текущий статус длится</dt><dd>${escapeHtml(formatDuration(timeline.duration_seconds))}</dd></div><div><dt>Проверок</dt><dd>${Number(timeline.confirmations || 1)}</dd></div>${transition ? `<div><dt>Уверенность перехода</dt><dd>${escapeHtml(confidenceLabels[transition.confidence] || transition.confidence)}</dd></div>` : ''}</dl></div>`;
    const evidence = selected.evidence.length ? selected.evidence.map((row) => {
      const rowStatus = row.fresh ? (row.availability === 'AVAILABLE' || row.availability === 'LIKELY' ? '#158257' : row.availability === 'NOT_AVAILABLE' || row.availability === 'LIKELY_NOT' ? '#b8333a' : '#d58a13') : '#8a9691';
      const extras = [row.limit_liters != null ? `лимит ${row.limit_liters} л` : null, formatQueue(row.queue) ? `очередь: ${formatQueue(row.queue)}` : null].filter(Boolean).join(' · ');
      const note = localizeNote(row.note);
      return `<div class="evidence-row" style="--evidence-color:${rowStatus}"><div class="evidence-head"><strong>${escapeHtml(AVAILABILITY_LABELS[row.availability] || row.availability)}</strong><span>${row.fresh ? formatAge(row.age_seconds) : 'устарело'}</span></div><div class="evidence-meta">${escapeHtml(row.source || 'источник не указан')} · ${escapeHtml(KIND_LABELS[row.kind] || row.kind)}${extras ? `<br>${escapeHtml(extras)}` : ''}<br>provenance: ${escapeHtml(row.effective_provenance)}${note ? `<br>${escapeHtml(note)}` : ''}</div></div>`;
    }).join('') : '<div class="empty-state">Для этой марки нет даже устаревших station-level свидетельств.</div>';
    $('#drawerContent').innerHTML = `
      <h2>${escapeHtml(displayNetwork(station.network))}</h2>
      <p class="drawer-address">${escapeHtml(station.address || 'Адрес не указан')}</p>
      <div class="drawer-actions"><a id="routeLink" href="${routeUrl}" target="_blank" rel="noopener noreferrer">Маршрут в Яндекс Картах ↗</a><a id="trafficLink" href="${trafficUrl}" target="_blank" rel="noopener noreferrer">Пробки у АЗС ↗</a><button id="copyCoords" type="button">Скопировать координаты</button></div>
      <div class="here-panel drawer-mark">
        <span class="here-kicker">Для своих</span>
        <strong>Видите эту АЗС своими глазами?</strong>
        ${state.club.enabled && state.club.member && ['NO_FRESH_DATA', 'CONFLICT'].includes(selected.status) ? '<p class="blind-hint">🔦 У приложения нет свежих данных по этой АЗС — ваша отметка здесь нужнее всего: <b>+2 🤝</b> бонусом.</p>' : ''}
        ${eyewitnessLine(selected, station.id) ? `<p class="here-mine group ${eyewitnessLine(selected, station.id).tone}">${escapeHtml(eyewitnessLine(selected, station.id).text)}</p>` : ''}
        ${markLine(station.id, state.grade) ? `<p class="here-mine">✔ ${escapeHtml(markLine(station.id, state.grade))}</p>` : ''}
        ${thanksButton(station.id)}
        ${verdictButtons(station.id)}
        ${markComposer(station.id)}
        <p class="here-note">Отметьте, что видите на колонках, и очередь. Отметка сразу появится у всех наверху в «Свои сообщают» и весит больше любой ленты. Живёт 45 минут.</p>
      </div>
      <div class="drawer-status" style="--status-color:${status.color}"><strong>${escapeHtml(selected.label)}</strong><p>${escapeHtml(selected.reason)}</p></div>
      ${yandexPanel(selected)}
      ${votePanel(selected)}
      ${trustPanel(selected)}
      ${timelinePanel}
      <div class="grade-matrix">${gradeCells}</div>
      <h3 class="section-title">Почему такой результат по ${GRADE_LABELS[state.grade]}</h3>
      <div class="evidence-list">${evidence}</div>
      <h3 class="section-title">Связанные идентификаторы</h3>
      <div class="evidence-meta">${station.source_refs.map((ref) => `${escapeHtml(ref.source)}:${escapeHtml(ref.station_id)}`).join('<br>')}</div>`;
    bindMarkButtons($('#drawerContent'));
    bindComposer($('#drawerContent'));
    bindThanks($('#drawerContent'));
    bindVerdicts($('#drawerContent'));
    $('#routeLink').addEventListener('click', () => track('route_open', analytics.predictionFields(station, state.grade)));
    $('#trafficLink').addEventListener('click', () => track('traffic_open', analytics.predictionFields(station, state.grade)));
    $('#copyCoords').addEventListener('click', async (event) => {
      try {
        await navigator.clipboard.writeText(`${lat}, ${lon}`);
        event.currentTarget.textContent = 'Координаты скопированы';
      } catch {
        event.currentTarget.textContent = `${lat}, ${lon}`;
      }
    });
  } catch (error) {
    $('#drawerContent').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function openDrawer(html) {
  $('#drawerContent').innerHTML = html;
  $('#scrim').hidden = false;
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('#detailDrawer').classList.remove('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
}

function platformInfo() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari on iOS always defines navigator.standalone. Telegram, VK and other
  // in-app browsers are WKWebViews where it is undefined, and none of them has
  // an "Add to Home Screen" item at all.
  const inAppBrowser = iOS && typeof navigator.standalone === 'undefined';
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { iOS, inAppBrowser, installed };
}

async function copyPageLink(button) {
  const link = location.href.split('?')[0];
  try {
    await navigator.clipboard.writeText(link);
    button.textContent = 'Ссылка скопирована';
  } catch {
    button.textContent = link;
  }
}

function showInstallHelp() {
  const { iOS, inAppBrowser } = platformInfo();
  const steps = inAppBrowser
    ? ['Нажмите кнопку «Скопировать ссылку» ниже.',
       'Откройте <b>Safari</b> и вставьте ссылку в адресную строку.',
       'Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана.',
       'Выберите <b>«На экран “Домой”»</b> и нажмите «Добавить».']
    : iOS
      ? ['Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана.',
         'Прокрутите список и выберите <b>«На экран “Домой”»</b>.',
         'Нажмите «Добавить». Приложение появится на экране как обычная иконка.']
      : ['Откройте меню браузера (три точки).',
         'Выберите <b>«Установить приложение»</b> или «Добавить на главный экран».',
         'Подтвердите установку.'];
  const warning = inAppBrowser
    ? `<div class="drawer-status" style="--status-color:#d58a13"><strong>Сейчас открыто не в Safari</strong><p>Страница открыта во встроенном браузере другого приложения — например, Telegram. В нём пункта «На экран “Домой”» не существует ни у одного сайта. Нужен именно Safari.</p></div>`
    : '';
  openDrawer(`<h2>Установить на телефон</h2>
    <p class="drawer-address">После установки приложение открывается без адресной строки, а интерфейс и последний загруженный снимок работают без сети.</p>
    ${warning}
    <ol class="install-steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
    <button type="button" class="list-more" id="copyLink">Скопировать ссылку</button>`);
  $('#copyLink').addEventListener('click', (event) => copyPageLink(event.currentTarget));
}

function showAbout() {
  const statsOn = analytics.enabled();
  openDrawer(`<h2>Что здесь иначе</h2>
    <p class="drawer-address">Приложение не выдаёт отсутствие данных за отсутствие топлива и запоминает изменения по каждой марке.</p>
    <div class="drawer-status" style="--status-color:#0d5a43"><strong>История «не было → появилось»</strong><p>После каждого живого обновления сохраняется статус конкретной АЗС и марки. Переход показывается отдельно от обычного давнего наличия. «Возможное пополнение» — только осторожная интерпретация подтверждённого перехода, а не заявление о бензовозе или количестве литров.</p></div>
    <div class="drawer-status about-secondary" style="--status-color:#7856c7"><strong>Evidence-first</strong><p>Учитываются возраст, тип сигнала, независимость upstream, очередь, лимит и конфликт источников.</p></div>
    <div class="drawer-status about-secondary" style="--status-color:#158257"><strong>Анонимная аналитика: ${statsOn ? 'включена' : 'выключена'}</strong><p>Считаем полезность поиска и точность прогнозов. Текст адреса, точные координаты, IP и рекламные идентификаторы не сохраняются. География — только крупная зона города.</p><button type="button" class="list-more" id="analyticsToggle">${statsOn ? 'Отключить статистику' : 'Включить статистику'}</button><p><a href="analytics.html" target="_blank" rel="noopener noreferrer">Закрытая панель владельца ↗</a></p></div>
    <h3 class="section-title">Семь честных состояний</h3><div class="source-list">${Object.values(STATUS).map((item) => `<div class="source-row"><strong style="color:${item.color}">${item.short}</strong></div>`).join('')}</div>`);
  $('#analyticsToggle')?.addEventListener('click', () => {
    analytics.setEnabled(!analytics.enabled());
    showAbout();
  });
}

const SOURCE_STATUS_LABELS = {
  GREEN_VERIFIED_HTTP: 'живые статусы',
  GREEN_VERIFIED_BROWSER: 'живые статусы (браузер)',
  GREEN_CATALOG_ONLY: 'каталог и цены',
  CONTROL_ONLY: 'контрольная сверка',
  YELLOW_NEEDS_KEY: 'нужен ключ',
  YELLOW_NEEDS_MANUAL_HAR: 'нужен ручной разбор',
  RED_BLOCKED: 'закрыт',
  RED_NO_REALTIME_DATA: 'без данных о наличии',
};

async function showSources() {
  openDrawer('<div class="loading-state">Загружаем реестр источников…</div>');
  try {
    const data = await api('/api/sources');
    const rows = [...data.sources].sort((a, b) => (b.station_rows_in_snapshot || 0) - (a.station_rows_in_snapshot || 0));
    const live = rows.filter((source) => source.station_rows_in_snapshot > 0);
    const idle = rows.filter((source) => !source.station_rows_in_snapshot);
    const card = (source) => `<div class="source-row"><strong>${escapeHtml(source.id)}</strong><span>${escapeHtml(SOURCE_STATUS_LABELS[source.status] || source.status || '—')}</span><small>${Number(source.station_rows_in_snapshot || 0).toLocaleString('ru-RU')} строк в снимке</small></div>`;
    $('#drawerContent').innerHTML = `<h2>Источники</h2>
      <p class="drawer-address">В последнем снимке данные дали <b>${live.length}</b> из ${rows.length} проверенных каналов. Строка — это одна запись об АЗС от одного источника; на карточке они объединяются и дедуплицируются по upstream.</p>
      <h3 class="section-title">Отдали данные сейчас</h3>
      <div class="source-list">${live.map(card).join('')}</div>
      <h3 class="section-title">Проверены, но сейчас не отдают</h3>
      <div class="source-list">${idle.map(card).join('')}</div>`;
  } catch (error) { $('#drawerContent').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

bootstrap();

// A published snapshot changes every ten minutes, but an open page used to
// keep the copy it loaded for as long as it stayed open — which looks exactly
// like an app that never updates.
const SNAPSHOT_POLL_MS = 120000;

// Every automatic reload goes through here. Two triggers exist (a new build
// and a new service worker) and on an iPhone home-screen app a page served
// from cache can keep asking for "newer" — without a cap that is a reload
// loop the user sees as a white screen.
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem('spbfi-auto-reload-at') || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem('spbfi-auto-reload-at', String(Date.now()));
  } catch {
    // No session storage: better a stale page than a loop.
    return false;
  }
  location.reload();
  return true;
}

async function pollForNewSnapshot() {
  try {
    staticCache.delete('static-data/meta.json');
    const meta = await api('/api/meta');
    // A newer build is live: reload rather than run old code against new data.
    // Only when the tab is visible, so a phone in a pocket does not flicker.
    if (meta.build && window.SPBFI_BUILD && meta.build !== window.SPBFI_BUILD && !document.hidden) {
      if (reloadOnce()) return;
    }
    if (meta.snapshot_at && meta.snapshot_at !== state.meta?.snapshot_at) {
      staticCache.clear();
      state.meta = meta;
      renderMeta();
      // Quietly: nobody asked for this reload, and blanking the list to
      // «Собираем доказательства…» took the chips from under a finger at the pump.
      await loadStations({ silent: true });
    } else {
      state.meta = meta;
      renderMeta();
    }
  } catch {
    // Offline or the host is briefly unavailable; the next tick tries again.
  }
}

setInterval(pollForNewSnapshot, SNAPSHOT_POLL_MS);
setInterval(pollGroupMarks, 60000);
pollGroupMarks();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { pollForNewSnapshot(); pollGroupMarks(); }
});

if ('serviceWorker' in navigator) {
  // The worker calls skipWaiting, so a new one takes control immediately — but
  // the page keeps running the code it already parsed until it is reloaded.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    reloadOnce();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((registration) => {
      setInterval(() => registration.update().catch(() => {}), 10 * 60 * 1000);
    }).catch(() => {});
  });
}

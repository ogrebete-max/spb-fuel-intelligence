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
    if (now - lastTap < 320 && outsideMap(event)) event.preventDefault();
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
    if (!button) return;
    state.grade = button.dataset.grade;
    $$('[data-grade]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-checked', item === button); });
    state.status = null;
    state.timeline = null;
    leaveOwnOnly();
    track('grade_select');
    loadStations();
  });
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

// Precise location is a per-app switch on iPhone, and messenger browsers
// locate worse than Safari; the fix has to be named, not guessed at.
function preciseHint() {
  const { iOS, inAppBrowser } = platformInfo();
  if (inAppBrowser) return 'Приложение открыто внутри мессенджера — там место определяется хуже и обновляется с задержкой. Откройте его в Safari и добавьте на экран «Домой».';
  if (iOS) return 'На iPhone точность ±1–3 км значит, что выключен переключатель «Точная геопозиция»: Настройки → Конфиденциальность и безопасность → Службы геолокации → Сайты Safari → «При использовании» и включить «Точная геопозиция». Потом закройте приложение и откройте снова.';
  return 'Проверьте, что браузеру разрешена точная геолокация.';
}

function formatMeters(metres) {
  return metres >= 1000 ? `${(metres / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км` : `${Math.round(metres)} м`;
}

function renderSearchContext({ waitingAccuracy = null } = {}) {
  const context = $('#searchContext');
  if (state.follow && waitingAccuracy) {
    context.innerHTML = `<strong>Уточняем ваше место…</strong> Пока телефон даёт точность ±${escapeHtml(formatMeters(waitingAccuracy))} — этого мало, чтобы выбрать ближайшие АЗС. <span class="context-warn">${escapeHtml(preciseHint())}</span>`;
    return;
  }
  if (state.searchScope === 'place') {
    context.innerHTML = `<strong>Рядом с: ${escapeHtml(state.searchLabel)}</strong> · радиус ${state.radiusKm} км по прямой <button type="button" data-clear-scope>Сбросить</button>`;
  } else if (state.searchScope === 'device') {
    const age = state.locationAt ? Math.round((Date.now() - state.locationAt) / 1000) : null;
    const fresh = age == null ? '' : age < 20 ? ' · место обновлено только что' : ` · место обновлено ${formatAge(age)}`;
    const precision = state.accuracy ? ` · ±${formatMeters(state.accuracy)}` : '';
    const coarse = state.accuracy > 300
      ? `<span class="context-warn">⚠️ Место определено неточно — список может быть не для вашей улицы. ${escapeHtml(preciseHint())}</span>`
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
  const coarse = state.accuracy > 300;
  button.classList.toggle('coarse', coarse);
  button.innerHTML = coarse
    ? `<span aria-hidden="true">⚠️</span> Место неточное · ±${formatMeters(state.accuracy)} · уточнить`
    : `<span aria-hidden="true">📍</span> Вы здесь · ±${formatMeters(state.accuracy)} · обновить`;
}

function liveDistanceKm(station) {
  if (state.location && station?.location) return haversineKm(state.location, station.location);
  return station?.distance_km ?? null;
}

function notePassedStations(here, accuracy) {
  if (accuracy > 300) return;
  const now = Date.now();
  for (const station of state.stations) {
    if (!station.location) continue;
    const metres = haversineKm(here, station.location) * 1000;
    if (metres <= PASSED_METRES) {
      state.passed[station.id] = {
        at: now, network: station.network, address: station.address, location: station.location,
      };
    }
  }
  for (const [id, item] of Object.entries(state.passed)) {
    if (now - item.at > PASSED_KEEP_MS) delete state.passed[id];
  }
}

function applyFix(coords, { force = false } = {}) {
  const here = { lat: coords.latitude, lon: coords.longitude };
  const accuracy = Math.round(coords.accuracy || 0);
  const firstFix = !state.location;
  if (firstFix && accuracy > COARSE_METRES && Date.now() - state.fixStartedAt < COARSE_WAIT_MS) {
    state.pendingFix = coords;
    renderSearchContext({ waitingAccuracy: accuracy });
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
  notePassedStations(here, accuracy);
  renderMe();
  renderLocateButton();
  refreshVerdicts();
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

function refreshLocation({ manual = false } = {}) {
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
    }
  }, 17000);
  // Two requests at once: a quick one that may reuse a fix from the last half
  // minute, and a precise fresh one. A brand-new high-accuracy fix can take
  // many seconds indoors or never come at all; the quick answer is shown
  // straight away and the precise one sharpens it when it arrives.
  let answered = false;
  let pending = 2;
  const onFix = ({ coords }) => {
    if (state.locateToken !== token) {
      applyFix(coords);
      return;
    }
    applyFix(coords, { force: manual && !answered });
    if (answered) return;
    answered = true;
    state.locating = false;
    renderLocateButton();
    if (manual) {
      showToast(
        `📍 Место обновлено · ±${formatMeters(state.accuracy)}`,
        state.accuracy > 300 ? 'Точность низкая — список может быть не для этой улицы.' : 'Ближайшие АЗС — наверху списка.',
      );
    }
  };
  const onError = (error) => {
    pending -= 1;
    if (answered || pending > 0 || state.locateToken !== token) return;
    state.locating = false;
    renderLocateButton();
    if (manual) {
      showToast('Не удалось обновить место', error.code === 1
        ? 'Геолокация запрещена для этого сайта в настройках телефона.'
        : 'Нет сигнала. Попробуйте ещё раз через несколько секунд.');
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
  const onFix = ({ coords }) => applyFix(coords);
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
  parts.push(grade.undated_only ? 'источник не сообщает времени' : formatAge(grade.age_seconds));
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
      if (event.target.closest('.thanks-button, .verdicts')) return;
      openStation(item.dataset.feedStation);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.target.closest('.thanks-button, .verdicts')) openStation(item.dataset.feedStation);
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

function showToast(title, subtitle, stationId) {
  const stack = $('#toastStack');
  if (!stack) return;
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'toast';
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}`;
  toast.addEventListener('click', () => { toast.remove(); if (stationId) openStation(stationId); });
  stack.prepend(toast);
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
  mark_gone: 'Эта отметка уже устарела.',
  too_many_thanks: 'На сегодня хватит «спасибо» — завтра можно снова.',
  expected_text: 'Напишите, за что благодарность.',
  member_unknown: 'Такого участника нет.',
};

function burst(symbol = '⛽') {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  const items = all.filter((item) => item.type !== 'warning');
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
    return `<article class="station-card own-card ${entry.tier.key}">
      <button type="button" class="card-main own-main" data-own-station="${escapeHtml(entry.stationId)}">
        <span class="card-topline"><strong class="network">${escapeHtml(displayNetwork(entry.info.network))}</strong><span class="distance">${escapeHtml(formatDistance(entry.km))}</span></span>
        <span class="address">${escapeHtml(shortAddress(entry.info.address || ''))}</span>
        <span class="feed-grades">${grades}${queue ? `<span class="feed-queue">очередь: ${escapeHtml(queue)}</span>` : ''}</span>
        <span class="own-age ${entry.tier.key}">${entry.tier.icon} ${escapeHtml(entry.tier.label)} · ${escapeHtml(formatAge((now - entry.latest) / 1000))}${who}</span>
      </button>
      <div class="card-actions">${thanksButton(entry.stationId)}${verdictButtons(entry.stationId)}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-own-station]').forEach((button) => button.addEventListener('click', () => openStation(button.dataset.ownStation)));
  list.querySelector('[data-own-back]').addEventListener('click', leaveOwnView);
  bindThanks(list);
  bindVerdicts(list);
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
    const marker = L.marker([info.lat, info.lon], { icon });
    marker.on('click', () => openStation(entry.stationId));
    marker.addTo(state.markers);
  }
}

function thankTargets(stationId) {
  const grades = (state.groupMarks || {})[stationId] || {};
  const me = myId();
  const byAuthor = new Map();
  for (const [grade, mark] of Object.entries(grades)) {
    if (!mark.who || mark.who === me || !GRADE_LABELS[grade] || Date.now() - mark.at > OWN_WINDOW_MS) continue;
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

function voteTargets(stationId) {
  const grades = (state.groupMarks || {})[stationId] || {};
  const me = myId();
  const looks = new Map();
  for (const [grade, mark] of Object.entries(grades)) {
    // A mark without a name came from a phone outside the club (possible until
    // the door is closed): there is nobody to confirm or refute.
    if (!mark.who || !mark.authorName || !GRADE_LABELS[grade] || Date.now() - mark.at > VOTE_WINDOW_MS) continue;
    const key = `${mark.who}:${mark.at}`;
    const look = looks.get(key) || { station: stationId, at: mark.at, author: mark.who, name: mark.authorName, mine: mark.who === me, up: mark.up || 0, down: mark.down || 0, myVote: mark.myVote || null, grades: [] };
    look.grades.push(`${GRADE_LABELS[grade].replace('АИ-', '')} ${mark.seen ? 'есть' : 'нет'}`);
    looks.set(key, look);
  }
  const latest = new Map();
  for (const look of looks.values()) {
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
  if (!pump || !state.location || Date.now() - (state.locationAt || 0) > 5 * 60 * 1000 || (state.accuracy || 0) > 500) return false;
  return haversineKm(state.location, pump) * 1000 <= VOTE_RADIUS_METRES;
}

function verdictInner(stationId) {
  if (!state.club.enabled || !state.club.member || !state.club.features?.votes) return '';
  const here = atPumpForVote(stationId);
  return voteTargets(stationId).map((look) => {
    if (look.mine) return look.up || look.down ? `<p class="verdict-own">Вашу отметку оценили на месте: 👍 ${look.up} · 👎 ${look.down}</p>` : '';
    const button = (vote, icon, count, title) => `<button type="button" class="verdict-button ${vote}${look.myVote === vote ? ' mine' : ''}${here ? '' : ' away'}" data-verdict="${vote}" aria-pressed="${look.myVote === vote}" title="${title}">${icon} <b>${count}</b></button>`;
    return `<div class="verdict" data-verdict-author="${escapeHtml(look.author)}" data-verdict-at="${look.at}">
      <span class="verdict-label">На месте так? ${look.name ? `<b>${escapeHtml(look.name)}</b>: ` : ''}${escapeHtml(look.grades.join(', '))}</span>
      ${button('up', '👍', look.up, 'Подтверждаю: вижу то же самое')}
      ${button('down', '👎', look.down, 'Опровергаю: на колонках другое')}
      <small class="verdict-hint${here ? ' here' : ''}">${here ? 'Вы на этой заправке: всё так — 👍, неправда — 👎' : '👍 👎 — только на этой заправке, в первый час после отметки'}</small>
    </div>`;
  }).join('');
}

function verdictButtons(stationId) {
  const inner = verdictInner(stationId);
  return inner ? `<div class="verdicts" data-verdicts-station="${escapeHtml(stationId)}" data-here="${atPumpForVote(stationId)}">${inner}</div>` : '';
}

function bindVerdicts(root) {
  root.querySelectorAll('.verdicts [data-verdict]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const look = button.closest('.verdict');
      const station = button.closest('.verdicts').dataset.verdictsStation;
      sendVerdict({ station, author: look.dataset.verdictAuthor, at: Number(look.dataset.verdictAt) }, button.dataset.verdict, button);
    });
  });
}

// Every copy on screen — the feed, the «Свои» list, an open card — follows a
// vote or the phone arriving at the pump. Redrawn only when something changed,
// so a finger on the way to a button does not lose it.
function refreshVerdicts(stationId = null, { force = false } = {}) {
  document.querySelectorAll('.verdicts').forEach((holder) => {
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
  const buttons = [...(button.closest('.verdict')?.querySelectorAll('[data-verdict]') || [button])];
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

function profileCard(profile) {
  if (!profile?.level) return '';
  const { level, counts = {} } = profile;
  const span = level.next ? level.next.min - level.min : 1;
  const progress = level.next ? Math.round(100 * (profile.liters - level.min) / span) : 100;
  const earned = profile.badges.filter((badge) => badge.earned).length;
  const badges = profile.badges.map((badge) => `<div class="badge${badge.earned ? ' earned' : ''}">
      <span class="badge-icon">${badge.icon}</span><b>${escapeHtml(badge.title)}</b>
      <small>${badge.earned ? `получен ${formatDay(badge.earned)}` : escapeHtml(badge.hint)}</small>
    </div>`).join('');
  const awards = (profile.awards || []).length
    ? `<h3 class="section-title">Благодарности клуба</h3><div class="source-list">${profile.awards.map((award) => `<div class="source-row"><strong>🏅 ${escapeHtml(award.text)}</strong><small>${formatDay(award.at)}</small></div>`).join('')}</div>`
    : '';
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
    </section>
    <h3 class="section-title">Значки · ${earned} из ${profile.badges.length}</h3>
    <div class="badge-grid">${badges}</div>
    ${awards}
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
function handleClubRejection(result) {
  if (!state.club.enabled) return false;
  const banned = result.status === 403 && result.data?.error === 'banned';
  if (result.status !== 401 && !banned) return false;
  forgetClub();
  if (state.club.mode !== 'closed') {
    // Until the door is closed a phone that is no longer inside simply goes
    // back to the ordinary app.
    state.club.enabled = false;
    renderGroupFeed();
    showToast(
      banned ? 'Владелец клуба закрыл вам доступ' : 'Вход в клуб на этом телефоне больше не действует',
      banned ? `${result.data.reason ? `Причина: ${result.data.reason}. ` : ''}Приложение работает как раньше.` : 'Попросите у своих новое приглашение.',
    );
    return true;
  }
  if (banned) showClubGate({ banned: result.data.reason || '' });
  else showClubGate({ notice: 'Вход на этом телефоне больше не действует. Попросите у своих новое приглашение.' });
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
    return;
  }
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

// While the club is a test nobody else is shown a way in: the owner opens it
// by tapping the page title five times. Quick taps reach the page as touches
// but the browser merges them into a single click, so the taps are counted
// from the pointer itself; a finger that slid was scrolling, not tapping.
function bindSecretClubEntry() {
  const title = $('#heroTitle');
  if (!title) return;
  let taps = [];
  let down = null;
  title.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY, at: Date.now() };
  });
  title.addEventListener('pointercancel', () => { down = null; });
  title.addEventListener('pointerup', (event) => {
    const tapped = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 12 && Date.now() - down.at < 700;
    down = null;
    if (!tapped) return;
    const now = Date.now();
    taps = [...taps.filter((at) => now - at < 3000), now];
    if (taps.length < 5) return;
    taps = [];
    if (state.club.enabled && state.club.member) showClub();
    else if (state.club.mode === 'off') showToast('Клуб пока не включён', 'Его включает владелец в настройках сервера.');
    else showClubGate({ mode: 'owner' });
  });
}

function clubJoinLine() {
  if (state.club.mode !== 'invite' || state.club.enabled) return '';
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

function showClubGate({ notice = '', banned = null, mode = 'join' } = {}) {
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
    ? `<div class="gate-alert"><strong>Владелец клуба закрыл вам доступ.</strong>${banned ? ` Причина: ${escapeHtml(banned)}.` : ''}</div>`
    : notice ? `<div class="gate-alert">${escapeHtml(notice)}</div>` : '';
  const install = installFirst ? `<div class="gate-install">
      <strong>Сначала установите приложение</strong>
      <p>Вход в ${inAppBrowser ? 'этом браузере' : 'Safari'} не переносится в приложение на экране «Домой», поэтому код вводится уже в нём.</p>
      <ol>${inAppBrowser ? '<li>Откройте эту ссылку в <b>Safari</b>.</li>' : ''}<li>Нажмите «Поделиться» — квадрат со стрелкой вверх.</li><li>Выберите <b>«На экран „Домой“»</b> и нажмите «Добавить».</li><li>Откройте приложение с иконки и введите код там.</li></ol>
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
      <button type="button" class="gate-link" id="gateBack">← У меня приглашение</button>`
    : `${passkeysOffered() && !installFirst ? `<div class="gate-return">
          <button type="button" class="gate-submit secondary" id="gatePasskey">🔑 Я уже в клубе — войти по ${unlockWords()}</button>
          <small>Если вход в клуб запоминали на этом или другом своём устройстве.</small>
        </div>` : ''}
      <form id="gateJoinForm" class="gate-form"${installFirst ? ' hidden' : ''}>
        <label>Код приглашения<input id="gateCode" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX" value="${escapeHtml(code)}" required><small>Можно вставить сюда всё сообщение с приглашением — код найдётся сам.${state.club.features?.returning ? ' Уже были в клубе? Подойдёт тот же код (неделю) или код для входа со своего телефона — имя и правила тогда не нужны.' : ''}</small></label>
        <label>Как вас называть<input id="gateName" maxlength="24" autocomplete="given-name" placeholder="Например, Саша"><small>Имя видят только участники — рядом с вашими отметками.</small></label>
        ${rules}
        <label class="gate-accept"><input type="checkbox" id="gateAccept"><span>Принимаю правила и отмечаю только то, что вижу сам</span></label>
        <button type="submit" class="gate-submit">Вступить в клуб</button>
        <small id="gateError" role="alert"></small>
      </form>
      ${installFirst ? rules : ''}
      <button type="button" class="gate-link" id="gateOwner">Я владелец клуба</button>`;
  // Until the door is closed the gate is an offer, not a wall.
  const dismiss = state.club.mode !== 'closed' ? '<button type="button" class="gate-close" id="gateClose">Не сейчас ✕</button>' : '';
  gate.innerHTML = `<div class="gate-card">
      ${dismiss}
      <span class="brand-mark" aria-hidden="true"><span></span></span>
      <p class="gate-kicker">Закрытый клуб</p>
      <h1>Топливо СПб — для своих</h1>
      <p class="gate-lead">Вход только по приглашению участника. Отметки здесь ставят люди, за которых кто-то поручился, — поэтому им можно верить.</p>
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
  $('#gateOwner')?.addEventListener('click', () => showClubGate({ notice, banned, mode: 'owner' }));
  $('#gateBack')?.addEventListener('click', () => showClubGate({ notice, banned, mode: 'join' }));
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
      if (error) error.textContent = clubMessage(result);
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
    ${profileCard(profile)}
    ${me.data.refuted_by ? `<div class="drawer-status" style="--status-color:#b8333a"><strong>👎 Ваши отметки опровергли: ${me.data.refuted_by} ${plural(me.data.refuted_by, 'человек', 'человека', 'человек')} из 5</strong><p>Так решили участники, которые сами были на тех заправках. Отмечайте только то, что видите на колонках: после пяти разных людей — выбывание из клуба.</p></div>` : ''}
    <div id="clubBoard"></div>
    <div class="drawer-status" style="--status-color:#0d5a43">
      <strong>Пригласить человека</strong>
      <p>Только того, за кого ручаетесь: за ложные отметки исключают, а пригласивший отвечает за приглашённого. Код пускает одного человека и действует 7 дней.${owner ? '' : ` Осталось приглашений: <b>${Number(left) || 0}</b>.`}</p>
      <button type="button" class="list-more" id="clubInvite"${!owner && !left ? ' disabled' : ''}>Создать приглашение</button>
      <div id="clubInviteResult"></div>
    </div>
    <h3 class="section-title">Мои приглашения</h3>
    <div class="source-list">${inviteRows}</div>
    ${owner ? '<h3 class="section-title">Участники</h3><div id="clubMembers" class="source-list"><div class="loading-state">Загружаем участников…</div></div>' : ''}
    ${loginSection(me.data.passkeys || 0)}
    <details class="club-howto">
      <summary>Как пользоваться клубом</summary>
      <ol>
        <li><b>Видите АЗС</b> — откройте её карточку и отметьте, что есть на колонках и какая очередь. Отметка живёт 45 минут и сразу видна всем своим.</li>
        ${state.club.features?.votes ? '<li><b>Вы на заправке, которую отметил другой?</b> Всё так — 👍, неправда — 👎. Вдали от заправки эти кнопки не работают: оценивает только тот, кто видит колонки сам.</li>' : ''}
        <li><b>Отметка помогла</b> — скажите 🙏 «Спасибо». Автору +2 🤝.</li>
        ${state.club.features?.passkeys ? '<li><b>Запомните вход 🔑</b> — если приложение сбросится или смените телефон, вернётесь по Face ID или отпечатку.</li>' : ''}
        ${state.club.features?.returning ? '<li><b>Вылетели, а вход не запоминали</b> — введите тот же код приглашения (он пускает вас неделю) или код с другого своего устройства: «👥 Клуб» → «Войти на другом устройстве».</li>' : ''}
      </ol>
    </details>
    <h3 class="section-title">Правила клуба</h3>
    <ol class="club-rules">${clubRules().map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol>
    <button type="button" class="list-more club-leave" id="clubLeave">Выйти из клуба на этом устройстве</button>`;
  $('#clubInvite')?.addEventListener('click', createInvite);
  bindInviteButtons($('#drawerContent'));
  bindLoginSection();
  loadLeaderboard();
  $('#clubLeave').addEventListener('click', () => {
    // It used to say a new invitation would be needed, which scared people
    // into staying signed in on shared devices; the way back is spelled out.
    const way = owner
      ? 'Вернуться можно ключом владельца: пять быстрых касаний по заголовку.'
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
    ].filter(Boolean).join(' · ');
    const disputed = item.disputed_30d
      ? `<span class="club-flag">Противоположные отметки: ${item.disputed_30d} ${plural(item.disputed_30d, 'раз', 'раза', 'раз')} (${item.disputed_by_people_30d} ${plural(item.disputed_by_people_30d, 'человек', 'человека', 'человек')}) за 30 дней</span>`
      : '';
    const action = item.role === 'owner' ? '' : item.banned
      ? `<button type="button" class="club-small" data-unban="${escapeHtml(item.id)}">Вернуть в клуб</button><button type="button" class="club-small" data-remove="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Удалить</button>`
      : `<button type="button" class="club-small" data-award="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">🏅 Наградить</button>${state.club.features?.returning ? `<button type="button" class="club-small" data-login-code="${escapeHtml(item.id)}">🔑 Код для входа</button>` : ''}<button type="button" class="club-small danger" data-ban="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Исключить</button><button type="button" class="club-small" data-remove="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Удалить</button>`;
    return `<div class="source-row club-member${item.banned ? ' banned' : ''}"><strong>${escapeHtml(item.name)}${item.banned ? (item.banned_by === 'votes' ? ' — выбыл(а) по 👎' : ' — исключён(а)') : ''}</strong><small>${facts}</small>${disputed}${item.banned && item.banned_reason ? `<small>Причина: ${escapeHtml(item.banned_reason)}</small>` : ''}${action}</div>`;
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
function eyewitnessLine(grade, stationId) {
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
    text: `👁 Свои видели ${ago}${crowd}: ${GRADE_LABELS[state.grade]} ${seen ? 'есть' : 'нет'}${queueText} — самая точная отметка`,
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

function bindComposer(root) {
  const box = root.querySelector('.mark-composer');
  if (!box) return;
  const chosen = {};
  let queue = null;
  const send = box.querySelector('.compose-send');
  box.querySelectorAll('[data-quick-grade]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const grade = button.dataset.quickGrade;
      const label = GRADE_LABELS[grade].replace('АИ-', '');
      if (!(grade in chosen)) chosen[grade] = true;
      else if (chosen[grade] === true) chosen[grade] = false;
      else delete chosen[grade];
      const value = chosen[grade];
      button.classList.toggle('yes', value === true);
      button.classList.toggle('no', value === false);
      button.textContent = value === true ? `${label} ✓` : value === false ? `${label} ✕` : label;
      button.setAttribute('aria-pressed', value === undefined ? 'false' : 'true');
      send.disabled = !Object.keys(chosen).length;
    });
  });
  box.querySelectorAll('[data-compose-grade]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const grade = button.dataset.composeGrade;
      const seen = button.dataset.composeSeen === '1';
      chosen[grade] = seen;
      button.parentElement.querySelectorAll('[data-compose-grade]').forEach((item) => item.classList.toggle('selected', item === button));
      send.disabled = !Object.keys(chosen).length;
    });
  });
  box.querySelectorAll('[data-compose-queue]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      queue = Number(button.dataset.composeQueue);
      box.querySelectorAll('[data-compose-queue]').forEach((item) => item.classList.toggle('selected', item === button));
    });
  });
  send.addEventListener('click', (event) => {
    event.stopPropagation();
    const stationId = box.dataset.composeStation;
    const grades = Object.keys(chosen);
    const summary = grades.map((grade) => `${GRADE_LABELS[grade].replace('АИ-', '')} ${chosen[grade] ? 'есть' : 'нет'}`).join(', ');
    const queueText = queue != null ? `, очередь: ${queueWords(queue)}` : '';
    // A look at a station the app knew nothing fresh about is worth a bonus.
    const details = state.stationDetails[stationId];
    const blindSpot = grades.some((grade) => ['NO_FRESH_DATA', 'CONFLICT'].includes(details?.grades?.[grade]?.status || state.gradesBrief?.[stationId]?.[grade]?.s));
    grades.forEach((grade) => saveMark(stationId, grade, chosen[grade], queue, { render: false, share: false }));
    box.innerHTML = `<span class="mark-sent">⏳ Отправляю своим: ${escapeHtml(summary)}${escapeHtml(queueText)}…</span>`;
    shareLook(stationId, grades.map((grade) => ({ grade, seen: chosen[grade] })), queue, { summary: summary + queueText, blindSpot })
      .then((outcome) => showSendOutcome(box.querySelector('.mark-sent'), outcome, `${summary}${queueText}`, 'У всех это уже наверху, в «Свои сообщают».'));
    renderGroupFeed();
    setTimeout(() => { renderStations(); renderHerePanel(); }, 4000);
  });
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
  if (!state.location || !state.stations.length || state.accuracy > 300) {
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

function renderStations({ append = false } = {}) {
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
  if (!append) state.visible = 0;
  const from = state.visible;
  const to = Math.min(state.stations.length, from + PAGE_SIZE);
  state.visible = to;
  const fragment = document.createDocumentFragment();
  state.stations.slice(from, to).forEach((station) => {
    const node = $('#stationTemplate').content.cloneNode(true);
    const grade = station.grade;
    const advice = grade.advice || {};
    const card = node.querySelector('.station-card');
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
    const near = state.location && state.accuracy <= 500 && km != null && km * 1000 <= NEARBY_REPORT_METRES;
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
  if (state.visible < state.stations.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'list-more';
    more.textContent = `Показать ещё ${Math.min(PAGE_SIZE, state.stations.length - state.visible)} из ${(state.stations.length - state.visible).toLocaleString('ru-RU')}`;
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
    const marker = L.marker([station.location.lat, station.location.lon], { icon });
    marker.bindPopup(`<div class="popup-title">${escapeHtml(station.network)}</div><div>${escapeHtml(shortAddress(station.address))}</div><div class="popup-status" style="--popup-color:${status.color}">${escapeHtml(station.grade.label)}</div><button class="popup-open" onclick="window.openFuelStation('${station.id}')">Открыть и отметить</button>`);
    marker.addTo(state.markers);
  });
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
      await loadStations();
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

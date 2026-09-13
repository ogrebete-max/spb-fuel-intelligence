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
  groupMarks: {}, stationInfo: {}, stationDetails: {}, total: 0,
  club: { enabled: false, member: null, profile: null, newsTimer: null },
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
    staticCache.set(relativePath, fetch(relativePath, { headers: { Accept: 'application/json' } }).then(async (response) => {
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
  const [title, subtitle, stale] = formatSnapshot(frozenAge, state.meta.mode);
  const stats = state.meta.stats || {};
  const baseline = Number((stats.source_rows || {}).sber || 0);
  $('#snapshotCard').innerHTML = `<span class="pulse ${stale ? 'stale' : ''}"></span><span><strong>${title}</strong><small>${subtitle} · ${Number(stats.canonical_stations).toLocaleString('ru-RU')} карточек</small></span>`;
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
    refresh.title = 'Публичная версия обновляется GitHub Actions по расписанию.';
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
    track('grade_select');
    loadStations();
  });
  $('.location-row .segmented').addEventListener('click', (event) => {
    const button = event.target.closest('[data-area]');
    if (!button) return;
    state.area = button.dataset.area;
    $$('[data-area]').forEach((item) => item.classList.toggle('active', item === button));
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
    if (state.searchScope) clearSearchScope({ keepText: true, reload: false });
    // Typing a street used to filter nothing at all until the user guessed to
    // press "Найти рядом"; filtering by address now happens as you type, and
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
  $('#sortSelect').addEventListener('change', (event) => { state.sort = event.target.value; track('sort_change', { filter: state.sort }); loadStations(); });
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

function renderSearchContext() {
  const context = $('#searchContext');
  if (state.searchScope === 'place') {
    context.innerHTML = `<strong>Рядом с: ${escapeHtml(state.searchLabel)}</strong> · радиус ${state.radiusKm} км по прямой <button type="button" data-clear-scope>Сбросить</button>`;
  } else if (state.searchScope === 'device') {
    const acc = state.accuracy ? ` · точность ±${state.accuracy} м` : '';
    context.innerHTML = `<strong>Рядом с вами</strong> · ближайшие сверху, список сам обновляется по мере движения${acc} <button type="button" data-clear-scope>Весь город</button>`;
  } else if (state.searchScope === 'map') {
    context.innerHTML = `<strong>${escapeHtml(state.searchLabel)}</strong> <button type="button" data-clear-scope>Сбросить</button>`;
  } else if (state.search.trim()) {
    context.textContent = 'Ищем точное совпадение по сети или адресу АЗС. Нажмите «Найти рядом», если это адрес места.';
  } else {
    context.textContent = 'Введите адрес, посёлок или название АЗС. Ввод фильтрует список; «Найти рядом» ищет вокруг этого места, расширяя радиус, пока не найдётся из чего выбрать.';
  }
  context.querySelector('[data-clear-scope]')?.addEventListener('click', () => clearSearchScope({ keepText: false, reload: true }));
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
  $('#locateButton').innerHTML = '<span aria-hidden="true">⌖</span> Рядом со мной';
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
    button.textContent = '⌖ Найти рядом';
  }
}

// Five kilometres around a village may hold two stations and no answer; the
// radius widens until there is something to choose from.
const RADIUS_LADDER = [5, 10, 20];
const MIN_NEARBY = 8;

async function loadStationsWideningRadius() {
  for (const km of RADIUS_LADDER) {
    state.radiusKm = km;
    await loadStations({ silent: km !== RADIUS_LADDER[0] });
    if (state.stations.length >= MIN_NEARBY) break;
  }
  renderSearchContext();
}

// "Рядом" is a mode, not a button press. A navigator does not ask you to tap
// "my position" every kilometre: once you allow location it follows you, keeps
// the list sorted by what is closest, and re-queries as you move. iOS also hands
// out a coarse cached fix first, so a single getCurrentPosition would happily
// show the other end of the city; watchPosition keeps improving instead.
const REQUERY_METRES = 150;

function locate() {
  if (state.follow) {
    stopFollowing();
    return;
  }
  startFollowing({ manual: true });
}

function startFollowing({ manual = false } = {}) {
  if (!navigator.geolocation) {
    if (manual) alert('Геолокация не поддерживается этим браузером.');
    return;
  }
  const button = $('#locateButton');
  if (manual) track('locate_start');
  button.innerHTML = '<span aria-hidden="true">◌</span> Определяем…';
  state.follow = true;
  document.body.classList.add('following');
  const onFix = ({ coords }) => {
    const here = { lat: coords.latitude, lon: coords.longitude };
    const moved = !state.location || haversineKm(state.location, here) * 1000 > REQUERY_METRES;
    const firstFix = !state.location;
    state.location = here;
    state.accuracy = Math.round(coords.accuracy || 0);
    button.innerHTML = `<span aria-hidden="true">●</span> Слежу за вами${state.accuracy > 300 ? ' · грубо' : ''}`;
    renderMe();
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
      track('locate_result', { success: true, zone: analytics.zoneFor(here), reason: state.accuracy > 300 ? 'coarse' : 'precise' });
      return;
    }
    if (moved && state.searchScope === 'device') {
      loadStations({ silent: true });
    }
    if (moved) refreshPushLocation();
  };
  const onError = (error) => {
    state.follow = false;
    document.body.classList.remove('following');
    button.innerHTML = '<span aria-hidden="true">⌖</span> Рядом со мной';
    if (manual) {
      alert(error.code === 1
        ? 'Доступ к геолокации запрещён. Разрешите его для этого сайта в настройках телефона, иначе «рядом» работать не будет.'
        : 'Не удалось определить положение. Попробуйте ещё раз на открытом месте.');
    }
    track('locate_result', { success: false, reason: error.code === 1 ? 'denied' : 'unavailable' });
  };
  // A cached fix within a minute appears instantly; the watch then refines it.
  navigator.geolocation.getCurrentPosition(onFix, onError, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
  state.watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
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
  } catch (error) {
    $('#stationList').innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message)}</div>`;
  }
}

function renderStatusStrip(counts, timelineCounts = {}) {
  const strip = $('#statusStrip');
  const appeared = timelineCounts.appeared || 0;
  const temporalChip = `<button class="status-chip timeline-filter ${state.timeline === 'appeared' ? 'active' : ''}" style="--status-color:#0d5a43" data-timeline="appeared" ${appeared ? '' : 'disabled'}>✦ Появилось недавно · ${appeared}</button>`;
  strip.innerHTML = temporalChip + Object.entries(STATUS).map(([key, item]) => {
    const count = counts[key] || 0;
    // A chip reading "· 0" must not be clickable: selecting it empties the
    // list and looks exactly like a broken page.
    const disabled = count === 0 && state.status !== key ? 'disabled' : '';
    return `<button class="status-chip ${state.status === key ? 'active' : ''}" style="--status-color:${item.color}" data-status="${key}" ${disabled}>${item.short} · ${count}</button>`;
  }).join('');
  strip.onclick = (event) => {
    const temporal = event.target.closest('[data-timeline]');
    if (temporal) {
      state.timeline = state.timeline === temporal.dataset.timeline ? null : temporal.dataset.timeline;
      track('status_filter', { filter: state.timeline || 'all' });
      loadStations();
      return;
    }
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.status = state.status === button.dataset.status ? null : button.dataset.status;
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
  if (!timeline || ['NO_HISTORY', 'OBSERVED', 'OUTDATED_HISTORY'].includes(timeline.state)) return null;
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

function saveMark(stationId, grade, seen, queue = null, { render = true, notify = true, summary = '' } = {}) {
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
  shareMark(stationId, grade, seen, queue, { notify, summary });
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

async function shareMark(stationId, grade, seen, queue = null, { notify = true, summary = '' } = {}) {
  const endpoint = window.SPBFI_REPORT_ENDPOINT;
  if (!endpoint) return;
  const known = state.stations.find((item) => item.id === stationId) || state.stationInfo[stationId];
  const place = known?.location || (known?.lat != null ? { lat: known.lat, lon: known.lon } : null);
  const name = known?.network || '';
  const address = shortAddress(known?.address || '');
  let legacyKey = '';
  try { legacyKey = localStorage.getItem(GROUP_KEY) || ''; } catch { /* nothing stored */ }
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...memberHeaders(), ...(legacyKey ? { 'X-Group-Key': legacyKey } : {}) },
      body: JSON.stringify({ station: stationId, grade, seen, who: myId(), lat: place?.lat, lon: place?.lon, name, address, notify, summary, ...(queue != null ? { queue } : {}) }),
    });
    if (response.ok) {
      try {
        const data = await response.json();
        if (data.rewards) celebrate(data.rewards);
      } catch { /* the mark is in; the celebration is optional */ }
      return;
    }
    if (response.status === 401 || response.status === 403) {
      let data = {};
      try { data = await response.json(); } catch { /* not JSON */ }
      // The club may have been switched on after this page was opened.
      if (!state.club.enabled) { checkClub(); return; }
      if (!handleClubRejection({ status: response.status, data })) {
        showToast('Отметка не отправлена', 'Она сохранена только на этом телефоне.');
      }
    }
  } catch {
    // Offline or the worker is down: the local mark is already saved.
  }
}

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
    const cutoff = Date.now() - GROUP_MARK_TTL_MS;
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
    box.innerHTML = `<div class="feed-empty">👁 <strong>Свои сообщают:</strong> за последние 45 минут отметок нет. Видите АЗС — откройте её карточку и отметьте, что на колонках.${pushButton()}</div>`;
    bindPushButton(box);
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
      <span class="feed-title"><strong>${escapeHtml(info.network || 'АЗС')}</strong><span class="feed-meta">${escapeHtml(meta)}</span></span>
      <span class="feed-address">${escapeHtml(shortAddress(info.address || ''))}</span>
      <span class="feed-grades">${grades}${queue ? `<span class="feed-queue">очередь: ${escapeHtml(queue)}</span>` : ''}</span>
      ${thanksButton(entry.stationId)}
    </div>`;
  }).join('');
  box.innerHTML = `<div class="feed-head">👁 Свои сообщают <small>за последние 45 минут · это самые точные данные в приложении</small>${pushButton()}</div><div class="feed-list">${cards}</div>`;
  box.querySelectorAll('[data-feed-station]').forEach((item) => {
    item.addEventListener('click', (event) => {
      if (event.target.closest('.thanks-button')) return;
      openStation(item.dataset.feedStation);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.target.closest('.thanks-button')) openStation(item.dataset.feedStation);
    });
  });
  bindThanks(box);
  bindPushButton(box);
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
      showToast(`🎉 Новый уровень: ${moment.levelUp.icon} ${moment.levelUp.title}`, `У вас ${moment.total} л. Своим с вами везёт!`);
    }
    moment.badges.forEach((badge, index) => {
      setTimeout(() => {
        burst(badge.icon);
        showToast(`${badge.icon} Новый значок: ${badge.title}`, 'Все значки — в разделе «Клуб».');
      }, 700 * (index + 1));
    });
    if (moment.confirmed.size) {
      showToast(`✅ Вы подтвердили: ${[...moment.confirmed].join(', ')}`, 'Им +3 л за точность — спасибо, что проверили.');
    }
    if (moment.liters > 0 && !moment.levelUp) {
      const next = moment.level?.next;
      showToast(`+${moment.liters} л ⛽ спасибо за отметку`, next ? `Всего ${moment.total} л · до «${next.title}» ещё ${next.left} л` : `Всего ${moment.total} л`);
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
  const items = news.filter((item) => item.at > since && !['mark', 'first_seen'].includes(item.type));
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
    showToast(`⛽ Пока вас не было: +${liters} л`, parts || 'Загляните в «Клуб».');
    return;
  }
  items.forEach((item, index) => {
    setTimeout(() => {
      if (item.type === 'thanks') showToast(`🙏 ${item.by_name || 'Свой'} говорит спасибо`, `За отметку «${GRADE_LABELS[item.grade] || ''} ${item.seen ? 'есть' : 'нет'}» · +${item.liters} л`, item.station);
      else if (item.type === 'confirmed') showToast(`✅ ${item.by_name || 'Свой'} подтвердил(а) вашу отметку`, `+${item.liters} л за точность`, item.station);
      else if (item.type === 'badge') { burst(item.icon); showToast(`${item.icon} Новый значок: ${item.title}`, 'Все значки — в разделе «Клуб».'); }
      else if (item.type === 'level') { burst('🎉'); showToast(`🎉 Новый уровень: ${item.icon} ${item.title}`, 'Так держать!'); }
      else if (item.type === 'award') { burst('🏅'); showToast('🏅 Благодарность клуба', `${item.text} · +${item.liters} л`); }
      else if (item.type === 'hero') { burst('🦸'); showToast('🦸 Вы — герой прошлой недели!', `${item.liters} л за неделю. Спасибо от всего клуба.`); }
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

function thankTargets(stationId) {
  const grades = (state.groupMarks || {})[stationId] || {};
  const me = myId();
  const byAuthor = new Map();
  for (const [grade, mark] of Object.entries(grades)) {
    if (!mark.who || mark.who === me || !GRADE_LABELS[grade] || Date.now() - mark.at > GROUP_MARK_TTL_MS) continue;
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
    showToast(`🙏 Спасибо отправлено: ${thanked.join(', ')}`, 'Им +2 л. Такие мелочи и держат клуб.');
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
        <span class="tank-liters"><b>${profile.liters}</b><small>литров</small></span>
      </div>
      <div class="tank-bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(4, Math.min(100, progress))}%"></i></div>
      <p class="tank-next">${level.next ? `До уровня ${level.next.icon} «${escapeHtml(level.next.title)}» — ещё ${level.next.left} л` : 'Высший уровень. Вы — легенда клуба!'} · за неделю ${profile.week} л</p>
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
      <summary>Как заработать литры</summary>
      <ul>
        <li><b>+1 л</b> — отметка АЗС (одна за час на одной заправке, до 10 л в день)</li>
        <li><b>+3 л</b> — другой участник подтвердил вашу отметку</li>
        <li><b>+2 л</b> — вам сказали «спасибо»</li>
        <li><b>+2 л</b> — первым увидели «есть» там, где было «нет»</li>
        <li><b>+10 л</b> — благодарность от владельца клуба</li>
      </ul>
      <p>Литры — за пользу своим, а не за количество нажатий. Ложная отметка не окупается: её не подтвердят, а владелец видит споры.</p>
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
      <span class="board-week"><b>${row.week}</b> л</span>
      <small class="board-meta">всего ${row.liters} л · значков ${row.badges}</small>
    </div>`).join('');
  const hero = result.data.hero_last_week
    ? `<p class="board-hero">🦸 Герой прошлой недели — <b>${escapeHtml(result.data.hero_last_week.name)}</b>, ${result.data.hero_last_week.liters} л</p>`
    : '';
  box.innerHTML = `<h3 class="section-title">Литры недели</h3>${hero}<div class="board">${rows}</div>`;
}

// ---------------------------------------------------------------- club

// The app becomes a closed club once the worker says so: marks, names and
// pushes belong to members, membership is by invitation, and the owner can
// exclude anyone. Until the worker has the club switched on nothing changes.
const CLUB_TOKEN_KEY = 'spbfi-club-token-v1';
const CLUB_MEMBER_KEY = 'spbfi-club-member-v1';
const CLUB_RULES = [
  'Клуб — только для своих. Приглашайте тех, за кого ручаетесь сами. Код одноразовый: не пересылайте его дальше.',
  'Отмечайте только то, что видите своими глазами прямо сейчас. Не пересказывайте чаты и слухи.',
  'Не уверены — не отмечайте. Лучше промолчать, чем отправить своих на пустую заправку.',
  'За ложные отметки владелец исключает из клуба. Кто пригласил — отвечает за приглашённого.',
  'Не показывайте приложение и отметки посторонним и не выкладывайте их в общие чаты.',
];
const CLUB_ERRORS = {
  invite_unknown: 'Такого кода нет. Проверьте буквы: в кодах не бывает О, 0, I и 1.',
  invite_used: 'Этот код уже использован. Он одноразовый — попросите новый у того, кто пригласил.',
  invite_expired: 'Срок кода истёк: он действует 7 дней. Попросите новый.',
  sponsor_banned: 'Пригласивший исключён из клуба, поэтому код недействителен.',
  rules_not_accepted: 'Чтобы вступить, нужно принять правила клуба.',
  expected_code_and_name: 'Введите код приглашения и имя.',
  wrong_owner_key: 'Ключ владельца не подошёл.',
  too_many_attempts: 'Слишком много попыток. Подождите минуту.',
  no_invites_left: 'Приглашения закончились. Новые может выдать владелец клуба.',
  try_again_in_a_minute: 'Клуб ещё запоминает вас. Попробуйте через минуту.',
  owner_only: 'Это может только владелец клуба.',
};
Object.assign(CLUB_ERRORS, REWARD_ERRORS);

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

function inviteFromUrl() {
  const clean = String(new URLSearchParams(location.search).get('invite') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : '';
}

// Any club call answered with "not a member" or "banned" lands here, so the
// phone never keeps pretending to be inside.
function handleClubRejection(result) {
  if (!state.club.enabled) return false;
  if (result.status === 401) {
    forgetClub();
    showClubGate({ notice: 'Вход на этом телефоне больше не действует. Попросите у своих новое приглашение.' });
    return true;
  }
  if (result.status === 403 && result.data?.error === 'banned') {
    forgetClub();
    showClubGate({ banned: result.data.reason || '' });
    return true;
  }
  return false;
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
  state.club.enabled = health.ok && health.data?.club === true;
  if (!state.club.enabled) {
    renderClubButton();
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
  hideClubGate();
  renderClubButton();
  pollGroupMarks();
  if (!state.club.newsTimer) {
    state.club.newsTimer = setInterval(pollClubNews, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollClubNews(); });
  }
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
  const rules = `<div class="gate-rules"><strong>Правила клуба</strong><ol>${CLUB_RULES.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol></div>`;
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
        <label>Ключ владельца<input id="gateOwnerKey" type="password" autocomplete="current-password" required></label>
        <label>Ваше имя в клубе<input id="gateOwnerName" maxlength="24" autocomplete="given-name" placeholder="Как вас называть"></label>
        <button type="submit" class="gate-submit">Войти как владелец</button>
        <small id="gateError" role="alert"></small>
      </form>
      <button type="button" class="gate-link" id="gateBack">← У меня приглашение</button>`
    : `<form id="gateJoinForm" class="gate-form"${installFirst ? ' hidden' : ''}>
        <label>Код приглашения<input id="gateCode" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX" value="${escapeHtml(code)}" required></label>
        <label>Как вас называть<input id="gateName" maxlength="24" autocomplete="given-name" placeholder="Например, Саша" required><small>Имя видят только участники — рядом с вашими отметками.</small></label>
        ${rules}
        <label class="gate-accept"><input type="checkbox" id="gateAccept"><span>Принимаю правила и отмечаю только то, что вижу сам</span></label>
        <button type="submit" class="gate-submit">Вступить в клуб</button>
        <small id="gateError" role="alert"></small>
      </form>
      ${installFirst ? rules : ''}
      <button type="button" class="gate-link" id="gateOwner">Я владелец клуба</button>`;
  gate.innerHTML = `<div class="gate-card">
      <span class="brand-mark" aria-hidden="true"><span></span></span>
      <p class="gate-kicker">Закрытый клуб</p>
      <h1>Топливо СПб — для своих</h1>
      <p class="gate-lead">Вход только по приглашению участника. Отметки здесь ставят люди, за которых кто-то поручился, — поэтому им можно верить.</p>
      ${alertBox}${install}${form}
    </div>`;
  gate.hidden = false;
  gate.scrollTop = 0;
  document.body.classList.add('club-locked');
  $('#gateCopyCode')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try { await navigator.clipboard.writeText(code); button.textContent = 'Скопировано'; } catch { button.textContent = code; }
  });
  $('#gateOwner')?.addEventListener('click', () => showClubGate({ notice, banned, mode: 'owner' }));
  $('#gateBack')?.addEventListener('click', () => showClubGate({ notice, banned, mode: 'join' }));
  $('#gateJoinForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('#gateAccept').checked) {
      $('#gateError').textContent = CLUB_ERRORS.rules_not_accepted;
      return;
    }
    enterClub('/club/join', { code: $('#gateCode').value, name: $('#gateName').value, accept: true }, event.target.querySelector('.gate-submit'));
  });
  $('#gateOwnerForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    enterClub('/club/owner', { key: $('#gateOwnerKey').value, name: $('#gateOwnerName').value }, event.target.querySelector('.gate-submit'));
  });
}

async function enterClub(path, body, button) {
  const error = $('#gateError');
  error.textContent = '';
  button.disabled = true;
  try {
    const result = await clubCall(path, { method: 'POST', body });
    if (!result.ok || !result.data?.token) {
      error.textContent = clubMessage(result);
      return;
    }
    try {
      localStorage.setItem(CLUB_TOKEN_KEY, result.data.token);
      localStorage.setItem(CLUB_MEMBER_KEY, JSON.stringify(result.data.member));
    } catch {
      error.textContent = 'Телефон не даёт сохранить вход. Если открыт частный режим Safari, откройте приложение обычным способом.';
      return;
    }
    state.club.member = result.data.member;
    if (location.search.includes('invite=')) history.replaceState(null, '', location.pathname);
    hideClubGate();
    renderClubButton();
    pollGroupMarks();
    showToast(`Добро пожаловать в клуб, ${result.data.member.name}`, 'Отмечайте только то, что видите сами. Пригласить своих — кнопка «Клуб» вверху.');
  } catch {
    error.textContent = 'Нет связи с клубом. Проверьте интернет и попробуйте ещё раз.';
  } finally {
    button.disabled = false;
  }
}

function renderClubButton() {
  const button = $('#clubButton');
  if (!button) return;
  button.hidden = !(state.club.enabled && state.club.member);
  const profile = state.club.profile;
  const icon = button.querySelector('[aria-hidden]');
  const label = button.querySelector('.club-label');
  if (icon) icon.textContent = profile?.level?.icon || '👥';
  if (label) label.textContent = profile ? ` ${profile.liters} л` : ' Клуб';
  button.setAttribute('aria-label', profile ? `Клуб: ${profile.level.title}, ${profile.liters} литров` : 'Клуб');
}

function formatDay(ms) {
  return ms ? new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';
}

function inviteText(code) {
  const link = `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
  return `Приглашаю в закрытый клуб «Топливо СПб»: где сейчас есть бензин — по отметкам своих.\n\n`
    + `1. Откройте на iPhone в Safari: ${link}\n`
    + `2. «Поделиться» → «На экран „Домой“».\n`
    + `3. Откройте приложение с иконки и введите код: ${code}\n\n`
    + 'Код одноразовый и действует 7 дней. Пожалуйста, не пересылайте его дальше.';
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
      ? `<span><button type="button" class="club-small" data-invite-share="${escapeHtml(invite.code)}">Отправить</button><button type="button" class="club-small" data-invite-revoke="${escapeHtml(invite.code)}">Отозвать</button></span>` : ''}</div>`;
  }).join('') : '<p class="drawer-address">Вы ещё никого не приглашали.</p>';
  $('#drawerContent').innerHTML = `
    <h2>Клуб «Топливо СПб»</h2>
    <p class="drawer-address">Вы в клубе как <b>${escapeHtml(member.name)}</b>${owner ? ' · владелец' : ''}.</p>
    ${profileCard(profile)}
    <div id="clubBoard"></div>
    <div class="drawer-status" style="--status-color:#0d5a43">
      <strong>Пригласить человека</strong>
      <p>Только того, за кого ручаетесь: за ложные отметки исключают, а пригласивший отвечает за приглашённого. Код одноразовый и действует 7 дней.${owner ? '' : ` Осталось приглашений: <b>${Number(left) || 0}</b>.`}</p>
      <button type="button" class="list-more" id="clubInvite"${!owner && !left ? ' disabled' : ''}>Создать приглашение</button>
      <div id="clubInviteResult"></div>
    </div>
    <h3 class="section-title">Мои приглашения</h3>
    <div class="source-list">${inviteRows}</div>
    ${owner ? '<h3 class="section-title">Участники</h3><div id="clubMembers" class="source-list"><div class="loading-state">Загружаем участников…</div></div>' : ''}
    <h3 class="section-title">Правила клуба</h3>
    <ol class="club-rules">${CLUB_RULES.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol>
    <button type="button" class="list-more club-leave" id="clubLeave">Выйти из клуба на этом телефоне</button>`;
  $('#clubInvite')?.addEventListener('click', createInvite);
  bindInviteButtons($('#drawerContent'));
  loadLeaderboard();
  $('#clubLeave').addEventListener('click', () => {
    if (!confirm('Выйти из клуба на этом телефоне? Чтобы вернуться, понадобится новое приглашение.')) return;
    forgetClub();
    closeDrawer();
    showClubGate();
  });
  if (owner) loadClubMembers();
}

function bindInviteButtons(root) {
  root.querySelectorAll('[data-invite-share]').forEach((button) => {
    button.addEventListener('click', () => shareInvite(button.dataset.inviteShare, button));
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
      <button type="button" class="gate-submit" data-invite-share="${escapeHtml(code)}">Отправить приглашение</button></div>`;
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
      `${item.level_icon || '🔰'} ${item.liters || 0} л`,
      `отметок за 3 ч: ${item.marks_3h}`,
      item.invited ? `привёл(а): ${item.invited}` : null,
    ].filter(Boolean).join(' · ');
    const disputed = item.disputed_30d
      ? `<span class="club-flag">С отметками не согласились ${item.disputed_30d} ${plural(item.disputed_30d, 'раз', 'раза', 'раз')} (${item.disputed_by_people_30d} ${plural(item.disputed_by_people_30d, 'человек', 'человека', 'человек')}) за 30 дней</span>`
      : '';
    const action = item.role === 'owner' ? '' : item.banned
      ? `<button type="button" class="club-small" data-unban="${escapeHtml(item.id)}">Вернуть в клуб</button>`
      : `<button type="button" class="club-small" data-award="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">🏅 Наградить</button><button type="button" class="club-small danger" data-ban="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Исключить</button>`;
    return `<div class="source-row club-member${item.banned ? ' banned' : ''}"><strong>${escapeHtml(item.name)}${item.banned ? ' — исключён(а)' : ''}</strong><small>${facts}</small>${disputed}${item.banned && item.banned_reason ? `<small>Причина: ${escapeHtml(item.banned_reason)}</small>` : ''}${action}</div>`;
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
      showToast(`🏅 ${button.dataset.name} получает благодарность клуба`, `${text} · +10 л`);
      loadClubMembers();
      loadLeaderboard();
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
const QUEUE_CHOICES = [[0, 'нет очереди'], [3, 'до 5 машин'], [12, '5–20 машин'], [30, 'больше 20']];

function queueWords(cars) {
  if (cars == null || cars === '') return null;
  const n = Number(cars);
  if (n === 0) return 'нет';
  if (n <= 5) return 'до 5 машин';
  if (n <= 20) return '5–20 машин';
  return 'больше 20 машин';
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

function bindComposer(root) {
  const box = root.querySelector('.mark-composer');
  if (!box) return;
  const chosen = {};
  let queue = null;
  const send = box.querySelector('.compose-send');
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
    grades.forEach((grade, index) => saveMark(stationId, grade, chosen[grade], queue, {
      render: false, notify: index === 0, summary: index === 0 ? summary + queueText : '',
    }));
    renderStations();
    renderHerePanel();
    renderGroupFeed();
    box.innerHTML = `<span class="mark-sent">✔ Отправлено своим: ${escapeHtml(summary)}${escapeHtml(queueText)}. У всех это уже наверху, в «Свои сообщают».</span>`;
  });
}

function bindMarkButtons(root) {
  root.querySelectorAll('[data-mark-station]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const seen = button.dataset.markSeen === '1';
      const row = button.closest('.mark-row');
      if (row) row.innerHTML = `<span class="mark-sent">✔ Отправлено своим: ${escapeHtml(GRADE_LABELS[state.grade])} ${seen ? 'есть' : 'нет'}. Они увидят это сразу.</span>`;
      saveMark(button.dataset.markStation, state.grade, seen);
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
    .replace(/^(?:(?:Россия|г\.?\s*Санкт-Петербург|Санкт-Петербург|Ленинградская область|Ленинградская обл\.?),\s*)+/i, '')
    .replace(/^[\s,]+/, '');
}

function formatDistance(km) {
  if (km == null) return '';
  return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`;
}

function renderHerePanel() {
  const panel = $('#herePanel');
  if (!panel) return;
  if (!state.location || !state.stations.length) {
    panel.hidden = true;
    return;
  }
  const nearest = state.stations
    .filter((item) => item.distance_km != null)
    .sort((a, b) => a.distance_km - b.distance_km)[0];
  if (!nearest || nearest.distance_km * 1000 > AT_STATION_METRES) {
    panel.hidden = true;
    return;
  }
  const brief = (state.gradesBrief || {})[nearest.id] || {};
  const rows = Object.keys(GRADE_LABELS).map((grade) => {
    const status = grade === state.grade ? nearest.grade.status : (brief[grade]?.s || 'NO_FRESH_DATA');
    const mark = GRADE_MARK[status] || GRADE_MARK.NO_FRESH_DATA;
    return `<div class="here-grade ${mark.tone}">
      <b>${escapeHtml(GRADE_LABELS[grade])}</b>
      <span>${mark.sign} ${escapeHtml(STATUS[status].short)}</span>
    </div>`;
  }).join('');
  const grade = nearest.grade;
  const mine = markLine(nearest.id, state.grade);
  panel.hidden = false;
  panel.innerHTML = `
    <span class="here-kicker">Вы сейчас на этой АЗС · ${escapeHtml(formatDistance(nearest.distance_km))}</span>
    <strong>${escapeHtml(nearest.network)}</strong>
    <span class="here-address">${escapeHtml(nearest.address)}</span>
    <div class="here-grades">${rows}</div>
    ${eyewitnessLine(grade, nearest.id) ? `<p class="here-mine group ${eyewitnessLine(grade, nearest.id).tone}">${escapeHtml(eyewitnessLine(grade, nearest.id).text)}</p>` : ''}
    ${mine ? `<p class="here-mine">✔ ${escapeHtml(mine)}</p>` : ''}
    <p class="here-note">Сверьте с колонками. Мы утверждаем это по ${(grade.votes || []).length} ${plural((grade.votes || []).length, 'источнику', 'источникам', 'источникам')}, самый свежий сигнал — ${escapeHtml(grade.undated_only ? 'без отметки времени' : formatAge(grade.age_seconds))}.</p>
    ${markButtons(nearest.id)}
    <div class="here-actions">
      <button type="button" id="hereDetails">Почему такой ответ</button>
      <a href="https://t.me/s/benzinspb78" target="_blank" rel="noopener noreferrer">Сообщить всем в чат ↗</a>
    </div>`;
  $('#hereDetails').addEventListener('click', () => openStation(nearest.id));
  bindMarkButtons(panel);
}

function renderStations({ append = false } = {}) {
  const list = $('#stationList');
  renderHerePanel();
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
    node.querySelector('.network').textContent = station.network;
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
    if (state.location && station.distance_km != null && station.distance_km * 1000 <= NEARBY_REPORT_METRES) {
      const row = document.createElement('div');
      row.innerHTML = markButtons(station.id, { compact: true });
      node.querySelector('.card-main').appendChild(row.firstElementChild);
      bindMarkButtons(node);
    } else {
      const link = document.createElement('span');
      link.className = 'mark-link';
      link.textContent = 'Видите эту АЗС? Отметить для своих →';
      node.querySelector('.card-main').appendChild(link);
    }
    const second = yandexLine(grade);
    if (second && second.agrees === false) {
      const note = document.createElement('span');
      note.className = 'yandex-flag';
      note.textContent = `⚠ ${second.text}`;
      node.querySelector('.card-main').insertBefore(note, node.querySelector('.meta-line'));
    }
    const distance = node.querySelector('.distance');
    distance.textContent = formatDistance(station.distance_km);
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

function shortNetwork(name) {
  const head = String(name || '').split(',')[0].replace(/\s*АЗС\s*$/i, '').trim().slice(0, 16);
  return !head || /^(other|прочие|независимая)/i.test(head) ? 'АЗС' : head;
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
    const timelinePanel = ['NO_HISTORY', 'OUTDATED_HISTORY'].includes(timeline.state) ? `<div class="timeline-panel neutral"><strong>${escapeHtml(timeline.label)}</strong><p>${escapeHtml(timeline.description)}</p></div>` : `<div class="timeline-panel ${timeline.recent ? 'fresh' : ''}"><span class="timeline-kicker">История статуса</span><strong>${escapeHtml(timeline.label)}</strong><p>${escapeHtml(timeline.description)}</p><dl><div><dt>Текущий статус длится</dt><dd>${escapeHtml(formatDuration(timeline.duration_seconds))}</dd></div><div><dt>Проверок</dt><dd>${Number(timeline.confirmations || 1)}</dd></div>${transition ? `<div><dt>Уверенность перехода</dt><dd>${escapeHtml(confidenceLabels[transition.confidence] || transition.confidence)}</dd></div>` : ''}</dl></div>`;
    const evidence = selected.evidence.length ? selected.evidence.map((row) => {
      const rowStatus = row.fresh ? (row.availability === 'AVAILABLE' || row.availability === 'LIKELY' ? '#158257' : row.availability === 'NOT_AVAILABLE' || row.availability === 'LIKELY_NOT' ? '#b8333a' : '#d58a13') : '#8a9691';
      const extras = [row.limit_liters != null ? `лимит ${row.limit_liters} л` : null, formatQueue(row.queue) ? `очередь: ${formatQueue(row.queue)}` : null].filter(Boolean).join(' · ');
      const note = localizeNote(row.note);
      return `<div class="evidence-row" style="--evidence-color:${rowStatus}"><div class="evidence-head"><strong>${escapeHtml(AVAILABILITY_LABELS[row.availability] || row.availability)}</strong><span>${row.fresh ? formatAge(row.age_seconds) : 'устарело'}</span></div><div class="evidence-meta">${escapeHtml(row.source || 'источник не указан')} · ${escapeHtml(KIND_LABELS[row.kind] || row.kind)}${extras ? `<br>${escapeHtml(extras)}` : ''}<br>provenance: ${escapeHtml(row.effective_provenance)}${note ? `<br>${escapeHtml(note)}` : ''}</div></div>`;
    }).join('') : '<div class="empty-state">Для этой марки нет даже устаревших station-level свидетельств.</div>';
    $('#drawerContent').innerHTML = `
      <h2>${escapeHtml(station.network || 'АЗС')}</h2>
      <p class="drawer-address">${escapeHtml(station.address || 'Адрес не указан')}</p>
      <div class="drawer-actions"><a id="routeLink" href="${routeUrl}" target="_blank" rel="noopener noreferrer">Маршрут в Яндекс Картах ↗</a><a id="trafficLink" href="${trafficUrl}" target="_blank" rel="noopener noreferrer">Пробки у АЗС ↗</a><button id="copyCoords" type="button">Скопировать координаты</button></div>
      <div class="here-panel drawer-mark">
        <span class="here-kicker">Для своих</span>
        <strong>Видите эту АЗС своими глазами?</strong>
        ${eyewitnessLine(selected, station.id) ? `<p class="here-mine group ${eyewitnessLine(selected, station.id).tone}">${escapeHtml(eyewitnessLine(selected, station.id).text)}</p>` : ''}
        ${markLine(station.id, state.grade) ? `<p class="here-mine">✔ ${escapeHtml(markLine(station.id, state.grade))}</p>` : ''}
        ${thanksButton(station.id)}
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

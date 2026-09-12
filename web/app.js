const STATUS = {
  CAN_REFUEL: { short: 'Можно заправиться', color: '#158257' },
  LIKELY_AVAILABLE: { short: 'Скорее есть', color: '#77a827' },
  CONFLICT: { short: 'Данные расходятся', color: '#7856c7' },
  LIMITED: { short: 'Есть ограничения', color: '#d58a13' },
  LIKELY_NOT: { short: 'Скорее нет', color: '#d5653f' },
  CONFIRMED_NO: { short: 'Подтверждено нет', color: '#b8333a' },
  NO_FRESH_DATA: { short: 'Нет свежих данных', color: '#8a9691' },
};
const GRADE_LABELS = { AI92: 'АИ-92', AI95: 'АИ-95', AI98: 'АИ-98', AI100: 'АИ-100', DT: 'ДТ', LPG: 'Газ' };
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
  status: null, timeline: null, location: null, bbox: null, meta: null, stations: [], visible: 0, map: null,
  markers: null, request: 0,
  staticMode: document.querySelector('meta[name="spbfi-static-site"]')?.content === 'true',
  gradesBrief: {},
  searchScope: null, radiusKm: 5, searchLabel: null,
};
const staticCache = new Map();
const STATUS_PRIORITY = { CAN_REFUEL: 0, LIMITED: 1, LIKELY_AVAILABLE: 2, CONFLICT: 3, LIKELY_NOT: 4, CONFIRMED_NO: 5, NO_FRESH_DATA: 6 };
const SERVES_NOW = { CAN_REFUEL: 0, LIMITED: 0, LIKELY_AVAILABLE: 0, CONFLICT: 1, NO_FRESH_DATA: 2, LIKELY_NOT: 3, CONFIRMED_NO: 3 };
let installPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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
  openDrawer(`<h2>Состояние источников</h2>
    <p class="drawer-address">На последнем обновлении ответили ${health.ok} из ${health.total} каналов. Когда источник молчит, его голос просто не учитывается — ответы строятся на остальных, а возраст данных остаётся виден на карточке.</p>
    ${rows ? `<h3 class="section-title">Не ответили</h3><div class="source-list">${rows}</div>` : '<div class="drawer-status" style="--status-color:#158257"><strong>Все источники ответили</strong><p>На последнем обновлении ни один канал не выпал.</p></div>'}`);
}

function bindControls() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('#installButton').hidden = false;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('#installButton').hidden = true; });
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
    loadStations();
  });
  $('.location-row .segmented').addEventListener('click', (event) => {
    const button = event.target.closest('[data-area]');
    if (!button) return;
    state.area = button.dataset.area;
    $$('[data-area]').forEach((item) => item.classList.toggle('active', item === button));
    loadStations();
  });
  $('.view-switch').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    $$('[data-view]').forEach((item) => item.classList.toggle('active', item === button));
    $('#contentGrid').classList.toggle('map-mode', state.view === 'map');
    if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
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
  $('#sortSelect').addEventListener('change', (event) => { state.sort = event.target.value; loadStations(); });
  $('#locateButton').addEventListener('click', locate);
  $('#mapAreaButton').addEventListener('click', () => {
    const bounds = state.map.getBounds();
    state.bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    state.location = null;
    state.search = '';
    state.searchScope = 'map';
    state.searchLabel = 'Показываем АЗС в выбранной области карты.';
    $('#searchInput').value = '';
    renderSearchContext();
    $('#mapAreaButton').style.display = 'none';
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
    context.innerHTML = `<strong>Рядом с вашей позицией</strong> · радиус ${state.radiusKm} км по прямой <button type="button" data-clear-scope>Сбросить</button>`;
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
  state.location = null;
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
  if (query.length < 3) return alert('Введите адрес или название места: например, «ул. Уточкина 3» или «МЦ на Уточкина».');
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
    await loadStations();
  } catch (error) {
    $('#searchContext').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '⌖ Найти рядом';
  }
}

function locate() {
  if (!navigator.geolocation) return alert('Геолокация не поддерживается этим браузером.');
  const button = $('#locateButton');
  button.textContent = 'Определяем…';
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    state.location = { lat: coords.latitude, lon: coords.longitude };
    state.bbox = null;
    state.search = '';
    state.searchScope = 'device';
    state.searchLabel = null;
    state.radiusKm = 5;
    $('#searchInput').value = '';
    state.sort = 'nearest_available';
    $('#sortSelect').value = 'nearest_available';
    button.innerHTML = '<span aria-hidden="true">●</span> Моя позиция';
    if (state.map) state.map.setView([coords.latitude, coords.longitude], 13);
    renderSearchContext();
    loadStationsWideningRadius();
  }, () => {
    button.innerHTML = '<span aria-hidden="true">⌖</span> Рядом со мной';
    alert('Не удалось получить координаты. Разрешите геолокацию в браузере.');
  }, { enableHighAccuracy: true, timeout: 10000 });
}

async function loadStations() {
  const requestId = ++state.request;
  $('#stationList').innerHTML = '<div class="loading-state">Собираем доказательства по АЗС…</div>';
  const params = new URLSearchParams({ grade: state.grade, area: state.area, sort: state.sort, limit: '500' });
  if (state.search.trim()) params.set('q', state.search.trim());
  if (state.status) params.set('status', state.status);
  if (state.timeline) params.set('timeline', state.timeline);
  if (state.location) { params.set('lat', state.location.lat); params.set('lon', state.location.lon); if (state.searchScope) params.set('radius_km', state.radiusKm); }
  if (state.bbox) params.set('bbox', state.bbox.join(','));
  try {
    const data = await api(`/api/stations?${params}`);
    if (requestId !== state.request) return;
    state.stations = data.stations;
    $('#resultCount').textContent = data.total.toLocaleString('ru-RU');
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
      loadStations();
      return;
    }
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.status = state.status === button.dataset.status ? null : button.dataset.status;
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
    ? '<p class="yandex-stale">Их сигнал старше нашего окна свежести, поэтому в голосовании он не участвовал.</p>'
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
    return `<div class="vote-row">
      <span class="vote-side ${positive ? 'yes' : 'no'}">${positive ? 'за' : 'против'}</span>
      <span class="vote-name">${escapeHtml(vote.source || '')}<small>${escapeHtml(KIND_LABELS[vote.kind] || vote.kind || '')} · ${escapeHtml(formatAge(vote.age_seconds))}</small></span>
      <span class="vote-bar"><span style="width:${Math.max(6, share)}%"></span></span>
    </div>`;
  }).join('');
  return `<div class="vote-panel">
    <div class="trust-head"><span class="trust-kicker">Как считался ответ</span><strong>${chance}% за то, что топливо есть</strong></div>
    <p>Голоса всех свежих источников, взвешенные по типу сигнала, его возрасту и числу подтверждений. Копии одного и того же upstream считаются один раз.</p>
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

function renderStations({ append = false } = {}) {
  const list = $('#stationList');
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
    node.querySelector('.address').textContent = station.address;
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
    const second = yandexLine(grade);
    if (second && second.agrees === false) {
      const note = document.createElement('span');
      note.className = 'yandex-flag';
      note.textContent = `⚠ ${second.text}`;
      node.querySelector('.card-main').insertBefore(note, node.querySelector('.meta-line'));
    }
    const distance = node.querySelector('.distance');
    distance.textContent = station.distance_km != null ? `${station.distance_km.toLocaleString('ru-RU')} км` : '';
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
  state.map.on('moveend', () => { $('#mapAreaButton').style.display = 'block'; });
}

function renderMarkers() {
  if (!state.map || !state.markers) return;
  state.markers.clearLayers();
  state.stations.forEach((station) => {
    const status = STATUS[station.grade.status];
    const icon = L.divIcon({ className: '', html: `<div class="fuel-marker" style="--marker:${status.color}"></div>`, iconSize: [20, 20], iconAnchor: [10, 20] });
    const marker = L.marker([station.location.lat, station.location.lon], { icon });
    marker.bindPopup(`<div class="popup-title">${escapeHtml(station.network)}</div><div>${escapeHtml(station.address)}</div><div class="popup-status" style="--popup-color:${status.color}">${escapeHtml(station.grade.label)}</div><button class="popup-open" onclick="window.openFuelStation('${station.id}')">Почему?</button>`);
    marker.addTo(state.markers);
  });
}

window.openFuelStation = openStation;
async function openStation(id) {
  openDrawer('<div class="loading-state">Загружаем доказательства…</div>');
  try {
    const station = await api(`/api/stations/${encodeURIComponent(id)}`);
    if (state.staticMode) {
      const elapsed = staticElapsedSeconds();
      Object.values(station.grades).forEach((value) => expireGrade(value, elapsed));
    }
    const selected = station.grades[state.grade];
    const status = STATUS[selected.status];
    const lat = Number(station.location.lat);
    const lon = Number(station.location.lon);
    const routeUrl = `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`;
    const gradeCells = Object.entries(station.grades).map(([grade, value]) => `<div class="grade-cell" style="--cell-color:${STATUS[value.status].color}"><b>${GRADE_LABELS[grade]}</b><small>${STATUS[value.status].short}</small></div>`).join('');
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
      <div class="drawer-actions"><a href="${routeUrl}" target="_blank" rel="noopener noreferrer">Маршрут в Яндекс Картах ↗</a><button id="copyCoords" type="button">Скопировать координаты</button></div>
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
  openDrawer(`<h2>Что здесь иначе</h2><p class="drawer-address">Приложение не выдаёт отсутствие данных за отсутствие топлива и запоминает изменения по каждой марке.</p><div class="drawer-status" style="--status-color:#0d5a43"><strong>История «не было → появилось»</strong><p>После каждого живого обновления сохраняется статус конкретной АЗС и марки. Переход показывается отдельно от обычного давнего наличия. «Возможное пополнение» — только осторожная интерпретация подтверждённого перехода, а не заявление о бензовозе или количестве литров.</p></div><div class="drawer-status about-secondary" style="--status-color:#7856c7"><strong>Evidence-first</strong><p>Учитываются возраст, тип сигнала, независимость upstream, очередь, лимит и конфликт источников.</p></div><h3 class="section-title">Семь честных состояний</h3><div class="source-list">${Object.values(STATUS).map((item) => `<div class="source-row"><strong style="color:${item.color}">${item.short}</strong></div>`).join('')}</div>`);
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

async function pollForNewSnapshot() {
  try {
    staticCache.delete('static-data/meta.json');
    const meta = await api('/api/meta');
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollForNewSnapshot();
});

if ('serviceWorker' in navigator) {
  // The worker calls skipWaiting, so a new one takes control immediately — but
  // the page keeps running the code it already parsed until it is reloaded.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((registration) => {
      setInterval(() => registration.update().catch(() => {}), 10 * 60 * 1000);
    }).catch(() => {});
  });
}

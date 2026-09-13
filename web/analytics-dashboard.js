(function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  let days = 7;

  const labels = {
    spb_north: 'Север Петербурга', spb_south: 'Юг Петербурга', spb_west: 'Запад Петербурга',
    spb_east: 'Восток Петербурга', spb_centre: 'Центр Петербурга', lo_other: 'Ленобласть', unknown: 'Без зоны',
    AI92: 'АИ-92', AI95: 'АИ-95', AI98: 'АИ-98', AI100: 'АИ-100', DT: 'ДТ',
    app_open: 'Открытие приложения', search_complete: 'Завершённый поиск', station_open: 'Открыта АЗС',
    route_open: 'Построен маршрут', report_sent: 'Отметка водителя', report_outcome: 'Проверка прогноза',
    '0_15m': 'до 15 мин', '15_45m': '15–45 мин', '45m_2h': '45 мин–2 ч', '2_6h': '2–6 ч', '6h_plus': 'старше 6 ч',
    high: 'Высокое', moderate: 'Среднее', low: 'Низкое',
  };
  const label = (key) => labels[key] || String(key).replaceAll('_', ' ');

  function key() { return sessionStorage.getItem('spbfi-analytics-key') || ''; }
  function text(node, value) { node.textContent = value == null ? '—' : String(value); }
  function percent(value) { return value == null ? 'пока нет фактов' : `${Number(value).toLocaleString('ru-RU')}%`; }

  function bars(selector, rows, formatter = (value) => Number(value).toLocaleString('ru-RU')) {
    const root = $(selector); root.replaceChildren();
    if (!rows?.length) { root.textContent = 'Пока недостаточно данных.'; return; }
    const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
    for (const row of rows.slice(0, 12)) {
      const item = document.createElement('div'); item.className = 'bar-row';
      const name = document.createElement('span'); name.textContent = label(row.key || row.day);
      const track = document.createElement('i'); const fill = document.createElement('b');
      fill.style.width = `${Math.max(2, 100 * Number(row.count || 0) / max)}%`; track.append(fill);
      const value = document.createElement('strong'); value.textContent = formatter(row.count);
      item.append(name, track, value); root.append(item);
    }
  }

  function calibration(selector, rows) {
    const root = $(selector); root.replaceChildren();
    if (!rows?.length) { root.textContent = 'Нужны отметки водителей у колонок.'; return; }
    for (const row of rows) {
      const line = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = label(row.key);
      const metrics = document.createElement('span');
      metrics.textContent = `${percent(row.accuracy_percent)} · Brier ${row.brier_score ?? '—'} · ${row.total} проверок`;
      line.append(name, metrics); root.append(line);
    }
  }

  function kpi(title, value, note) {
    const card = document.createElement('article');
    const small = document.createElement('small'); small.textContent = title;
    const strong = document.createElement('strong'); strong.textContent = value;
    const p = document.createElement('p'); p.textContent = note;
    card.append(small, strong, p); return card;
  }

  function render(data) {
    $('#login').hidden = true; $('#dashboard').hidden = false;
    text($('#updated'), `Обновлено ${new Date(data.generated_at).toLocaleString('ru-RU')} · период ${data.days} дней`);
    const t = data.totals;
    $('#kpis').replaceChildren(
      kpi('Активность', t.daily_active_sum.toLocaleString('ru-RU'), 'сумма уникальных устройств за каждый день'),
      kpi('Поиски рядом', t.searches.toLocaleString('ru-RU'), `${percent(t.search_success_percent)} дали результат`),
      kpi('Маршруты', t.routes.toLocaleString('ru-RU'), `${percent(t.route_conversion_percent)} от открытий АЗС`),
      kpi('Проверки на месте', t.on_site_checks.toLocaleString('ru-RU'), `${percent(t.accuracy_percent)} прогнозов совпали`),
      kpi('Brier score', t.brier_score ?? '—', '0 — идеально, меньше лучше'),
      kpi('Нулевые поиски', t.zero_searches.toLocaleString('ru-RU'), `${t.widened_searches} раз радиус пришлось расширить`),
    );
    bars('#trend', data.trend.map((row) => ({ key: row.day.slice(5), count: row.users })));
    const eventMap = Object.fromEntries(data.events.map((row) => [row.key, row.count]));
    bars('#funnel', ['app_open', 'search_complete', 'station_open', 'route_open', 'report_sent'].map((key) => ({ key, count: eventMap[key] || 0 })));
    bars('#zones', data.zones); bars('#grades', data.grades); bars('#events', data.events);
    calibration('#ageCalibration', data.calibration.by_age);
    calibration('#trustCalibration', data.calibration.by_trust);
    calibration('#statusCalibration', data.calibration.by_status);
    calibration('#sourceCalibration', data.calibration.by_source);
    $('#searchHealth').textContent = `Успешных поисков: ${percent(t.search_success_percent)}. Без результата: ${t.zero_searches}. С расширением радиуса свыше 5 км: ${t.widened_searches}.`;
  }

  async function load() {
    $('#loginError').textContent = 'Загружаем…';
    const endpoint = String(window.SPBFI_ANALYTICS_ENDPOINT || '').replace(/\/$/, '');
    if (!endpoint) { $('#loginError').textContent = 'Endpoint аналитики не настроен.'; return; }
    try {
      const response = await fetch(`${endpoint}/analytics/dashboard?days=${days}`, { headers: { 'X-Analytics-Key': key() }, cache: 'no-store', credentials: 'omit' });
      if (response.status === 403) throw new Error('Неверный ключ.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      $('#loginError').textContent = ''; render(data);
    } catch (error) {
      $('#dashboard').hidden = true; $('#login').hidden = false; $('#loginError').textContent = error.message;
    }
  }

  $('#keyForm').addEventListener('submit', (event) => {
    event.preventDefault(); sessionStorage.setItem('spbfi-analytics-key', $('#adminKey').value); load();
  });
  document.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
    days = Number(button.dataset.days); document.querySelectorAll('[data-days]').forEach((item) => item.classList.toggle('active', item === button)); load();
  }));
  if (key()) load();
})();

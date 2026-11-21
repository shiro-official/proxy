import { audience, bindAudience, mountAudience } from './audience.js';
import { checks, mountChecks } from './checks.js';

const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01M15 7.5h3m-3 9h3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18m-9-9c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  activity: '<path d="M2 12h4l3-8 5 16 3-8h5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m5 9v-2a4 4 0 0 0-3-4"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6m3-4v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  external: '<path d="M13 5h6v6m0-6-9 9m8-1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  network: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5m-7 5v-3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/>',
  transfer: '<path d="M7 20V4m-4 4 4-4 4 4m6-4v16m-4-4 4 4 4-4"/>',
  shield: '<path d="M12 22s7-3.5 7-10V5l-7-3-7 3v7c0 6.5 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14l5-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const sections = {
  overview: ['Обзор', 'overview'],
  ingress: ['Входы', 'server'],
  exits: ['EU-ноды', 'globe'],
  checks: ['Проверки', 'activity'],
  audience: ['Аудитория', 'people'],
  journal: ['Журнал', 'history'],
};
const domain = 'tg.ebunny.cloud';
const demo = document.body.dataset.mode !== 'live';
const entranceIp = () => demo ? '192.0.2.10' : escapeText(telemetry?.ingressIp ?? '—');
const exitIp = () => demo ? '198.51.100.10' : escapeText(telemetry?.exitIp ?? '—');
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const sampleTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
let telemetry;
let telemetryError = false;
let pollTelemetry;
let reportRequest;
const storageKey = 'ebunny-panel-v1';
function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (stored && Array.isArray(stored.drafts) && Array.isArray(stored.events)) return stored;
  } catch {
    // The remainder of the interface works even when browser storage is disabled.
  }
  return { drafts: [], events: [] };
}
let { drafts, events } = loadState();
let period = '24ч';
let toastTimer;
const main = document.querySelector('main');
const navigation = document.querySelector('#navigation');
const editor = document.querySelector('#editor');
const timestamp = new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' });
const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const status = (text, tone = 'lime') => `<span class="status ${tone}"><i></i>${text}</span>`;
const emptyState = (image, title, detail) => `<div class="empty"><span class="icon-box">${icon(image, 21)}</span><h3>${title}</h3><p>${detail}</p></div>`;

const samples = {
  '24ч': {
    labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '23:59'],
    values: [21, 25, 22, 33, 29, 23, 29, 41, 34, 50, 55, 46, 66, 59, 74, 51, 54, 64, 57, 83, 73, 88, 76, 64, 81, 86, 73, 88, 80, 62, 69, 76, 87, 79, 90, 84, 93],
  },
  '7д': {
    labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    values: [18, 24, 21, 38, 27, 34, 43, 40, 56, 49, 58, 53, 46, 64, 72, 58, 77, 68, 74, 85, 79, 89],
  },
  '30д': {
    labels: ['1', '5', '10', '15', '20', '25', '30'],
    values: [15, 20, 24, 18, 26, 24, 32, 38, 31, 43, 39, 49, 43, 59, 55, 58, 64, 79, 65, 72, 80, 76, 82, 90],
  },
};

const periods = { '24ч': '24h', '7д': '7d', '30д': '30d' };

function chart() {
  const width = 640;
  const height = 158;
  const live = telemetry?.chart;
  const points = demo
    ? samples[period].values.map((value, index, values) => ({ value: Math.round(value * 1.5), at: index / (values.length - 1), bucket: index }))
    : (live?.points ?? []).map((point) => ({ ...point, at: (point.at - live.from) / (live.to - live.from) }));
  const max = points.reduce((highest, point) => Math.max(highest, point.value), 0);
  const step = demo ? 50 : Math.max(1, Math.ceil(max / 3));
  const scale = [3, 2, 1, 0].map((item) => item * step);
  const labels = demo ? samples[period].labels : live?.points.length ? chartTimes(live) : [];
  const segments = [];
  let previous = -2;
  for (const point of points) {
    const x = 4 + point.at * (width - 8);
    const y = 4 + (1 - point.value / scale[0]) * (height - 8);
    if (point.bucket !== previous + 1) segments.push([]);
    segments.at(-1).push([x.toFixed(1), y.toFixed(1)]);
    previous = point.bucket;
  }
  const plotted = segments.map((segment) => {
    const [firstX, firstY] = segment[0];
    if (segment.length === 1) return `<ellipse cx="${firstX}" cy="${firstY}" rx="3" ry="3" fill="#c7f970"/>`;
    const line = segment.map(([x, y]) => `${x},${y}`).join(' ');
    return `<polygon points="${firstX},${height - 4} ${line} ${segment.at(-1)[0]},${height - 4}" fill="url(#chart-fill)"/>
      <polyline points="${line}" fill="none" stroke="#c7f970" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<section class="panel chart-panel" aria-labelledby="chart-title">
    <div class="panel-top"><div><h2 id="chart-title">Нагрузка прокси</h2><p>${demo ? 'Активные соединения' : 'Пиковое число одновременных соединений'}</p></div>
    <div class="segments" role="group" aria-label="Период графика">${Object.keys(periods).map((item) => `<button type="button" data-period="${item}" aria-pressed="${item === period}">${item}</button>`).join('')}</div></div>
    ${points.length ? `<div class="chart"><div class="chart-scale" aria-hidden="true">${scale.map((value) => `<span>${value}</span>`).join('')}</div>
    <div class="chart-body"><svg class="chart-plot" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${demo ? 'Демонстрационный график нагрузки' : 'График активных соединений'} за период ${period}">
      <defs><linearGradient id="chart-fill" x2="0" y2="1"><stop stop-color="#c7f970" stop-opacity=".25"/><stop offset="1" stop-color="#c7f970" stop-opacity=".015"/></linearGradient></defs>
      ${[4, 54, 104, 154].map((y) => `<path d="M0 ${y}H640" stroke="#2c2b35" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`).join('')}
      ${plotted}
    </svg><div class="chart-labels" aria-hidden="true">${labels.map((label) => `<span>${label}</span>`).join('')}</div></div></div>`
    : emptyState('activity', 'Нет замеров за этот период', 'График появится после первого замера Telemt.')}</section>`;
}

function chartTimes({ from, to }) {
  const options = period === '24ч' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' };
  const format = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'Europe/Moscow' });
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => format.format(from + (to - from) * fraction));
}
function stat(label, value, unit, image, tone, detail) {
  return `<article class="panel stat"><div class="stat-top"><span>${label}</span><span class="icon-box ${tone}">${icon(image)}</span></div><div class="stat-value">${value}<span>${unit}</span></div><p>${detail}</p></article>`;
}
function routing() {
  const nodes = [
    ['Вход в Яндексе', domain, 'server', 'lime'],
    ['EU-выход', 'WireGuard · NAT', 'network', 'pink'],
    ['Telegram', 'MTProto · FakeTLS', 'send', 'violet'],
  ];
  return `<section class="panel routing"><div class="panel-top"><div><h2>Маршрут трафика</h2><p>Основной вход</p></div>${icon('network')}</div>
    <ol>${nodes.map(([title, line, symbol, tone]) => `<li><span class="icon-box ${tone}">${icon(symbol)}</span><div><strong>${title}</strong><small>${line}</small></div></li>`).join('')}</ol></section>`;
}
function infrastructure() {
  return `<section class="panel infra"><div class="panel-top"><div><h2>Инфраструктура</h2><p>Узлы пилота eBunny</p></div><a href="#ingress" class="text-link">К входам ${icon('arrow', 15)}</a></div>
    <div class="table-wrap"><table><thead><tr><th scope="col">Узел</th><th scope="col">Назначение</th><th scope="col">Адрес</th><th scope="col">Статус</th></tr></thead><tbody>
    <tr><td><strong>Yandex Cloud</strong></td><td>Вход MTProto</td><td class="mono">${entranceIp()}</td><td>${demo ? status('В сети') : monitoringStatus(telemetry?.telemt, 'Метрики доступны', 'Нет ответа от Telemt')}</td></tr>
    <tr><td><strong>EU VPS</strong></td><td>Выход WireGuard</td><td class="mono">${exitIp()}</td><td>${demo ? status('В сети') : monitoringStatus(telemetry?.wireguard, 'Пир отвечает', 'Пир не ответил')}</td></tr>
    </tbody></table></div></section>`;
}
function overview() {
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-art" aria-hidden="true"></div>
    <div class="hero-content"><div class="hero-status">${status('Вход MTProto')}</div><h2 id="hero-title">${domain}</h2><p>Yandex Cloud <span>→</span> WireGuard <span>→</span> Telegram</p>
    <a class="button hero-button" href="#ingress">Конфигурация входа ${icon('arrow', 16)}</a></div></section>
    <div id="overview-data">${overviewData()}</div>`;
}

function monitoringStatus(state, up, down) {
  if (state === true) return status(up);
  return status(state === false ? down : 'Нет данных', 'pink');
}

function formatBytes(bytes) {
  const scale = Math.min(3, bytes > 0 ? Math.floor(Math.log2(bytes) / 10) : 0);
  return [number.format(bytes / 1024 ** scale), ['Б', 'КиБ', 'МиБ', 'ГиБ'][scale]];
}

function overviewData() {
  const last = telemetry?.observedAt && sampleTime.format(telemetry.observedAt) + ' МСК';
  const traffic = telemetry?.traffic;
  const [trafficValue, trafficUnit] = demo ? ['34,8', 'ГиБ'] : traffic ? formatBytes(traffic.bytes) : ['—', ''];
  const coverage = traffic && traffic.coverageSeconds >= 85_200 ? 'За последние 24 часа' :
    traffic ? `За ${Math.round(traffic.coverageSeconds / 60)} мин замеров за 24 ч` : 'Нужны два последовательных замера';
  const note = telemetryError ? 'Не удалось обновить метрики.' :
    last ? `Последний замер: ${last}${telemetry.fresh ? '' : ' · данные устарели'}` :
      telemetry?.configured === false ? 'Сборщик метрик ещё не подключён.' : 'Ожидаем первый замер с входной ВМ.';
  const connections = telemetry?.connections;
  const latency = telemetry?.latency;
  return `${demo ? '' : `<p class="notice">${note}</p>`}<div class="stats">
    ${stat('Соединения', demo ? '128' : connections == null ? '—' : number.format(connections), '', 'activity', 'lime', 'Одновременно активные')}
    ${stat('Трафик', trafficValue, trafficUnit, 'transfer', 'pink', demo ? 'За последние 24 часа' : coverage)}
    ${stat('WireGuard', demo ? '50' : latency == null ? '—' : number.format(latency), demo || latency != null ? 'мс' : '', 'shield', 'violet', telemetry?.wireguard === false ? 'EU-пир не ответил' : 'Задержка до EU-выхода')}
    </div><div class="dashboard-grid">${chart()}${routing()}</div>${infrastructure()}`;
}

async function updateOverview(root, focusPeriod = false) {
  clearTimeout(pollTelemetry);
  reportRequest?.abort();
  const controller = new AbortController();
  reportRequest = controller;
  try {
    const response = await fetch(`/api/telemetry?period=${periods[period]}`, { signal: controller.signal });
    if (response.status === 401) return location.reload();
    if (!response.ok) throw new Error();
    const report = await response.json();
    if (!root.isConnected || controller.signal.aborted) return;
    telemetry = report;
    telemetryError = false;
  } catch {
    if (controller.signal.aborted || !root.isConnected) return;
    telemetryError = true;
    telemetry = telemetry ? { ...telemetry, fresh: false, connections: null, telemt: null, wireguard: null, latency: null } : undefined;
  }
  const focused = focusPeriod || root.contains(document.activeElement) && document.activeElement.dataset.period;
  root.innerHTML = overviewData();
  if (focused) root.querySelector(`[data-period="${period}"]`).focus({ preventScroll: true });
  pollTelemetry = setTimeout(() => {
    if (root.isConnected) void updateOverview(root);
  }, 30_000);
}

function ingress() {
  const profile = [
    ['Операционная система', 'Ubuntu 24.04 LTS'],
    ['Платформа', 'Intel Ice Lake · Shared-core'],
    ['Процессор', '2 vCPU · 50% гарантировано'],
    ['Память', '2 ГиБ'],
    ['Загрузочный диск', 'SSD · 10 ГиБ'],
    ['Зона', 'ru-central1-d'],
    ['Публичный IPv4', 'Назначается автоматически'],
    ['Доступ', 'SSH-ключ'],
    ['Резервное копирование и DDoS-защита', 'Выключены'],
  ];
  return `<div class="detail-grid">
    <section class="panel content-panel"><div class="panel-top"><div><h2>Основной вход</h2><p>Yandex Cloud</p></div>${status('Пилот')}</div>
    <dl class="facts"><div><dt>Домен</dt><dd class="mono">${domain}:443</dd></div><div><dt>Публичный IPv4</dt><dd class="mono">${entranceIp()}</dd></div>
    <div><dt>Протокол</dt><dd>MTProto / FakeTLS</dd></div><div><dt>Канал</dt><dd><a href="https://t.me/eBunnyVPN" target="_blank" rel="noopener noreferrer">@eBunnyVPN ${icon('external', 14)}</a></dd></div></dl></section>
    <section class="panel content-panel"><div class="panel-top"><div><h2>Профиль создания ВМ</h2><p>Для новых входов</p></div><span class="icon-box lime">${icon('server')}</span></div>
    <dl class="facts">${profile.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join('')}</dl><p class="notice">${icon('info', 16)} Создание через Yandex Cloud API ещё не подключено.</p></section></div>`;
}

function exits() {
  const rows = drafts.map((draft) => `<tr><td><strong>${escapeText(draft.name)}</strong></td><td class="mono">${escapeText(draft.host)}:${escapeText(draft.port)}</td><td>${escapeText(draft.user)}</td><td>${status('Черновик', 'pink')}</td>
    <td><button class="icon-button" type="button" data-remove="${escapeText(draft.id)}" aria-label="Удалить черновик ${escapeText(draft.name)}" title="Удалить черновик">${icon('close', 16)}</button></td></tr>`).join('');
  return `<section class="panel infra"><div class="panel-top"><div><h2>Выходы WireGuard</h2><p>Основная нода и черновики подключения</p></div></div>
    <div class="table-wrap"><table><thead><tr><th scope="col">Нода</th><th scope="col">Адрес</th><th scope="col">SSH-пользователь</th><th scope="col">Статус</th><th scope="col"><span class="sr-only">Действия</span></th></tr></thead><tbody>
    <tr><td><strong>EU VPS</strong></td><td class="mono">${exitIp()}</td><td>—</td><td>${status('Пилот')}</td><td></td></tr>${rows}</tbody></table></div></section>
    <p class="notice">${icon('info', 16)} Черновик сохраняет параметры ноды в этом браузере. Настройка VPS по SSH ещё не подключена.</p>`;
}

function journal() {
  const items = events.slice().reverse();
  return `<section class="panel content-panel"><div class="panel-top"><div><h2>Последние действия</h2><p>Локальная активность</p></div></div>
    ${items.length ? `<ul class="journal-list">${items.map((item) => `<li><span class="icon-box pink">${icon(item.kind === 'add' ? 'plus' : 'close')}</span><div><strong>${item.kind === 'add' ? 'Добавлен' : 'Удалён'} черновик EU-ноды</strong><small>${escapeText(item.name)}</small></div><time datetime="${new Date(item.createdAt).toISOString()}">${timestamp.format(item.createdAt)}</time></li>`).join('')}</ul>` : emptyState('history', 'Пока пусто', 'Добавленные черновики EU-нод появятся здесь.')}</section>`;
}

const pages = { overview, ingress, exits, checks: () => checks(demo), audience: () => audience(demo), journal };
function render() {
  clearTimeout(pollTelemetry);
  reportRequest?.abort();
  const route = location.hash.slice(1);
  const active = Object.hasOwn(pages, route) ? route : 'overview';
  navigation.innerHTML = Object.entries(sections).map(([key, [label, symbol]]) =>
    `<a href="#${key}" aria-label="${label}" title="${label}" ${active === key ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('');
  main.innerHTML = `<header class="page-header"><h1>${sections[active][0]}</h1><div class="header-actions">
    ${demo ? '<span class="demo-badge"><i></i>Демо-режим</span>' : '<button type="button" class="button" data-logout>Выйти</button>'}<button class="button primary" type="button" data-add>${icon('plus', 17)} Добавить EU-ноду</button>
    </div></header><div class="page-content">${pages[active]()}</div>`;
  document.title = `${sections[active][0]} · eBunny`;
  if (active === 'overview' && !demo) void updateOverview(main.querySelector('#overview-data'));
  if (active === 'checks' && !demo) void mountChecks(main.querySelector('#bscheck-app'));
  if (active === 'audience') {
    const container = main.querySelector('#audience-report');
    if (demo) bindAudience(container);
    else void mountAudience(container);
  }
}
function notify(message) {
  const toast = document.querySelector('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}
function saveDrafts(next, kind, name) {
  const nextEvents = [...events, { kind, name, createdAt: Date.now() }];
  try {
    localStorage.setItem(storageKey, JSON.stringify({ drafts: next, events: nextEvents }));
    drafts = next;
    events = nextEvents;
    return true;
  } catch {
    return false;
  }
}
function openEditor() {
  editor.innerHTML = `<form id="node-form">
    <div class="dialog-top"><div><h2 id="dialog-title">Добавить EU-ноду</h2><p>Параметры SSH для черновика подключения.</p></div><button class="icon-button" type="button" data-dismiss aria-label="Закрыть">${icon('close')}</button></div>
    <label>Имя ноды<input name="name" placeholder="Например, EU-2" required maxlength="60" autofocus></label>
    <div class="form-row"><label>IPv4 или домен<input name="host" placeholder="vps.example.com" autocomplete="off" required maxlength="253"></label><label>SSH-порт<input name="port" type="number" value="22" min="1" max="65535" required></label></div>
    <label>SSH-пользователь<input name="user" placeholder="ubuntu" autocomplete="off" required maxlength="64" pattern="[A-Za-z0-9_][A-Za-z0-9_\\-]*"></label>
    <p class="form-error" role="alert"></p>
    <div class="dialog-actions"><button class="button" type="button" data-dismiss>Отмена</button><button class="button primary" type="submit">Сохранить черновик</button></div>
  </form>`;
  editor.showModal();
}
function validHost(host) {
  if (/^[0-9.]+$/.test(host)) {
    const octets = host.split('.');
    return octets.length === 4 && octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
  }
  return host.includes('.') && host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
}
editor.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const name = String(data.get('name')).trim();
  const host = String(data.get('host')).trim().toLowerCase();
  const port = Number(data.get('port'));
  const user = String(data.get('user')).trim();
  const error = editor.querySelector('.form-error');
  if (!name || !validHost(host)) {
    error.textContent = 'Укажи имя ноды и корректный IPv4 или домен.';
    return;
  }
  if (drafts.some((draft) => draft.host === host && draft.port === port)) {
    error.textContent = 'Нода с таким адресом и портом уже добавлена.';
    return;
  }
  const draft = { id: crypto.randomUUID(), name, host, port, user };
  if (!saveDrafts([...drafts, draft], 'add', name)) {
    error.textContent = 'Браузер не сохранил черновик. Проверь доступ к локальному хранилищу.';
    return;
  }
  editor.close();
  if (location.hash === '#exits') render();
  else location.hash = 'exits';
  notify('Черновик EU-ноды сохранён');
});
main.addEventListener('click', async (event) => {
  const logout = event.target.closest('[data-logout]');
  if (logout) {
    logout.disabled = true;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error();
      location.reload();
    } catch {
      logout.disabled = false;
      notify('Не удалось завершить сессию.');
    }
    return;
  }
  if (event.target.closest('[data-add]')) openEditor();
  const periodButton = event.target.closest('[data-period]');
  if (periodButton) {
    period = periodButton.dataset.period;
    if (demo) {
      main.querySelector('.chart-panel').outerHTML = chart();
      main.querySelector(`[data-period="${period}"]`).focus();
    } else void updateOverview(main.querySelector('#overview-data'), true);
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const draft = drafts.find((item) => item.id === remove.dataset.remove);
    if (!draft) return;
    if (saveDrafts(drafts.filter((item) => item.id !== draft.id), 'remove', draft.name)) {
      render();
      main.querySelector('[data-add]').focus();
      notify('Черновик удалён');
    } else notify('Браузер не сохранил удаление черновика');
  }
});
editor.addEventListener('click', (event) => {
  if (event.target.closest('[data-dismiss]')) editor.close();
});
window.addEventListener('hashchange', () => {
  if (location.hash === '#main') return;
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
});
render();

const series = [
  {
    key: 'follows',
    title: 'Новые подписчики',
    source: 'Канал @eBunnyVPN · все источники',
    values: [31, 34, 32, 43, 36, 39, 47, 60, 52, 57, 48, 56, 62, 50, 48, 55, 64, 56, 72, 65, 59, 68, 89, 102, 94, 83, 105, 99, 113, 108],
  },
  {
    key: 'starts',
    title: 'Запуски бота',
    source: '@eBunnyAPP · start=mtproxy',
    values: [14, 12, 16, 20, 15, 18, 24, 27, 22, 28, 25, 23, 29, 24, 20, 30, 26, 29, 32, 25, 31, 41, 33, 44, 51, 43, 47, 61, 59, 53],
  },
];

const number = new Intl.NumberFormat('ru-RU');
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const lastExampleDay = Date.UTC(2026, 10, 20);
const exampleDays = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(lastExampleDay);
  date.setUTCDate(date.getUTCDate() - 29 + index);
  return { date, follows: series[0].values[index], starts: series[1].values[index] };
});

const plotWidth = 720;
const plotHeight = 208;

const plotX = (index, length) => 4 + index * (plotWidth - 8) / (length - 1);
const plotY = (value, limit) => 4 + (1 - value / limit) * (plotHeight - 8);
let period = 30;

function seriesPath(days, key, limit) {
  return days.map((day, index) => `${plotX(index, days.length).toFixed(2)},${plotY(day[key], limit).toFixed(2)}`).join(' ');
}

function dateElement(date, formatter) {
  return `<time datetime="${date.toISOString().slice(0, 10)}">${formatter.format(date)}</time>`;
}

function dailyValues(day, visible) {
  return `${dateElement(day.date, fullDate)}${visible.map(({ key, title }) =>
    `<span class="audience-key ${key}"><i aria-hidden="true"></i><span>${title}</span> <strong>${number.format(day[key])}</strong></span>`).join('')}`;
}

function chartData(report) {
  const data = report ? report.days.map((day) => ({ ...day, date: new Date(day.date) })) : exampleDays;
  const days = data.slice(-period);
  const visible = report ? series.filter(({ key }) => key === 'starts') : series;
  return { days, visible };
}

function audienceReport(report) {
  const { days, visible } = chartData(report);
  const maximum = Math.max(...days.flatMap((day) => visible.map(({ key }) => day[key])));
  const step = Math.max(5, Math.ceil(maximum / 20) * 5);
  const scale = [4, 3, 2, 1, 0].map((level) => level * step);
  const lastDay = days.at(-1);
  const labelIndices = [0, Math.round((days.length - 1) / 3), Math.round((days.length - 1) * 2 / 3), days.length - 1];
  return `<div class="audience-summary">
    ${series.map(({ key, title, source }) => `<article class="panel stat audience-metric">
      <div class="stat-top"><h2 class="audience-key ${key}"><i aria-hidden="true"></i>${title}</h2></div>
      <div class="stat-value${report && key === 'follows' ? ' unavailable' : ''}">${report && key === 'follows' ? 'Нет данных' : number.format(days.reduce((sum, day) => sum + day[key], 0))}</div>
      <p>${source}</p>
      ${report && key === 'starts' ? `<p>Уникальных аккаунтов: <strong>${number.format(report.unique[period])}</strong></p>` : ''}
    </article>`).join('')}
    <article class="panel stat audience-metric"><div class="stat-top"><h2>Переходы из «Спонсор прокси»</h2></div>
      <div class="stat-value unavailable">Нет данных</div>
      <p>Telegram может показать источник подписки. Прямого счётчика кликов пока нет.</p>
    </article>
  </div>
  <section class="panel audience-chart" aria-labelledby="audience-chart-title">
    <div class="panel-top"><div><h2 id="audience-chart-title">Динамика аудитории</h2><p>${dateElement(days[0].date, shortDate)} — ${dateElement(lastDay.date, shortDate)} · по дням</p></div>
      <div class="segments" role="group" aria-label="Период аудитории">${[7, 30].map((value) => `<button type="button" data-audience-period="${value}" aria-pressed="${period === value}">${value} дн.</button>`).join('')}</div></div>
    <div class="audience-chart-grid">
      <div class="audience-scale" aria-hidden="true">${scale.map((value) => `<span>${value}</span>`).join('')}</div>
      <div>
        <svg class="audience-plot" data-limit="${scale[0]}" viewBox="0 0 ${plotWidth} ${plotHeight}" preserveAspectRatio="none" role="img" aria-label="${report ? 'Запуски бота' : 'Новые подписчики и запуски бота'} по дням. Значения доступны под графиком.">
          <defs>${visible.map(({ key }) => `<linearGradient class="${key}" id="audience-${key}" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".23"/><stop offset="1" stop-color="currentColor" stop-opacity=".015"/></linearGradient>`).join('')}</defs>
          ${scale.map((value) => `<path class="audience-gridline" d="M0 ${plotY(value, scale[0])}H${plotWidth}"/>`).join('')}
          ${visible.map(({ key }) => {
            const points = seriesPath(days, key, scale[0]);
            return `<g class="${key}"><polygon points="4,${plotY(0, scale[0])} ${points} ${plotWidth - 4},${plotY(0, scale[0])}" fill="url(#audience-${key})"/><polyline class="audience-line" points="${points}"/></g>`;
          }).join('')}
          <line class="audience-cursor" y1="4" y2="${plotY(0, scale[0])}"/>
          ${visible.map(({ key }) => `<ellipse class="audience-dot ${key}" data-point="${key}" rx="4" ry="4"/>`).join('')}
        </svg>
        <div class="chart-labels" aria-hidden="true">${labelIndices.map((index) => dateElement(days[index].date, shortDate)).join('')}</div>
      </div>
    </div>
    <label class="audience-picker"><span>День</span><input type="range" min="0" max="${days.length - 1}" value="${days.length - 1}"></label>
    <output class="audience-day" aria-live="off">${dailyValues(lastDay, visible)}</output>
  </section>
  <details class="panel audience-table"><summary>Значения по дням</summary>
    <div class="table-wrap"><table><thead><tr><th scope="col">Дата</th>${visible.map(({ title }) => `<th scope="col">${title}</th>`).join('')}</tr></thead>
      <tbody>${days.map((day) => `<tr><th scope="row">${dateElement(day.date, shortDate)}</th>${visible.map(({ key }) => `<td>${number.format(day[key])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

export function audience(demo) {
  if (!demo) return '<div id="audience-report"><p class="notice">Загружаем аудиторию…</p></div>';
  return `<div id="audience-report">${audienceReport()}</div>
    <p class="notice">Демо-данные. Запуски бота считаются после команды /start mtproxy. Один человек может запустить бота несколько раз.</p>`;
}

export async function mountAudience(container) {
  try {
    const response = await fetch('/api/audience');
    if (response.status === 401) return location.reload();
    if (!response.ok) throw new Error('Не удалось загрузить аудиторию.');
    const report = await response.json();
    if (!report.configured) {
      container.innerHTML = '<section class="panel content-panel"><h2>Данные аудитории ещё не подключены</h2><p class="notice">Подключи события /start mtproxy в @eBunnyAPP, чтобы видеть запуски и уникальные аккаунты.</p></section>';
      return;
    }
    container.innerHTML = audienceReport(report);
    bindAudience(container, report);
  } catch (error) {
    container.textContent = error.message;
  }
}

export function bindAudience(container, report) {
  const { days, visible } = chartData(report);
  const plot = container.querySelector('.audience-plot');
  const cursor = plot.querySelector('.audience-cursor');
  const points = visible.map(({ key }) => [key, plot.querySelector(`[data-point="${key}"]`)]);
  const field = container.querySelector('input[type="range"]');
  const output = container.querySelector('.audience-day');
  const displayDay = (index) => {
    const day = days[index];
    const x = plotX(index, days.length);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    for (const [key, point] of points) {
      point.setAttribute('cx', x);
      point.setAttribute('cy', plotY(day[key], Number(plot.dataset.limit)));
      point.setAttribute('rx', plotWidth * 4 / Math.max(plot.clientWidth, 1));
    }
    field.value = index;
    const measurements = visible.map(({ key, title }) => `${title.toLocaleLowerCase('ru')}: ${day[key]}`);
    field.setAttribute('aria-valuetext', [fullDate.format(day.date), ...measurements].join(', '));
    output.innerHTML = dailyValues(day, visible);
  };

  displayDay(days.length - 1);
  field.addEventListener('input', () => displayDay(field.valueAsNumber));
  const selectFromPlot = (event) => {
    const bounds = plot.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * plotWidth;
    const index = Math.max(0, Math.min(days.length - 1, Math.round((x - 4) / (plotWidth - 8) * (days.length - 1))));
    if (index !== field.valueAsNumber) displayDay(index);
  };
  plot.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') selectFromPlot(event);
  });
  plot.addEventListener('pointerup', selectFromPlot);

  for (const button of container.querySelectorAll('[data-audience-period]')) {
    button.addEventListener('click', () => {
      const selected = Number(button.dataset.audiencePeriod);
      if (selected === period) return;
      period = selected;
      container.innerHTML = audienceReport(report);
      bindAudience(container, report);
      container.querySelector(`[data-audience-period="${period}"]`).focus();
    });
  }
}

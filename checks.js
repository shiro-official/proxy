const money = new Intl.NumberFormat('ru', { style: 'currency', currency: 'RUB' });
const time = new Intl.DateTimeFormat('ru', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
});
const credits = (value) => Number.isFinite(value) ? `${value} кр. / ${money.format(value / 100)}` : '—';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const link = '<a class="text-link" href="https://bsbord.com/" target="_blank" rel="noopener noreferrer">Открыть bsbord.com ↗</a>';

export function checks(demo) {
  return `<section class="panel content-panel" aria-labelledby="bs-title">
    <div class="panel-top"><div><h2 id="bs-title">BSCheck</h2><p>TCP 443 по сетям операторов</p></div>${link}</div>
    ${demo ? `<p class="notice">Ключ формата <code>bsk_live_…</code> создаётся в bsbord.com → API. Войди в серверную панель через Telegram, чтобы подключить его.</p>
    <dl class="facts"><div><dt>Проверка</dt><dd>TCP, порт 443</dd></div><div><dt>Расписание</dt><dd>Каждые 6 минут</dd></div></dl>` : '<div id="bscheck-app" class="bscheck" aria-busy="true"><p class="notice">Загружаем настройки…</p></div>'}
  </section>`;
}

async function api(path = '', data) {
  const response = await fetch(`/api/bscheck${path}`, data === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (response.status === 401) {
    location.reload();
    throw new Error('Сессия истекла.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не прошёл.');
  return result;
}

function resultsTable(history) {
  if (!history.length) return '<p class="notice">Проверок пока нет.</p>';
  const stateLabels = { done: 'Завершена', running: 'В процессе', failed: 'Ошибка', unknown: 'Итог не подтверждён' };
  return `<div class="bs-history">${history.map((run) => `<details>
    <summary><span>${time.format(run.created)} · ${escape(run.target)}</span><span>${stateLabels[run.state]} · ${credits(run.cost)}</span></summary>
    ${run.error ? `<p class="notice">${escape(run.error)}</p>` : ''}
    ${run.result?.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Сеть</th><th scope="col">Проба</th><th scope="col">Результат</th><th scope="col">Задержка</th></tr></thead>
    <tbody>${run.result.map((row) => `<tr><td>${escape(row.operator ? `${row.operator} · ${row.region} · ${row.dpi === 'on' ? 'с БС' : 'без БС'}` : row.key)}</td>
    <td>${row.ok === null ? '—' : row.tls ? 'TLS' : 'TCP'}</td>
    <td>${row.ok === null ? 'Нет замера' : row.ok ? 'Доступен' : 'Недоступен'}</td><td>${Number.isFinite(row.latency) ? `${row.latency} мс` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </details>`).join('')}</div>`;
}

function settingsForm(config, operators) {
  return `<form data-task="settings" class="bs-settings">
    <div class="form-row"><label>Публичный IPv4 входа<input name="target" autocomplete="off" value="${escape(config.target)}" maxlength="15" required></label>
    <label>Дневной лимит, кр.<input type="number" name="limit" value="${config.dailyLimit}" min="0" max="1000000" required></label></div>
    <details class="bs-networks"${config.operators.length ? '' : ' open'}><summary>Сети для проверки</summary>
      <div class="bs-operator-grid">${operators.map((unit) => `<label><input type="checkbox" name="operators" value="${escape(unit.key)}"${config.operators.includes(unit.key) ? ' checked' : ''}>
      <span>${escape(unit.name)} · ${escape(unit.region)} <small>${unit.dpi === 'on' ? 'с БС' : 'без БС'}${unit.probeable ? '' : ' · нет замеров'}</small></span></label>`).join('')}</div></details>
    <label class="bs-checkbox"><input type="checkbox" name="enabled"${config.enabled ? ' checked' : ''}> Автооплата проверок каждые 6 минут в пределах дневного лимита</label>
    <button class="button" type="submit">Сохранить настройки</button>
  </form>`;
}

export async function mountChecks(root, initialMessage = '') {
  try {
    const config = await api();
    const [balance, operators] = config.configured
      ? await Promise.allSettled([api('/account'), api('/operators')])
      : [{ status: 'skipped' }, { status: 'skipped' }];
    if (!root.isConnected) return;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<form data-task="key" class="bs-key">
      <label>${config.configured ? 'Заменить API-ключ' : 'API-ключ BSCheck'}<input name="key" type="password" autocomplete="off" placeholder="bsk_live_…" required></label>
      <button class="button primary" type="submit">${config.configured ? 'Заменить' : 'Подключить ключ'}</button>
    </form>
    <p class="notice">Ключ создаётся в bsbord.com → API. После проверки он сохраняется на сервере.</p>
    ${config.configured ? `<dl class="facts"><div><dt>Расписание</dt><dd>${config.settings.enabled ? 'Каждые 6 минут' : 'Пауза'}</dd></div>
      <div><dt>Расход сегодня по Москве</dt><dd>${credits(config.spent)}</dd></div>
      ${balance.status === 'fulfilled' ? `<div><dt>Баланс BSCheck</dt><dd>${credits(balance.value.balance)} · ${escape(balance.value.tier)}</dd></div>` : ''}
      </dl>` : ''}
    ${operators.status === 'fulfilled' ? settingsForm(config.settings, operators.value) : ''}
    ${config.configured ? `<div class="bs-actions">${config.settings.enabled ? '<button class="button" type="button" data-task="pause">Поставить расписание на паузу</button>' : ''}<button class="button" type="button" data-task="preview">Оценить стоимость</button>
      <button class="button primary" type="button" data-task="run" hidden></button><button class="button" type="button" data-task="refresh">Обновить</button></div>
      <h3 class="bs-history-title">Проверки</h3>${resultsTable(config.history)}` : ''}
    <p class="form-error" role="status"></p>`;
    const status = root.querySelector('[role="status"]');
    status.textContent = initialMessage || config.scheduleError ||
      (operators.status === 'rejected' ? operators.reason.message : '');
    const paid = root.querySelector('[data-task="run"]');
    let quote;
    let busy = false;
    const controlled = async (button, action) => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      status.textContent = '';
      try {
        await action();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        busy = false;
        button.disabled = false;
      }
    };

    root.querySelector('[data-task="key"]').onsubmit = (event) => {
      event.preventDefault();
      const input = event.target.elements.key;
      void controlled(event.submitter, async () => {
        const key = input.value;
        input.value = '';
        await api('/key', { key });
        await mountChecks(root, 'Ключ подключён. Выбери сети для проверки.');
      });
    };

    const settings = root.querySelector('[data-task="settings"]');
    if (settings) {
      settings.oninput = () => {
        quote = undefined;
        paid.hidden = true;
        root.querySelector('[data-task="preview"]').disabled = true;
        status.textContent = 'Сохрани изменённые настройки перед оценкой.';
      };
      settings.onsubmit = (event) => {
        event.preventDefault();
        void controlled(event.submitter, async () => {
          const data = new FormData(settings);
          await api('/settings', {
            target: data.get('target').trim(),
            operators: data.getAll('operators'),
            dailyLimit: Number(data.get('limit')),
            enabled: data.has('enabled'),
          });
          await mountChecks(root, 'Настройки сохранены.');
        });
      };
    }

    const pause = root.querySelector('[data-task="pause"]');
    if (pause) pause.onclick = () => void controlled(pause, async () => {
      await api('/pause', {});
      await mountChecks(root, 'Расписание приостановлено.');
    });
    if (paid) {
      root.querySelector('[data-task="refresh"]').onclick = () => void mountChecks(root);
      root.querySelector('[data-task="preview"]').onclick = (event) => void controlled(event.currentTarget, async () => {
        const estimate = await api('/preview', {});
        quote = { cap: estimate.cost, id: crypto.randomUUID() };
        paid.textContent = `Запустить за ≤ ${credits(estimate.cost)}`;
        paid.hidden = false;
        status.textContent = `До ${credits(estimate.cost)} за пробу. При 240 прогонах в сутки — до ${credits(estimate.cost * 240)} по текущей оценке.`;
      });
      paid.onclick = () => void controlled(paid, async () => {
        if (!quote) return;
        const approved = quote;
        paid.hidden = true;
        status.textContent = 'Проверка выполняется…';
        try {
          const result = await api('/run', approved);
          quote = undefined;
          await mountChecks(root, result.state === 'done' ? 'Проверка завершилась.' : 'Итог проверки смотри в истории.');
        } catch (error) {
          // Retrying the button action keeps the same logical run identifier.
          paid.hidden = false;
          throw error;
        }
      });
    }
  } catch (error) {
    root.setAttribute('aria-busy', 'false');
    root.textContent = error.message;
  }
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const stateText = {
  creating: 'Запрос подготовлен',
  pending: 'ВМ создаётся',
  uncertain: 'Операцию нужно сверить',
  prepared: 'ВМ запущена',
  failed: 'Ошибка ВМ',
  active: 'DNS переключён',
};
const grantText = { available: 'Доступен', exhausted: 'Грант закончился', paused: 'На паузе' };
const time = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
});

async function api(path = '', body) {
  const response = await fetch(`/api/rollout${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 401) {
    location.reload();
    throw new Error('Сессия истекла.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Операция не прошла.');
  return data;
}

function candidateCard(row, dns, projects) {
  const canRefresh = !['active', 'failed'].includes(row.state);
  const canPublish = row.state === 'prepared' && row.ip && dns?.ip;
  const permissionDenied = row.state === 'failed' &&
    /^Yandex Compute: (HTTP 403|PERMISSION_DENIED)/.test(row.message ?? '');
  return `<article class="rollout-candidate">
    <div class="panel-top"><div><h3>${escape(row.name)}</h3><p>${escape(projects.find(({ id }) => id === row.project)?.name ?? row.project)} · ${time.format(row.created)} МСК</p></div>
      <span class="status ${row.state === 'active' ? 'lime' : 'pink'}"><i></i>${stateText[row.state]}</span></div>
    ${row.operation_id ? `<p class="notice">Операция Яндекса: <code>${escape(row.operation_id)}</code></p>` : ''}
    ${row.ip ? `<p class="rollout-ip mono">${escape(row.ip)}:443</p>` : ''}
    ${row.message ? `<p class="notice">${escape(row.message)}</p>` : ''}
    ${permissionDenied ? `<p class="notice">Для ВМ с публичным IPv4 проверь роли <code>compute.editor</code> и <code>vpc.publicAdmin</code> у сервисного аккаунта в каталоге.
      <a class="text-link" href="https://yandex.cloud/ru/docs/compute/security/#choosing-roles" target="_blank" rel="noopener noreferrer">Роли в документации Яндекса</a></p>` : ''}
    ${row.state === 'prepared' ? '<p class="notice">Настрой WireGuard и Telemt на резерве и проверь подключение по его адресу.</p>' : ''}
    ${row.state === 'uncertain' ? '<p class="notice">Обновление статуса проверяет уже отправленную операцию.</p>' : ''}
    ${canRefresh ? `<button class="button" type="button" data-refresh="${escape(row.id)}">Обновить статус ВМ</button>` : ''}
    ${canPublish ? `<form data-publish="${escape(row.id)}" data-ip="${escape(row.ip)}" class="rollout-form">
      <label class="bs-checkbox"><input type="checkbox" name="confirmed" required> Telegram подключился через этот IP, чаты и медиа загрузились.</label>
      <p class="notice">A-запись tg.ebunny.cloud изменится с ${escape(dns.ip)} на ${escape(row.ip)}.</p>
      <button class="button primary" type="submit">Переключить DNS</button>
    </form>` : ''}
  </article>`;
}

function projectsSection(projects) {
  if (!projects.length) return '<p class="notice">Подключи проект Яндекса через официальный OAuth или сервисный аккаунт.</p>';
  const available = projects.filter(({ grantState }) => grantState === 'available');
  return `<details class="rollout-projects"><summary>Проекты и состояние грантов</summary>
    <p class="notice">Состояние указывается после проверки в Billing. Меньшее число — выше приоритет.</p>
    ${projects.map((project) => `<form data-grant="${escape(project.id)}" class="rollout-project">
      <div><strong>${escape(project.name)}</strong><p class="notice">Приоритет ${project.priority} · ${project.auth === 'oauth' ? 'OAuth' : 'Сервисный аккаунт'}${project.grantUpdated ? ` · ${time.format(project.grantUpdated)} МСК` : ''}</p></div>
      <label>Состояние<select name="grant">${Object.entries(grantText).map(([state, label]) =>
        `<option value="${state}"${state === project.grantState ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="rollout-project-actions"><button class="button" type="button" data-check="${escape(project.id)}">Проверить доступ</button>
      <button class="button" type="submit">Сохранить состояние</button></div>
      <p class="notice rollout-check-feedback" role="status"></p>
    </form>`).join('')}</details>
    ${available.length ? `<form class="rollout-form" data-create>
      <label>Проект Яндекса<select name="project" required>
        <option value="" disabled selected>Выбери проект</option>
        ${available.map(({ id, name }) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}
      </select></label>
      <label class="bs-checkbox"><input type="checkbox" required> Подтверждаю создание платной ВМ по профилю, указанному выше.</label>
      <button class="button primary" type="submit">Создать резервную ВМ</button>
    </form>` : '<p class="notice">Нет доступного проекта для создания ВМ.</p>'}`;
}

function catalogSection(enabled) {
  if (!enabled) return `<details class="rollout-projects" open>
    <summary>Подключить проект из Яндекса · Требуется настройка</summary>
    <p class="notice">Настрой общий доступ Yandex Cloud на VPS с панелью. После перезапуска здесь появится выбор каталога и сети.</p>
    <a class="text-link" href="https://github.com/shiro-official/proxy/tree/panel#подключение-проектов-по-общему-доступу" target="_blank" rel="noopener noreferrer">Инструкция подключения</a>
  </details>`;
  return `<details class="rollout-projects" data-catalog>
    <summary>Подключить проект из Яндекса</summary>
    <div class="rollout-form">
      <button class="button" type="button" data-clouds>Загрузить облака</button>
      <label data-cloud-field hidden>Облако<select data-cloud></select></label>
      <label data-folder-field hidden>Каталог<select data-folder></select></label>
    </div>
    <form class="rollout-form" data-network>
      <label>ID каталога<input name="folder" required maxlength="64" autocomplete="off"></label>
      <button class="button" type="submit">Показать подсети и группы</button>
    </form>
    <form class="rollout-form" data-import hidden>
      <label>Название проекта<input name="name" maxlength="80" autocomplete="off"></label>
      <label>Подсеть в ru-central1-d<select name="subnet" required></select></label>
      <label>Группа безопасности<select name="group" required></select></label>
      <button class="button primary" type="submit">Подключить проект</button>
    </form>
    <p class="notice" data-catalog-status role="status"></p>
  </details>`;
}

function automationSection(data) {
  const available = data.projects.filter(({ grantState }) => grantState === 'available');
  if (!data.projects.length && !data.automation.enabled && !data.automation.message) {
    return '<details class="rollout-projects"><summary>Автосоздание резерва · Выключено</summary><p class="notice">Сначала подключи хотя бы один проект Яндекса.</p></details>';
  }
  const { enabled, project, message } = data.automation;
  const name = data.projects.find((item) => item.id === project)?.name;
  return `<details class="rollout-projects"${enabled || message ? ' open' : ''}>
    <summary>Автосоздание резерва · ${enabled ? 'Включено' : 'Выключено'}</summary>
    <p class="notice">Панель создаёт одну резервную ВМ в выбранном проекте. После переключения на неё панель может создать следующий резерв.</p>
    ${message ? `<p class="notice">${escape(message)}</p>` : ''}
    ${enabled ? `<div class="rollout-dns"><strong>${escape(name ?? project)}</strong>
      <button class="button" type="button" data-stop-automatic>Отключить автосоздание</button></div>`
      : available.length ? `<form class="rollout-form" data-automatic>
        <label>Проект для резерва<select name="project" required><option value="" disabled selected>Выбери проект</option>
          ${available.map(({ id, name }) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label>
        <label class="bs-checkbox"><input type="checkbox" required> Разрешаю платное создание и пополнение резерва в этом проекте.</label>
        <button class="button primary" type="submit">Поддерживать один резерв</button>
      </form>` : ''}
  </details>`;
}

function optionList(items, label) {
  return `<option value="" disabled selected>${label}</option>${items.map(({ id, name }) =>
    `<option value="${escape(id)}">${escape(name)} · ${escape(id)}</option>`).join('')}`;
}

function bindCatalog(root, run, refresh) {
  const catalog = root.querySelector('[data-catalog]');
  if (!catalog) return;
  const feedback = catalog.querySelector('[data-catalog-status]');
  const cloud = catalog.querySelector('[data-cloud]');
  const folder = catalog.querySelector('[data-folder]');
  const network = catalog.querySelector('[data-network]');
  const importer = catalog.querySelector('[data-import]');
  let resources;
  let folderId;
  const clearNetwork = () => { importer.hidden = true; folderId = undefined; };
  const showGroups = () => {
    const selected = resources.subnets.find((subnet) => subnet.id === importer.elements.subnet.value);
    importer.elements.group.innerHTML = optionList(resources.securityGroups.filter((group) => group.networkId === selected?.networkId), 'Выбери группу');
  };
  catalog.querySelector('[data-clouds]').onclick = () => void run(async () => {
    const clouds = await api('/clouds');
    cloud.innerHTML = optionList(clouds, 'Выбери облако');
    catalog.querySelector('[data-cloud-field]').hidden = !clouds.length;
    feedback.textContent = clouds.length ? 'Выбери облако или введи ID каталога.' : 'Список облаков пуст. Можно указать ID каталога вручную.';
  }, feedback);

  cloud.onchange = () => void run(async () => {
    const folders = await api(`/folders?cloudId=${encodeURIComponent(cloud.value)}`);
    folder.innerHTML = optionList(folders, 'Выбери каталог');
    catalog.querySelector('[data-folder-field]').hidden = !folders.length;
    feedback.textContent = folders.length ? 'Выбери нужный каталог.' : 'В облаке не найдено доступных каталогов.';
  }, feedback);

  const loadNetwork = () => void run(async () => {
    clearNetwork();
    const chosen = network.elements.folder.value.trim();
    resources = await api(`/network?folderId=${encodeURIComponent(chosen)}`);
    if (chosen !== network.elements.folder.value.trim()) return;
    folderId = chosen;
    importer.elements.subnet.innerHTML = optionList(resources.subnets, 'Выбери подсеть');
    showGroups();
    importer.hidden = !resources.subnets.length;
    feedback.textContent = resources.subnets.length ? 'Выбери подсеть и группу из той же сети.' : 'В каталоге нет доступных подсетей ru-central1-d.';
  }, feedback);

  folder.onchange = () => {
    network.elements.folder.value = folder.value;
    importer.elements.name.value = folder.selectedOptions[0].text.split(' · ')[0];
    loadNetwork();
  };
  network.elements.folder.oninput = clearNetwork;
  importer.elements.subnet.onchange = showGroups;
  network.onsubmit = (event) => { event.preventDefault(); loadNetwork(); };
  importer.onsubmit = (event) => {
    event.preventDefault();
    if (!folderId) return;
    void run(async () => {
      const data = new FormData(importer);
      await api('/import', { folderId, name: data.get('name'), subnetId: data.get('subnet'), securityGroupId: data.get('group') });
      await refresh('Проект подключён. Его можно выбрать для создания ВМ.');
    }, feedback);
  };
}

function page(data, dns, dnsError) {
  return `<div class="panel-top"><div><h2>Резерв и перенос входа</h2><p>Yandex Cloud · Cloudflare</p></div></div>
    ${catalogSection(data.discovery)}
    ${projectsSection(data.projects)}
    ${automationSection(data)}
    ${data.cloudflare ? `<div class="rollout-dns"><span>Cloudflare · текущее значение A-записи</span><strong class="mono">${escape(dns?.ip ?? '—')}</strong><button class="button" type="button" data-reload>Обновить DNS</button></div>` :
      '<p class="notice">Для переключения DNS подключи токен Cloudflare с правом редактирования этой зоны.</p>'}
    ${dnsError ? `<p class="notice">${escape(dnsError)}</p>` : ''}
    ${data.candidates.map((row) => candidateCard(row, dns, data.projects)).join('')}
    ${data.switches.length ? `<h3 class="bs-history-title">Переключения DNS</h3>
      <ul class="rollout-log">${data.switches.map((event) => `<li><span>${time.format(event.created)} МСК</span><span class="mono">${escape(event.previous_ip)} → ${escape(event.target_ip)}</span><span>${event.state === 'done' ? 'Подтверждено' : 'Сверь DNS'}${event.message ? ` · ${escape(event.message)}` : ''}</span></li>`).join('')}</ul>` : ''}
    <p class="form-error" role="status"></p>`;
}

export async function mountRollout(root, message = '') {
  let data;
  try {
    data = await api();
  } catch (error) {
    root.textContent = error.message;
    return;
  }
  let dns;
  let dnsError;
  if (data.cloudflare) {
    try {
      dns = await api('/dns');
    } catch (error) {
      dnsError = error.message;
    }
  }
  if (!root.isConnected) return;
  root.innerHTML = page(data, dns, dnsError);
  const notification = root.querySelector('.form-error');
  notification.textContent = message;
  const buttons = [...root.querySelectorAll('button')];
  let busy = false;
  const run = async (action, feedback = notification) => {
    if (busy) return;
    busy = true;
    buttons.forEach((button) => { button.disabled = true; });
    feedback.textContent = 'Операция выполняется…';
    try {
      await action();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      busy = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  };

  bindCatalog(root, run, (note) => mountRollout(root, note));
  const auto = root.querySelector('[data-automatic]');
  if (auto) auto.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      await api('/automation', { enabled: true, project: auto.elements.project.value, confirmCost: true });
      await mountRollout(root, 'Автосоздание резерва включено.');
    });
  };
  const stopAutomatic = root.querySelector('[data-stop-automatic]');
  if (stopAutomatic) stopAutomatic.onclick = () => void run(async () => {
    await api('/automation', { enabled: false });
    await mountRollout(root, 'Автосоздание отключено.');
  });

  const create = root.querySelector('[data-create]');
  if (create) {
    let requestId;
    create.elements.project.onchange = () => { requestId = undefined; };
    create.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        requestId ??= crypto.randomUUID();
        const row = await api('/reserve', { requestId, project: create.elements.project.value, confirmCost: true });
        await mountRollout(root, row.state === 'pending' ? 'Запрос на создание принят. Обнови статус ВМ.' : stateText[row.state]);
      });
    };
  }
  for (const button of root.querySelectorAll('[data-check]')) {
    const feedback = button.closest('form').querySelector('.rollout-check-feedback');
    button.onclick = () => void run(async () => {
      await api('/check', { project: button.dataset.check });
      feedback.textContent = 'Вход и чтение списка ВМ подтверждены. Права на создание проверяются отдельно.';
    }, feedback);
  }
  for (const form of root.querySelectorAll('[data-grant]')) {
    form.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        await api('/grant', { project: form.dataset.grant, state: form.elements.grant.value });
        await mountRollout(root, 'Состояние проекта сохранено.');
      });
    };
  }
  for (const button of root.querySelectorAll('[data-refresh]')) {
    button.onclick = () => void run(async () => {
      const row = await api('/refresh', { id: button.dataset.refresh });
      await mountRollout(root, stateText[row.state]);
    });
  }
  for (const form of root.querySelectorAll('[data-publish]')) {
    form.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        await api('/publish', { id: form.dataset.publish, expectedIp: dns.ip, targetIp: form.dataset.ip, confirmMtproto: true });
        await mountRollout(root, 'Cloudflare подтвердил новый адрес.');
      });
    };
  }
  const reload = root.querySelector('[data-reload]');
  if (reload) reload.onclick = () => void mountRollout(root);
}

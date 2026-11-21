const layout = document.querySelector('.layout');
const gate = document.querySelector('#login');
let poll;

async function auth(path, method = 'GET') {
  const response = await fetch(`/api/${path}`, { method });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Запрос не прошёл.');
  return data;
}

function showLogin(message = '') {
  layout.hidden = true;
  gate.hidden = false;
  gate.querySelector('.login-flow').hidden = true;
  gate.querySelector('.login-status').textContent = message;
  gate.querySelector('button').disabled = false;
}

async function begin() {
  const button = gate.querySelector('button');
  const status = gate.querySelector('.login-status');
  const flow = gate.querySelector('.login-flow');
  button.disabled = true;
  flow.hidden = true;
  status.textContent = '';
  clearTimeout(poll);
  try {
    const attempt = await auth('auth/begin', 'POST');
    flow.querySelector('a').href = attempt.link;
    flow.querySelector('strong').textContent = attempt.code;
    flow.hidden = false;
    status.textContent = 'Ожидаем подтверждение.';
    const wait = async () => {
      if (Date.now() >= attempt.expires) {
        showLogin('Код истёк. Запроси новый.');
        return;
      }
      try {
        const result = await auth('auth/finish', 'POST');
        if (result.state === 'authorized') {
          location.reload();
          return;
        }
        if (result.state === 'expired') {
          showLogin('Код истёк или превышено число попыток.');
          return;
        }
      } catch {
        status.textContent = 'Связь с панелью прервалась. Повторяем проверку.';
      }
      poll = setTimeout(wait, 1800);
    };
    poll = setTimeout(wait, 1200);
  } catch (error) {
    showLogin(error.message);
  }
}

gate.querySelector('button').addEventListener('click', begin);
try {
  const session = document.body.dataset.runtime === 'static' ? { demo: true } : await auth('session');
  if (session.demo || session.authenticated) {
    document.body.dataset.mode = session.demo ? 'demo' : 'live';
    await import('./app.js');
    gate.hidden = true;
    layout.hidden = false;
  } else showLogin();
} catch {
  showLogin('Не удалось проверить доступ к панели. Обнови страницу.');
}

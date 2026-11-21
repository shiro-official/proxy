import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const token = () => randomBytes(24).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const attemptLifetime = 5 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const safeEqual = (left, right) => typeof left === 'string' && timingSafeEqual(
  Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'),
);
const cookieValue = (request, name) =>
  (request.headers.cookie || '').match(new RegExp(`(?:^|; *)${name}=([a-zA-Z0-9_-]+)`))?.[1];

export function createAuth(db, config, requestFetch = fetch) {
  const { origin, ownerId, botName, botToken, masterKey } = config;
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
  const webhookSecret = createHmac('sha256', masterKey).update('ebunny-telegram-webhook-v1').digest('hex');
  const hashCode = (id, code) => createHmac('sha256', masterKey).update(`${id}:${code}`).digest('hex');

  db.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      browser TEXT PRIMARY KEY, link TEXT UNIQUE NOT NULL, pin TEXT NOT NULL, created INTEGER NOT NULL,
      expires INTEGER NOT NULL, claimed INTEGER, verified INTEGER NOT NULL DEFAULT 0,
      wrong INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, received INTEGER NOT NULL);
  `);

  function session(request) {
    const value = cookieValue(request, 'ebunny_session');
    return !!value && !!db.prepare('SELECT 1 FROM sessions WHERE token = ? AND expires > ?').get(digest(value), Date.now());
  }

  let requestsInWindow = [];
  function begin(request) {
    const now = Date.now();
    requestsInWindow = requestsInWindow.filter((created) => created > now - 60_000);
    if (requestsInWindow.length >= 20) {
      throw new RequestError(429, 'Слишком много запросов на вход. Повтори через минуту.');
    }
    requestsInWindow.push(now);
    const previous = cookieValue(request, 'ebunny_login');
    if (previous) db.prepare('DELETE FROM login_attempts WHERE browser = ?').run(digest(previous));
    db.prepare('DELETE FROM login_attempts WHERE expires <= ?').run(now);
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    const browserToken = token();
    const browser = digest(browserToken);
    const link = token();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    db.prepare('INSERT INTO login_attempts (browser, link, pin, created, expires) VALUES (?, ?, ?, ?, ?)').run(
      browser, digest(link), hashCode(browser, code), now, now + attemptLifetime,
    );
    return {
      body: { link: `https://t.me/${botName}?start=panel_${link}`, code, expires: now + attemptLifetime },
      cookies: [cookie('ebunny_login', browserToken, attemptLifetime / 1000)],
    };
  }

  function finish(request) {
    const browserToken = cookieValue(request, 'ebunny_login');
    const now = Date.now();
    const browser = browserToken && digest(browserToken);
    const attempt = browser && db.prepare('SELECT * FROM login_attempts WHERE browser = ? AND expires > ?').get(browser, now);
    if (!attempt || attempt.wrong >= 5) return { body: { state: 'expired' } };
    if (!attempt.verified) return { body: { state: 'pending' } };
    const sessionToken = token();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM login_attempts WHERE browser = ?').run(browser);
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(sessionToken), now + sessionLifetime);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      body: { state: 'authorized' },
      cookies: [cookie('ebunny_login', '', 0), cookie('ebunny_session', sessionToken, sessionLifetime / 1000)],
    };
  }

  function signOut(request) {
    const value = cookieValue(request, 'ebunny_session');
    if (value) db.prepare('DELETE FROM sessions WHERE token = ?').run(digest(value));
    return { body: { ok: true }, cookies: [cookie('ebunny_session', '', 0)] };
  }

  async function botApi(method, body) {
    const response = await requestFetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    }).catch(() => null);
    const result = await response?.json().catch(() => null);
    if (!response?.ok || !result?.ok) throw new RequestError(502, 'Telegram Bot API не ответил на запрос.');
  }

  async function onTelegram(update) {
    const message = update?.message;
    if (String(message?.from?.id) !== ownerId || message?.chat?.type !== 'private' ||
        String(message.chat.id) !== ownerId || !Number.isSafeInteger(update.update_id)) return;
    const now = Date.now();
    db.prepare('DELETE FROM telegram_updates WHERE received < ?').run(now - 86_400_000);
    if (!db.prepare('INSERT OR IGNORE INTO telegram_updates VALUES (?, ?)').run(update.update_id, now).changes) return;
    const reply = (text) => botApi('sendMessage', { chat_id: ownerId, text });
    const text = (message.text || '').trim();
    const link = text.match(/^\/start panel_([A-Za-z0-9_-]{32})$/)?.[1];
    if (link) {
      const attempt = db.prepare('UPDATE login_attempts SET claimed = ? WHERE link = ? AND expires > ? AND verified = 0 AND wrong < 5 RETURNING browser')
        .get(now, digest(link), now);
      return reply(attempt
        ? 'Если ты сама открыла панель eBunny, отправь сюда шестизначный код из её окна. Не используй коды, присланные другим человеком.'
        : 'Ссылка для входа истекла. Запроси новую в панели.');
    }
    if (/^\d{6}$/.test(text)) {
      const attempt = db.prepare('SELECT browser, pin FROM login_attempts WHERE claimed IS NOT NULL AND expires > ? AND verified = 0 AND wrong < 5 ORDER BY claimed DESC LIMIT 1').get(now);
      if (!attempt) return reply('Активного запроса нет. Открой ссылку из панели.');
      if (!safeEqual(attempt.pin, hashCode(attempt.browser, text))) {
        db.prepare('UPDATE login_attempts SET wrong = wrong + 1 WHERE browser = ?').run(attempt.browser);
        return reply('Код не подошёл. Сверь код в браузере.');
      }
      db.prepare('UPDATE login_attempts SET verified = 1 WHERE browser = ?').run(attempt.browser);
      return reply('Вход подтверждён. Вернись в браузер.');
    }
    return reply('Открой панель eBunny и нажми «Войти через Telegram».');
  }

  return {
    begin, finish, session, signOut, onTelegram,
    isTelegram: (request) => safeEqual(request.headers['x-telegram-bot-api-secret-token'], webhookSecret),
    registerWebhook: () => botApi('setWebhook', {
      url: `${origin}/api/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ['message'],
    }),
  };
}

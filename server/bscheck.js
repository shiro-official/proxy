import { isIPv4 } from 'node:net';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestError } from './auth.js';

const interval = 6 * 60_000;
const initialSettings = { target: '', operators: [], enabled: false, dailyLimit: 0 };
const moscowDay = (date) => Math.floor((date + 3 * 3600_000) / 86_400_000);
const errorCode = (value) => typeof value === 'string' && /^[a-z0-9_]{1,70}$/.test(value) ? value : 'upstream_error';
const validCredits = (value) => Number.isSafeInteger(value) && value >= 0;

function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function unseal(value, key) {
  const buffer = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(-16));
  return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString('utf8');
}

class BsError extends RequestError {
  constructor(status, code, retry, requestId) {
    super(status, `BSCheck: ${code}${requestId ? ` (${requestId})` : ''}`);
    this.code = code;
    this.retry = retry;
  }
}

function readResult(data, payload) {
  const byOperator = data.by_target?.[payload.target]?.by_operator ?? {};
  return payload.operators.map((key) => {
    const unit = byOperator[key];
    return {
      key,
      operator: unit?.operator ?? null,
      region: unit?.region ?? null,
      dpi: unit?.dpi ?? null,
      ok: typeof unit?.tcp?.ok === 'boolean' ? unit.tcp.ok : null,
      latency: typeof unit?.tcp?.latency_ms === 'number' ? unit.tcp.latency_ms : null,
      tls: unit?.tcp_is_tls === true,
    };
  });
}

export function createBscheck(db, masterKey, requestFetch = fetch) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bs_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bs_runs (
      id TEXT PRIMARY KEY, slot INTEGER UNIQUE, created INTEGER NOT NULL, day INTEGER NOT NULL,
      target TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, estimate INTEGER NOT NULL,
      cost INTEGER, result TEXT, error TEXT
    );
  `);
  db.prepare("UPDATE bs_runs SET state = 'unknown', error = 'interrupted' WHERE state = 'running'").run();
  const get = (key) => db.prepare('SELECT value FROM bs_settings WHERE key = ?').get(key)?.value;
  const put = (key, value) => db.prepare('INSERT OR REPLACE INTO bs_settings VALUES (?, ?)').run(key, value);
  const settings = () => JSON.parse(get('settings') ?? JSON.stringify(initialSettings));
  const configured = () => Boolean(get('api_key'));
  const apiKey = () => {
    if (!configured()) throw new RequestError(409, 'Сначала подключи ключ BSCheck.');
    return unseal(get('api_key'), masterKey);
  };
  let busy = false;
  let scheduleError = null;
  let lastSlot;

  async function call(path, key, body, id) {
    const response = await requestFetch(`https://bsbord.com/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(id ? { 'Idempotency-Key': id } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(id ? 100_000 : 15_000),
      redirect: 'error',
    }).catch(() => { throw new BsError(502, 'connection_failed', 2); });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const code = errorCode(data?.error?.code);
      const upstreamId = response.headers.get('x-request-id') ?? '';
      const requestId = /^[0-9a-z-]{1,80}$/i.test(upstreamId) ? upstreamId : '';
      const retry = code === 'request_in_progress' ? 2
        : response.status === 429 ? Math.max(1, Number(data?.error?.details?.retry_after) || 2) : 0;
      throw new BsError(response.ok ? 502 : response.status, code, retry, requestId);
    }
    return data;
  }

  const account = async (key = apiKey()) => {
    const data = await call('/account', key);
    return {
      tier: data.tier,
      balance: validCredits(data.balance_total) ? data.balance_total : data.balance_credits,
    };
  };

  const catalog = async (key = apiKey()) => {
    const data = await call('/operators', key);
    if (!Array.isArray(data.units)) throw new BsError(502, 'invalid_catalog', 0);
    return data.units.map(({ op_key, name, region, dpi, probeable }) => ({ key: op_key, name, region, dpi, probeable }));
  };

  function payloadFor(config) {
    if (!isIPv4(config.target) || !config.operators.length) throw new RequestError(400, 'Укажи IPv4 и выбери хотя бы одну сеть.');
    return { target: `${config.target}:443`, operators: config.operators, probes: { tcp: true }, dpi: 'any' };
  }

  async function preview(payload, key) {
    const data = await call('/probe/preview', key, payload);
    if (!validCredits(data.cost_credits)) throw new BsError(502, 'invalid_preview', 0);
    return { cost: data.cost_credits };
  }

  const spent = () => db.prepare(`SELECT coalesce(sum(CASE WHEN state = 'done' THEN cost ELSE estimate END), 0) AS n
    FROM bs_runs WHERE day = ? AND state IN ('running', 'done', 'unknown')`).get(moscowDay(Date.now())).n;

  async function startRun({ cap, slot = null, manualId }) {
    if (busy) throw new RequestError(409, 'Проверка уже выполняется.');
    busy = true;
    let id;
    try {
      if (slot !== null && db.prepare('SELECT 1 FROM bs_runs WHERE slot = ?').get(slot)) return;
      if (manualId) {
        const previous = db.prepare('SELECT state FROM bs_runs WHERE id = ?').get(manualId);
        if (previous) return { id: manualId, state: previous.state };
      }
      const config = settings();
      if (slot !== null && !config.enabled) return;
      const key = apiKey();
      const payload = payloadFor(config);
      if (slot !== null && spent() >= config.dailyLimit) throw new RequestError(409, 'Дневной лимит BSCheck исчерпан.');
      const { cost } = await preview(payload, key);
      if (slot !== null && !settings().enabled) return;
      if (slot === null && cost > cap) throw new RequestError(409, 'Цена выросла. Обнови оценку перед запуском.');
      if (slot !== null && spent() + cost > config.dailyLimit) throw new RequestError(409, 'Дневного лимита BSCheck не хватает на пробу.');
      const now = Date.now();
      id = manualId ?? randomUUID();
      db.prepare("INSERT INTO bs_runs VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL)")
        .run(id, slot, now, moscowDay(now), payload.target, JSON.stringify(payload), cost);
      const update = db.prepare('UPDATE bs_runs SET state = ?, cost = ?, result = ?, error = ? WHERE id = ?');
      try {
        let data;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            data = await call('/probe', key, payload, id);
            break;
          } catch (error) {
            if (!error.retry || error.retry > 15 || attempt === 2) throw error;
            await delay(error.retry * 1000);
          }
        }
        const charge = data.cost_credits ?? (data.outcome === 'no_dpi_on' ? 0 : null);
        if (!validCredits(charge)) throw new BsError(502, 'invalid_result', 0);
        update.run('done', charge, JSON.stringify(readResult(data, payload)), null, id);
        return { id, state: 'done' };
      } catch (error) {
        const knownRejection = error instanceof BsError && error.status < 500 &&
          !['request_in_progress', 'idempotency_key_reused'].includes(error.code);
        update.run(knownRejection ? 'failed' : 'unknown', null, null, error.message, id);
        throw error;
      }
    } finally {
      busy = false;
    }
  }

  function summary() {
    const history = db.prepare('SELECT id, created, target, state, estimate, cost, result, error FROM bs_runs ORDER BY created DESC LIMIT 30').all()
      .map((row) => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
    return { configured: configured(), settings: settings(), history, spent: spent(), scheduleError };
  }

  return {
    summary, account, catalog,
    pause() {
      put('settings', JSON.stringify({ ...settings(), enabled: false }));
      scheduleError = null;
      return { ok: true };
    },
    preview: () => preview(payloadFor(settings()), apiKey()),
    async setKey(body) {
      if (busy) throw new RequestError(409, 'Дождись окончания текущей проверки.');
      const key = String(body?.key ?? '').trim();
      if (!/^bsk_live_[A-Za-z0-9_-]{8,200}$/.test(key)) throw new RequestError(400, 'Нужен ключ формата bsk_live_… из личного кабинета.');
      const info = await account(key);
      if (busy) throw new RequestError(409, 'Дождись окончания текущей проверки.');
      db.exec('BEGIN');
      try {
        put('api_key', seal(key, masterKey));
        put('settings', JSON.stringify({ ...settings(), operators: [], enabled: false }));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return info;
    },
    async configure(body) {
      if (busy) throw new RequestError(409, 'Дождись окончания текущей проверки.');
      if (!isIPv4(body?.target) || !Array.isArray(body?.operators) || body.operators.length > 100 ||
          typeof body.enabled !== 'boolean' || !validCredits(body.dailyLimit) || body.dailyLimit > 1_000_000 ||
          (body.enabled && (!body.operators.length || !body.dailyLimit))) throw new RequestError(400, 'Проверь IPv4, выбранные сети и дневной лимит.');
      const operators = [...new Set(body.operators)];
      const key = apiKey();
      const available = new Set((await catalog(key)).map((unit) => unit.key));
      if (busy || key !== apiKey()) throw new RequestError(409, 'Настройки изменились. Повтори сохранение.');
      if (operators.some((operator) => !available.has(operator))) throw new RequestError(400, 'В списке есть неизвестная сеть BSCheck.');
      const config = { target: body.target, operators, enabled: body.enabled, dailyLimit: body.dailyLimit };
      put('settings', JSON.stringify(config));
      scheduleError = null;
      return config;
    },
    manual(body) {
      if (!validCredits(body?.cap) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(body?.id || '')) {
        throw new RequestError(400, 'Сначала оцени стоимость проверки.');
      }
      return startRun({ cap: body.cap, manualId: body.id });
    },
    async tick(now = Date.now()) {
      const config = settings();
      if (!config.enabled || busy) return;
      const slot = Math.floor(now / interval);
      if (slot === lastSlot) return;
      lastSlot = slot;
      try {
        await startRun({ slot });
        scheduleError = null;
      } catch (error) {
        scheduleError = error.message;
      }
    },
  };
}

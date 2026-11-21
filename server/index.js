import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuth, RequestError } from './auth.js';
import { createBscheck } from './bscheck.js';
import { readConfig } from './config.js';
import { createAudience } from './audience.js';
import { createTelemetry } from './telemetry.js';
import { createRollout } from './rollout.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8', true]],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8', true]],
  ['/bootstrap.js', ['bootstrap.js', 'text/javascript; charset=utf-8', true]],
  ['/assets/hero.webp', ['assets/hero.webp', 'image/webp', true]],
  ['/rollout.js', ['rollout.js', 'text/javascript; charset=utf-8', false]],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8', false]],
  ['/audience.js', ['audience.js', 'text/javascript; charset=utf-8', false]],
  ['/checks.js', ['checks.js', 'text/javascript; charset=utf-8', false]],
]);

async function jsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw new RequestError(415, 'Ожидается JSON.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 128 * 1024) throw new RequestError(413, 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new RequestError(400, 'Некорректный JSON.');
  }
}

function json(response, status, body, cookies) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cookies) response.setHeader('Set-Cookie', cookies);
  response.end(JSON.stringify(body));
}

export function createPanel(config, { db, requestFetch = fetch, tcpProbe } = {}) {
  if (!db) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const dbFile = join(config.dataDir, 'ebunny.sqlite');
    db = new DatabaseSync(dbFile);
    chmodSync(dbFile, 0o600);
    db.exec('PRAGMA journal_mode = WAL');
  }
  const auth = createAuth(db, config, requestFetch);
  const bs = createBscheck(db, config.masterKey, requestFetch);
  const audience = createAudience(db, config);
  const telemetry = createTelemetry(db, config.telemetryKey);
  const rollout = createRollout(db, config.cloud ?? { projects: [] }, requestFetch, tcpProbe);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:");
    if (config.origin.startsWith('https:')) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(request.url, config.origin).pathname;
      const route = `${request.method} ${path}`;
      if (route === 'POST /api/telegram/webhook') {
        if (!auth.isTelegram(request)) throw new RequestError(403, 'Доступ запрещён.');
        await auth.onTelegram(await jsonBody(request));
        return json(response, 200, { ok: true });
      }
      if (route === 'POST /api/telemetry/sample') {
        if (!telemetry.accepts(request)) throw new RequestError(403, 'Доступ запрещён.');
        return json(response, 200, telemetry.record(await jsonBody(request)));
      }
      if (route === 'POST /api/audience/start') {
        if (!audience.accepts(request)) throw new RequestError(403, 'Доступ запрещён.');
        return json(response, 200, audience.record(await jsonBody(request)));
      }
      if (request.method === 'POST' && request.headers.origin !== config.origin) {
        throw new RequestError(403, 'Недопустимый источник запроса.');
      }
      if (route === 'GET /api/session') return json(response, 200, { authenticated: auth.session(request) });
      if (route === 'POST /api/auth/begin') {
        const result = auth.begin(request);
        return json(response, 200, result.body, result.cookies);
      }
      if (route === 'POST /api/auth/finish') {
        const result = auth.finish(request);
        return json(response, 200, result.body, result.cookies);
      }
      if (route === 'POST /api/auth/logout') {
        const result = auth.signOut(request);
        return json(response, 200, result.body, result.cookies);
      }
      const asset = assets.get(path);
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
        const [file, contentType, publicFile] = asset;
        if (!publicFile && !auth.session(request)) throw new RequestError(401, 'Войди через Telegram.');
        response.setHeader('Content-Type', contentType);
        if (request.method === 'HEAD') return response.end();
        const content = readFileSync(new URL(`../${file}`, import.meta.url));
        return response.end(path === '/' ? content.toString().replace('data-runtime="static"', 'data-runtime="server"') : content);
      }
      if (!path.startsWith('/api/')) throw new RequestError(404, 'Страница не найдена.');
      if (!auth.session(request)) throw new RequestError(401, 'Сессия истекла. Войди через Telegram.');
      switch (route) {
        case 'GET /api/rollout': return json(response, 200, rollout.overview());
        case 'GET /api/rollout/dns': return json(response, 200, await rollout.dns());
        case 'POST /api/rollout/reserve': return json(response, 200, await rollout.reserve(await jsonBody(request)));
        case 'POST /api/rollout/refresh': return json(response, 200, await rollout.refresh(await jsonBody(request)));
        case 'POST /api/rollout/publish': return json(response, 200, await rollout.publish(await jsonBody(request)));
        case 'GET /api/telemetry': return json(response, 200, telemetry.report(new URL(request.url, config.origin).searchParams.get('period') ?? undefined));
        case 'GET /api/audience': return json(response, 200, audience.report());
        case 'GET /api/bscheck': return json(response, 200, bs.summary());
        case 'GET /api/bscheck/account': return json(response, 200, await bs.account());
        case 'GET /api/bscheck/operators': return json(response, 200, await bs.catalog());
        case 'POST /api/bscheck/key': return json(response, 200, await bs.setKey(await jsonBody(request)));
        case 'POST /api/bscheck/settings': return json(response, 200, await bs.configure(await jsonBody(request)));
        case 'POST /api/bscheck/pause': return json(response, 200, bs.pause());
        case 'POST /api/bscheck/preview': return json(response, 200, await bs.preview());
        case 'POST /api/bscheck/run': return json(response, 200, await bs.manual(await jsonBody(request)));
        default: throw new RequestError(404, 'Запрос не найден.');
      }
    } catch (error) {
      if (!(error instanceof RequestError)) console.error('Panel request failed:', error.name);
      json(response, error.status || 500, { error: error instanceof RequestError ? error.message : 'Внутренняя ошибка панели.' });
    }
  });
  server.requestTimeout = 30_000;
  return { server, db, auth, bs, rollout };
}

async function main() {
  const config = readConfig();
  if (process.argv.includes('--register-webhook')) {
    if (!config.origin.startsWith('https:')) throw new Error('Для webhook нужен публичный HTTPS-адрес панели.');
    const temporaryDb = new DatabaseSync(':memory:');
    try {
      await createAuth(temporaryDb, config).registerWebhook();
      console.log('Webhook Telegram установлен.');
    } finally {
      temporaryDb.close();
    }
    return;
  }
  const panel = createPanel(config);
  const timer = setInterval(() => void panel.bs.tick(), 15_000);
  timer.unref();
  if (config.cloud.projects.length) setInterval(() => void panel.rollout.poll(), 30_000).unref();
  panel.server.listen(config.port, config.host, () => console.log(`Панель слушает ${config.host}:${config.port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

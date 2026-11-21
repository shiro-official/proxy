import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPanel } from '../server/index.js';

const ownerId = '123456';
const masterKey = Buffer.alloc(32, 15);
const bsKey = 'bsk_live_test_only_key';
const telemetryKey = 'e'.repeat(64);
const audienceKey = 'a'.repeat(64);
const operator = 'mts|цфо|off';

test('Telegram login and BSCheck stay owner-only, paid runs are idempotent and respect the schedule budget', async (t) => {
  const db = new DatabaseSync(':memory:');
  let origin;
  let webhook;
  let replyCount = 0;
  let paidCalls = 0;
  let failOnce = false;
  const seenIds = [];
  const config = { origin: 'http://127.0.0.1', ownerId, masterKey, audienceKey, telemetryKey, botName: 'DemoPanelBot', botToken: '1:mock' };
  const requestFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (url.startsWith('https://api.telegram.org/')) {
      if (path.endsWith('/setWebhook')) webhook = JSON.parse(init.body);
      if (path.endsWith('/sendMessage')) replyCount += 1;
      return Response.json({ ok: true });
    }
    assert.equal(init.headers.Authorization, `Bearer ${bsKey}`);
    switch (path) {
      case '/v1/account': return Response.json({ tier: 'bronze', balance_total: 500 });
      case '/v1/operators':
        return Response.json({ units: [{ op_key: operator, name: 'МТС', region: 'ЦФО', dpi: 'off', probeable: true }] });
      case '/v1/probe/preview': return Response.json({ cost_credits: 10 });
      case '/v1/probe': {
        paidCalls += 1;
        seenIds.push(init.headers['Idempotency-Key']);
        const { target } = JSON.parse(init.body);
        if (failOnce) {
          failOnce = false;
          return Response.json({ error: { code: 'request_in_progress' } }, { status: 409 });
        }
        return Response.json({ cost_credits: 10, by_target: { [target]: { by_operator: {
          [operator]: { ok: true, operator: 'mts', region: 'ЦФО', dpi: 'off', tcp_is_tls: true, tcp: { ok: false } },
        } } } });
      }
      default: assert.fail(`Unexpected path: ${path}`);
    }
  };
  const panel = createPanel(config, { db, requestFetch });
  panel.server.listen(0, '127.0.0.1');
  await once(panel.server, 'listening');
  const base = `http://127.0.0.1:${panel.server.address().port}`;
  origin = config.origin;
  t.after(() => { panel.server.close(); db.close(); });
  let cookie = '';
  const request = (path, { method = 'GET', body, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { Cookie: cookie, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const post = (path, body, headers) => request(path, { method: 'POST', body, headers });
  const webhookSecret = createHmac('sha256', masterKey).update('ebunny-telegram-webhook-v1').digest('hex');
  const sendMessage = (id, text, updateId, secret = webhookSecret) => post('/api/telegram/webhook', {
    update_id: updateId, message: { from: { id: Number(id) }, chat: { type: 'private', id: Number(id) }, text },
  }, { 'X-Telegram-Bot-Api-Secret-Token': secret });

  await panel.auth.registerWebhook();
  assert.deepEqual(webhook, { url: `${origin}/api/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ['message'] });
  assert.equal((await request('/api/bscheck')).status, 401);
  assert.equal((await request('/api/audience')).status, 401);
  assert.equal((await request('/api/telemetry')).status, 401);
  assert.equal((await post('/api/telemetry/sample', { telemt: true })).status, 403);
  assert.equal((await post('/api/telemetry/sample', { telemt: true, connections: 42 }, { Authorization: `Bearer ${telemetryKey}` })).status, 200);
  assert.match(await (await request('/')).text(), /data-runtime="server"/);
  assert.equal((await request('/app.js')).status, 401);
  assert.equal((await request('/.panel-data/ebunny.sqlite')).status, 404);
  assert.equal((await post('/api/auth/begin', undefined, { Origin: 'https://other.example' })).status, 403);
  const first = await post('/api/auth/begin');
  const { link, code } = await first.json();
  cookie = first.headers.getSetCookie()[0].split(';')[0];
  const start = '/start ' + new URL(link).searchParams.get('start');
  assert.equal((await sendMessage(ownerId, start, 1, 'forged')).status, 403);
  await sendMessage('3333', start, 2);
  assert.equal(replyCount, 0);
  assert.equal((await (await post('/api/auth/finish')).json()).state, 'pending');
  await sendMessage(ownerId, start, 3);
  await sendMessage('3333', code, 4);
  assert.equal((await (await post('/api/auth/finish')).json()).state, 'pending');
  await sendMessage(ownerId, code === '000000' ? '000001' : '000000', 5);
  await sendMessage(ownerId, code, 6);
  const completion = await post('/api/auth/finish');
  assert.equal((await completion.json()).state, 'authorized');
  cookie = completion.headers.getSetCookie()[1].split(';')[0];
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await (await request('/api/telemetry?period=7d')).json()).connections, 42);
  const publishStart = (body, bearer = audienceKey) => post('/api/audience/start', body, { Authorization: `Bearer ${bearer}` });
  const event = { update_id: '101', telegram_id: '76543210' };
  assert.equal((await publishStart(event, 'bad')).status, 403);
  assert.equal((await (await publishStart(event)).json()).recorded, true);
  assert.equal((await (await publishStart(event)).json()).recorded, false);
  await publishStart({ ...event, update_id: '102' });
  assert.notEqual(db.prepare("SELECT account FROM audience_starts WHERE update_id = '101'").get().account, event.telegram_id);
  const audience = await (await request('/api/audience')).json();
  assert.equal(audience.days.at(-1).starts, 2);
  assert.equal(audience.unique[7], 1);

  assert.equal((await post('/api/bscheck/key', { key: bsKey })).status, 200);
  const ciphertext = db.prepare("SELECT value FROM bs_settings WHERE key = 'api_key'").get().value;
  assert.notEqual(ciphertext, bsKey);
  assert.doesNotMatch(await (await request('/api/bscheck')).text(), /bsk_live_/);
  assert.equal((await post('/api/bscheck/settings', { target: '192.0.2.10', operators: ['unknown'], enabled: false, dailyLimit: 0 })).status, 400);
  assert.equal((await post('/api/bscheck/settings', { target: '192.0.2.10', operators: [operator], enabled: false, dailyLimit: 0 })).status, 200);
  assert.equal((await (await post('/api/bscheck/preview', {})).json()).cost, 10);
  assert.equal((await post('/api/bscheck/run', { id: randomUUID(), cap: 5 })).status, 409);
  assert.equal(paidCalls, 0);
  const id = randomUUID();
  failOnce = true;
  assert.equal((await post('/api/bscheck/run', { id, cap: 10 })).status, 200);
  assert.deepEqual(seenIds, [id, id]);
  assert.equal((await post('/api/bscheck/run', { id, cap: 10 })).status, 200);
  assert.equal(paidCalls, 2);
  const run = (await (await request('/api/bscheck')).json()).history[0];
  assert.equal(run.result[0].ok, false);
  assert.equal(run.result[0].tls, true);

  await post('/api/bscheck/settings', { target: '192.0.2.10', operators: [operator], enabled: true, dailyLimit: 20 });
  const now = Date.now();
  await panel.bs.tick(now);
  await panel.bs.tick(now + 1000);
  await panel.bs.tick(now + 360_000);
  assert.equal(paidCalls, 3);
  const summary = await (await request('/api/bscheck')).json();
  assert.equal(summary.spent, 20);
  assert.match(summary.scheduleError, /лимит/i);
  await post('/api/bscheck/pause', {});
  assert.equal((await (await request('/api/bscheck')).json()).settings.enabled, false);
  await post('/api/auth/logout');
  assert.equal((await request('/api/bscheck')).status, 401);
});

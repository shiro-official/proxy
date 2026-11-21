import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRollout } from '../server/rollout.js';
import { validateCloudConfig } from '../server/providers.js';

test('manual rollout creates one reserve and switches the existing DNS record only after confirmation and a TCP check', async (t) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cloud = validateCloudConfig({
    projects: [{
      id: 'pilot', name: 'Test project', folderId: 'folder123', subnetId: 'subnet123',
      securityGroupId: 'security123', imageId: 'image1234', sshUser: 'bunny',
      sshPublicKey: `ssh-ed25519 ${'A'.repeat(68)} testing`,
      key: { id: 'testkey123', service_account_id: 'serviceaccount1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    }],
    cloudflare: { zoneId: 'a'.repeat(32), recordId: 'b'.repeat(32), token: 'c'.repeat(32) },
  });
  const active = '192.0.2.10';
  const candidate = '192.0.2.11';
  let nextIp = active;
  let patchCalls = 0;
  let createCalls = 0;
  let ready = false;
  let createBody;
  let tcpOpen = false;
  const tcp = async (ip) => {
    assert.equal(ip, candidate);
    return tcpOpen;
  };
  const controls = createRollout(db, cloud, async (url, options) => {
    const parsed = new URL(url);
    const body = options.body && JSON.parse(options.body);
    if (parsed.hostname === 'iam.api.cloud.yandex.net') {
      assert.equal(JSON.parse(Buffer.from(body.jwt.split('.')[0], 'base64url')).alg, 'PS256');
      return Response.json({ iamToken: 'test-token' });
    }
    if (parsed.hostname === 'compute.api.cloud.yandex.net' && options.method === 'POST') {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      createCalls += 1;
      createBody = body;
      return Response.json({ id: 'operation1' });
    }
    if (parsed.hostname === 'operation.api.cloud.yandex.net') {
      return Response.json(ready ? { done: true, response: { id: 'instance1' } } : { done: false });
    }
    if (parsed.hostname === 'compute.api.cloud.yandex.net') {
      return Response.json({
        id: 'instance1', name: createBody.name,
        labels: { 'ebunny-role': 'ingress-candidate' }, status: 'RUNNING',
        networkInterfaces: [{ primaryV4Address: { oneToOneNat: { address: candidate } } }],
      });
    }
    if (parsed.hostname === 'api.cloudflare.com') {
      assert(parsed.pathname.endsWith(cloud.cloudflare.recordId));
      if (options.method === 'PATCH') {
        assert.deepEqual(body, { content: candidate });
        patchCalls += 1;
        nextIp = body.content;
      }
      return Response.json({ result: { id: cloud.cloudflare.recordId, name: 'tg.ebunny.cloud', type: 'A', proxied: false, content: nextIp } });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, tcp);

  const id = randomUUID();
  await assert.rejects(controls.reserve({ requestId: id, project: 'pilot', confirmCost: false }), /платной ВМ/);
  const row = await controls.reserve({ requestId: id, project: 'pilot', confirmCost: true });
  assert.equal(row.state, 'pending');
  assert.equal(createBody.zoneId, 'ru-central1-d');
  assert.equal(createBody.platformId, 'standard-v3');
  assert.equal(createBody.bootDiskSpec.diskSpec.typeId, 'network-ssd');
  assert.equal(createBody.bootDiskSpec.diskSpec.size, '10737418240');
  assert.deepEqual(createBody.resourcesSpec, { cores: '2', coreFraction: '50', memory: '2147483648' });
  assert.match(createBody.metadata['user-data'], /ssh_authorized_keys/);
  assert.doesNotMatch(createBody.metadata['user-data'], /PRIVATE KEY|test-token/);
  assert.equal((await controls.reserve({ requestId: id, project: 'pilot', confirmCost: true })).id, id);
  await assert.rejects(controls.reserve({ requestId: randomUUID(), project: 'pilot', confirmCost: true }), /уже есть/);
  assert.equal(createCalls, 1);

  assert.equal((await controls.refresh({ id })).state, 'pending');
  ready = true;
  const readyRow = await controls.refresh({ id });
  assert.equal(readyRow.state, 'prepared');
  assert.equal(readyRow.ip, candidate);
  const request = { id, expectedIp: active, targetIp: candidate, confirmMtproto: true };
  await assert.rejects(controls.publish({ ...request, confirmMtproto: false }), /проверь резерв/i);
  await assert.rejects(controls.publish(request), /TCP 443/);
  assert.equal(patchCalls, 0);
  tcpOpen = true;
  await assert.rejects(controls.publish({ ...request, expectedIp: '192.0.2.50' }), /адрес изменился/);
  assert.equal(patchCalls, 0);

  assert.deepEqual(await controls.publish(request), { ip: candidate });
  assert.deepEqual(await controls.publish(request), { ip: candidate });
  assert.equal(patchCalls, 1);
  assert.equal(controls.overview().switches[0].previous_ip, active);
  assert.equal(controls.overview().candidates[0].state, 'active');
  assert.doesNotMatch(JSON.stringify(controls.overview()), /PRIVATE KEY|test-token/);
});

test('checks official user OAuth without creating a VM and requires explicit project selection', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const project = {
    folderId: 'folder123', subnetId: 'subnet123', securityGroupId: 'security123', imageId: 'image1234',
    sshUser: 'bunny', sshPublicKey: `ssh-ed25519 ${'A'.repeat(68)} testing`,
  };
  const firstToken = 'test-oauth-token-primary-123';
  const spareToken = 'test-oauth-token-secondary-456';
  const first = { ...project, id: 'primary', priority: 10, oauthToken: firstToken };
  const spare = { ...project, id: 'backup', priority: 20, folderId: 'folder222', oauthToken: spareToken };
  const config = validateCloudConfig({ projects: [spare, first] });
  assert.throws(() => validateCloudConfig({ projects: [{ ...first, oauthToken: 'not:a:bearer' }] }), /OAuth/);
  assert.throws(() => validateCloudConfig({ projects: [{ ...first, key: {} }] }), /один способ входа/);
  const sent = [];
  const rollout = createRollout(db, config, async (url, init) => {
    const host = new URL(url).hostname;
    const body = init.body && JSON.parse(init.body);
    sent.push(`${host} ${init.method}`);
    if (host === 'iam.api.cloud.yandex.net') {
      assert.deepEqual(body, { yandexPassportOauthToken: spareToken });
      return Response.json({ iamToken: 'short-lived-token' });
    }
    assert.equal(host, 'compute.api.cloud.yandex.net');
    assert.equal(init.headers.Authorization, 'Bearer short-lived-token');
    if (init.method === 'GET') {
      assert.equal(new URL(url).searchParams.get('folderId'), spare.folderId);
      assert.equal(new URL(url).searchParams.get('pageSize'), '1');
      return Response.json({ instances: [] });
    }
    assert.equal(body.folderId, spare.folderId);
    assert(!JSON.stringify(body).includes(spareToken));
    return Response.json({ id: 'operation2' });
  });

  assert.deepEqual(rollout.overview().projects.map(({ id, auth }) => [id, auth]), [['primary', 'oauth'], ['backup', 'oauth']]);
  rollout.setGrantState({ project: 'primary', state: 'exhausted' });
  await assert.rejects(rollout.reserve({ project: 'primary', requestId: randomUUID(), confirmCost: true }), /проект недоступен/i);
  await assert.rejects(rollout.reserve({ project: null, requestId: randomUUID(), confirmCost: true }), /ещё не подключён/i);
  assert.deepEqual(await rollout.checkProject({ project: 'backup' }), { ok: true, project: 'backup' });
  assert.equal(rollout.overview().candidates.length, 0);
  const request = { project: 'backup', requestId: randomUUID(), confirmCost: true };
  const created = await rollout.reserve(request);
  assert.equal(created.project, 'backup');
  assert.equal(created.state, 'pending');
  rollout.setGrantState({ project: 'backup', state: 'paused' });
  assert.equal((await rollout.reserve(request)).id, created.id);
  await assert.rejects(rollout.reserve({ ...request, requestId: randomUUID() }), /проект недоступен/i);
  assert.deepEqual(sent, ['iam.api.cloud.yandex.net POST', 'compute.api.cloud.yandex.net GET', 'compute.api.cloud.yandex.net POST']);
  const publicState = JSON.stringify(rollout.overview());
  assert(!publicState.includes(firstToken));
  assert(!publicState.includes(spareToken));
});

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
  let denied = false;
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
      if (denied) return Response.json({ code: 7, message: 'Sensitive test response' }, {
        status: 403, headers: { 'x-request-id': 'request-for-support' },
      });
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
  denied = true;
  const failed = await controls.reserve({ requestId: randomUUID(), project: 'pilot', confirmCost: true });
  assert.equal(failed.state, 'failed');
  assert.match(failed.message, /HTTP 403 \(7\).*request-for-support/);
  assert.equal(patchCalls, 1);
  assert.doesNotMatch(JSON.stringify(controls.overview()), /PRIVATE KEY|test-token|Sensitive test response/);
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

test('discovers resources with one identity, imports a project and only creates a reserve after opt-in', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sharedToken = 'test-shared-oauth-token-123';
  const cloud = validateCloudConfig({ projects: [], discovery: {
    oauthToken: sharedToken, sshUser: 'bunny', sshPublicKey: `ssh-ed25519 ${'A'.repeat(68)} testing`,
    imageFamily: 'ubuntu-2404-lts',
  } });
  let writes = 0;
  let fail = false;
  const now = 1_700_000_000_000;
  const controls = createRollout(db, cloud, async (url, init) => {
    const parsed = new URL(url);
    const { pathname, searchParams } = parsed;
    if (parsed.hostname === 'iam.api.cloud.yandex.net') {
      assert.deepEqual(JSON.parse(init.body), { yandexPassportOauthToken: sharedToken });
      return Response.json({ iamToken: 'short-iam-token' });
    }
    assert.equal(init.headers.Authorization, 'Bearer short-iam-token');
    if (pathname.endsWith('/clouds')) {
      return searchParams.has('pageToken')
        ? Response.json({ clouds: [{ id: 'cloudtwo2', name: 'Shared cloud' }] })
        : Response.json({ clouds: [{ id: 'cloudone1', name: 'Main cloud' }], nextPageToken: 'page-two' });
    }
    if (pathname.endsWith('/folders')) {
      assert.equal(searchParams.get('cloudId'), 'cloudone1');
      return Response.json({ folders: [{ id: 'folder123', name: 'Pilot', status: 'ACTIVE' }, { id: 'folder456', name: 'Removed', status: 'DELETING' }] });
    }
    if (pathname.endsWith('/subnets')) return Response.json({ subnets: [
      { id: 'subnet123', name: 'Entrance', networkId: 'network123', zoneId: 'ru-central1-d' },
      { id: 'subnet456', name: 'Other zone', networkId: 'network123', zoneId: 'ru-central1-a' },
    ] });
    if (pathname.endsWith('/securityGroups')) return Response.json({ securityGroups: [
      { id: 'group1234', name: 'Ingress', networkId: 'network123', status: 'ACTIVE' },
      { id: 'group5678', name: 'Different network', networkId: 'network456', status: 'ACTIVE' },
    ] });
    if (pathname.endsWith('/images:latestByFamily')) {
      assert.equal(searchParams.get('folderId'), 'standard-images');
      assert.equal(searchParams.get('family'), 'ubuntu-2404-lts');
      return Response.json({ id: 'image1234', status: 'READY' });
    }
    if (pathname.endsWith('/instances') && init.method === 'GET') return Response.json({ instances: [] });
    if (pathname.endsWith('/instances') && init.method === 'POST') {
      writes += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.folderId, 'folder123');
      assert.equal(body.networkInterfaceSpecs[0].subnetId, 'subnet123');
      assert.equal(body.bootDiskSpec.diskSpec.imageId, 'image1234');
      assert(!JSON.stringify(body).includes(sharedToken));
      return fail ? Response.json({
        code: 8, message: 'Quota compute.instanceCores.count.ru-central1-d exceeded. Sensitive diagnostic text.',
      }, { status: 429 }) : Response.json({ id: 'operation1' });
    }
    assert.fail(`Unexpected request: ${url}`);
  });

  assert.equal(controls.overview().discovery, true);
  assert.equal(controls.overview().automation.enabled, false);
  assert.equal((await controls.clouds()).length, 2);
  assert.deepEqual(await controls.folders('cloudone1'), [{ id: 'folder123', name: 'Pilot' }]);
  assert.equal((await controls.networkResources('folder123')).subnets.length, 1);
  await assert.rejects(controls.importProject({ folderId: 'folder123', name: 'Pilot', subnetId: 'subnet123', securityGroupId: 'group5678' }), /в той же сети/);
  const args = { folderId: 'folder123', name: 'Pilot', subnetId: 'subnet123', securityGroupId: 'group1234' };
  const project = await controls.importProject(args);
  await assert.rejects(controls.importProject(args), /уже подключён/);
  assert(!JSON.stringify(controls.overview()).includes(sharedToken));
  await controls.replenish(now);
  assert.equal(writes, 0);
  assert.throws(() => controls.setAutomation({ enabled: true, project: project.id }), /подтверди расходы/);
  controls.setAutomation({ enabled: true, project: project.id, confirmCost: true });
  await Promise.all([controls.replenish(now), controls.replenish(now)]);
  await controls.replenish(now + 20 * 60_000);
  assert.equal(writes, 1);
  const row = controls.overview().candidates[0];
  db.prepare("UPDATE ingress_candidates SET state = 'active' WHERE id = ?").run(row.id);
  await controls.replenish(now + 1000);
  assert.equal(writes, 1);

  fail = true;
  await controls.replenish(now + 20 * 60_000);
  assert.equal(writes, 2);
  assert.equal(controls.overview().automation.enabled, false);
  const declined = controls.overview().candidates.find(({ state }) => state === 'failed');
  assert.match(declined.message, /HTTP 429 \(8\).*compute\.instanceCores\.count\.ru-central1-d/);
  assert.doesNotMatch(declined.message, /Sensitive diagnostic text/);
  await controls.replenish(now + 40 * 60_000);
  assert.equal(writes, 2);
});

test('reconciles older explicit quota rejections after a successful lookup and preserves other uncertain operations', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const project = {
    id: 'pilot', oauthToken: 'test-oauth-token-primary-123', folderId: 'folder123',
    subnetId: 'subnet123', securityGroupId: 'security123', imageId: 'image1234',
    sshUser: 'bunny', sshPublicKey: `ssh-ed25519 ${'A'.repeat(68)} testing`,
  };
  let available = false;
  let instance;
  const controls = createRollout(db, validateCloudConfig({ projects: [project] }), async (url, init) => {
    const { hostname } = new URL(url);
    if (hostname === 'iam.api.cloud.yandex.net') return Response.json({ iamToken: 'test-token' });
    assert.equal(hostname, 'compute.api.cloud.yandex.net');
    assert.equal(init.method, 'GET');
    assert.equal(new URL(url).searchParams.get('folderId'), project.folderId);
    if (!available) return Response.json({ code: 8 }, { status: 429 });
    return Response.json({ instances: instance ? [instance] : [] });
  });
  const write = db.prepare("INSERT INTO ingress_candidates VALUES (?, ?, ?, ?, 'uncertain', NULL, NULL, NULL, ?)");
  const quota = 'Yandex Compute: HTTP 429 (8).';
  write.run('old', project.id, 'ebunny-quota-old', 1, quota);
  await assert.rejects(controls.refresh({ id: 'old' }), /HTTP 429/);
  assert.equal(controls.overview().candidates[0].state, 'uncertain');
  available = true;
  assert.equal((await controls.refresh({ id: 'old' })).state, 'failed');
  write.run('unknown', project.id, 'ebunny-unknown', 2, 'Yandex Compute: ответ не получен.');
  assert.equal((await controls.refresh({ id: 'unknown' })).state, 'uncertain');
  db.prepare("UPDATE ingress_candidates SET state = 'failed' WHERE id = 'unknown'").run();
  write.run('found', project.id, 'ebunny-found', 3, quota);
  instance = {
    id: 'instance1', name: 'ebunny-found', labels: { 'ebunny-role': 'ingress-candidate' }, status: 'RUNNING',
    networkInterfaces: [{ primaryV4Address: { oneToOneNat: { address: '192.0.2.111' } } }],
  };
  assert.equal((await controls.refresh({ id: 'found' })).state, 'prepared');
});

import { constants, createPrivateKey, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { RequestError } from './auth.js';

const iamUrl = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const computeUrl = 'https://compute.api.cloud.yandex.net/compute/v1/instances';
const operationsUrl = 'https://operation.api.cloud.yandex.net/operations';
const dnsName = 'tg.ebunny.cloud';
const safeId = (value) => typeof value === 'string' && /^[a-z0-9]{8,64}$/i.test(value);
const yamlString = (value) => JSON.stringify(value);

export function validateCloudConfig(value) {
  if (value == null) return { projects: [] };
  if (!Array.isArray(value.projects) || value.projects.length > 20) throw new Error('Некорректный список проектов Yandex Cloud.');
  const keys = new Set();
  for (const project of value.projects) {
    if (!project || !/^[a-z0-9-]{1,32}$/.test(project.id ?? '') || keys.has(project.id) ||
        ![project.folderId, project.subnetId, project.securityGroupId, project.imageId].every(safeId) ||
        !/^[a-z_][a-z0-9_-]{0,31}$/.test(project.sshUser ?? '') || project.sshUser === 'root' ||
        !/^ssh-ed25519 [A-Za-z0-9+/=]{60,120}(?: [^\r\n]{1,120})?$/.test(project.sshPublicKey ?? '') ||
        (project.name != null && (typeof project.name !== 'string' || project.name.length > 80)) ||
        !safeId(project.key?.id) || !safeId(project.key?.service_account_id)) {
      throw new Error('Некорректные параметры одного из проектов Yandex Cloud.');
    }
    try {
      const privateKey = createPrivateKey(project.key.private_key.replace(/^PLEASE DO NOT REMOVE THIS LINE![^\n]*\r?\n/, ''));
      if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
    } catch {
      throw new Error('Не удалось прочитать RSA-ключ сервисного аккаунта Yandex Cloud.');
    }
    keys.add(project.id);
  }
  if (value.cloudflare != null && (!/^[a-f0-9]{32}$/i.test(value.cloudflare.zoneId ?? '') ||
      !/^[a-f0-9]{32}$/i.test(value.cloudflare.recordId ?? '') ||
      !/^[a-zA-Z0-9_-]{20,200}$/.test(value.cloudflare.token ?? ''))) {
    throw new Error('Некорректные параметры Cloudflare.');
  }
  return value;
}

class ProviderError extends RequestError {
  constructor(provider, upstreamStatus, code) {
    super(502, `${provider}: ${upstreamStatus ? `HTTP ${upstreamStatus}` : 'ответ не получен'}${code ? ` (${code})` : ''}.`);
    this.upstreamStatus = upstreamStatus;
  }
}

const asCode = (value) => /^[A-Za-z0-9_.-]{1,48}$/.test(String(value ?? '')) ? String(value) : null;

async function api(requestFetch, provider, url, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await requestFetch(url, {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new ProviderError(provider, null); });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.success === false) {
    throw new ProviderError(provider, response.status, asCode(data?.errors?.[0]?.code ?? data?.code));
  }
  return data;
}

function jwt(key, now) {
  const iat = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'PS256', kid: key.id })}.${encode({ iss: key.service_account_id, aud: iamUrl, iat, exp: iat + 300 })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: key.private_key.replace(/^PLEASE DO NOT REMOVE THIS LINE![^\n]*\r?\n/, ''),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function vmRequest(project, name) {
  const userData = [
    '#cloud-config',
    'users:',
    `  - name: ${yamlString(project.sshUser)}`,
    '    groups: [sudo]',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '    sudo: ["ALL=(ALL) NOPASSWD:ALL"]',
    `    ssh_authorized_keys: [${yamlString(project.sshPublicKey)}]`,
    'ssh_pwauth: false',
    'disable_root: true',
    'package_update: true',
    'packages: [wireguard-tools, nftables, curl, iputils-ping, python3]',
  ].join('\n') + '\n';
  return {
    folderId: project.folderId,
    name,
    labels: { 'ebunny-role': 'ingress-candidate' },
    zoneId: 'ru-central1-d',
    platformId: 'standard-v3',
    resourcesSpec: { cores: '2', coreFraction: '50', memory: '2147483648' },
    schedulingPolicy: { preemptible: false },
    bootDiskSpec: { autoDelete: true, diskSpec: { typeId: 'network-ssd', size: '10737418240', imageId: project.imageId } },
    networkInterfaceSpecs: [{
      subnetId: project.subnetId, securityGroupIds: [project.securityGroupId],
      primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: 'IPV4' } },
    }],
    metadata: { 'user-data': userData },
  };
}

export function createProviders(config, requestFetch) {
  const tokens = new Map();
  async function getToken(project) {
    const existing = tokens.get(project.id);
    const now = Date.now();
    if (existing && existing.expires > now + 60_000) return existing.token;
    const data = await api(requestFetch, 'Yandex IAM', iamUrl, { method: 'POST', body: { jwt: jwt(project.key, now) } });
    if (typeof data.iamToken !== 'string' || !data.iamToken) throw new ProviderError('Yandex IAM', null);
    tokens.set(project.id, { token: data.iamToken, expires: Date.parse(data.expiresAt) || now + 300_000 });
    return data.iamToken;
  }

  async function compute(project, url, options) {
    return api(requestFetch, 'Yandex Compute', url, { ...options, token: await getToken(project) });
  }

  async function getDns() {
    const cf = config.cloudflare;
    if (!cf) throw new RequestError(409, 'Сначала подключи Cloudflare.');
    const url = `https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records/${cf.recordId}`;
    const data = await api(requestFetch, 'Cloudflare', url, { token: cf.token });
    const record = data.result;
    if (record?.type !== 'A' || record.name !== dnsName || record.proxied !== false ||
        record.id !== cf.recordId || !isIPv4(record.content)) {
      throw new RequestError(409, 'В Cloudflare ожидается A-запись tg.ebunny.cloud в режиме DNS only.');
    }
    return { url, ip: record.content };
  }

  return {
    prepareProject: async (project) => { await getToken(project); },
    create: (project, name) => compute(project, computeUrl, { method: 'POST', body: vmRequest(project, name) }),
    operation: (project, id) => compute(project, `${operationsUrl}/${encodeURIComponent(id)}`),
    instance: (project, id) => compute(project, `${computeUrl}/${encodeURIComponent(id)}`),
    async find(project, name) {
      const query = new URLSearchParams({ folderId: project.folderId, filter: `name = "${name}"`, pageSize: '10' });
      const data = await compute(project, `${computeUrl}?${query}`);
      const matches = (data.instances ?? []).filter((instance) => instance.name === name && instance.labels?.['ebunny-role'] === 'ingress-candidate');
      if (matches.length > 1) throw new RequestError(409, 'Найдено несколько ВМ с этим именем.');
      return matches[0];
    },
    async dns() {
      return { ip: (await getDns()).ip };
    },
    async switchDns(current, target) {
      const record = await getDns();
      if (record.ip === target) return { ip: target };
      if (record.ip !== current) throw new RequestError(409, 'DNS изменился. Обнови экран перед переключением.');
      const result = await api(requestFetch, 'Cloudflare', record.url, {
        method: 'PATCH', token: config.cloudflare.token, body: { content: target },
      });
      if (result.result?.content !== target) throw new RequestError(502, 'Cloudflare не подтвердил новый адрес.');
      const verified = await getDns();
      if (verified.ip !== target) throw new RequestError(502, 'Проверка DNS после переключения не прошла.');
      return { ip: target };
    },
  };
}

export const providerId = safeId;
export const rejectedRequest = (error) => error instanceof ProviderError &&
  [400, 401, 403, 404, 422].includes(error.upstreamStatus);

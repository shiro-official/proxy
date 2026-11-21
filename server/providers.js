import { constants, createPrivateKey, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { RequestError } from './auth.js';

const iamUrl = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const computeUrl = 'https://compute.api.cloud.yandex.net/compute/v1/instances';
const resourceUrl = 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1';
const vpcUrl = 'https://vpc.api.cloud.yandex.net/vpc/v1';
const imageUrl = 'https://compute.api.cloud.yandex.net/compute/v1/images:latestByFamily';
export const ingressZone = 'ru-central1-d';
const operationsUrl = 'https://operation.api.cloud.yandex.net/operations';
const dnsName = 'tg.ebunny.cloud';
const safeId = (value) => typeof value === 'string' && /^[a-z0-9]{8,64}$/i.test(value);
const yamlString = (value) => JSON.stringify(value);
export const grantStates = ['available', 'exhausted', 'paused'];
const oauthTokenValid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,4000}$/.test(value);

function sshSettingsValid(entry) {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(entry.sshUser ?? '') && entry.sshUser !== 'root' &&
    /^ssh-ed25519 [A-Za-z0-9+/=]{60,120}(?: [^\r\n]{1,120})?$/.test(entry.sshPublicKey ?? '');
}

function validateIdentity(entry) {
  if (entry.oauthToken !== undefined) {
    if (entry.key !== undefined || !oauthTokenValid(entry.oauthToken)) {
      throw new Error('Задай один способ входа в Яндекс: OAuth-токен либо ключ сервисного аккаунта.');
    }
    return;
  }
  try {
    if (!safeId(entry.key?.id) || !safeId(entry.key?.service_account_id)) throw new Error();
    const privateKey = createPrivateKey(entry.key.private_key.replace(/^PLEASE DO NOT REMOVE THIS LINE![^\n]*\r?\n/, ''));
    if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch {
    throw new Error('Не удалось прочитать RSA-ключ сервисного аккаунта Yandex Cloud.');
  }
}

export function validateCloudConfig(value) {
  if (value == null) return { projects: [] };
  if (!Array.isArray(value.projects) || value.projects.length > 20) throw new Error('Некорректный список проектов Yandex Cloud.');
  const keys = new Set();
  for (const project of value.projects) {
    if (!project || !/^[a-z0-9-]{1,32}$/.test(project.id ?? '') || keys.has(project.id) ||
        ![project.folderId, project.subnetId, project.securityGroupId, project.imageId].every(safeId) ||
        !sshSettingsValid(project) ||
        (project.name != null && (typeof project.name !== 'string' || project.name.length > 80)) ||
        (project.priority != null && (!Number.isSafeInteger(project.priority) || project.priority < 1 || project.priority > 10000)) ||
        (project.grantState != null && !grantStates.includes(project.grantState))) {
      throw new Error('Некорректные параметры одного из проектов Yandex Cloud.');
    }
    validateIdentity(project);
    keys.add(project.id);
  }
  const discovery = value.discovery;
  if (discovery != null) {
    if (typeof discovery !== 'object' || !sshSettingsValid(discovery) ||
        (discovery.organizationId != null && !safeId(discovery.organizationId)) ||
        (discovery.imageId != null && !safeId(discovery.imageId)) ||
        (discovery.imageFamily != null && !/^[a-z][a-z0-9-]{2,62}$/.test(discovery.imageFamily)) ||
        (discovery.imageId && discovery.imageFamily)) {
      throw new Error('Некорректный общий шаблон обнаружения ресурсов Яндекса.');
    }
    validateIdentity(discovery);
  }
  if (value.cloudflare != null && (!/^[a-f0-9]{32}$/i.test(value.cloudflare.zoneId ?? '') ||
      !/^[a-f0-9]{32}$/i.test(value.cloudflare.recordId ?? '') ||
      !/^[a-zA-Z0-9_-]{20,200}$/.test(value.cloudflare.token ?? ''))) {
    throw new Error('Некорректные параметры Cloudflare.');
  }
  return value;
}

class ProviderError extends RequestError {
  constructor(provider, upstreamStatus, code, requestId, hint) {
    super(502, `${provider}: ${upstreamStatus ? `HTTP ${upstreamStatus}` : 'ответ не получен'}${code ? ` (${code})` : ''}.${requestId ? ` ID запроса: ${requestId}.` : ''}${hint ? ` ${hint}` : ''}`);
    this.upstreamStatus = upstreamStatus;
    this.provider = provider;
    this.code = code;
  }
}

const asCode = (value) => /^[A-Za-z0-9_.-]{1,48}$/.test(String(value ?? '')) ? String(value) : null;

const exhaustedCode = (code) => ['8', 'RESOURCE_EXHAUSTED'].includes(String(code));
export const isComputeExhaustion = (message) => /^Yandex Compute: (?:HTTP 429 \((?:8|RESOURCE_EXHAUSTED)\)|RESOURCE_EXHAUSTED \(8\))\./.test(message ?? '');

function quotaHint(error) {
  const text = JSON.stringify({ message: error?.message, details: error?.details }).slice(0, 20_000);
  const keys = [...new Set(text.match(/(?:compute\.(?:instanceCores\.count|instanceMemory\.size|ssdDisks\.size)(?:\.ru-central1-[a-z])?|compute\.(?:instances|disks)\.count|vpc\.external(?:Static)?Addresses\.count)(?![a-zA-Z0-9_.-])/g))];
  return keys.length ? `Квота: ${keys.join(', ')}.` : '';
}

export function operationFailure(error) {
  if (String(error.code) === '7') return 'Yandex Compute: PERMISSION_DENIED (7).';
  if (exhaustedCode(error.code)) return ['Yandex Compute: RESOURCE_EXHAUSTED (8).', quotaHint(error)].filter(Boolean).join(' ');
  return 'Yandex Cloud завершил создание ВМ с ошибкой.';
}

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
    const trace = (response.headers.get('x-request-id') ?? response.headers.get('x-server-trace-id') ?? '').trim();
    const requestId = /^[A-Za-z0-9._-]{6,120}$/.test(trace) ? trace : null;
    const code = asCode(data?.errors?.[0]?.code ?? data?.code);
    const hint = provider === 'Yandex Compute' && response.status === 429 && exhaustedCode(code) ? quotaHint(data) : '';
    throw new ProviderError(provider, response.status, code, requestId, hint);
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
    zoneId: ingressZone,
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
  async function getToken(project, force = false) {
    const existing = tokens.get(project.id);
    const now = Date.now();
    if (!force && existing && existing.expires > now + 60_000) return existing.token;
    const body = project.oauthToken
      ? { yandexPassportOauthToken: project.oauthToken }
      : { jwt: jwt(project.key, now) };
    const data = await api(requestFetch, 'Yandex IAM', iamUrl, { method: 'POST', body });
    if (typeof data.iamToken !== 'string' || !data.iamToken) throw new ProviderError('Yandex IAM', null);
    tokens.set(project.id, { token: data.iamToken, expires: Date.parse(data.expiresAt) || now + 300_000 });
    return data.iamToken;
  }

  async function compute(project, url, options) {
    try {
      return await api(requestFetch, 'Yandex Compute', url, { ...options, token: await getToken(project) });
    } catch (error) {
      if (!(error instanceof ProviderError) || error.upstreamStatus !== 401) throw error;
      tokens.delete(project.id);
      return api(requestFetch, 'Yandex Compute', url, { ...options, token: await getToken(project) });
    }
  }

  const catalogIdentity = config.discovery && { ...config.discovery, id: ':discovery' };
  const catalogGet = async (provider, url) => {
    if (!catalogIdentity) throw new RequestError(409, 'Сначала подключи общий доступ Yandex Cloud.');
    return api(requestFetch, provider, url, { token: await getToken(catalogIdentity) });
  };

  async function listCatalog(provider, endpoint, field, filter) {
    const query = new URLSearchParams({ ...filter, pageSize: '100' });
    const resources = [];
    for (let page = 0; page < 10; page += 1) {
      const response = await catalogGet(provider, `${endpoint}?${query}`);
      const items = response[field] ?? [];
      if (!Array.isArray(items)) throw new ProviderError(provider, null);
      resources.push(...items);
      if (!response.nextPageToken) return resources;
      query.set('pageToken', response.nextPageToken);
    }
    throw new RequestError(409, 'Слишком много ресурсов для одного списка.');
  }

  const catalogItem = ({ id, name }) => ({ id, name: typeof name === 'string' ? name : id });

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
    async clouds() {
      const filter = config.discovery?.organizationId ? { organizationId: config.discovery.organizationId } : {};
      const clouds = await listCatalog('Yandex Resource Manager', `${resourceUrl}/clouds`, 'clouds', filter);
      return clouds.filter(({ id }) => safeId(id)).map(catalogItem);
    },
    async folders(cloudId) {
      if (!safeId(cloudId)) throw new RequestError(400, 'Некорректный ID облака.');
      const folders = await listCatalog('Yandex Resource Manager', `${resourceUrl}/folders`, 'folders', { cloudId });
      return folders.filter(({ id, status }) => safeId(id) && status === 'ACTIVE').map(catalogItem);
    },
    async networkResources(folderId) {
      if (!safeId(folderId)) throw new RequestError(400, 'Некорректный ID каталога.');
      const [subnets, securityGroups] = await Promise.all([
        listCatalog('Yandex VPC', `${vpcUrl}/subnets`, 'subnets', { folderId }),
        listCatalog('Yandex VPC', `${vpcUrl}/securityGroups`, 'securityGroups', { folderId }),
      ]);
      return {
        subnets: subnets.filter(({ id, networkId, zoneId }) => safeId(id) && safeId(networkId) && zoneId === ingressZone)
          .map((subnet) => ({ ...catalogItem(subnet), networkId: subnet.networkId })),
        securityGroups: securityGroups.filter(({ id, networkId, status }) => safeId(id) && safeId(networkId) && status === 'ACTIVE')
          .map((group) => ({ ...catalogItem(group), networkId: group.networkId })),
      };
    },
    async templateImage() {
      if (!catalogIdentity) throw new RequestError(409, 'Сначала подключи общий доступ Yandex Cloud.');
      if (catalogIdentity.imageId) return catalogIdentity.imageId;
      const query = new URLSearchParams({ folderId: 'standard-images', family: catalogIdentity.imageFamily ?? 'ubuntu-2404-lts' });
      const image = await catalogGet('Yandex Compute', `${imageUrl}?${query}`);
      if (!safeId(image.id) || image.status !== 'READY') throw new RequestError(502, 'Образ из шаблона ещё недоступен.');
      return image.id;
    },
    prepareProject: async (project) => { await getToken(project); },
    async checkProject(project) {
      const accessToken = await getToken(project, true);
      const query = new URLSearchParams({ folderId: project.folderId, pageSize: '1' });
      const data = await api(requestFetch, 'Yandex Compute', `${computeUrl}?${query}`, { token: accessToken });
      if (!Array.isArray(data.instances ?? [])) throw new ProviderError('Yandex Compute', null);
    },
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
  ([400, 401, 403, 404, 422].includes(error.upstreamStatus) ||
    (error.provider === 'Yandex Compute' && error.upstreamStatus === 429 && exhaustedCode(error.code)));

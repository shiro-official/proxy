import { createHash, randomUUID } from 'node:crypto';
import { connect, isIPv4 } from 'node:net';
import { RequestError } from './auth.js';
import { createProviders, grantStates, providerId, rejectedRequest } from './providers.js';

function probeTcp(ip) {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port: 443, family: 4 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(5000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function createRollout(db, config, requestFetch, tcp = probeTcp) {
  const providers = createProviders(config, requestFetch);
  const projects = new Map(config.projects.map((project, index) => [project.id, {
    ...project, priority: project.priority ?? (index + 1) * 10,
  }]));
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingress_candidates (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT UNIQUE NOT NULL, created INTEGER NOT NULL,
      state TEXT NOT NULL, operation_id TEXT, instance_id TEXT, ip TEXT, message TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_ingress_per_project ON ingress_candidates(project)
      WHERE state IN ('creating', 'pending', 'uncertain', 'prepared');
    CREATE TABLE IF NOT EXISTS cloud_discovered_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT UNIQUE NOT NULL,
      subnet_id TEXT NOT NULL, security_group_id TEXT NOT NULL, image_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reserve_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), project TEXT,
      enabled INTEGER NOT NULL, last_attempt INTEGER, message TEXT
    );
    CREATE TABLE IF NOT EXISTS cloud_grant_state (
      project TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dns_rollouts (
      id TEXT PRIMARY KEY, candidate TEXT NOT NULL, created INTEGER NOT NULL,
      previous_ip TEXT NOT NULL, target_ip TEXT NOT NULL, state TEXT NOT NULL, message TEXT
    );
  `);
  const grantFor = db.prepare('SELECT state, updated FROM cloud_grant_state WHERE project = ?');
  const grantState = (project) => grantFor.get(project.id)?.state ?? project.grantState ?? 'available';
  const savedProject = db.prepare('SELECT * FROM cloud_discovered_projects WHERE id = ?');
  const savedProjects = db.prepare('SELECT * FROM cloud_discovered_projects ORDER BY rowid');
  const policyFor = db.prepare('SELECT * FROM reserve_policy WHERE singleton = 1');
  const policy = () => policyFor.get() ?? { project: null, enabled: 0, last_attempt: null, message: null };
  const policyView = () => {
    const row = policy();
    return { project: row.project, enabled: !!row.enabled, lastAttempt: row.last_attempt, message: row.message };
  };
  const pause = db.prepare('UPDATE reserve_policy SET enabled = 0, message = ? WHERE singleton = 1 AND project = ?');
  const existingReserve = db.prepare(`SELECT 1 FROM ingress_candidates WHERE project = ?
    AND state IN ('creating', 'pending', 'uncertain', 'prepared')`);
  const newestCandidate = db.prepare('SELECT state FROM ingress_candidates WHERE project = ? ORDER BY created DESC LIMIT 1');

  function materialize(row) {
    if (!row || !config.discovery) return undefined;
    const { key, oauthToken, sshUser, sshPublicKey } = config.discovery;
    return {
      id: row.id, name: row.name, folderId: row.folder_id, subnetId: row.subnet_id,
      securityGroupId: row.security_group_id, imageId: row.image_id,
      priority: 1000, key, oauthToken, sshUser, sshPublicKey,
    };
  }

  function orderedProjects() {
    const discovered = config.discovery ? savedProjects.all().map(materialize).filter((item) => !projects.has(item.id)) : [];
    return [...projects.values(), ...discovered].sort((left, right) => left.priority - right.priority);
  }
  const rowFor = db.prepare('SELECT * FROM ingress_candidates WHERE id = ?');
  const update = db.prepare('UPDATE ingress_candidates SET state = ?, message = ? WHERE id = ?');
  let switching = false;
  const refreshing = new Set();
  let polling = false;
  let replenishing = false;

  function projectFor(id) {
    const project = typeof id === 'string' && (projects.get(id) ?? materialize(savedProject.get(id)));
    if (!project) throw new RequestError(409, 'Этот проект Яндекса ещё не подключён.');
    return project;
  }

  function candidateFor(id) {
    const row = typeof id === 'string' && rowFor.get(id);
    if (!row) throw new RequestError(404, 'ВМ не найдена в панели.');
    return row;
  }

  function ingestInstance(row, instance) {
    if (!providerId(instance?.id) || instance.name !== row.name ||
        instance.labels?.['ebunny-role'] !== 'ingress-candidate') {
      throw new RequestError(502, 'Yandex Cloud не подтвердил данные созданной ВМ.');
    }
    const ip = instance.networkInterfaces?.[0]?.primaryV4Address?.oneToOneNat?.address;
    const state = instance.status === 'RUNNING' && isIPv4(ip) ? 'prepared'
      : ['ERROR', 'CRASHED', 'STOPPED'].includes(instance.status) ? 'failed' : 'pending';
    db.prepare('UPDATE ingress_candidates SET instance_id = ?, ip = ?, state = ?, message = ? WHERE id = ?')
      .run(instance.id, isIPv4(ip) ? ip : null, state, state === 'failed' ? String(instance.status) : null, row.id);
    return rowFor.get(row.id);
  }

  const rollout = {
    overview() {
      return {
        discovery: !!config.discovery,
        automation: policyView(),
        projects: orderedProjects().map((project) => ({
          id: project.id,
          name: project.name || project.id,
          priority: project.priority,
          auth: project.oauthToken ? 'oauth' : 'service-account',
          grantState: grantState(project),
          grantUpdated: grantFor.get(project.id)?.updated ?? null,
        })),
        cloudflare: !!config.cloudflare,
        candidates: db.prepare('SELECT * FROM ingress_candidates ORDER BY created DESC LIMIT 50').all(),
        switches: db.prepare('SELECT * FROM dns_rollouts ORDER BY created DESC LIMIT 10').all(),
      };
    },
    dns: providers.dns,
    clouds: providers.clouds,
    folders: providers.folders,
    networkResources: providers.networkResources,
    async importProject(body) {
      if (!config.discovery) throw new RequestError(409, 'Сначала подключи общий доступ Yandex Cloud.');
      const { folderId, subnetId, securityGroupId } = body ?? {};
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (![folderId, subnetId, securityGroupId].every(providerId) || name.length > 80) {
        throw new RequestError(400, 'Укажи каталог, подсеть и группу безопасности.');
      }
      if (orderedProjects().some((project) => project.folderId === folderId)) {
        throw new RequestError(409, 'Этот каталог уже подключён.');
      }
      const id = `catalog-${createHash('sha256').update(folderId).digest('hex').slice(0, 16)}`;
      if (projects.has(id)) throw new RequestError(409, 'Имя проекта уже используется.');
      const { subnets, securityGroups } = await providers.networkResources(folderId);
      const subnet = subnets.find((item) => item.id === subnetId);
      const group = securityGroups.find((item) => item.id === securityGroupId);
      if (!subnet || !group || subnet.networkId !== group.networkId) {
        throw new RequestError(400, 'Выбери доступную подсеть ru-central1-d и группу в той же сети.');
      }
      const imageId = await providers.templateImage();
      const row = { id, name: name || folderId, folder_id: folderId, subnet_id: subnetId, security_group_id: securityGroupId, image_id: imageId };
      await providers.checkProject(materialize(row));
      const inserted = db.prepare('INSERT OR IGNORE INTO cloud_discovered_projects VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, row.name, folderId, subnetId, securityGroupId, imageId);
      if (!inserted.changes) throw new RequestError(409, 'Этот каталог уже подключён.');
      return { id, name: row.name };
    },
    setAutomation(body) {
      if (typeof body?.enabled !== 'boolean') throw new RequestError(400, 'Выбери состояние автосоздания.');
      if (!body.enabled) {
        db.prepare('UPDATE reserve_policy SET enabled = 0, message = NULL WHERE singleton = 1').run();
        return policyView();
      }
      const project = projectFor(body.project);
      if (body.confirmCost !== true || grantState(project) !== 'available') {
        throw new RequestError(400, 'Выбери доступный проект и подтверди расходы на резерв.');
      }
      db.prepare(`INSERT INTO reserve_policy VALUES (1, ?, 1, NULL, NULL)
        ON CONFLICT(singleton) DO UPDATE SET project = excluded.project, enabled = 1, message = NULL,
        last_attempt = CASE WHEN reserve_policy.project = excluded.project THEN reserve_policy.last_attempt END`).run(project.id);
      return policyView();
    },
    async checkProject(body) {
      const project = projectFor(body?.project);
      await providers.checkProject(project);
      return { ok: true, project: project.id };
    },
    setGrantState(body) {
      const project = projectFor(body?.project);
      if (!grantStates.includes(body?.state)) throw new RequestError(400, 'Неизвестное состояние проекта.');
      db.prepare('INSERT OR REPLACE INTO cloud_grant_state VALUES (?, ?, ?)').run(project.id, body.state, Date.now());
      return { state: body.state };
    },
    async reserve(body, automatic = false) {
      if (body?.confirmCost !== true || typeof body.requestId !== 'string' ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(body.requestId)) {
        throw new RequestError(400, 'Подтверди создание платной ВМ.');
      }
      const id = body.requestId;
      const project = projectFor(body.project);
      const matchingOperation = () => {
        const row = rowFor.get(id);
        if (row && row.project !== project.id) {
          throw new RequestError(409, 'Идентификатор уже использован для другого проекта.');
        }
        return row;
      };
      const prior = matchingOperation();
      if (prior) return prior;
      if (grantState(project) !== 'available') {
        throw new RequestError(409, 'Выбранный проект недоступен для создания ВМ. Сверь состояние в Billing.');
      }
      await providers.prepareProject(project);
      const concurrent = matchingOperation();
      if (concurrent) return concurrent;
      if (grantState(project) !== 'available') {
        throw new RequestError(409, 'Проект сменил статус. Обнови данные перед созданием ВМ.');
      }
      if (automatic) {
        const current = policy();
        if (!current.enabled || current.project !== project.id) {
          throw new RequestError(409, 'Автосоздание отключено.');
        }
      }
      if (existingReserve.get(project.id)) {
        throw new RequestError(409, 'В этом проекте уже есть резерв или незавершённая операция.');
      }
      const name = `ebunny-${id.replaceAll('-', '')}`;
      db.prepare("INSERT INTO ingress_candidates VALUES (?, ?, ?, ?, 'creating', NULL, NULL, NULL, NULL)")
        .run(id, project.id, name, Date.now());
      refreshing.add(id);
      try {
        const operation = await providers.create(project, name);
        if (!providerId(operation.id)) throw new RequestError(502, 'Yandex Cloud не вернул ID операции.');
        db.prepare("UPDATE ingress_candidates SET state = 'pending', operation_id = ? WHERE id = ?").run(operation.id, id);
      } catch (error) {
        update.run(rejectedRequest(error) ? 'failed' : 'uncertain', error.message, id);
      } finally {
        refreshing.delete(id);
      }
      return rowFor.get(id);
    },

    async refresh(body) {
      const row = candidateFor(body?.id);
      if (['active', 'failed'].includes(row.state) || refreshing.has(row.id) || switching) return row;
      const project = projectFor(row.project);
      refreshing.add(row.id);
      try {
        if (row.operation_id) {
          const op = await providers.operation(project, row.operation_id);
          if (op.error) {
            update.run('failed', 'Yandex Cloud завершил создание ВМ с ошибкой.', row.id);
            return rowFor.get(row.id);
          }
          if (!op.done) return row;
          const instanceId = op.response?.id ?? op.metadata?.instanceId;
          if (providerId(instanceId)) return ingestInstance(row, await providers.instance(project, instanceId));
        }
        const instance = row.instance_id ? await providers.instance(project, row.instance_id) : await providers.find(project, row.name);
        return instance ? ingestInstance(row, instance) : row;
      } finally {
        refreshing.delete(row.id);
      }
    },

    async replenish(now = Date.now()) {
      if (replenishing || switching) return;
      const current = policy();
      if (!current.enabled) return;
      replenishing = true;
      try {
        const project = projectFor(current.project);
        if (grantState(project) !== 'available') {
          pause.run('Проект недоступен. Проверь Billing и включи автосоздание снова.', project.id);
          return;
        }
        if (existingReserve.get(project.id)) return;
        if (newestCandidate.get(project.id)?.state === 'failed') {
          pause.run('Последнее создание ВМ завершилось ошибкой. Проверь результат и повтори создание вручную.', project.id);
          return;
        }
        if (current.last_attempt && now - current.last_attempt < 10 * 60_000) return;
        db.prepare('UPDATE reserve_policy SET last_attempt = ? WHERE singleton = 1 AND project = ?').run(now, project.id);
        const row = await rollout.reserve({ project: project.id, confirmCost: true, requestId: randomUUID() }, true);
        if (row.state === 'failed' || row.state === 'uncertain') {
          pause.run('Яндекс не подтвердил создание резерва. Сверь операцию перед повторным запуском.', project.id);
        }
      } catch (error) {
        const latest = policy();
        if (latest.enabled && latest.project === current.project && !existingReserve.get(current.project)) {
          pause.run(error instanceof RequestError ? error.message : 'Не удалось создать резерв.', current.project);
        }
      } finally {
        replenishing = false;
      }
    },

    async poll() {
      if (polling || switching) return;
      polling = true;
      try {
        const pending = db.prepare("SELECT id FROM ingress_candidates WHERE state IN ('creating', 'pending', 'uncertain') ORDER BY created LIMIT 20").all();
        for (const row of pending) {
          try {
            await rollout.refresh(row);
          } catch {
            // The saved operation can be checked again after transient provider failures.
          }
        }
      } finally {
        polling = false;
      }
    },

    async publish(body) {
      if (switching) throw new RequestError(409, 'Другое переключение DNS ещё выполняется.');
      const row = candidateFor(body?.id);
      if (refreshing.has(row.id)) throw new RequestError(409, 'Дождись обновления статуса ВМ.');
      if (body?.confirmMtproto !== true || !isIPv4(body.expectedIp) || !isIPv4(row.ip) ||
          !['prepared', 'active'].includes(row.state)) throw new RequestError(400, 'Проверь резерв через Telegram и подтверди текущий IP.');
      switching = true;
      let eventId;
      try {
        const current = await providers.dns();
        if (current.ip !== row.ip && current.ip !== body.expectedIp) {
          throw new RequestError(409, 'Текущий адрес изменился. Сверь DNS и повтори проверку.');
        }
        if (row.state === 'active' && current.ip === row.ip) return current;
        if (row.state === 'active') throw new RequestError(409, 'Эта ВМ уже переключалась. Сверь DNS вручную.');
        const instance = await providers.instance(projectFor(row.project), row.instance_id);
        const actual = instance.networkInterfaces?.[0]?.primaryV4Address?.oneToOneNat?.address;
        if (instance.id !== row.instance_id || instance.name !== row.name ||
            instance.labels?.['ebunny-role'] !== 'ingress-candidate' ||
            instance.status !== 'RUNNING' || actual !== row.ip || body.targetIp !== row.ip) {
          throw new RequestError(409, 'Адрес или статус резерва изменился. Обнови ВМ и проверь её снова.');
        }
        if (!await tcp(row.ip)) throw new RequestError(409, 'TCP 443 резерва недоступен. DNS сохранён.');
        eventId = randomUUID();
        db.prepare("INSERT INTO dns_rollouts VALUES (?, ?, ?, ?, ?, 'pending', NULL)")
          .run(eventId, row.id, Date.now(), body.expectedIp, row.ip);
        const result = await providers.switchDns(body.expectedIp, row.ip);
        db.exec('BEGIN');
        try {
          update.run('active', null, row.id);
          db.prepare("UPDATE dns_rollouts SET state = 'done' WHERE id = ?").run(eventId);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return result;
      } catch (error) {
        if (eventId) db.prepare("UPDATE dns_rollouts SET state = 'uncertain', message = ? WHERE id = ?").run(error.message, eventId);
        throw error;
      } finally {
        switching = false;
      }
    },
  };
  return rollout;
}

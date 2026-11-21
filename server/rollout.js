import { randomUUID } from 'node:crypto';
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
  const orderedProjects = [...projects.values()].sort((left, right) => left.priority - right.priority);
  const rowFor = db.prepare('SELECT * FROM ingress_candidates WHERE id = ?');
  const update = db.prepare('UPDATE ingress_candidates SET state = ?, message = ? WHERE id = ?');
  let switching = false;
  const refreshing = new Set();
  let polling = false;

  function projectFor(id) {
    const project = projects.get(id);
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
        projects: orderedProjects.map((project) => ({
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
    setGrantState(body) {
      const project = projectFor(body?.project);
      if (!grantStates.includes(body?.state)) throw new RequestError(400, 'Неизвестное состояние проекта.');
      db.prepare('INSERT OR REPLACE INTO cloud_grant_state VALUES (?, ?, ?)').run(project.id, body.state, Date.now());
      return { state: body.state };
    },
    async reserve(body) {
      if (body?.confirmCost !== true || typeof body.requestId !== 'string' ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(body.requestId)) {
        throw new RequestError(400, 'Подтверди создание платной ВМ.');
      }
      const id = body.requestId;
      const preferred = body.project === null;
      const matchingOperation = () => {
        const row = rowFor.get(id);
        if (row && !preferred && row.project !== body.project) {
          throw new RequestError(409, 'Идентификатор уже использован для другого проекта.');
        }
        return row;
      };
      const prior = matchingOperation();
      if (prior) return prior;
      const project = preferred
        ? orderedProjects.find((item) => grantState(item) === 'available') : projectFor(body.project);
      if (!project || grantState(project) !== 'available') {
        throw new RequestError(409, 'Нет доступного проекта. Сверь состояние в Billing.');
      }
      await providers.prepareProject(project);
      const concurrent = matchingOperation();
      if (concurrent) return concurrent;
      if (grantState(project) !== 'available') {
        throw new RequestError(409, 'Проект сменил статус. Обнови данные перед созданием ВМ.');
      }
      if (db.prepare("SELECT 1 FROM ingress_candidates WHERE project = ? AND state IN ('creating', 'pending', 'uncertain', 'prepared')").get(project.id)) {
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

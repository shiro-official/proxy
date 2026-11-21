import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { RequestError } from './auth.js';

const minute = 60_000;
const day = 24 * 60 * minute;
const staleAfter = 3 * minute;
const bucketMinutes = { '24h': 15, '7d': 120, '30d': 480 };
const daysPerPeriod = { '24h': 1, '7d': 7, '30d': 30 };
const digest = (value) => createHash('sha256').update(value).digest();
const optional = (value, validate) => value === null || value === undefined || validate(value);
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counter = (value) => Number.isSafeInteger(value) && value >= 0;

export function createTelemetry(db, key) {
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_telemetry (
    minute INTEGER PRIMARY KEY, observed INTEGER NOT NULL, telemt INTEGER NOT NULL,
    connections INTEGER, bytes INTEGER, uptime REAL,
    wireguard INTEGER, latency REAL, ingress_ip TEXT, exit_ip TEXT
  )`);
  const replace = db.prepare('INSERT OR REPLACE INTO proxy_telemetry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM proxy_telemetry WHERE minute < ?');
  const latestSample = db.prepare('SELECT * FROM proxy_telemetry ORDER BY minute DESC LIMIT 1');
  const within = db.prepare('SELECT * FROM proxy_telemetry WHERE minute >= ? ORDER BY minute');

  return {
    accepts(request) {
      const header = request.headers.authorization;
      return !!key && typeof header === 'string' && timingSafeEqual(digest(header), digest(`Bearer ${key}`));
    },
    record(body, now = Date.now()) {
      const { telemt, connections, bytes, uptime, wireguard, latency, ingressIp, exitIp } = body ?? {};
      if (typeof telemt !== 'boolean' || !optional(connections, counter) || !optional(bytes, counter) ||
          !optional(uptime, nonnegative) || !optional(wireguard, (value) => typeof value === 'boolean') ||
          !optional(latency, (value) => nonnegative(value) && value < 60_000) ||
          !optional(ingressIp, isIPv4) || !optional(exitIp, isIPv4) ||
          (!telemt && [connections, bytes, uptime].some((value) => value != null)) ||
          (latency != null && wireguard !== true)) {
        throw new RequestError(400, 'Некорректный замер прокси.');
      }
      const slot = Math.floor(now / minute);
      replace.run(slot, now, Number(telemt), connections ?? null, bytes ?? null, uptime ?? null,
        wireguard == null ? null : Number(wireguard), latency ?? null, ingressIp ?? null, exitIp ?? null);
      prune.run(slot - 31 * 24 * 60);
      return { ok: true };
    },
    report(period = '24h', now = Date.now()) {
      if (!Object.hasOwn(bucketMinutes, period)) throw new RequestError(400, 'Неизвестный период.');
      const latest = latestSample.get();
      const from = now - daysPerPeriod[period] * day;
      const step = bucketMinutes[period] * minute;
      const chart = new Map();
      let last;
      let bytes = 0;
      let coverageSeconds = 0;
      for (const sample of within.all(Math.floor(Math.min(from, now - day) / minute))) {
        if (sample.observed >= from && sample.connections != null) {
          const bucket = Math.floor((sample.observed - from) / step);
          const previous = chart.get(bucket);
          if (!previous || previous.value <= sample.connections) {
            chart.set(bucket, { bucket, at: sample.observed, value: sample.connections });
          }
        }
        if (last && last.observed >= now - day && sample.bytes != null && last.bytes != null &&
            sample.uptime != null && last.uptime != null) {
          const elapsed = sample.observed - last.observed;
          const uptimeChange = (sample.uptime - last.uptime) * 1000;
          if (elapsed <= staleAfter && uptimeChange > 0 && Math.abs(uptimeChange - elapsed) < 15_000 &&
              sample.bytes >= last.bytes) {
            bytes += sample.bytes - last.bytes;
            coverageSeconds += elapsed / 1000;
          }
        }
        last = sample;
      }
      const fresh = !!latest && now - latest.observed <= staleAfter;
      return {
        configured: !!key,
        fresh,
        observedAt: latest?.observed ?? null,
        telemt: fresh ? !!latest.telemt : null,
        connections: fresh ? latest.connections : null,
        wireguard: fresh && latest.wireguard != null ? !!latest.wireguard : null,
        latency: fresh ? latest.latency : null,
        ingressIp: latest?.ingress_ip ?? null,
        exitIp: latest?.exit_ip ?? null,
        traffic: coverageSeconds ? { bytes, coverageSeconds: Math.floor(coverageSeconds) } : null,
        chart: { from, to: now, points: [...chart.values()] },
      };
    },
  };
}

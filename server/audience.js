import { createHmac, timingSafeEqual } from 'node:crypto';
import { RequestError } from './auth.js';

const dayLength = 86_400_000;
const moscowOffset = 3 * 3600_000;
const dayIndex = (time) => Math.floor((time + moscowOffset) / dayLength);

export function createAudience(db, { audienceKey, masterKey }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audience_starts (
    update_id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    day INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audience_starts_day ON audience_starts(day);`);
  const hash = (value) => createHmac('sha256', masterKey).update(value).digest();
  return {
    accepts(request) {
      const header = request.headers.authorization;
      return !!audienceKey && typeof header === 'string' &&
        timingSafeEqual(hash(header), hash(`Bearer ${audienceKey}`));
    },
    record(body, now = Date.now()) {
      const updateId = body?.update_id;
      const telegramId = body?.telegram_id;
      if (typeof updateId !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(updateId) ||
          typeof telegramId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(telegramId)) {
        throw new RequestError(400, 'Нужны update_id и telegram_id в виде строк.');
      }
      const digest = hash(`audience-start:${telegramId}`).toString('hex');
      const inserted = db.prepare('INSERT OR IGNORE INTO audience_starts VALUES (?, ?, ?)').run(updateId, digest, dayIndex(now)).changes;
      return { ok: true, recorded: inserted === 1 };
    },
    report(now = Date.now()) {
      if (!audienceKey) return { configured: false };
      const today = dayIndex(now);
      const firstDay = today - 29;
      const byDay = new Map(db.prepare('SELECT day, count(*) AS starts FROM audience_starts WHERE day BETWEEN ? AND ? GROUP BY day')
        .all(firstDay, today).map((row) => [row.day, row.starts]));
      const unique = db.prepare('SELECT count(DISTINCT account) AS total FROM audience_starts WHERE day BETWEEN ? AND ?');
      return {
        configured: true,
        days: Array.from({ length: 30 }, (_, index) => {
          const day = firstDay + index;
          return { date: new Date(day * dayLength).toISOString().slice(0, 10), starts: byDay.get(day) ?? 0 };
        }),
        unique: { 7: unique.get(today - 6, today).total, 30: unique.get(firstDay, today).total },
      };
    },
  };
}

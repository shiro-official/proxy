import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { validateCloudConfig } from './providers.js';

export function readConfig(env = process.env) {
  const origin = new URL(env.PANEL_ORIGIN || 'http://127.0.0.1:4180');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.href !== origin.origin + '/' ||
      (origin.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(origin.hostname))) {
    throw new Error('PANEL_ORIGIN должен быть HTTPS-адресом либо локальным HTTP-адресом.');
  }
  if (!/^\d{1,16}$/.test(env.TELEGRAM_OWNER_ID || '') ||
      !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(env.TELEGRAM_PANEL_BOT || '') ||
      !/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_PANEL_BOT_TOKEN || '') ||
      !/^[a-f\d]{64}$/i.test(env.PANEL_MASTER_KEY || '')) {
    throw new Error('Задай TELEGRAM_OWNER_ID, TELEGRAM_PANEL_BOT, TELEGRAM_PANEL_BOT_TOKEN и PANEL_MASTER_KEY в .env.');
  }
  if (env.AUDIENCE_INGEST_KEY && !/^[a-f\d]{64}$/i.test(env.AUDIENCE_INGEST_KEY)) {
    throw new Error('AUDIENCE_INGEST_KEY должен содержать 64 hex-символа.');
  }
  if (env.TELEMETRY_INGEST_KEY && !/^[a-f\d]{64}$/i.test(env.TELEMETRY_INGEST_KEY)) {
    throw new Error('TELEMETRY_INGEST_KEY должен содержать 64 hex-символа.');
  }
  const bundled = env.CREDENTIALS_DIRECTORY && join(env.CREDENTIALS_DIRECTORY, 'ebunny-cloud.json');
  const cloudPath = env.PANEL_CLOUD_CONFIG_PATH || (bundled && existsSync(bundled) ? bundled : undefined);
  let cloud;
  if (cloudPath) {
    try {
      cloud = JSON.parse(readFileSync(cloudPath, 'utf8'));
    } catch {
      throw new Error('Не удалось прочитать JSON конфигурации облачных API.');
    }
  }
  return {
    cloud: validateCloudConfig(cloud),
    telemetryKey: env.TELEMETRY_INGEST_KEY,
    audienceKey: env.AUDIENCE_INGEST_KEY,
    origin: origin.origin,
    ownerId: env.TELEGRAM_OWNER_ID,
    botName: env.TELEGRAM_PANEL_BOT,
    botToken: env.TELEGRAM_PANEL_BOT_TOKEN,
    masterKey: Buffer.from(env.PANEL_MASTER_KEY, 'hex'),
    dataDir: resolve(env.PANEL_DATA_DIR || '.panel-data'),
    host: env.PANEL_BIND || '127.0.0.1',
    port: Number(env.PANEL_PORT || 4180),
  };
}

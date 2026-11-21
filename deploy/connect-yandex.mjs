import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { validateCloudConfig } from '../server/providers.js';

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Не удалось прочитать JSON: ${label}.`);
  }
}

export function connectYandex(file, keyFile, publicKey, sshUser = 'bunny') {
  const config = existsSync(file) ? readJson(file, 'конфигурация панели') : { projects: [] };
  if (config.discovery != null) throw new Error('Общий доступ уже настроен. Проверь блок discovery в конфигурации.');
  const key = readJson(keyFile, 'авторизованный ключ Яндекса');
  const next = {
    ...config,
    discovery: { key, sshUser, sshPublicKey: publicKey.trim(), imageFamily: 'ubuntu-2404-lts' },
  };
  validateCloudConfig(next);
  const staging = mkdtempSync(join(dirname(file), '.ebunny-cloud-'));
  try {
    const prepared = join(staging, 'config.json');
    writeFileSync(prepared, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(prepared, file);
  } finally {
    rmSync(staging, { recursive: true });
  }
}

async function main() {
  const [keyFile, sshUser] = process.argv.slice(2);
  if (!keyFile || !process.stdin.isTTY) {
    throw new Error('Запусти скрипт от root в SSH: node deploy/connect-yandex.mjs <путь-к-JSON> [имя-SSH-пользователя]');
  }
  if (!existsSync(keyFile)) throw new Error('Загрузи JSON-ключ сервисного аккаунта на VPS.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let publicKey;
  try {
    publicKey = await terminal.question('Вставь публичный SSH-ключ (строку ssh-ed25519): ');
  } finally {
    terminal.close();
  }
  connectYandex('/etc/ebunny-cloud.json', keyFile, publicKey, sshUser);
  console.log('Общий доступ сохранён в /etc/ebunny-cloud.json.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

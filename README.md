# eBunny

Локальный прототип панели MTProto-прокси. Интерфейс загружает демонстрационные метрики. Добавленные EU-ноды сохраняются как черновики в браузере.

## Запуск

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Откройте http://127.0.0.1:4173. В этом режиме доступны демоданные. Для входа через Telegram и BSCheck используйте серверный запуск ниже.

## Профиль входной ВМ

Ubuntu 24.04 LTS, Intel Ice Lake Shared-core, 2 vCPU с гарантированной долей 50%, 2 ГиБ RAM, SSD 10 ГиБ, зона ru-central1-d. Публичный IPv4 назначается автоматически. Доступ по SSH-ключу. Защита от DDoS и резервное копирование выключены.

## Аудитория

На странице «Аудитория» демонстрационный график показывает новые подписки на канал и запуски бота с параметром `start=mtproxy`. Telegram предоставляет статистику новых подписчиков по источникам для каналов с доступной статистикой. Переходы по промоблоку «Спонсор прокси» отображаются отдельно как недоступные. В серверной панели данные о запусках появляются после подключения событий бота. Статистика подписок требует отдельной интеграции со статистикой канала.

## Приватная панель с Telegram и BSCheck

Публичный адрес панели — **https://my.ebunny.cloud**. Нужен хост с Node.js 24 или новее и HTTPS на порту 443. Создайте отдельного бота для входа через @BotFather. Существующий @eBunnyAPP продолжит принимать запуски из закрепа.

1. Скопируйте `.env.example` в `.env` с правами `0600`. Укажите числовой ID владельца, username отдельного бота без `@`, токен и мастер-ключ из `openssl rand -hex 32`. Храните мастер-ключ вместе с защищённой копией конфигурации. Он нужен для расшифровки ключа BSCheck после перезапуска.
2. Создайте в Cloudflare запись A `my` на публичный IPv4 хоста панели в режиме DNS only. В `.env.example` уже указан `PANEL_ORIGIN=https://my.ebunny.cloud`. Запустите один экземпляр панели через `npm start`. Добавьте блок из `Caddyfile` в конфигурацию Caddy на этом хосте. Он принимает HTTPS на `my.ebunny.cloud` и передаёт запросы на `127.0.0.1:4180`. Для выпуска сертификата Caddy понадобятся доступные порты 80 и 443. База SQLite хранится в `.panel-data/`, путь можно задать через `PANEL_DATA_DIR`.
3. Проверьте `curl -fsS https://my.ebunny.cloud/api/session`. После этого на запущенном сервере выполните `npm run telegram:webhook`. В браузере нажмите «Войти через Telegram», перейдите в бота и отправьте ему код, показанный в этом окне. Один аккаунт имеет право подтвердить вход. Начатый вход действует 5 минут, сессия действует 8 часов.
4. На bsbord.com откройте **API** в левом меню и выпустите ключ `bsk_live_…`. После входа в панель вставьте его в **Проверки → API-ключ BSCheck**. Панель никогда не возвращает сохранённый ключ в браузер.
5. Укажите публичный IPv4 входной ВМ, выберите сети и сохраните настройки. «Оценить стоимость» не запускает платную пробу. Разовую проверку оплачивает отдельная кнопка с подтверждённой оценкой. Для расписания раз в 6 минут включите его вручную и укажите дневной бюджет в кредитах. При замене ключа расписание ставится на паузу. Данные и история сохраняются в SQLite.

В серверном обзоре метрики прокси пока демонстрационные. В панели используются `@eBunnyVPN` для канала и `@eBunnyAPP` для бота.

### Установка как служба на Ubuntu

Перед запуском проверьте, что публичные TCP-порты 80 и 443 доступны на сервере панели. Если на них уже работает обратный прокси, добавьте в него отдельный виртуальный хост для `my.ebunny.cloud` с проксированием на `127.0.0.1:4180`.

Подключитесь к VPS по SSH. Для установки из GitHub выполните `sudo git clone --branch panel --single-branch https://github.com/shiro-official/proxy.git /opt/ebunny-panel`, затем пропустите команды создания каталога и распаковки ниже. При установке из архива положите его в домашний каталог пользователя.

```sh
sudo install -d -m 0755 /opt/ebunny-panel
sudo tar --no-same-owner -xzf "$HOME/ebunny-panel.tar.gz" -C /opt/ebunny-panel
cd /opt/ebunny-panel
sudo apt-get update
sudo apt-get install -y curl xz-utils openssl
sudo ./deploy/install-node24.sh
sudo sh -c 'test -f .env || install -m 0600 .env.example .env'
openssl rand -hex 32
sudoedit /opt/ebunny-panel/.env
```

Впишите в `.env` свой числовой ID, имя нового бота без `@`, его токен и только что сгенерированный мастер-ключ. Сохраните мастер-ключ для следующих обновлений. Строки `PANEL_ORIGIN`, `PANEL_BIND` и `PANEL_PORT` уже заполнены. Не публикуйте `.env`. Служба использует отдельную копию Node.js и хранит базу в `/var/lib/ebunny-panel`.

```sh
sudo install -m 0644 deploy/ebunny-panel.service /etc/systemd/system/ebunny-panel.service
sudo systemctl daemon-reload
sudo systemctl enable --now ebunny-panel
curl -fsS http://127.0.0.1:4180/api/session
```

Ожидаемый ответ — `{"authenticated":false}`. Если приложение не отвечает, откройте `sudo journalctl -u ebunny-panel -n 30 --no-pager`.

Для отдельного VPS без действующего веб-сервера используйте Caddy. В Cloudflare должна существовать запись A `my` на IPv4 этого VPS. На уже настроенном Caddy добавьте блок для панели в существующий файл вместо полной замены.

```sh
sudo apt-get install -y caddy
sudo install -m 0644 Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -fsS https://my.ebunny.cloud/api/session
```

После успешного HTTPS-подключения зарегистрируйте webhook отдельного бота входа.

```sh
sudo /opt/ebunny-node24/bin/node --env-file=/opt/ebunny-panel/.env \
  /opt/ebunny-panel/server/index.js --register-webhook
```

Откройте `https://my.ebunny.cloud`, войдите через Telegram и затем подключите BSCheck в разделе «Проверки».

### Подсчёт запусков @eBunnyAPP

Укажите отдельный случайный `AUDIENCE_INGEST_KEY` из `openssl rand -hex 32` и передайте его процессу @eBunnyAPP через секреты. В существующем обработчике команды `/start mtproxy` отправляйте событие в `POST /api/audience/start` с заголовком `Authorization: Bearer <AUDIENCE_INGEST_KEY>` и JSON `{"update_id":"123","telegram_id":"456"}`. Подставляйте значения из принятого обновления Telegram. При повторной доставке обновления используйте тот же `update_id`. Панель хранит псевдоним аккаунта и считает запуски и уникальные аккаунты за 7 или 30 дней. Регистрация webhook бота входа не меняет настройки @eBunnyAPP.

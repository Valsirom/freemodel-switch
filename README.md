# freemodel switch

Аккаунт-свитчер для [freemodel.dev](https://freemodel.dev) под Claude Code, с прогрессбарами использования и датой окончания подписки. Аналог CC Switch / Kiro Account Manager / Cockpit Tools, но заточенный под freemodel.

## Что умеет

- Хранит несколько аккаунтов freemodel (токен `fe_oa_…` + base URL).
- **Переключение в один клик** — переписывает `ANTHROPIC_AUTH_TOKEN` и `ANTHROPIC_BASE_URL` в `~/.claude/settings.json` (атомарно, остальные поля не трогает). Активный аккаунт подсвечивается.
- **Прогрессбары использования** — окна `5 часов` и `Неделя` (потрачено / лимит, время до сброса).
- **Подписка** — план, дата продления/окончания, остаток дней (подсвечивается красным ≤3 дн, жёлтым ≤7 дн), кредиты.
- Добавление / редактирование / удаление аккаунтов.
- Токены шифруются на диске через OS-хранилище (DPAPI на Windows) — `safeStorage`.

## Как запустить

```bash
npm install
npm start
```

## Архитектура и ключевой нюанс freemodel

У freemodel **два независимых realm'а авторизации** — это определило всю конструкцию:

| | Прокси (трафик Claude Code) | Дашборд (данные usage/подписки) |
|---|---|---|
| Хост | `cc.freemodel.dev` | `freemodel.dev/api/*`, `api.freemodel.dev` |
| Авторизация | токен `fe_oa_…` (Bearer) | cookie-сессия (Google OAuth / OTP) |

Токен `fe_oa_…` даёт доступ **только** к проксированию запросов. На эндпоинтах дашборда (`/api/usage`, `/api/billing`, `/api/auth/me`) он возвращает `Unauthorized` — там нужна сессия из браузера. Прокси при этом **не** отдаёт usage в заголовках ответа.

Поэтому прогрессбары и дату подписки **нельзя** получить по одному токену. Есть два способа дать приложению сессию дашборда:

1. **Кнопка «Войти»** — открывается окно дашборда, ты логинишься сам (Google / OTP; пароль приложение не видит). Сессия сохраняется в постоянной партиции Electron (`persist:acct-<id>`), окно закрывается автоматически, как только появляется cookie `bm_session`.
2. **Кнопка «Импорт сессии»** — для случая «я уже залогинен в браузере». Открой `freemodel.dev` в браузере → F12 → Application → Cookies → `freemodel.dev` → скопируй значение cookie **`bm_session`** и вставь в приложение. Cookie инжектится в партицию аккаунта.

> Почему нельзя «вставить ссылку и подтвердить в браузере» (device-flow, как у Kiro/AWS SSO): у freemodel нет device-эндпоинта, OAuth `redirect_uri` жёстко зашит на `freemodel.dev/api/auth/google/callback` (нельзя вернуть на localhost), а сессия — это `HttpOnly` cookie `bm_session`, недоступная странице. Поэтому единственный путь «из браузера» — ручной импорт значения cookie.

### Эндпоинты, которые читает приложение

- `GET /api/auth/me` → `{ name, email }`, `401` если не залогинен.
- `GET /api/usage` → `{ totalRequests, totalTokens, window5h, windowWeek }`, где каждое окно `{ usedCents, limitCents, resetsAt }`.
- `GET /api/billing` → `{ planId, status, currentPeriodEnd, cancelAtPeriodEnd, credits }`. `currentPeriodEnd` — UTC без зоны, на фронте добавляется `Z`.

## Структура

```
src/main/      процесс Electron
  main.js        окно + IPC + логика обновления
  settings.js    чтение/запись ~/.claude/settings.json (атомарно)
  store.js       хранилище аккаунтов, шифрование токенов (safeStorage)
  usage.js       запросы usage/billing по cookie-сессии аккаунта
  login.js       окно входа в дашборд на сессию аккаунта
  preload.js     безопасный IPC-мост (contextIsolation)
src/renderer/  UI
  index.html, styles.css
  render.js      форматтеры + HTML карточки
  app.js         события, модалка, обновление
```

## Безопасность

- Токены не хранятся в открытом виде: `safeStorage` (DPAPI). В UI показывается только хинт `fe_oa_…xxxx`.
- `contextIsolation: true`, `nodeIntegration: false`, узкий IPC-мост, CSP в `index.html`.
- Пароли от freemodel вводятся в окне самого дашборда — приложение их не обрабатывает и не хранит, только переиспользует cookie-сессию.
- `settings.json` пишется атомарно (temp + rename), правятся только два env-ключа.

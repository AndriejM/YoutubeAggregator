# YouTubeAggregator.chrome — План проекта

> Документ живой: дополняется и уточняется по ходу разработки.
> План на русском. Документация (`README.md`) — на английском.

---

## 1. Продуктовая цель

Расширение для Chrome (Manifest V3), которое добавляет в левый сайдбар youtube.com
собственный виджет-агрегатор подписок:

- **Заголовок виджета:** кнопка открытия конфигурации; combobox переключения
  профилей — отдельной строкой под заголовком.
- **Под заголовком:** дерево групп каналов (решение 2026-11-08, §18): ряд группы с общим
  счётчиком; внутри группы — каналы (аватар, название, счётчик новых видео с момента
  последнего посещения канала).
- **Конфигурация** открывается в главной области YouTube (справа от сайдбара), не в отдельной вкладке.

Это улучшенный клон PocketTube (`examples/`, id `kdmnjgijlmjgmimahnillepgcgeemffb`).
Мы не копируем его код (он обфусцирован и связан с платной инфраструктурой), а
воспроизводим и улучшаем его поведение на собственной архитектуре.

### Что берём из анализа `examples/` (доказательная база)

| Факт из PocketTube | Доказательство | Наш вывод |
|---|---|---|
| MV3: content script `build/app.js` + `build/context.css` на `https://*.youtube.com/*`, `run_at: document_start` | `examples/manifest.json:15-20` | Та же схема, без сборщика |
| Точка внедрения — гайд YouTube: `#guide-inner-content`, `ytd-guide-entry-renderer`, `a[href="/feed/subscriptions"]`, мини-гайд `ytd-mini-guide-entry-renderer` | селекторы в `build/app.js` (59 вхождений `ytd-guide-entry-renderer`) | Внедряемся в тот же контейнер |
| Повторная постановка виджета при SPA-навигации — 13 `MutationObserver` + `setInterval` ожидание появления гайда | `build/app.js` | Один наблюдатель + идемпотентный mount |
| Конфигурация — `<iframe id="ysm-manager-modal">` с локальным SPA (`pockettube-app/dist/*`) внутри главной области | `build/app.js`, `manifest.json:47-50` | У нас — инлайн-DOM панель в `#content` (решение §15) |
| Тема синхронизируется по атрибуту `html[dark]`, цвета через `var(--yt-spec-text-primary)` | `build/app.js`, `build/context.css` | CSS-переменные YouTube + наблюдатель за `dark` |
| Список каналов берётся из `window.ytInitialGuideData` → `guideSubscriptionsSectionRenderer` → `guideEntryRenderer` (title, thumbnail, count) | `build/app.js` (`channelsListYTConvert`) | Тот же дешёвый источник списка подписок |
| Списки каналов: `https://www.youtube.com/feed/subscriptions`, `/feed/channels`, `POST /youtubei/v1/browse` (`context` + `browseId` + `continuation`) | `build/app.js`, `build/ut.js`, `build/utf.js` | Резервные источники + пагинация |
| Новые видео — RSS `https://www.youtube.com/feeds/videos.xml?channel_id=…` (парсинг XML, `published`) | `build/background.js`, `build/utf.js` | Основной механизм счётчика |
| Alarm-периоды: `updateSubs` 20160 мин (14 сут), `updateHealth` 120 мин, `getSubs` 1 мин, `automaticBackup` 60 мин | `build/background.js` | Свои периоды; MVP — постранично, без опроса всех каналов |
| Ключи хранилища: `ysc_settings`, `ysc_subs_count`, `ysc_channel_metadata`, `ysc_title_id`, `ysc_token_google`, `ysc_backup`, `channelsHealth`, `api_counter` | `build/background.js` | Своя схема `yga:*` (см. §5) |
| Профили: `https://www.youtube.com/getAccountSwitcherEndpoint` + `accountItem` | `build/app.js`, `build/background.js` | Считаем список аккаунтов из masthead |
| Локализация — собственный словарь в бандле, `chrome.i18n` не используется (0 вхождений) | `build/app.js`, `examples/_locales/*/messages.json` | У нас — `_locales` + `chrome.i18n` |
| Санитайзер DOMPurify перед вставкой разметки YouTube | `examples/purify2.min.js` + `ALLOWED_URI_REGEXP` | У нас `textContent` + ` escapeHTML` без внешней библиотеки |
| PocketTube вызывает YouTube Data API v3 (`youtube/v3/channels`) + Drive appdata и свой `pockettube.io` | `build/background.js` | **Мы не используем OAuth/API-ключ/свой сервер** — только те же права, что имеет страница YouTube |

---

## 2. Технические принципы

1. **Ноль внешних зависимостей.** Только `html`, `css`, `js`. Никаких npm, сборщиков,
   минификаторов, иконочных шрифтов (Material Design Icons в PocketTube — 2.8 МБ).
   Иконки — инлайн SVG прямо в разметке.
2. **Ноль сетевых разрешений сверх YouTube.** `host_permissions: https://*.youtube.com/*`.
   Без Google OAuth, без API-ключа, без собственного бэкенда.
3. **Никакого внешнего кода в world страницы**, кроме необходимого моста (см. §7).
4. **Устойчивость к изменениям YouTube.** Все селекторы — в одном модуле
   `content/selectors.js` с fallback-цепочками; при отсутствии селектора виджет
   деградирует, а не ломает страницу.
5. **Производительность.** Никаких опросов всех каналов каждую минуту на старте:
   счётчики считаются лениво, при открытии виджета, пачками, с кэшем и дедупликацией.
6. **Безопасность.** Данных пользователя минимум; никаких `innerHTML` с данными YouTube
   без экранирования; CSP в `manifest.json`.

---

## 3. Структура расширения

```
YouTubeAggregator.chrome/
├── manifest.json                 MV3
├── PLAN.md                       этот файл
├── README.md                     документация (EN)
├── _locales/
│   ├── en/messages.json
│   └── ru/messages.json
├── background/
│   └── service-worker.js         кэш, хранилище, сообщения, счётчики
├── content/
│   ├── bootstrap.js              точка входа (isolated world), бутстрап и наблюдатели
│   ├── selectors.js              все селекторы YouTube + fallback
│   ├── widget.js                 UI бокового виджета (заголовок + список каналов)
│   ├── panel.js                  контейнер панели конфигурации в главной области
│   ├── group-picker.js           инлайн-кнопка «Группа» на странице канала (§8.8)
│   ├── bridge-client.js          обращения к мосту страницы (CustomEvent/Promise)
│   ├── api-client.js            подписки, новые видео (через мост)
 │   ├── i18n.js                   обёртка над chrome.i18n
 │   ├── state.js                  состояние/подписки на изменения стора + счётчики (§10)
 │   ├── profiles.js               CRUD профилей + composition (§5, этап 2)
 │   ├── accounts.js               определение текущего аккаунта → accountKey (§5, этап 2)
 │   ├── rss-parser.js             общий парсер /feeds/videos.xml (SW + content + тесты, §10)
 │   ├── counters.js               подвал счётчиков: общий чип + кнопка «обновить» (§10, этап 3)
 │   └── widget.css                стили виджета и панели (context.css аналог)
├── page/
│   └── bridge.js                 injected into MAIN world: доступ к ytcfg/ytInitialData
├── config/
│   ├── panel.js                  сборка панели конфигурации в DOM (без iframe)
│   ├── panel-sections.js         секции: профили, каналы, счётчики, виджет, тема, данные
│   └── panel.css                 стили панели (namespace .yga-panel-*)
├── options/
│   └── options.html|js|css       резервная полноэкранная конфигурация (fallback)
├── popup/
│   └── popup.html|js|css         опционально: быстрый обзор (поздний этап)
├── icons/
│   └── icon16.png icon48.png icon128.png
└── test/
    ├── smoke.html                ручные проверки парсера XML в браузере
    ├── harness.mjs               общие стабы chrome/DOM для харнесов
    ├── logic.mjs                 node-харнес: RSS-парсер + ядро воркера + content-вид (60 проверок)
    ├── dom.mjs                   node-харнес слоя виджета: строки, правый клик, applyCounts (7 проверок)
    └── fixture-feed.xml          фикстура Atom-фида для харнеса
```

Принятое решение: панель конфигурации — **инлайн-DOM**, собирается в isolated world
контент-скрипта и вставляется в главную область YouTube (`#content`). Никаких iframe,
никаких `web_accessible_resources` для конфигурации, никакого iframe↔content messaging.
Единственный мост в мир страницы — скрипт `page/bridge.js` для чтения данных YouTube (§7).

---

## 4. Manifest (целевой)

```json
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "short_name": "YGA",
  "version": "0.1.0",
  "default_locale": "en",
  "description": "__MSG_extDescription__",
  "action": { "default_title": "__MSG_extName__" },
  "background": { "service_worker": "background/service-worker.js" },
  "permissions": ["storage", "unlimitedStorage", "alarms"],
  "host_permissions": ["https://*.youtube.com/*"],
  "content_scripts": [{
    "matches": ["https://*.youtube.com/*"],
    "js": ["content/bootstrap.js"],
    "css": ["content/widget.css"],
    "run_at": "document_idle"
  }],
  "web_accessible_resources": [{
    "resources": ["page/bridge.js", "icons/*"],
    "matches": ["https://*.youtube.com/*"]
  }],
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

Принятые решения: `run_at: document_idle` (вежливее к LCP; при необходимости перейдём на
`document_start` — PocketTube использует именно его). `"action"` без popup на MVP.
Только **Chrome MV3** (Firefox-адаптация с отдельным bridge — вне MVP).
`options_ui` как резервная страница — позже (этап 6).

---

## 5. Модель данных (chrome.storage.local)

**Что такое профиль (решение принято):** профиль — это **локальный набор каналов**,
придуманный пользователем (например «Работа», «Музыка», «Дайджест»), а **не** аккаунт
Google/YouTube. Подписки при этом берутся из одного текущего аккаунта YouTube,
в котором пользователь залогинен; аккаунт используется только как источник подписок
и как ключ кэша (`accountKey`). Переключение реальных аккаунтов YouTube — вне MVP (бэклог, §11).

Все ключи с префиксом `yga:`.

```js
"yga:groups" = [                            // тематические группы каналов (решение §18)
  { id: "g_1", name: "Фильмы",        collapsed: false, order: 0, createdAt, updatedAt },
  { id: "g_2", name: "Кулинария",     collapsed: true,  order: 1, … },
  { id: "g_3", name: "Программирование", collapsed: true, order: 2, … },
  { id: "g_4", name: "Хобби",         collapsed: true,  order: 3, … }
]
                                            // канал принадлежит ровно одной группе (§18):
                                            // "yga:profile-channels:<profileId>"["UCxxxx"].groupId

"yga:settings" = {
  version: 1,
  activeProfileId: "p_1",
  refresh: { mode: "onOpen",              // MVP: onOpen | scheduled (гибрид, см. §10)
             scheduled: { enabled: false, periodInMinutes: 240, maxChannelsPerRun: 60 },
             batch: 12, minIntervalMs: 90000 },
  widget:  { position: "afterSubscriptions", widthPx: 300, showCounts: true,
              showZeroCount: false, sort: "activity", hideWatched: false, compact: false,
              hideEmptyGroups: false,        // группы (§18.3)
              channelPageButton: true },     // кнопка «Группа» на странице канала (§8.8)
  theme:   { followYouTube: true, accent: "#c00" }
}

"yga:account" = {                          // текущий аккаунт YouTube (информационно)
  accountKey, title, avatarUrl, detectedAt
}

"yga:profiles" = {                         // локальные профили-наборы
  "p_1": {
    id: "p_1", name: "Все подписки",      // служебный профиль по умолчанию
    builtin: true, createdAt, updatedAt,
    `sort: "activity"`,                      // activity | alpha | subs | manual | groups
    filters: { hideWatched: false, excludeShorts: false, excludeLive: false },
    includeAllSubs: true                   // true = автоматически все подписки
  },
  "p_2": { id: "p_2", name: "Музыка", builtin: false, includeAllSubs: false, … }
}

"yga:subs:<accountKey>" = {                // каталог подписок YouTube (общий для профилей)
  "UCxxxx": { channelId, title, avatarUrl, subscriberCount, lastSeenAt }
}

 "yga:profile-channels:<profileId>" = {     // состав профиля + его локальное состояние
   "UCxxxx": {
     addedAt,                               // когда канал добавлен в профиль
     lastVisitAt,                           // когда последний раз кликнули по каналу в виджете
     groupId: null,                          // группа профиля (§18), null = «Без группы»
     excluded: false,                       // убран пользователем (🗑), сам не снимается
     unsubscribed: false,                   // канал больше не подписка (снимается автоматически)
     pinned: false, muted: false, tags: [], order: 0   // order при sort=manual
   }
 }

"yga:videos:<channelId>" = {               // кэш RSS — общий для всех профилей
  entries: [{ videoId, title, publishedAt, watched: false }],
  fetchedAt, etag
}
```

Правила:
- Счётчик «новых» — производное: `entries.filter(e => publishedAt > lastVisitAt).length`,
  в сторе храним только `lastVisitAt` и кэш записей.
- `newCount` (кэш последнее известное значение) хранится отдельно от состава профиля,
  чтобы не перетирать пользовательские данные при полных перезаписях.
- Квота отсутствует (local + unlimitedStorage), но есть write-amplification `chrome.storage`:
  пишем батчами с debounce 300 мс.
- `storage.sync` не используем на MVP (решение отложено, §15).
- Один канал может входить в несколько профилей; `lastVisitAt` — на профиль
  (в разных профилях счётчик обнуляется независимо).
- Видимость канала в профиле: подписка **и** не `excluded`. `excluded` ставит
  пользователь (🗑 в списке каналов), `unsubscribed` проставляет синхронизация с
  подписками; второй флаг снимается сам при возврате подписки, первый — только
  явным добавлением. Профиль с `includeAllSubs: true` получает записи состава
  неявно, курируемый — только явным добавлением (иначе новый профиль = все подписки).
- `groupId` канала живёт в составе профиля (`yga:profile-channels:<profileId>`);
  `null` = «Без группы». Группа содержит каналы только своего профиля; при удалении
  группы её каналы переходят в «Без группы» (§18).

---

## 6. Источники данных YouTube

| Задача | Источник | Примечание |
|---|---|---|
| Список подписок (id, title, avatar) | `window.ytInitialGuideData` → `guideSubscriptionsSectionRenderer` | Дёшево, без запросов; на текущем YouTube (2026-11) `ytInitialGuideData` на window отсутствует — оставляем как бесплатную первую попытку |
| Список подписок (fallback, полный) | `GET /feed/channels` → парсинг `ytInitialData`/`ytInitialJSONLData` (page-world fetch через мост) | Проверено 2026-11-08: 995 каналов. `POST /youtubei/v1/browse` НЕ годится: требует `Authorization: SAPISIDHASH`, доступный только самой странице (из content/SW — 403) |
| Список подписок (fallback 2) | `GET /feed/subscriptions` → парсинг `ytInitialData` | Если /feed/channels недоступен |
| Новые видео канала | `GET /feeds/videos.xml?channel_id=<id>` (15 самых свежих записей) | Без авторизации; парсим `DOMParser` → `entry/published` |
| Аккаунт (для `accountKey`, не для профилей) | `ytcfg.EXTERNAL_CHANNEL_ID` → `ytcfg.SERVICES[authUser].channelId` (через мост) | Профили локальные (§5); аккаунт нужен только как ключ каталога подписок. Проверено 2026-11-08: `ytd-masthead #avatar-btn` лежит в **shadow DOM** (`document.querySelector` его не видит), а `accountItemRenderer` в `ytInitialData` домашней страницы отсутствует — DOM-эвристика не сработала, `ytcfg` работает всегда. Имя/аватар — best-effort из `ytInitialData`/masthead, нужды только для подписи в панели (этап 4) |
| Тема/язык/страна | `html[dark]`, `ytcfg.INNERTUBE_CONTEXT.hl/gl` | Для локализации и стиля панели |

Ограничение RSS: только ~15 последних видео на канал — этого хватает для счётчика
«новых с последнего посещения», но не для полной истории. Принято осознанно.

---

## 7. Мост в main world (обязательное зло)

Content script живёт в isolated world и **не видит** `window.ytInitialData`/`ytcfg`.
Поэтому:

- `page/bridge.js` доставляется как `content_scripts` с `"world": "MAIN"`
  (инъекция `<script src=chrome-extension://…>` блокируется CSP YouTube).
  Обмен — `window.postMessage` с `__yga:cmd`/`__yga:resp` и `nonce`, который
  генерирует isolated-скрипт; ответ принимается только при совпадении `nonce` и
  `event.source === window`.
- Мост умеет ровно пять вещей: `getGuideSubscriptions()`, `getContext()`,
  `browseSubscriptions()` (реализован как `GET /feed/channels`, см. §6),
  `getSubscriptionsPage()` (`GET /feed/subscriptions`), `getAccountInfo()`.
  Никакого произвольного eval и никаких вызовов с произвольными аргументами.
- `GET /feeds/videos.xml` делает **service worker** (у него есть `host_permissions`),
  а не страница — чтобы не зависеть от CORS и не плодить запросы в page world.

---

## 8. Внедрение в DOM YouTube

1. `bootstrap.js` (`document_idle`): ждём появления `#guide-inner-content`
   (наблюдатель за `ytd-app`/`tp-yt-app-drawer` + `#guide-inner-content`), таймаут 15 с,
   повторная попытка при смене гайда.
2. `mountWidget()` **идемпотентен**: виджет имеет `data-yga="widget"`; перед вставкой
   проверяем, что он уже есть и всё ещё в DOM (`.isConnected`) — иначе перевешиваем.
 3. Точка вставки (настраиваемая):
    - `afterSubscriptions` — после `a[href="/feed/subscriptions"]` внутри `#sections`
      (по умолчанию; как PocketTube);
    - `top` — первым в `#guide-inner-content`;
    - `miniGuide` — отдельная иконка в `ytd-mini-guide-renderer`, открывающая панель.

    Сверху над этими двумя именованными позициями работает **явный слот**
    `widget.guideIndex` (решение 2026-11-09): целое число — позиция виджета среди
    детей его фактического хоста (`widgetHost()`), `null` — «выводить из
    `widget.position`». Пишется кнопками ▲/▼ в заголовке виджета (`.yga-move-up` /
    `.yga-move-down`, `content/widget.js:moveWidget`; с этапа 8 — в `yga-header`,
    рядом с ⚙, а не в футере), переживает SPA-перемонты
    (YouTube пересобирает гайд на навигации) и сбрасывается в `null` при смене
    `widget.position` в панели — обе записи уходят одним `saveSettingsPaths()`,
    иначе виджет перемонтируется дважды. Кнопка на краю гайда дизейблится.

4. При закрытом/свёрнутом гайде (`tp-yt-app-drawer[closed]`) виджет скрывается,
   остаётся только мини-иконка.
5. На SPA-навигации (`ytd-app` + `history`/`yt-navigate-finish` события) — перепроверка
  перемонтирование; при уходе с youtube.com-роутов виджет не мешаем, при возврате — восстанавливаем.
6. Ширина: CSS custom property `--yga-width` (по умолчанию 300px, из настроек),
   `overflow-x: hidden`, внутренний скролл `overflow-y: auto` + тонкий scrollbar,
   `min-height: 0` для корректного flex-скролла внутри `#guide-inner-content`.
7. Конфигурация в главной области (**инлайн-DOM, без iframe**): контейнер `.yga-panel`
   вставляется в `ytd-app > #content` рядом с `#page` (ищем
   `ytd-two-column-browse-results-renderer` и его родителя) и собирается модулем
   `config/panel.js`. Контент YouTube не удаляем, а скрываем классом `.yga-hidden`
   (проще восстановить, чем пересобирать). Выход — Esc или кнопка ✕; при закрытии
   класс снимаем, скролл страницы возвращаем. Панель живёт в том же isolated world,
   что и виджет, — общий модуль состояния, без messaging между мирками.
8. Кнопки профилей на страницах канала и видео (**инлайн-DOM, этапы 5 и 9, §18.5**):
   модуль `content/group-picker.js` рисует **по одной маленькой круглой кнопке на
   каждый профиль** (первая буква имени профиля, фон — `profile.color` из
   конфигурации, §5): на страницах канала (`/channel/`, `/@handle`, `/c/`, `/user/`)
   — сразу **справа** от кнопки подписки (якорь `subscribeButton` →
   `ytd-page-header ytd-subscribe-button-renderer`, fallback `channelHeader`; позиция
   как у кнопки PocketTube), на страницах видео (`/watch`) — сразу **слева** от
   Like/Dislike (якорь `likeDislike` → `ytd-segmented-like-dislike-button-renderer`,
   `insertAdjacentElement("beforebegin")`). Идемпотентный mount по образцу виджета
   (пункт 2) и перепроверка на SPA-навигации (пункт 5); `channelId` страницы — через
   мост `getPageChannel` (§7). Клик по кнопке профиля открывает dropdown **этого
   профиля** (`role="menu"`, закрытие по клику вне): список групп профиля, справа от
   названия — checkbox, отражающий принадлежность канала (отметка — `setGroup
   (profileId, [channelId], groupId)`, снятие — `groupId = null`, т.е. «Без группы»);
   канал может состоять в группах нескольких профилей одновременно (по одной группе
   на профиль, §18.1). Внизу меню — быстрое создание группы («＋ Группа…»), сразу
   назначающая канал. Кнопки перестраиваются на `onProfilesChanged` (создание /
   переименование / смена цвета / удаление профиля). Отключаются настройками
   `widget.channelPageButton` и `widget.watchPageButton` (по умолчанию `true`).

Все известные «болючие» места (нужны `!important`, конкретная специфичность,
`z-index`, отключение анимаций) собираем в `content/widget.css` с комментариями.

---

## 9. UI виджета

Виджет показывает **дерево групп каналов** (решение 2026-11-08, §18), а не плоский список.
Группа разворачивается/сворачивается вниз кликом по её строке; каналы отображаются
с отступом под именем группы.

```
┌ yga-widget ────────────────────────────────────────┐
│ Aggregator [▾ профиль] [12] [↻] [⚙] [▲] [▼]      │  yga-header (этап 8)
├────────────────────────────────────────────────────┤
│ [▾] 📁 Фильмы                                 27  │  yga-group (развёрнута)
│       ●  Мосфильм                            3   │    yga-row (канал)
│       ●  КиноПоиск_hd                       12   │
│       ●  TrailerTime                        12   │
│ [▸] 📁 Кулинарии                            15  │  yga-group (свёрнута,
│                                                    │    каналы скрыты)
│ [▸] 📁 Программирование                      8  │
│ ─ Без группы ─                               4  │  yga-group (псевдо-группа)
│       ●  Linus Tech Tips                      4  │
└────────────────────────────────────────────────────┘
```

- **Этап 8 (2026-11-10): виджет только для просмотра.** Заголовок `yga-header` —
  чип общего счётчика, кнопка обновления (иконка), ⚙ и ▲/▼; combobox профиля —
  отдельной строкой `yga-profile-row` под заголовком (в узкий заголовок не
  помещается), без каких-либо кнопок рядом. Отдельных `.yga-toolbar`/`.yga-footer`
  больше нет. Из виджета убрано всё редактирующее: кнопки переименования/удаления
  профиля, опция «＋ Новый профиль» в combobox и пикер каналов профиля
  (`.yga-picker`) — это переехало в панель настроек (§9.2). В combobox остаётся
  только переключение активного профиля.
- Combobox профиля: MVP — нативный `<select>` в стилизованной обёртке (доступность,
  клавиатура, нативный popup). Собственный `role="combobox"` + `role="listbox"` — позже,
  если понадобится иконка профиля и поиск внутри выпадающего списка.
- Кнопка конфигурации: `<button aria-label="Configuration">` + инлайн SVG шестерни
  (этап 8: зубчатая шестерня вместо «солнца» — прежний круг с лучами читался
  как яркость).
- Строка группы: `<button class="yga-group" aria-expanded>` — индикатор `[▾]/[▸]` (SVG chevron),
  имя группы, суммарный счётчик. Клик по строке — toggle; состояние `collapsed` хранится
  в `yga:groups[].collapsed` (§5), не в DOM.
- Строка канала: `<a class="yga-row" href="/channel/<id>/videos">` c `<img class="yga-avatar">`,
  `<span class="yga-title">`, `<span class="yga-count" title="N new videos">`;
  отступ `--yga-indent` (наследуется от YouTube `--yt-guide-item-indent` при наличии).
- Сортировка каналов внутри группы: счётчик **по убыванию**, затем название канала
  по алфавиту (locale-aware `Intl.Collator`). Пустые группы не показываем, если
  `hideEmptyGroups: true` (по умолчанию `false` до этапа групп — см. §11).
- Счётчик `0` не показываем (или показываем приглушённо — настройка `showZeroCount`).
- Долгие названия — `text-overflow: ellipsis`, `title`-атрибут с полным именем.
- Ленивая загрузка аватаров: `IntersectionObserver`, реальный `src` из `data-src`
  (PocketTube делает так же) — экономит трафик на 300+ каналах. При свёрнутой группе
  каналы не в DOM → аватары не грузятся вообще.
- Доступность: `aria-live="polite"` на счётчиках, `aria-expanded`/`aria-controls` на
  строках групп, корректный порядок фокуса, контраст по WCAG AA в обеих темах YouTube.

### 9.2. Экран «Настройки» (инлайн-панель)

Экран открывается кнопкой ⚙ в заголовке виджета: панель `.yga-panel` в `#content` (§8.7),
тот же isolated world, что и виджет, — прямое чтение/запись `chrome.storage` без messaging.
Это экран управления **каналами и группами активного профиля** (по образцу UI PocketTube,
без копирования кода) плюс секции настроек из §11 (этап 4). Все изменения применяются
**сразу**, кнопки «Сохранить» нет (§15).

**9.2.1. Список каналов**

- Поиск по названию канала (фильтрует мгновенно, debounce ввода ~150 мс).
- Чекбоксы + «выделить все/снять» — массовые операции: переместить в группу,
  убрать из профиля, отметить просмотренным (обнулить счётчик).
- Сортировка списка по колонкам: название / счётчик / группа.
- Чип группы в строке канала — клик открывает выбор группы (native `<select>` на MVP).
- Иконка 🗑 на строке — убрать канал из профиля (не отписываясь на YouTube).
- Иконка ↺ — обнулить счётчик канала.
- Пустое состояние: подсказка «нет каналов по фильтру» / «профиль пуст».

**9.2.2. Группы каналов** (§18)

- CRUD групп: «+ Группа» — модалка с единственным полем имени (PocketTube-образец).
- Переименование и удаление выделенной группы; при удалении каналы уходят в «Без группы».
- Фильтр-чипы групп со счётчиком `n/m` (каналов в группе / всего).
- Счётчики новых видео группы (`= Σ` счётчиков каналов) рядом с именем группы.
- Порядок секций: группы, затем список каналов.

**9.2.3. Общие требования**

- Прямая запись в `chrome.storage` (debounce 300 мс, §5); виджет и панель используют общий
  `state.js` → любое изменение видно мгновенно в обоих без перезагрузки (§13.6).
- Никакого `innerHTML` с данными YouTube (§12, XSS); строки интерфейса — `chrome.i18n`
  (`_locales/en|ru`, §14).
- Esc/✕ — закрытие панели, восстановление `.yga-hidden`-контента YouTube (§8.7).
- Секции панели не должны быть одной длинной страницей: каждая секция — отдельная
  закладка; активна одна, остальные скрыты; содержимое вкладки прокручивается внутри
  панели, если не помещается по высоте.

---

## 10. Счётчик «новых видео с последнего посещения»

Алгоритм (MVP):
1. Пользователь открыл виджет / сменил профиль / нажал «обновить» → `refreshNewCounts(profileId)`.
2. Берём каналы профиля, у которых `now - lastPollAt > minIntervalMs`, пачками по N (12),
   с последовательной очередью и паузой 200-400 мс между запросами.
3. Service worker: `fetch('/feeds/videos.xml?channel_id=' + id)` → `DOMParser`
   (`application/xml`) → `entry` → `{videoId, title, published}`.
   **Поправка 2026-11-08:** в MV3 service worker **нет `DOMParser`** — парсер
   `content/rss-parser.js` (сканер тегов, UMD-глоб `yga.rssParser`) подключается
   и в воркер (ESM-import ради сайд-эффекта), и в контент-скрипты, и в тесты.
4. `newCount = entries.filter(e => publishedAt > lastVisitAt).length`,
   `lastPollAt = now`. Кэш на 15 записей на канал.
   Реализация: в воркере хранится **unbounded** `newCount` (lastVisitAt=0, минус
   вручную «отметить просмотренным»), а профильный вид считается в content-мире
   из `lastVisitAt` состава — так воркер не знает о профилях лишнего.
   **Поправка 2026-11-09:** чтобы content-миру было из чего считать этот вид,
   воркер отдаёт вместе с числом массив `at` — `publishedAt` всех непросмотренных
   записей (по убыванию). `newSince(at, lastVisitAt)` (`content/counters.js`) =
   `at.filter(t => t > lastVisitAt).length`. Флаги `watched` общие для всех
   профилей, `lastVisitAt` — профильный, поэтому сбчёт в одном профиле не
   «съедает» счётчик в другом (§5). `at` входит в `counters:counts|get|init`
   и в сравнение изменений (записи могли ротироваться при том же `newCount`).
5. **Что обнуляет счётчик (решение принято):** `lastVisitAt = now` проставляется
   **при клике по каналу в нашем виджете** и по кнопке «отметить просмотренным».
   Клик по каналу ведёт сразу на `https://www.youtube.com/channel/<id>/videos`
   (вкладка «Видео» активна сразу по прибытии). Открытие страницы канала вне виджета
   на MVP счётчик не обнуляет (можно пересмотреть в бэклоге, если появятся жалобы
   на «счётчик не сбрасывается»).
6. Счётчик группы — производная, не отдельный запрос: `groupCount = Σ newCount` каналов
   группы; пересчитывается из кэша при любой смене детских значений. Клик по каналу
   обнуляет счётчик канала — счётчик группы уменьшается на ту же величину; при смене
   профиля пересчёт из кэша без запросов (§18.4).
7. Счётчик обновляем в DOM точечно (только текст в `.yga-count`), без перерисовки списка.
   Счётчики идут синхронно с чтением RSS: воркер отправляет `counters:counts` окном
   ~350 мс по мере draining очереди, вкладка перерисовывает строки и чип сразу —
   проверка каналов не должна дожидаться F5. Общий чип (`yga.counters`) считается **из строк списка** — того же
   lastVisitAt-вида активного профиля, чтобы чип никогда не противоречил списку
   рядом (правый клик обнуляет и строку, и чип сразу). Воркерный агрегат
   (`counters:aggregate`) тоже lastVisitAt-aware (воркер читает состав профиля)
   и используется только пока каталог/строки ещё не отрисованы.

Режимы обновления (решение принято — гибрид):
- `mode: "onOpen"` (по умолчанию) — только по открытию виджета/смене профиля/кнопке.
- `mode: "scheduled"` (включается в конфигурации) — `chrome.alarms` с периодом
  `scheduled.periodInMinutes` (по умолчанию 240, минимум 60), за один прогон не более
  `maxChannelsPerRun` каналов; alarm создаётся/удаляется при изменении настройки.
  Для сравнения: у PocketTube `updateSubs` 20160 мин, `getSubs` 1 мин.

Мёртвый канал (2026-11-13): подряд `DEAD_AFTER_ERRORS = 5` ошибок чтения фида — это
заблокированный или удалённый на YouTube канал, а не временный сбой. Воркер ведёт
`errorStreak` (сбрасывается при первом успехе или на `304`), и на пятой ошибке
`markDead()` убирает канал из группы (§18.1) и исключает его из каждого профиля, где он
лежал (§5). `excluded` — выбор пользователя, который `syncProfile` не сбрасывает, поэтому
канал, который YouTube всё ещё показывает в каталоге, не возвращается на следующем
чтении каталога; для `includeAllSubs`-профиля без записи в составе воркер создаёт её сам.
Мёртвый канал больше не опрашивается: `profileData` фильтрует исключённые. Восстановление —
только кнопка «добавить» в «Конфигурация/Каналы». Виджет перерисовывается без перезагрузки
вкладки: запись состава проходит через `storage.onChanged` → `onCompositionChanged`, а
`membershipSig` (`content/counters.js`) отличает реальную смену состава от патча
счётчиков (§10.7).

Fallback и честность: если RSS недоступен/429 — показываем `?` вместо числа,
не обнуляем счётчик; при `lastPollAt` старше 24 ч — помечаем счётчик «устаревшим»
(приглушённый стиль + подсказка в `title`).

---

## 11. Этапы разработки

### Этап 0 — каркас (реализовано 2026-11-08, проверено в браузере)
- [x] `manifest.json`, `_locales/en|ru`, `service-worker.js`, `bootstrap.js`, `widget.css`, иконки.
      MV3, `run_at: document_idle`, порядок content-скриптов явный (§14); иконки —
      красный круг + белый play.
- [x] Инжект пустого блока с заголовком в `#guide-inner-content`, идемпотентный mount.
      `yga.mountWidget()` — проверка `[data-yga="widget"]` + `.isConnected` (widget.js:504),
      точка вставки — после ссылки подписок в `#sections` с fallback-цепочками `selectors.js`.
- [x] Проверка: виджет переживает SPA-навигацию (подписки → видео → канал), тёмную/светлую тему.
      Перепроверка по `yt-navigate-finish` (bootstrap.js:111); тема — через `--yt-spec-*`
      переменные YouTube в `widget.css`.
- Критерий: расширение устанавливается, виджет появляется на всех 4 типах страниц и не мешает YouTube.
  **Проверено в браузере 2026-11-08** (andi), коммиты `853fc03`…`6a7ca82`.

### Этап 1 — подписки (реализовано 2026-11-08, проверено в браузере)
- [x] `page/bridge.js`: `getGuideSubscriptions()`, `getContext()`.
      Доставка — `content_scripts` с `"world": "MAIN"` (CSP YouTube блокирует
      `<script src=chrome-extension://…>`), обмен `postMessage` + `nonce`.
- [x] Получение списка каналов (id, title, avatar) из guide data; fallback на browse.
      На живом YouTube (2026-11) `ytInitialGuideData` на `window` отсутствует, а
      `POST /youtubei/v1/browse` даёт 403 без page-only `SAPISIDHASH` — fallback
      реализован как `GET /feed/channels` в page world (§6, коммиты `043f5de`, `2251dad`).
- [x] Отображение списка в виджете с аватарами (ленивая загрузка), без счётчиков.
      `IntersectionObserver` + `data-src` (widget.js:186), сортировка по названию.
- [x] Кэш подписок в `yga:subs:<accountKey>` + обновление при изменении подписок на YouTube.
      Запись с debounce 300 мс и partial-guard; обновление — `refreshSubscriptions()` на
      загрузке и на каждом `yt-navigate-finish` (bootstrap.js:117), запись в стор только
      при реальном изменении. Ключ `<accountKey>` пришёл вместе с этапом 2 (миграция
      `yga:subs:default` → `yga:subs:<UCid>`).
- [x] Служебный профиль `p_1` («Все подписки», `includeAllSubs: true`) создаётся автоматически.
      `profiles.js:41,120` — `builtinProfile()` + дописывание в состав при загрузке профилей.
- Критерий: список совпадает с реальными подписками; при 200+ каналов нет лага (профилировка).
  **Проверено в браузере 2026-11-08**: 995 каналов через `GET /feed/channels`, отрисовка
  без заметного лага, лаг не измерялся профилировщиком (решение: при 995 канал
  отображается мгновенно из кэша, повторные навигации — дешёвый гайд-чтение).

### Этап 2 — локальные профили (реализовано и проверено в браузере 2026-11-08, `dec7819`)
- [x] CRUD профилей: создание, переименование, удаление (служебный `p_1` не удаляемый).
      UI на MVP — в заголовке виджета: `select` с опцией «＋ Новый профиль…», кнопки
      «переименовать» (карандаш) и «удалить» (✕), обе disabled для `p_1`;
      диалоги — `prompt`/`confirm` до панели конфигурации (этап 4). Модуль `content/profiles.js`.
- [x] Composition: добавление/исключение каналов из профиля (`yga:profile-channels:<id>`),
      флаг `includeAllSubs`, поведение при unsubscribed-канале (убирать из состава, но
      сохранять историю `lastVisitAt` на случай возвращения подписки).
      Разделение флагов: `unsubscribed` — автоматический (канал ушёл из подписок,
      снимается сам при возврате подписки), `excluded` — воля пользователя
      (`profiles.removeChannel`), сам не снимается. Для `includeAllSubs` состав =
      подписки минус `excluded`; для курируемого профиля записи создаёт только
      `profiles.addChannel` (иначе новый профиль стал бы копией всех подписок).
      interim UI до панели этапа 4 (§9.2.1): в виджете под списком курируемого профиля
      кнопка «＋ Добавить каналы» открывает picker — поиск по названию (debounce 150 мс)
      и чекбоксы по всему каталогу подписок (не более 200 строк, остальное —
      «уточните поиск»); отметка сразу пишет состав, виджет перерисовывается.
      Новый профиль открывается сразу с открытым picker'ом.
- [x] Combobox в заголовке виджета: список профилей, persisted `activeProfileId`
      (`yga:settings`), переключение перерисовывает список без запросов к YouTube
      (`state.refreshVisible()` → только чтение стора).
- [x] Определение текущего аккаунта (`#avatar-btn` / `ytd-masthead #account-item` +
      `accountItemRenderer`/`switchAccountItemRenderer` из `ytInitialData` через мост)
      → `yga:account` и `accountKey` (ключ каталога `yga:subs:<accountKey>`);
      устаревший кэш этапа 1 (`yga:subs:default`) мигрируется под новый ключ и удаляется.
      Подпись аккаунта в панели конфигурации — сделана на этапе 4 (раздел «Профили»).
- [x] Экспорт/импорт профилей (JSON) — сделан на этапе 4 (раздел «Данные», дамп всех `yga:*`).
- Критерий: 3 профиля с разными наборами каналов; переключение мгновенное;
  удаление профиля не трогает каталог подписок и другие профили.
  Логика проверена вне браузера (33 проверки: composition, exclude/unsubscribe,
  переключение профиля, миграция ключа аккаунта); ручная проверка в браузере — заодно с этапами 0–1.

### Этап 3 — счётчики новых видео (реализовано 2026-11-08, браузерная проверка не выполнена)
- [x] RSS-запросы в worker, парсер XML, батч-очередь с троттлингом.
      `content/rss-parser.js` — общий парсер (в SW нет DOMParser); воркер:
      очередь с дедупом по каналу, пауза 300 мс, `ETag`/`If-None-Match`→304,
      ретраи 429/5xx/сеть ×1 с backoff, кэш `yga:videos:<id>` + индекс
      `yga:videos-index` (для полного пересчёта после рестарта SW).
- [x] `newCount`, `lastVisitAt` (обнуление по клику в виджете), кнопки «обновить» и «отметить просмотренным».
      Клик по строке → `counters:setVisit` (единый писатель lastVisitAt — воркер)
      и переход на `/channel/<id>/videos`; «отметить просмотренным» — правый клик
      по строке (до панели этапа 4). В подвале виджета — общий счётчик (chip
      `99+/N+`) и кнопка «↻ Обновить» (`force`).
- [x] Кэш и обработка ошибок (429/нет сети/устаревание).
      Ошибка канала: чип `?`, число не обнуляется, кэш сохраняется; `fetchedAt`
      старше 24 ч — приглушённый стиль + подсказка. Обмен с вкладками — шина
      `chrome.runtime.sendMessage` (SW→tabs) с окном ~350 мс: счётчики приходят
      по мере чтения RSS, не после всей очереди; `storage.onChanged` — мультитэбовая
      сходимость состава профиля (единственный писатель состава — `profiles.js`).
- [x] API worker'а `refreshNewCounts(profileId, {scheduled:false})` — заготовка под
      `scheduled`-режим; сам переключатель режима появится на этапе 4.
      Сообщения `counters:refresh|setVisit|get|init|settings`; `chrome.alarms`
      `yga:scheduled-refresh` (period ≥ 60 мин, `maxChannelsPerRun`) создаётся
      только при `refresh.scheduled.enabled` (по умолчанию выключен).
- Критерий: число новых видео совпадает с реальностью на 5 тестовых каналах.
  Логика проверена вне браузера: `node test/logic.mjs` — 60 проверок (парсер
  по фикстуре, очередь/троттлинг/дедуп, ETag/304, 429, watched-merge, setVisit
  + lastVisitAt-агрегат и независимость профилей, `at`-полезная нагрузка,
  `newSince`, curated-состав, будильник scheduled); `node test/dom.mjs` — 7
  проверок слоя виджета (строка `15+`, правый клик обнуляет строку и чип,
  сходимость по шине, независимость профиля); `test/smoke.html` — парсер
  в браузере.
  **Фикс 2026-11-09:** правый клик («отметить просмотренным») не обнулял
  счётчик — строка всегда показывала `15+`. Причина: content-вид `countFor`
  игнорировал `lastVisitAt` (эвристика «минус час за час с последней загрузки»)
  и не мог учесть визит, т.к. воркер передавал только число. Теперь воркер
  отдаёт `at`, вид считается по `publishedAt > lastVisitAt`, общий чип — из
  строк, а `markVisited` больше не переписывает общий (профиль-независимый)
  кэш счётчиков. Общий чип при нуле скрывается, как и нулевой счётчик строки
  (§9); ошибки `?×n` остаются видимыми.

### Этап 4 — конфигурация в главной области (инлайн-DOM) (реализовано 2026-11-09, браузерная проверка не выполнена)
- [x] `config/panel.js` + `config/panel.css`: панель в `#content` справа от сайдбара, без iframe.
      Панель — инлайн-DOM в том же изолированном мире, что и виджет: никаких iframe,
      `web_accessible_resources` и межмирового обмена. Хост страницы
      (`ytd-two-column-browse-results-renderer` → родитель `#content`) скрывается
      классом `.yga-hidden`, панель вставляется соседним узлом, поэтому гайд
      (и виджет) остаются видимыми. Якоря `contentRoot`/`browseResults` — в `selectors.js`.
- [x] Секции: Профили (CRUD, состав каналов) · Группы (§9.2.2, полноценно — этап 5) ·
      Список каналов (§9.2.1, сортировка/скрытие) ·
      Счётчики (режим onOpen/scheduled, интервал, батч) · Виджет (позиция, ширина, показ нуля) ·
      Тема · Данные (экспорт/импорт JSON, сброс).
      `config/panel-sections.js` — 7 секций; у падающего билдера — заглушка `panelSectionError`,
      остальное не затрагивается. Список каналов: поиск с дебаунсом 150 мс, сортировка
      «название/новые видео», переключатель «показать все подписки», чекбоксы +
      массовые операции (добавить/убрать/просмотрено), лимит 300 строк с подсказкой
      «уточните поиск», ленивые аватары через `IntersectionObserver`.
      Раздел «Группы» — заглушка до этапа 5 (модель `yga:groups` не вводится раньше срока).
- [x] Инлайн-редактирование настроек: изменение сразу отражается в виджете (общий `state.js`).
      Единый писатель — `profiles.saveSettingsPath(path, value)`: мгновенное зеркало
      в памяти + отложенная (300 мс) запись в `yga:settings`; подписчики —
      `profiles.onSettingsChanged`. Виджет различает стоимость правки: ширина/компактность/
      счётчики — только CSS-классы и `--yga-*`, «показывать нули» — перекраска счётчиков
      (`applyCounts`), позиция — перемонтирование. Кнопки «Сохранить» нет (§15).
      Кнопка ⚙ в шапке виджета открывает/закрывает панель.
- [x] Закрытие по Esc/✕, восстановление скрытого контента YouTube, блокировка скролла страницы.
      `Esc` и ✕ снимают `.yga-scroll-lock` с `html`/`body`, возвращают `.yga-hidden`
      хосту страницы и снимают слушатели. `yt-navigate-finish` перепривязывает панель
      к новому `#content` и в любом случае восстанавливает скрытый контент.
- [x] Подпись аккаунта в панели (отложена с этапа 2) — раздел «Профили»: аватар,
      имя и `accountKey` из `yga:account`.
- [x] Экспорт/импорт JSON и сброс (перенесено с этапа 2) — раздел «Данные»:
      дамп всех `yga:*`-ключей с маркером `ygaExport`, импорт с проверкой маркера,
      полный сброс с подтверждением (подписки YouTube не затрагиваются).
- Критерий: любое изменение настройки применяется в виджете без перезагрузки страницы.
  Проверено вне браузера: `node test/dom.mjs` — 25 проверок, из них 18 сценария панели
  (⚙ открывает панель в `#content`, гайд живёт, хост YouTube скрыт, скролл залочен,
  все 7 секций собрались без ошибок; правки `widget.widthPx` / `compact` / `showCounts` /
  `showZeroCount` доходят до виджа сразу; `Esc` закрывает панель, контент и скролл
  восстановлены). `node test/logic.mjs` — 60 проверок без изменений.
  Локализация панели: 58 новых ключей в `_locales/en` и `_locales/ru` (87 всего, наборы совпадают).
- Известная проблема UI (2026-11-09): панель показывает все 7 секций подряд; при пустом
  новом профиле секции «Счётчики» и «Виджет» уходят за край экрана, полоса прокрутки
  не появляется. Требуется доработка: вкладки вместо длинной страницы + внутренний
  скролл `.yga-panel-body`. **Решено в этапе 5 (`9ab7f27`):** панель — вкладки
  (`yga-panel-tabs` + `role=tab`), строится только активная секция, скрытые помечаются
  stale и пересобираются при активации; `.yga-panel-body` со внутренним скроллом.

### Этап 5 — группы каналов (решение §18; UI виджета — дерево вместо плоского списка) (реализовано 2026-11-09, `9ab7f27`, браузерная проверка не выполнена)
- [x] Модель: `yga:groups` + `groupId` в составе профиля (§5); CRUD групп в `groups.js`.
- [x] Виджет: строки групп с toggle `collapsed`, суммарный счётчик группы (§10.6),
      каналы с отступом под развёрнутой группой, сортировка внутри группы (§9).
- [x] Клик по каналу: переход на `/channel/<id>/videos` + обнуление счётчика канала
      и пересчёт счётчика группы (§10).
- [x] Экран настроек §9.2.1: поиск, чекбоксы/массовые операции, чип группы, 🗑/↺.
- [x] Экран настроек §9.2.2: CRUD групп (модалка), rename/delete, чипы-фильтры `n/m`,
      удаление группы → её каналы в «Без группы».
- [x] Кнопка «Группа» на странице канала (§8.8): dropdown групп активного профиля,
      быстрое создание, автодобавление канала в состав профиля.
- Критерий: `groupCount = Σ` детских счётчиков; клик по каналу обнуляет оба;
  `collapsed`/имена/состав переживают перезагрузку и SPA-навигацию; назначение группы
  кнопкой на странице канала сразу видно в виджете.

### Этап 6 — устойчивость и polish (реализовано 2026-11-09, браузерная проверка не выполнена)
- [x] Слой селекторов с fallback + телеметрия «сломалось» (в консоль/журнал стора).
       Fallback-цепочки — в `selectors.js` с этапа 0; телеметрия: `console.debug` +
       локальный журнал `yga:log` (кольцевой, ≤100 записей `{t, kind, detail}`,
       debounce 1 с); пишется при miss'е селектора и при таймауте mount (15 с) из
       `bootstrap.js`. Журнал локальный, наружу не уходит (§12). Просмотр: в консоли
       SW — `chrome.storage.local.get("yga:log", …)`.
- [x] CSP в manifest, экранирование всех строк YouTube, отказ от `innerHTML` с чужими данными.
       `content_security_policy.extension_pages: script-src 'self'; object-src 'self'`.
       Все 6 вхождений `innerHTML` — статический SVG-разметка (иконки), данных YouTube
       в них нет; весь текст YouTube — через `textContent`, URL — с whitelist `https://*.youtube.com`.
- [x] Производительность: профилировка 300 каналов, отсутствие layout thrash.
       Код-ревью: единственный forced-layout read — один `getBoundingClientRect` для
       позиционирования dropdown в `group-picker.js` (вне циклов); счётчики обновляются
       точечно (текст `.yga-count`), список батчится. Процедура профилировки в README;
       прогон в браузере на 300 каналах — заодно с браузерной проверкой этапов 3–5.
- [x] Локализация en/ru через `_locales` + `chrome.i18n`.
       114/114 ключей в `en`/`ru` (наборы совпадают, проверка ключей — в CI-прогонах
       харнесов); все UI-строки, включая `prompt`/`confirm`, идут через `yga.i18n`;
       кириллица в прод-коде — только в комментариях.
- [x] `README.md` (EN): установка (Load unpacked), архитектура, разрешение проблем с YouTube.
       Переписан: фичи, установка, архитектура и поток данных, ключи стора, разработка
       (харнесы), troubleshooting (пропал виджет / `?` у счётчиков / `15+` / сброс),
       приватность.
 - Критерий: расширение грузится без ошибок; при поломке селектора виджет деградирует,
   а факт зафиксирован в `yga:log`; документация позволяет установить и починить без PLAN.md.
   Проверено вне браузера: `node test/logic.mjs` — 60 проверок; `node test/dom.mjs` — 43
   (новая: miss селектора попадает в `yga:log`).

### Этап 7 — исправления из браузерной эксплуатации (2026-11-09)

1. **Combobox профиля: белый текст на белом фоне.** `.yga-profile-select` имел
   `background: transparent`, поэтому нативный popup `<option>` рисовался фоном ОС
   (белым), а текст наследовал белый цвет тёмной темы — видно было только на hover.
   Исправлено в `content/widget.css`: у селектора сплошной `background:
   var(--yga-surface)` (добавлен fallback `--yt-spec-general-background-a, #fff`),
   для `.yga-profile-select option` заданы `color`/`background` из темы; в
   `.yga-force-light` добавлен `--yga-surface: #fff`. Аналогично исправлен
   `.yga-panel-select option` в `config/panel.css`. Регресс-гард — 2 проверки в
   `test/dom.mjs` (по тексту CSS).
2. **Перемещение виджета по гайду (▲/▼).** См. §8.3: `widget.guideIndex` + футер
   `.yga-footer` с кнопками `.yga-move-up`/`.yga-move-down`, i18n-ключи `moveUp`/
   `moveDown`. Новый `profiles.js:saveSettingsPaths()` — атомарная запись нескольких
   вложенных полей одним emit. 7 проверок в `test/dom.mjs`.
3. **Клик по каналу перегружал всю страницу YouTube.** Разобрано по исходнику
   YouTube (`/s/desktop/<hash>/jsbin/spf.vflset/spf.js`, скачан 2026-11-09):
   обработчик клика SPF выглядит так
   ```js
   function Hc(a){ if(a.metaKey||a.altKey||a.ctrlKey||a.shiftKey||a.button>0) return null;
     var b=Ec(a.target);                                   // closest('.spf-link')
     return !b || z["nolink-class"] && Fc(a.target) ? null  // нет .spf-link → отказ
          : (a=Gc(a.target,b)) ? a.href : null; }
   ```
   т.е. **без класса `spf-link` у предка ссылки SPF отказывается от клика**, и
   браузер делает настоящую навигацию с полной перезагрузкой страницы.
   `PocketTube` (`examples/build/app.js`, 12 вхождений) навешивает
   `spf-link yt-simple-endpoint style-scope ytd-guide-entry-renderer` на каждый
   свой элемент гайда — поэтому у него SPA-навигация работает.
   Исправлено: `.yga-row` теперь `class="yga-row spf-link yt-simple-endpoint"`
   (`content/widget.js:rowNode`); проверка — в `test/dom.mjs`.
   Побочно (это была вторая, отдельная проблема, а не причина перезагрузки):
   - `bootstrap.js` вызывал `refreshSubscriptions()` на каждом `yt-navigate-finish`,
     а `page/bridge.js:getGuideSubscriptions` на текущем YouTube возвращает `[]`,
     поэтому каждый клик уходил в `api-client.js:fromBrowse()` — тяжёлый
     page-world-запрос `GET /feed/channels` с парсингом HTML;
   - `widget.render()` полностью перестраивал `.yga-list`.
   Исправлено: каталог обновляется по TTL `CATALOG_TTL_MS` (5 мин) + ретраем
   `CATALOG_RETRY_MS` (60 с) после ошибки; форсируется только на первом маунте,
   остальное отдаёт scheduled-alarm воркера. `widget.render()` переведён на
   ключевую сверку (`renderGroups` → `planGroups` + переиспользование
   `.yga-group-wrap` по `data-yga-group`, маркеры `_ygaCollapsed`/`_ygaSig`):
   группа с тем же состоянием сворачивания и тем же составом остаётся тем же
   DOM-узлом, счётчики перекрашиваются через `applyCounts()`. Проверка идентичности
    узлов — в `test/dom.mjs`.
    Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 55.
    **Не проверено в браузере** — нужен ручной прогон: клик по каналу должен вести
    себя как клик по элементу гайда YouTube (без F5-перезагрузки), ▲/▼ должны
    переживать переходы по страницам.
 4. **После `spf-link` клик ведёт себя как у YouTube (spf-замена контента), но
    гайд при этом перестраивается, а виджет исчезал.** `yt-navigate-finish`
    срабатывает раньше, чем YouTube вставляет новый гайд: `mountWidget()` в
    обработчике не находил `#guide-inner-content #sections`, возвращал `null`,
    а ожидающий MutationObserver к тому моменту уже был остановлен после
    успешного первого маунта — перемонтировать было некому.
    Исправлено в `content/bootstrap.js`: наблюдатель за `ytd-app` больше не
    останавливается (`startWaiting()` идемпотентен, `observerStop()` удалён);
    колбэк срабатывает только когда виджет реально отсутствует в DOM;
    `yt-navigate-finish` при неудачном маунте снова вызывает `startWaiting()`;
    телеметрия `mount-timeout` пишется только если виджет не монтировался ни разу
    (`everMounted`). Регресс-тест — 2 проверки в `test/dom.mjs` (гайд удалён →
    виджета нет; новый гайд добавлен → виджет вернулся).
    Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 57.
 5. **Сайдбар перерисовывался на каждой навигации (у PocketTube — нет).**
    Причина: виджет вставлялся внутрь `#guide-inner-content #sections` —
    Polymer-поддерева `ytd-guide-renderer`. Вставка чужого узла в управляемый
    контейнер заставляет гайд-рендерер перерисовать `#sections`, что удаляло
    виджет; наш же remount-наблюдатель вставлял его обратно — и цикл
    замыкался: перерисовка гайда на каждой навигации.
    Исправлено: виджет монтируется **рядом** с управляемой поддеревом — как
    сосед `ytd-guide-renderer` внутри `#guide-inner-content` (обычный DOM,
    Polymer его не перерисовывает). `widget.js:widgetHost()` возвращает
    `#guide-inner-content`, новый `guideManaged(host)` находит управляемый
    элемент (новый селектор `guideRenderer` в `selectors.js`), `insertWidget`
    вставляет виджет через `host.insertBefore(widget, managed.nextSibling)`
    (не `insertAdjacentElement` — иначе перенос из более позднего слота не
    возвращался на место); `position: "top"` — перед managed. Слоты ▲/▼
    считаются по детям хоста (гайд-рендерер = один слот). Регресс-гарды:
    «widget stays outside the Polymer-managed guide subtree» (маунт и
    rebuild) в `test/dom.mjs`.
    Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 59.
  6. **Клик по каналу всё ещё мог давать `boot-doc` при попытках SPA-навигации.**
     Живые логи показали, что `window.navigation.navigate` и `spf.navigate`
     приводят к полной перезагрузке, поэтому они убраны из автоматического
     списка `page/bridge.js:spaApis()`. Рабочий набор сейчас: варианты
     `window.ytCommand.navigate/load`, `ytglobal`, `ytPageManagerApi`, `ytspb`,
     `yt.load` и `anchor-click` (нативный якорь или скрытый `spf-link`).
     После патча пользовательские логи показали `row-click`/`row-nav` без
     последующего `boot-doc`: сайдбар не моргает, меняется только страница канала.
     Для точного определения API добавлен live-переход `CustomEvent("yga:journal")`
     из MAIN-world `page/bridge.js` в `content/selectors.js`, трекинг `currentApi`
     в `cmdNavigate()` и запись `row-nav spa` в `content/widget.js`.
     Свежий лог подтвердил рабочий путь: `page-nav try anchor-click` →
     `row-nav spa`, без `boot-doc`. `anchorClick()` возвращал `false` слишком
     рано, потому что YouTube перехватывает синтетический клик асинхронно;
     теперь он возвращает `true` после диспатча, а `cmdNavigate()` ждёт
     `yt-navigate-start/finish` или смены URL в пределах `wait`.
      Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 59.
  7. **Ctrl+F5: `Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'applyCounts')`.**
     `bootstrap.js` передавал `yga.widget.render` в `.then()` напрямую, поэтому
     метод терял `this`, а `render()` обращался к `this.applyCounts()`.
     Исправлено: `applyCounts()` вынесен в локальную функцию, `render()` вызывает
     её напрямую, а `yga.widget.applyCounts` остаётся публичным алиасом.
     Регресс-гард: `Promise.resolve(subs).then(yga.widget.render)` в `test/dom.mjs`.
     Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 60.


### Этап 8 — виджет только для просмотра (2026-11-10)

Пользователь: «виджет нужен только для просмотра, всё остальное — в настройках».

1. **Заголовок вместо заголовка+тулбара+футера.** `content/widget.js:buildWidget()`
   собирает строку `yga-header`: `title → total → refresh → ⚙ → ▲ → ▼`, а combobox
   профиля вынесен отдельной строкой `yga-profile-row` под заголовок (в узкий
   заголовок `<select>` не помещался; рядом с ним — никаких кнопок).
   `.yga-toolbar` и `.yga-footer` удалены; `counters.js:ensureToolbar()` вставляет
   чип `.yga-total` и кнопку `.yga-refresh` в `yga-header` перед ⚙ (кнопка
   обновления стала иконкой без подписи — в заголовке мало места). ▲/▼ переехали
   из футера в заголовок (§8.3). Регресс-гарды: «header carries total, refresh,
   gear and the move buttons», «refresh button is icon-only», «no footer / toolbar
   row left», «profile combobox is NOT in the header row», «profile combobox lives
   on its own line below the header» в `test/dom.mjs`.
2. **Убрано редактирование из виджета.** Удалены кнопки `.yga-profile-rename` /
   `.yga-profile-del`, опция «＋ Новый профиль» (`__add__`) в combobox и весь
   пикер каналов профиля (`.yga-picker`, `togglePicker`/`fillPicker`/`renderToolbar`
   и `curated()` в `widget.js`); `wireProfiles()` теперь только переключает
   активный профиль. Создание/переименование/удаление профилей и отбор каналов
   живут в панели (§9.2, секции «Профили» и «Каналы»). Гарды: «no rename/delete
   profile buttons», «profile select has no «+ New profile» option».
3. **Иконка ⚙ — зубчатая шестерня.** Прежний `GEAR_SVG` (круг с восемью лучами)
   визуально читался как значок яркости; заменён на cog-path.
4. **Кнопка «открыть канал» в панели.** В секции «Каналы» (`config/panel-sections.js:
   channelRow`) справа от строки — `<a class="yga-panel-icon yga-panel-open"
   href="/channel/<id>/videos" target="_blank" rel="noopener">` (↗). Настоящая
   ссылка: Ctrl/middle-click работают как ожидается, панель (оверлей) не закрывается.
   i18n-ключ `channelsOpen` (`_locales/en|ru`). Гард: «channel row has an
   open-in-new-tab link» в `test/dom.mjs`.

   Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 68.
   **Не проверено в браузере** — нужен ручной прогон: заголовок не должен ломать
   вёрстку гайда на узкой ширине, ↗ должен открывать канал в новой вкладке.

### Этап 9 — кнопки профилей на страницах канала и видео (2026-11-10, завершён 2026-11-11)

**Статус: завершён.** Тринадцатая браузерная проверка подтверждена пользователем: кнопки на
канале и видео стоят на своих местах, при скролле идут за якорем без прилипания, выезда за
край и прыжков; на видео не задевают Like. Итоговая модель позиционирования — оверлей на
`document.body` в `position:absolute` в document-координатах. Дальнейшие мелкие поправки
пользователя отложены в новую сессию.

Пользователь: кнопки добавления канала в группы — справа от подписки на канале (как
PocketTube) и слева от Like/Dislike на видео; по одной маленькой кнопке на профиль
(первая буква + цвет профиля, colorpicker в конфигурации); dropdown с чекбоксами групп.

1. **Цвет профиля.** `content/profiles.js`: поле `color` у профиля; палитра `PALETTE`
   (8 цветов), детерминированный `paletteColor(id)` (хэш id) для бэкфилла существующих
   профилей в `load()` и новых в `create()`; `setColor(id, color)` с валидацией
   `#rrggbb` (пишет через `persistProfiles()` → `onProfilesChanged`). В панели
   (`config/panel-sections.js:BUILDERS.profiles`) — `input[type=color]`
   (`.yga-panel-color`) в строке профиля, change → `setColor` + перерисовка секции.
2. **Кнопки профилей.** `content/group-picker.js` переписан: вместо одной кнопки
   «Группа» активного профиля — `div.yga-gp-group` с `button.yga-gp-letter` на каждый
   профиль (первая буква имени, `--yga-gp-color`/`--yga-gp-fg` — цвет профиля и
     контрастный текст по яркости). Якоря — текстово-геометрические: канал ищет
     видимую Subscribe/Subscribed/Sponsor/Join кнопку (в т.ч. RU), затем
     `selectors.js:subscribeButton`, затем правую видимую кнопку внутри шапки; видео
     ищет видимую Like-кнопку по accessible name, затем `likeButton`/`likeDislike`,
     затем `watchActions`. Оверлей на `document.body` (`position: fixed`) ставится по
     `getBoundingClientRect()` якоря, в дерево YouTube не вставляется (§7.5). Якоря
     ищутся `findVisible()` по light DOM (ShadyDOM `force/noPatch`), цепочки —
     view-model-теги → legacy `ytd-*-renderer` → `[class*="…"]`, `findDeep()` — запасной
     путь. Хост несёт `data-yga-anchor` для диагностики. Перемонтирование по
     `yt-navigate-finish`, `onProfilesChanged` и смене `widget.channelPageButton` /
     `widget.watchPageButton`.

3. **Dropdown с чекбоксами.** Клик по кнопке профиля открывает меню групп **этого**
   профиля: `label.yga-gp-item` → `span.yga-gp-name` + `input.yga-gp-check`
   (отмечен = `groupId` канала в этом профиле); снятие чекбокса = «Без группы»
   (`setGroup(..., null)`), отметка = назначение. Быстрое создание группы внизу меню.
   Быстрые перерисовки — `state.refreshVisible()`; меню закрывается по клику вне.
4. **Настройки и i18n.** `widget.watchPageButton` (по умолчанию `true`) — чекбокс в
   секции «Виджет»; ключи `widgetWatchPageButton(+Hint)`, `profileColor` (en/ru).
5. **Тесты.** `test/dom.mjs`: сценарий stage9 — mount на канале (позиция справа от
   подписки, 3 кнопки «ACG», цвет в styleVars), dropdown p3 (строка «Music», чекбокс →
   `groupId`, повторное открытие — отмечен, снятие → `null`), mount на `/watch` слева
   от Like/Dislike, colorpicker в панели → новый цвет протёк в кнопку. Харнес
   `dispatchEvent` нормализует plain-объекты событий (`preventDefault`).
   Итог харнесов: `logic.mjs` — 60, `dom.mjs` — 84.
6. **Фиксы браузерной проверки (2026-11-10).** Пользователь: «не вижу новых кнопок ни на
   канале ни на видео». Две причины:
   - **Поздний якорь.** `yt-navigate-finish` срабатывает раньше, чем YouTube отрисует
     шапку подписки и кластер Like/Dislike, поэтому первый `mount()` не находил якорь и
     молча выходил. `content/group-picker.js`: ограниченный retry (`RETRY_MS` 400 мс,
     дедлайн `RETRY_TIMEOUT_MS` 15 с, `scheduleRetry`/`stopRetry`) при отсутствии якоря
     или ответа моста; окно retry сбрасывается на `yt-navigate-finish` и смене настроек;
     по истечении — журнал `group-picker-timeout`. (Виджет выживает тем же способом через
     постоянный MutationObserver в `bootstrap.js`.)
   - **Watch-страница.** `cmdGetPageChannel` в `page/bridge.js` резолвил только канал
     страниц; на `/watch` возвращал пустой `channelId` → кнопки не монтировались никогда.
     Добавлен fallback на `ytInitialPlayerResponse` (`videoDetails.channelId`,
     `microformat.playerMicroformatRenderer.ownerChannelId`/`externalChannelId`, автор как
     title).
   Регресс-тест в `test/dom.mjs`: навигация на канал без якоря → кнопок нет → якорь
   появляется позже → кнопки монтируются после retry-тика.
7. **Якорь рядом с кнопкой PocketTube (2026-11-10).** Пользователь: «сделай как в
   PocketTube», «добавь свои кнопки рядом с его». Разбор `examples/build/app.js`: кнопка
   «Добавить в группу» PocketTube — это `.add-to-collection-button-new`, которую PocketTube
   вставляет в **light DOM** рядом с кластером подписки (канал и видео). Наши прежние якоря
   (`ytd-page-header ytd-subscribe-button-renderer`, `ytd-segmented-like-dislike-button-renderer`)
   в живой шапке не матчились (телеметрия `selector-miss`), а реальные узлы YouTube лежат в
   **Shadow DOM**, куда `document.querySelector` не заглядывает. Решение:
   - `selectors.js`: новый `pocketTubeButton: [".add-to-collection-button-new"]` + тихий
     `findOptional()` (отсутствие не пишется в `yga:log` — кнопки PocketTube может не быть).
   - `group-picker.js`: `mount()` сначала ищет `pocketTubeButton`; если он есть — вставляет
     `div.yga-gp-group` сразу **после** него (`afterend`, обе страницы). Иначе — прежние якоря
     (после подписки на канале, перед Like/Dislike на видео). Light-DOM-якорь ⇒ CSS виджета
     стилизует кнопки без инъекции в shadow root.
   Регресс-тест: на канале появляется `.add-to-collection-button-new` → кнопки монтируются
   соседним элементом сразу за ним.
8. **Фиксы второй браузерной проверки (2026-11-10).** Пользователь: кнопки появились только
   на канале, но «в следующей строчке под кнопками подписки»; на видео кнопок нет; «после
   твоих изменений поломался правильный рендеринг — страница моргает» (регресс §7.5).
   - **Моргание/перерисовка.** В п.7 в `subscribeButton`/`channelHeader` добавили
     `#page-header` и `#page-header yt-flexible-actions-view-model`. `#page-header` —
     элемент под управлением Lit: вставка нашего узла внутрь/после него заставляет YouTube
     перерисовать всю шапку на каждой навигации — тот же класс бага, что чинили в §7.5.
     Откатили: из обеих цепочек убраны `#page-header*`-селекторы, остались только `ytd-*`
     (legacy-fallback). Единственный рабочий light-DOM-якорь — кнопка PocketTube.
   - **Кнопки «на новой строке» и их отсутствие на видео.** PocketTube держит в DOM несколько
     `.add-to-collection-button-new` (в т.ч. скрытые шаблоны); `findOptional` брал первый —
     скрытый ⇒ якорь вне экрана/в чужом контейнере. Добавлен `selectors.findVisible()` —
     первый матч с **ненулевым** `getBoundingClientRect()` (скрытые/отсоединённые узлы дают
     нулевой box). `mount()` для PocketTube-якоря использует `findVisible`.
   Регресс-тест: в DOM скрытый `.add-to-collection-button-new` (`_hidden`) + видимый →
   кнопки монтируются соседом **видимого**. Харнесы: `logic.mjs` — 60, `dom.mjs` — 85.
9. **Автономный fixed-оверлей вместо привязки к PocketTube (2026-11-10).** Пользователь:
   «моргание не исчезло, рефрешится целый ютуб; кнопок нет ни на канале ни на видео; если ты
   привязываешься к кнопке PocketTube — не надо, наш плагин должен заменить PocketTube».
   Вывод: опора на чужую кнопку (п.7–8) — тупик, а вставка в дерево YouTube (п.7) — источник
   моргания (§7.5). Полностью убрали зависимость от PocketTube и вставки в DOM YouTube:
   - **Никогда не вставляем в дерево YouTube.** `group-picker.js` монтирует `div.yga-gp-group`
     как `position: fixed`-оверлей на `document.body` (CSS `.yga-gp-group { position: fixed;
     z-index: 10000; }`). Оверлей на `<body>` физически не может вызвать перерисовку Lit/Polymer
     шапки — моргание исключено по построению.
   - **Позиционирование от нативного якоря.** `positionHost()` читает `getBoundingClientRect()`
     якоря и ставит `left`/`top` через `style.setProperty`: на канале — справа от кластера
     подписки (`rect.right + 8`), на видео — слева от Like/Dislike (`rect.left - 8 - w`).
     Якорь **только читается**, в него ничего не вставляется.
   - **Прокол Shadow DOM.** Нативные якоря (`ytd-subscribe-button-renderer`,
     `ytd-segmented-like-dislike-button-renderer`) лежат в открытых shadow root'ах, куда
     `document.querySelector` не заглядывает. `selectors.js`: `deepQuerySelectorAll()` (BFS по
     `element.shadowRoot`) + метод `findDeep(name)`; `isVisible`/`findVisible` и ключ
     `pocketTubeButton` удалены.
   - **Трекинг якоря.** `startTracking()` вешает `scroll`(capture)+`resize` и `setInterval`
     250 мс, чтобы оверлей следовал за якорем; `stopTracking()` вызывается в `unmount()` и в
     обработчиках `yt-navigate-finish`/`onSettingsChanged`. Меню групп appending'ится на
     `document.body` (оверлей с `transform` стал бы containing block для `position: fixed`).
   Регресс-тесты переписаны: оверлей на `document.body` вне управляемого поддеревa с
   `styleVars.left/top` (канал `168px/200px`, видео `66px/200px`); новый тест — якорь внутри
   фейкового `shadowRoot` не виден `querySelector`, но кнопки монтируются через `findDeep`.
   PocketTube-тест удалён. `report()` в харнесе теперь всегда завершает процесс (оверлей держит
   `setInterval`). Харнесы: `logic.mjs` — 60, `dom.mjs` — 86.
    **Требует браузерной проверки** (перезагрузка расширения + Ctrl+Shift+R): кнопок нет на обеих
    страницах и моргание — именно то, что этот шаг устраняет.
10. **Фиксы третьей браузерной проверки (2026-11-10).** Пользователь: «визуально ничего не
    изменилось», `document.querySelector('[data-yga-group-buttons]').dataset.ygaAnchor` →
    `watch-deep`. Причина: RU-подпись Like «Мне нравится» содержит подстроку «не нравится»,
    поэтому `DISLIKE_TEXT_RE` отбрасывал Like-кнопку и якорь падал в deep-путь. Исправлено:
    dislike-guard теперь требует границу слова/пробела (`(?:^|\s)(?:dislike|не нравится)(?:\s|$)`),
    Like-регулярка расширена (`like`, `unlike`, `liked`, `Мне нравится` через `нравится`).
    Дополнительно текстовый поиск кнопок получил deep-fallback через `selectors.queryDeep()`
    для открытых shadow root'ов, а `findVisibleButton()` выбирает наименьший видимый матч,
    чтобы не брать внешний контейнер. Deep-якоря стали диагностичнее: `watch-like-deep`,
    `watch-deep-like`, `watch-deep-cluster`, `watch-deep-left`, `watch-deep-actions`.
    Регресс-тесты: RU Like не отсеивается как Dislike; Like внутри фейкового `shadowRoot`
    находится deep-текстовым якорем. Харнесы: `logic.mjs` — 60, `dom.mjs` — 89→91.
     **Статус на конец дня (2026-11-10):** правки в коде и харнесах зафиксированы, браузерная
     проверка после перезагрузки расширения ещё не выполнена. Следующий шаг завтра: перезагрузить
     расширение, открыть канал/видео с Ctrl+Shift+R, проверить `data-yga-anchor`; если снова
     `*-deep`, прислать новое значение якоря и ближайший DOM-фрагмент вокруг Subscribe/Like.
11. **Четвёртая браузерная проверка: кнопки на обеих страницах, но не на своих местах
    (2026-11-11).** Пользователь: «кнопки присутствуют на обоих экранах, но не на своих местах».
    Вместо догадок добавлен read-only зонд `test/probe-anchor.js` (печатает якорь, `rect` хоста,
    все матчи цепочек `selectors.js` и все видимые кнопки шапки/`#actions` с accessible name);
    вывод снимков и дал три корня:
    - **Канал (`channel-actions`).** Якорем становился `yt-flexible-actions-view-model` — весь
      ряд действий (680×40, L293→R973 при вьюпорте 1030), а не кнопка подписки: Subscribe лежит
      в **нативном** shadow root (`shadyDom:false` — прежний вывод §11.9 «всё в light DOM»
      устарел), а `findChannelAnchor` пробовал deep-поиск только после контейнера. `left =
      rect.right + 6 = 979` clamp'ился к 940 → кнопки у правого края экрана.
    - **Видео (`watch-deep-actions` → `watch-like`).** Ряд `#actions` начинается с x=16 и
      упакован без зазоров (Like 16→102, Dislike 102→172, …), поэтому слот «слева от Like»
      физически не существует; `left = 16-6-86 = -76` clamp'ился к левому краю поверх Like.
    - **Якорь падал на Dislike.** Хост на L10 = `102-6-86`, т.е. якорем был Dislike: RU-имя
      `Поставить отметку "Не нравится"` не отбрасывалось `DISLIKE_TEXT_RE`, который требовал
      границу `\s`, а перед «Не» стоит кавычка.
    Исправления в `group-picker.js`:
    - `DISLIKE_TEXT_RE` — граница «любой не-буква» (`(?:^|[^\p{L}])…(?:$|[^\p{L}])`, флаг `u`);
      «Мне нравится» по-прежнему Like, `«Не нравится»` — отбраковано.
    - `findChannelAnchor()` — порядок: light-текст → **deep-текст** → light-loose → deep-loose
      (`CHANNEL_TEXT_LOOSE_RE` под descriptive-имена вида «Отменить подписку на канал …») →
      только затем контейнер-ряд. Добавлен `row` в описатель якоря (`rowFor()` по
      `ROW_SELECTOR`).
    - `positionHost()` — вместо одной стороны от якоря выбор **свободного слота в ряду**:
      кандидаты [желаемая сторона, после последней кнопки ряда, обратная сторона, перед первой],
      первый проходит проверку вписывания во вьюпорт (4 px) и непересечения с `rowBoxes()`
      (видимые кнопки ряда, deep — чтобы не накрыть и shadow-кнопку). Канал: справа от Subscribe;
      видео: слева от Like, иначе свободный зазор после ряда.
    Харнес: `_rect` в фикстурах (живые геометрии из снимков), `closest()` теперь понимает
    списки селекторов; три новых регресса — shadowed Subscribe важнее ряда (`channel-text-deep`,
      `796px/365px`), quoted RU Dislike не становится якорем, упакованный ряд видео берёт
    зазор после последней кнопки (`370px/743px`). `logic.mjs` — 60, `dom.mjs` — 91→94.
    **Пятая браузерная проверка (2026-11-11) — этап переоткрыт:** позиция верна только на
    канале из снимков; на втором кнопками «прыгнули вправо», на третьем — «на две строчки
    вниз»; пользователь отметил языковую хрупкость текстовых якорей. Корни: (1) `band` в
    `positionHost` брался от rect ряда — перенос строки центрировал оверлей по двухстрочному
    ряду и тянул слот за кнопки второй строки; (2) текстовые regex знают только RU/EN имена.
    Исправление: **структурные якоря первыми** (языконезависимые теги/классы/accessibility-id) —
    `SUBSCRIBE_STRUCT` (`yt-subscribe-button-view-model`, `ytd-subscribe-button-renderer`,
    `#subscribe-button`, `[class*="subscribe-button"]`) → `channel-subscribe`, `LIKE_STRUCT`
    (`[id="id.video.like.button"]`, view-model теги/классы) → `watch-like-struct`; хелпер
    `findSmallestVisible()` (наименьший видимый матч, dislike-view-model отбраковывается — его
    класс содержит подстроку `like-button-view-model`). Текстовые ветки остались fallback.
    `positionHost`: band = rect самого якоря, `rowBoxes` фильтруются строкой якоря
    (`b.top < trect.bottom && b.bottom > trect.top`). Зонд: цепочка `subscribeButton`
    дополнена структурными селекторами. Харнес: 2 новых регресса (структурная подписка без
    единой подписи; перенос ряда не утягивает оверлей), `top` packed-ряда 743→745 (центрирование
    по кнопке 40px вместо ряда 36px). `logic.mjs` 60, `dom.mjs` 94→96.
    **Требует браузерной проверки на всех трёх каналах** (ожидается `channel-subscribe` /
    `watch-like-struct` либо текстовый fallback; при промахе — снимок `test/probe-anchor.js`).
    Фолбэк-план пользователя, если структурные якоря тоже окажутся хрупкими: перенос кнопок
    в виджет (там текущий канал доступен).
    **Шестая браузерная проверка (2026-11-11):** все три канала встали на свои места —
    структурная подписка подтверждена. Видео сломались иначе: на обоих `data-yga-anchor` =
    `watch-like-id`, т.е. провалились и структурная, и обе текстовые ветки, и сработала
    legacy-цепочка `likeButton` через `findVisible` (первый матч с ненулевым rect). На одном
    видео оверлей наехал на подписку, на другом исчез — оба симптома согласуются с якорем по
    **скрытому дублю-призраку** (rect есть, но элемент не там, где настоящий Like).
    Исправления: (1) ветка `watch-like-id` больше не использует `findVisible` — тот же полный
    список селекторов (`LIKE_CHAIN`) проходит через `findSmallestVisible` light→deep
    (наименьший матч + ширина-гард); (2) в `findSmallestVisible` добавлен **классовый
    dislike-гард** `isDislikeStructural()` — комментарий обещал его, но код имел только
    текстовый: `yt-dislike-button-view-model` матчится `[class*="like-button-view-model"]`
    как подстрока, его accessible name — только счётчик (текст-гард молчит), и он меньше
    Like, поэтому «наименьший» выбрал бы его; сегментированный кластер («segmented»,
    «like-dislike») гард проходит; (3) диагностика прямо на хосте: `positionHost` пишет
    `data-yga-anchor-el` (тег#id.класс «accessible name») и `data-yga-anchor-rect`
    (L,T WxH) — одна строка в консоли вместо полного зонда. Зонд: цепочка `likeButton`,
    deep-снимки обеих like-цепочек, флаги OFFSCREEN/VIS/OPACITY/SHADOW, чтение новых
    датасетов. Харнес: 2 регресса (count-only dislike не бьёт like-view-model —
    `watch-like-struct` `158px/745px`; цепочка пропускает широкий ghost `#like-button`
    в пользу `ytd-like-button-renderer` — `watch-like-id` `108px/745px`).
    `logic.mjs` 60, `dom.mjs` 96→98.
    **Седьмая браузерная проверка (2026-11-11):** однострочник с проблемного видео дал
    `anchor: watch-deep-actions` (`div#actions`), а зонд — пустые `likeDislike`/`likeButton`
    (light и deep) при видимом Like `button.ytSpecButtonShapeNextHost` внутри
    `div#top-level-buttons-computed`: на этой раскладке **нет ни view-model-обёрток, ни
    legacy-тегов** — структурные ветки промахиваются по определению. Настоящая причина
    залипания: mount поймал `#actions` **до** рендера like-кластера, якорь встал в ряд, а
    `reanchor()` ре-резолвил только **отсоединённые** якоря — ряд остаётся connected навсегда,
    поэтому оверлей всю страницу лежал на подписке. Второе видео (`watch-like`, оверлей слева
    от Like) — поведение по спеке, подтверждено. Исправления: (1) **ранги якорей**
    `ANCHOR_RANK` + `GOOD_RANK=2`: трекер (250ms) ре-резолвит connected-якорь с рангом выше
    GOOD и ставит первый лучший, экспоненциальный backoff 1s→16s и максимум 5 попыток
    (deep-find не крутится вечно на страницах, где лучший якорь — fallback); (2)
    `#top-level-buttons-computed` добавлен в `LIKE_STRUCT` и в цепочку `likeDislike` —
    единственный языконезависимый проб для раскладки без view-model. Харнес: +2 регресса
    (пустой `#actions` → `watch-deep-actions`; поздний кластер апгрейдит якорь в
    `watch-like-struct` `661px/901px`). `logic.mjs` 60, `dom.mjs` 98→100.
    **Требует браузерной проверки на видео с наездом:** перезагрузка расширения,
    Ctrl+Shift+R; ожидается `watch-like-struct` (или `watch-like`) и оверлей слева от Like;
    залипший `watch-deep-actions` больше не должен переживать рендер кластера.
    **Восьмая браузерная проверка (2026-11-11):** позиции подтверждены на канале и обоих
    видео, но при скролле оверлей «зависает на старом месте, потом перепрыгивает».
    Слушатель scroll+rAF на месте — тормоз в стоимости кадра: `positionHost` каждый кадр
    звал `rowBoxes` → `queryDeep(BUTTON_SELECTOR, row)`, а рядом оказываются огромные
    контейнеры (`#page-header`, `#above-the-fold`) — deep-обход shadow-дерева на 60fps
    насыщал main thread поверх скролл-работы YouTube, кадры терялись и оверлей ехал только
    на таймере 250ms. Исправление: список кнопок ряда кэшируется в `rowCache` (ключ — сам
    элемент ряда), каждый кадр заново снимаются только `getBoundingClientRect`; кэш
    сбрасывается таймером трекинга (250ms), при свапе якоря в `reanchor` (ряд тот же,
    содержимое новое) и в `mount`/`stopTracking`. `logic.mjs` 60, `dom.mjs` 100.
    **Требует браузерной проверки:** скролл канала и видео — оверлей должен идти за
    якорем без задержек; при этом новый контрол в ряду (Join/поздний кластер) учитывается
    не позже 250ms.
    **Девятая браузерная проверка (2026-11-11):** канал после кэша ряда стал плавным, на
    видео прыжки остались; плюс новая находка — при скролле канала и видео оверлей не
    уезжает за экран, а прилипает к верхнему краю окна. Корень прилипания: `top =
    Math.max(4, ...)` в `positionHost` — когда якорь уходит за верх вьюпорта, clamp
    парковал хост на 4px. Исправления: (1) clamp убран, вместо него оверлей скрывается
    (`yga-gp-hidden`), когда rect якоря целиком вне вьюпорта (`bottom < 0 || top >
    innerHeight`) — кнопки уезжают вместе с якорем; (2) `reanchor()` убран из покадрового
    rAF-пути (scroll зовёт только `positionHost`), он остаётся на таймере 250ms — мёртвый
    якорь больше не платит глубоким `findAnchor` за каждый кадр скролла (главный кандидат
    на остаточные прыжки видео: YouTube перерисовывает like-кластер при скролле, dead-путь
    крутился покадрово). Харнес: `innerHeight=1440`, +1 регресс (якорь за верхом экрана →
    хост скрыт). `logic.mjs` 60, `dom.mjs` 100→101. **Требует браузерной проверки:**
     скролл канала и видео — кнопки идут за якорем, уходят за экран и не прилипают; на
     видео прыжки должны исчезнуть или заметно уменьшиться.
     **Десятая браузерная проверка (2026-11-11):** на видео прилипание к верхнему краю
     ушло, но кнопки «уезжают за границу» (половина хоста за верхним краем), прыжки на
     видео остались; на канале прилипание к верхнему краю не ушло вообще. Три корня:
     (1) отсутствие clamp'а рисует хост на отрицательном `top`, пока якорь частично виден
     под sticky-masthead → оверлей теперь скрывается, когда якорь не ЦЕЛИКОМ внутри полосы
     под шапкой (`trect.top < topBound || trect.bottom > innerHeight`), `topBound` —
     `rect.bottom` фиксированного `ytd-masthead`/`#masthead` (0, если не найден);
     (2) на канале прилипает сам якорь: схлопнутая шапка канала приклеена под masthead,
     rect подписки не двигается при скролле → `detectPinned()` на таймере 250ms (липкое
     состояние: снимает только движение якоря `|Δtop| > 3`, ставятся два тика со
     `|ΔscrollY| > 40`) и оверлей уходит вместе со схлопнутой шапкой;
     (3) прыжки видео — стоимость и нестабильность кадра: `rowBoxes` переснимал
     `getBoundingClientRect` каждого контрола ряда каждый кадр и каждый кадр же писал три
     dataset-атрибута (инвалидация стилей → layout-чтение), а состав боксов ряда меняется
     при ленивом реренде YouTube → слот перещёлкивался между зазорами. Теперь боксы кэша
     в DOCUMENT-пространстве (`rect + scrollX/scrollY`, кадр = один `getBoundingClientRect`
     якоря), выбранный зазор держится, пока свободен (гистерезис `slot`), боксы самого
     якоря и его обёрток (`#top-level-buttons-computed` подходит под `[class*="button"]`)
     больше не считаются препятствием, диагностика (`data-yga-anchor-el/-rect/-pinned/
     -top-bound`) пишется только на таймере 250ms и при смене якоря. Харнес: +8 регрессов
     (якорь под masthead → скрыт; возврат из-под masthead → виден `218px/77px`; липкая
     шапка → скрыт и возврат; зазор после широкого бокса; churn ряда не переключает зазор;
     заблокированный зазор перещёлкивается). `logic.mjs` 60, `dom.mjs` 101→109.
     **Требует браузерной проверки:** видео — кнопки не вылезают за край и не прыгают;
     канал — кнопки уходят вместе со схлопнутой шапкой вместо прилипания. Если «уходят
     вместе с шапкой» не устраивает (кнопок нет при скролле канала) — варианты: понизить
      z-index оверлея под masthead и прятать только под шапкой либо переносить кнопки в
      виджет (§11.11 фолбэк).
      **Одиннадцатая браузерная проверка (2026-11-11):** канал полностью устроил — кнопки
      корректно уезжают за край и не прыгают; на видео край тоже корректный, но прыжки
      остались. Следующий корень: `position:fixed` обязывал переписывать `left/top` каждый
      кадр скролла, а на watch-странице тяжёлый JS YouTube иногда задерживает rAF — хост
      отстаёт и перепрыгивает. Хост переведён в `position:absolute` в DOCUMENT-координатах
      (`left = leftDoc`, `top = trect.top + scrollY + offset`); при обычном скролле
      пересчитанные координаты не меняются, поэтому `lastLeft/lastTop` подавляют запись
      стиля, а саму страницу прокручивает браузер без участия JS. Размер хоста кэшируется
      (`hostW/hostH`) вместо `offsetWidth/offsetHeight` каждый кадр. Харнес: регресс
      sticky-канала обновлён на document-координаты (`top=1040px` при `scrollY=400`).
      `logic.mjs` 60, `dom.mjs` 109. **Требует браузерной проверки:** видео — прыжки при
      скролле должны исчезнуть; канал — поведение не должно ухудшиться.
      **Двенадцатая браузерная проверка (2026-11-11):** скроллинг идеален на канале и видео,
      прыжков нет; позиция на канале идеальная, на видео кнопки слегка наезжают на Like.
      Причина: предпочтительный watch-слот слева от Like считался с тем же зазором 6px, что
      и fallback-зазоры, а у Like есть hover/padding-ореол и у активной кнопки профиля —
      4px ring. Исправление: отдельный `watchLeftGap=10` только для предпочтительного слота
      слева от Like; fallback-зазоры остались 6px. Диагностика добавила
      `data-yga-host-size`. Харнес: watch-left `68px→64px`, late-cluster `661px→657px`.
       `logic.mjs` 60, `dom.mjs` 109. **Тринадцатая браузерная проверка (2026-11-11):**
       пользователь подтвердил — все отлично; этап 9 закрыт. Возможные мелкие поправки будут
       собраны в новой сессии.



### Этап 99 — дальнейшие функции (бэклог)
- Drag&drop каналов в группы и между ними, ручная сортировка (без библиотек: HTML5 DnD),
  сортировка по активности/подписчикам.
- Отметка «просмотрено» по видео (не по каналу), авто-отметка при просмотре на YouTube.
- «Открыть все новые» как единый плейлист (`/watch_videos?video_ids=…`, как PocketTube).
- Глобальный поиск по каналам в виджете (инпут под заголовком).
- Pin/favorite каналов.
- Popup расширения (быстрый список топ-N новых), badge с общим числом новых.
- Экспорт/импорт подписок и настроек (JSON), сброс к значениям по умолчанию.
- Синхронизация между устройствами через `chrome.storage.sync` (без сервера).
- Поддержка нескольких аккаунтов YouTube (профиль ⇔ аккаунт) как отдельный режим.

### Этап 10 — фильтры видео: Shorts / трансляции / старше N дней (2026-11-12)

**Статус: этап закрыт 2026-11-12.** Реализация завершена, харнесы зелёные; браузерная
проверка отложена по решению пользователя.

Фильтры глобальные (`settings.filters`), не по профилям: общий кэш счётчиков в worker
остаётся profile-blind (§10.4), один пересчёт обслуживает все вкладки. По умолчанию все
фильтры выключены — поведение идентично этапу 9.

1. **Парсер.** `content/rss-parser.js`: у записи появились поля `label` (текст
   `media:title` внутри `media:group` — это заголовок видео), `kind` (`video` /
   `shorts` / `live` — путь ссылки `link rel="alternate"`: `youtube.com/shorts/<id>`,
   `youtube.com/live/<id>`), `duration` (`media:duration`, секунды) и `category`
   (последний токен `scheme` верхнеуровневого `<category>`: `video`/`movies`/
   `episodes`/`shows`).
2. **Worker.** `background/service-worker.js`: `filtersCfg()` (дефолты — все выкл),
   `entryVisible()` (Shorts — `kind === "shorts"`, live — `kind === "live"`, возраст —
   `at - publishedAt > maxAgeDays·сутки`); `computeCounts`/`unwatchedAt`/`countValue`/
   `countSince` применяют фильтры; `counters:settings` пересчитывает счётчики из кэша
   записей **без рефетча** и рассылает `counters:counts` + агрегаты всех профилей;
   записи кэша, написанные до появления `kind`, не классифицируются из storage —
   при включённом `hideShorts`/`hideLive` они один раз отправляются в очередь на
   рефетч (`migrating` в ответе).
3. **Панель.** `config/panel-sections.js`: новая секция «Фильтры» (`sectionFilters`) —
   чекбоксы `filters.hideShorts`, `filters.hideLive` и число `filters.maxAgeDays`
   (0 = выкл, максимум 3650); каждое изменение — `u.save` + `u.notifyWorker()`.
   Дефолты `filters` добавлены в `content/profiles.js` (`getSettings`).
4. **i18n.** Ключи `sectionFilters`, `filterHideShorts(+Hint)`, `filterHideLive(+Hint)`,
   `filterMaxAgeDays(+Hint)` в `_locales/en|ru`.
5. **Сброс счётчиков.** Правый клик теперь работает не только по каналу: по строке группы
   сбрасываются все каналы этой группы, по общему счётчику в шапке — все видимые каналы
   активного профиля. Используется существующий батч `counters:setVisits` (одна запись
   composition + один emit), локальный перекрас rows/group chips/total выполняется сразу.
6. **Тесты.** `test/fixture-feed.xml`: записи Shorts (`link … /shorts/<id>`) и live
   (`link … /live/<id>`), остальные — `watch?v=`. `test/logic.mjs`: парсер — `kind`/
   `label`/`duration`/`category` и регресс «заголовок со словами Shorts/Live остаётся
   `video`»; секция filters — off=5, hideShorts=4, +hideLive=3, maxAgeDays=1→0, 0=выкл,
   возврат=5, пересчёт без рефетча, рассылка counts+aggregate; секция kind filters —
   реальный формат фида (три ссылки), off=3 → hideShorts=2 → +hideLive=1 → off=3 и
   миграция кэша без `kind` (refetch + переклассификация). `test/dom.mjs`: правый клик
   по группе сбрасывает только её каналы, правый клик по total сбрасывает все видимые
   каналы. Итог харнесов: `logic.mjs` — 97, `dom.mjs` — 163.

### Этап 11 — аватары групп: встроенные иконки и URL (2026-11-12)

**Статус: реализация завершена 2026-11-12, базовая браузерная проверка пройдена пользователем
(«все работает»); тонировка доработана после обратной связи 2026-11-12: цвет из попапа
сохраняется, виджет меняет `img` на тонированный `span`, аватар в таблице больше не скрывается
из-за CSS-правила `:not([src])`, а форма аватаров сделана прямоугольной с небольшим скруглением.
После обратной связи про обрезку верхней левой четверти добавлены `mask-size`, `mask-repeat`
и `mask-position` для тонированных аватаров; для цвета добавлена кнопка «Установить», которая
применяет выбранный цвет к текущей иконке, не закрывая попап. После обратной связи про то, что
кнопка работала только после повторного выбора цвета, «Установить» читает текущее значение
colorpicker и сохраняет его сразу, даже если пользователь не двигал colorpicker заново.
Требуется повторная браузерная проверка тонировки.** Харнесы зелёные.

Аватар хранится внутри записи группы в `yga:groups` как `avatar`:

- `{ type: "builtin", theme: "<theme-id>", index: <1..count>, color?: "#rrggbb" }` — встроенная
  иконка из `icons/groups/<theme>/<index>.<ext>`, опционально тонированная в цвет;
- `{ type: "url", url: "https://..." }` — внешнее изображение по прямой HTTPS-ссылке;
- отсутствие поля `avatar` — аватар не задан.

1. **Каталог иконок.** `test/gen-group-icons.mjs` сканирует `icons/groups` и генерирует
   компактный `content/group-icons.js`: 38 тем, 4830 иконок. Файлы идут подряд как
   `1.ext..count.ext`, поэтому в каталоге хранятся только `id`, `label`, `ext` и `count`.
   `seo-and-internet-marketing` и `wedding` используют `.jpg`, остальные — `.png`.
2. **Модель групп.** `content/groups.js`: `setAvatar(groupId, avatar)` нормализует аватар
   через `yga.groupIcons.normalize()`, удаляет невалидные значения и пишет изменение в
   `yga:groups` с `updatedAt`.
3. **Попап выбора.** `config/icon-picker.js`: модалка внутри панели с вкладками
   «Без аватара», всеми темами и «URL». Сетка показывает превью встроенных иконок,
   вкладка URL принимает только прямые `https://` ссылки, кнопка «Убрать» очищает аватар.
   Внешние иконки можно искать на `https://icons8.com/` и устанавливать прямой ссылкой вида
   `https://img.icons8.com/?size=48&id=HqsZDKt3q3UW&format=png&color=000000`.
4. **Конфигурация.** `config/panel-sections.js`: в разделе «Группы» перед названием группы
   появляется прямоугольная кнопка аватара с небольшим скруглением. Клик открывает попап; выбор сразу сохраняет аватар,
   обновляет виджет и перерисовывает секцию.
5. **Виджет.** `content/widget.js`: аватар группы вставляется слева от названия группы.
   При переиспользовании DOM-узла группы аватар перекрашивается отдельно, если изменился
   только он. Внешние URL-картинки помечаются `loading="lazy"`; при ошибке загрузки CSS
   скрывает битую иконку, не ломая строку группы.
6. **Manifest и i18n.** `manifest.json` подключает `content/group-icons.js` до
   `content/groups.js` и `config/icon-picker.js` до `config/panel-sections.js`;
   `web_accessible_resources` уже покрывает `icons/*`. Добавлены ключи en/ru для аватара,
   попапа, URL-подсказок и кнопки удаления.
7. **Тонировка (запрос пользователя 2026-11-12).** Иконки темноватые, но PNG/JPG остаются
   нетронутыми: у встроенного аватара появился `color` (`#rgb`/`#rrggbb`), который красит
   иконку через CSS `mask-image` (альфа-канал файла = форма, `background-color` = цвет).
   `group-icons.js`: `normalize` принимает только валидный hex, `sig` учитывает цвет,
   добавлены `normalizeColor`, `tinted`, `avatarNode` (span с маской вместо img). Виджет,
   панель и превью попапа красятся через `avatarNode`; URL-аватары не тонируются. В попапе
     — ряд «Цвет» с нативным color-input, кнопкой «Установить» и кнопкой «Оригинал»; выбранный
      цвет применяется к следующей выбранной иконке, а «Установить» сразу сохраняет текущее
      значение colorpicker для текущей встроенной иконки, не закрывая попап и не требуя
      повторного выбора уже показанного цвета. `paintGroupAvatar()` удаляет старый узел при
     очистке аватара и меняет тип узла при переходе `img ↔ span`, чтобы виджет не оставлял
     оригинальную картинку под тонировкой. Ключи i18n: `groupAvatarColor`,
     `groupAvatarColorApply`, `groupAvatarColorReset`.
     Для тонированных `span` в CSS заданы `mask-size: contain`, `mask-repeat: no-repeat`
     и `mask-position: center`, иначе маска использовала исходный размер файла и показывала
     только верхний левый угол иконки.
8. **Тесты.** `test/dom.mjs`: каталог PNG/JPG, сохранение встроенного аватара, отрисовка
   в виджете, открытие попапа, выбор иконки, проверка URL-вкладки (невалидный URL
   отклоняется, валидный сохраняется), удаление аватара и исчезновение из виджета,
     тонировка (нормализация цвета, span с маской в виджете, color-input в попапе,
     сохранение цвета при выборе, замена `img` на тонированный `span` и обратно, выбор цвета
      до первой иконки, кнопка «Установить» для текущей иконки, применение показанного цвета без
      повторного выбора). Итог харнесов: `logic.mjs` — 84,
      `dom.mjs` — 163.

### Этап 12 — импорт групп из PocketTube (2026-11-13)

**Статус: реализовано 2026-11-13, харнесы зелёные; браузерная проверка — следующий шаг.**

1. **Формат PocketTube.** Группы лежат в `chrome.storage.sync` как
   `{ "<имя группы>": ["UC…"] }`, порядок — в `ysc_meta` (`{name: {img, position}}`),
   реестр имён — `ysc_collection`; собственный экспорт PocketTube имеет ту же форму,
   а дамп `chrome.storage` оборачивает её в `{local, sync}`. Переносимы только имена,
   порядок и id каналов: флаги «просмотрено» у PocketTube на уровне видео, у нас
   `lastVisitAt` на уровне канала (§10.4), поэтому не мигрируют.
2. **Выгрузка.** DevTools на странице самого расширения PocketTube (попап/опции) или
   в инспекторе service worker: `chrome.storage.local.get(null)` +
   `chrome.storage.sync.get(null)` → JSON-файл. Storage чужого расширения нам
   недоступен (MV3 изолирует его по id), поэтому импорт читает файл, а не данные
   PocketTube напрямую.
3. **Модуль.** `content/pockettube.js`: `parse()` — группы в порядке `position`
   (фallback — порядок экспорта), id фильтруются `UC[A-Za-z0-9_-]{22}`, ключи `ysc_*`
   и `yga:*` пропускаются, payload без id возвращает `null`; `plan()` — сопоставление
   групп с активным профилем по имени (lower case), каналы вне каталога считаются
   `missing`; `apply()` — пишут только владельцы ключей (`groups.js` для `yga:groups`,
   `profiles.js` для состава через `setGroup`, §5), повторный импорт идемпотентен.
4. **Панель.** Закладка «Данные»: список профилей рядом с кнопкой
   «Импорт групп из PocketTube» (цель — выбранный профиль, по умолчанию активный;
   `dataImportPocketTubeProfile`) → файл → превью `{profile}/{groups}/{channels}/{missing}`
   → `window.confirm` → применение → `state.refreshVisible()` без перезагрузки
   страницы, но только если цель совпадает с активным профилем (иначе изменения
   видны при переключении на цель). В отличие от сырого импорта `yga:*`, который
   перезагружает вкладку. Ключи i18n `dataImportPocketTube`
   (+`Profile`/`Confirm`/`Done`/`Failed`) в `en`/`ru` (146/146).
5. **Ограничения.** Группы назначаются выбранному профилю; канал, которого нет в
   каталоге подписок, пропускается — иначе `syncProfile` отметил бы его
   `unsubscribed` и строка никогда бы не появилась (§5). Аватары PocketTube
   (`ysc_meta.img`) — файлы самого расширения, не переносятся.
6. **Тесты.** `test/logic.mjs`: секция pockettube — порядок по `ysc_meta`, дамп
   `{local, sync}`, чужой payload отклоняется, план (3 группы, 3 канала, 1 вне
   каталога), применение (группы + `groupId` в составе и в строках виджета),
   идемпотентность и импорт в другой (curated) профиль — свой набор групп и
   membership. Итог харнесов: `logic.mjs` — 107, `dom.mjs` — 163.

---

## 12. Риски и как их снижаем

| Риск | Снижение |
|---|---|
| YouTube меняет DOM гайда → виджет пропадает | `selectors.js` с цепочками fallback; mount с широкими якорями (`#guide-inner-content` стабильнее, чем `a[href="/feed/subscriptions"]`); телеметрия неудачного mount |
| Виджет ломает вёрстку YouTube (двойные скроллбары, обрезанный гайд) | Только our-namespace CSS (`.yga-*`), никаких глобальных селекторов; `contain: layout style`; отдельный режим «off» по кнопке в панели |
| 300 каналов × RSS = много запросов, 429 | Ленивый refresh только при открытии, батчи по 12, троттлинг, кэш, `etag`/`If-None-Match`, минимальный интервал |
| RSS отдаёт лишь 15 видео | Счётчик «новых» корректен, пока новых ≤ 15; иначе показываем `15+` |
| MV3 service worker «засыпает» | Никакого долгоживущего состояния в worker; вся логика идемпотентна, состояние — в storage; alarms создаются только когда пользователь включил `scheduled`-режим |
| Инлайн-панель конфликтует со стилями/состоянием YouTube (SPA перерисовал `#content`) | Панель в собственном контейнере `.yga-panel` c `contain: layout style`; перемонтирование по тому же наблюдателю, что и виджет; контент YouTube скрываем классом, не удаляем |
| Scheduled-режим создаёт фоновые запросы без ведома пользователя | По умолчанию выключен; в панели — явный чекбокс, минимальный период 60 мин, счётчик запросов в сторе и отображение «последний прогон» |
| `chrome.webRequest` (как у PocketTube) требует лишних прав и в MV3 ограничен | Не используем |
| XSS через названия/URL каналов | `textContent` для текстов, whitelist-проверка `http(s)` + host `*.youtube.com` для URL, `rel="noopener"` |
| Приватность | Никаких внешних запросов, кроме youtube.com; телеметрия только локально |

---

## 13. Критерии приёмки MVP

1. `chrome://extensions` → Load unpacked: расширение грузится без ошибок в console.
2. На `youtube.com`, `/feed/subscriptions`, `/watch`, `/channel/...` виджет присутствует,
   не дублируется и не исчезает после SPA-переходов.
3. Список каналов = реальные подписки; аватар и название корректны; аватары грузятся лениво.
4. Счётчик новых видео совпадает с реальными новыми видео (для ≤15 на канал).
5. Переключение профиля меняет список; данные профилей независимы и сохраняются.
6. Кнопка конфигурации открывает панель в главной области YouTube; настройки применяются сразу.
7. Тёмная/светлая тема YouTube подбирается автоматически, контраст AA.
8. 300 каналов: первичная отрисовка < 300 мс, скролл без подлагиваний.
9. Нет внешних зависимостей, нет запросов вне `*.youtube.com`.
10. Каналы сгруппированы: свёрнутая группа не показывает каналы и не грузит аватары;
    счётчик группы равен сумме счётчиков её каналов (включая «Без группы»).
11. Клик по каналу ведёт на `/channel/<id>/videos`, обнуляет счётчик канала и
    пересчитывает счётчик группы.
12. Экран «Настройки» (§9.2): поиск и массовые операции по каналам, CRUD групп с чипами
    `n/m`; изменения применяются сразу, без перезагрузки страницы (§6).
13. На странице канала кнопка «Группа» назначает группу активного профиля (или
    «Без группы»/новую группу); изменение сразу отражается в дереве виджета (§8.8).

---

## 14. Стиль кода и инструменты

- ES2022 модулей **нельзя** в content script без `type: module` (MV3 это поддерживает
  только для service worker) → контент: IIFE-файлы с единым namespace
  `window.yga` / глобальная фабрика + явный порядок в `manifest.content_scripts.js`.
- Service worker: `"type": "module"` (MV3 поддерживает) — для чистого импорта.
- Без сборщика: правки файлов сразу видны в «Reload» расширения.
- Имена: kebab-case для файлов, `camelCase` для JS, классы `yga-*` (префикс обязателен,
  чтобы не пересекаться с YouTube и другими расширениями).
- Комментарии и идентификаторы — на английском (сам документ PLAN.md — русский).
- Каждая «костыльная» правка CSS снабжается комментарием `/* YT-override: <почему> */`.
- Ручное тестирование: `test/smoke.html` для парсеров XML/JSON и вычислений счётчика;
  остальное — вручную в браузере (без автотестов на MVP, т.к. нет внешних зависимостей).

---

## 15. Решения, зафиксированные 2026-11-07

| Вопрос | Решение |
|---|---|
| Что такое «профиль» | **Локальный профиль-набор** каналов, не аккаунт Google/YouTube (§5) |
| Что обнуляет счётчик | **Клик по каналу в виджете** (+ кнопка «отметить просмотренным») (§10) |
| Модель обновления счётчиков | **Гибрид**: `onOpen` по умолчанию, `scheduled` (alarms) включается в конфигурации (§10) |
| Панель конфигурации | **Инлайн-DOM в `#content`**, без iframe (§3, §8.7, этап 4) |
| Целевые браузеры | **Только Chrome MV3** (Edge работает на том же коде) |
| Combobox профилей на MVP | Нативный `<select>` в стилизованной обёртке (§9) |
| Группы каналов | Дерево групп в виджете вместо плоского списка; группа — локальная, канал ровно в одной группе на профиль; счётчик группы = Σ каналов (§18) |
| Экран «Настройки» | Инлайн-панель §9.2 по образцу PocketTube (список каналов + группы), без кнопки «Сохранить» (§9.2) |
| Куда назначать канал в группу | Экран «Настройки» (§9.2.1/9.2.2) **плюс** инлайн-кнопка «Группа» в шапке страницы канала (§8.8) |

### Ещё не решено (нужны решения до этапа 2)

1. **Сортировка списка по умолчанию**: активность (последние новые видео), алфавит,
   порядок YouTube-подписок или группы (§18.6). Предлагаю `activity` с мгновенным fallback
   на алфавит, пока счётчики не посчитаны; после этапа 5 — рассмотреть `groups`.
2. Нужен ли собственный `action` popup расширения, или достаточно виджета в сайдбаре
   (на MVP — popup не делаем).
3. Языки MVP: en + ru достаточно?
4. Синхронизация между устройствами (`chrome.storage.sync`) — делаем или нет (бэклог).
5. Формат состава профиля: явный список добавленных каналов или «все минус исключения»
   (у служебного профиля — `includeAllSubs: true`).

---

## 16. Следующий шаг

Этап 11 (аватары групп: встроенные иконки из `icons/groups` и опциональный HTTPS URL)
реализован 2026-11-12 и проверен в браузере пользователем. Тонировка встроенных аватаров
доработана после браузерной проверки: исправлены замена узла в виджете и скрытие тонированного
аватара в таблице групп через CSS `mask-image` без изменения файлов; форма аватаров и превью
сделана прямоугольной с небольшим скруглением; для маски добавлены `mask-size`, `mask-repeat`
и `mask-position`, чтобы иконка масштабировалась целиком, а не обрезалась по исходному размеру;
ряд цвета дополнен кнопкой «Установить» для текущей иконки; кнопка сохраняет текущее значение
colorpicker сразу, без повторного выбора уже показанного цвета (см. §11, Этап 11, п. 7).
Следующий шаг — повторная браузерная проверка тонировки: перезагрузить расширение, в
«Конфигурация/Группы» открыть попап аватара, выбрать цвет и иконку, проверить кнопку
«Установить» без повторного выбора цвета, цвет, полный размер и прямоугольную форму в панели
и виджете, кнопку «Оригинал» и URL-аватары (не тонируются).

Этап 99 — бэклог (§11): drag&drop каналов в группы (HTML5 DnD без библиотек), отметка
«просмотрено» по видео, «Открыть все новые»
плейлистом `/watch_videos`, глобальный поиск в виджете, pin/favorite, popup с badge,
`chrome.storage.sync`, несколько аккаунтов YouTube.

Перед новыми функциями — браузерная проверка этапов 3–6 (отложена): критерии §13 на
живом youtube.com, в том числе профилировка ~300 каналов (процедура в README) и
подтверждение телеметрии `yga:log` при изменении DOM YouTube.

## 17. Журнал изменений плана

| Дата | Изменение |
|---|---|
| 2026-11-13 | Фикс Этапа 12 из браузерной эксплуатации: после импорта PocketTube заблокированные на YouTube каналы висели как подписанные. Воркер считает подрядные ошибки фида (`errorStreak`, сброс на успехе или `304`), на пятой (`DEAD_AFTER_ERRORS`) `markDead()` убирает канал из группы и исключает его из всех профилей, где он лежал (§5, §18.1); для `includeAllSubs`-профиля без записи в составе запись создаётся воркером. `countValue` отдаёт `streak`, `refreshChannels` считает `dead` и рассылает агрегаты задетых профилей; `content/counters.js` перерисовывает виджет при смене состава (`membershipSig`) вместо patch-only `applyCounts`, поэтому мёртвый канал уходит без перезагрузки вкладки. Харнесы: `logic.mjs` 107→123 (секция dead channels: рост streak, сброс на успехе, пятая ошибка, implicit-профиль), `dom.mjs` 163. Ждёт браузерной проверки. §10, §11. |
| 2026-11-13 | Этап 12: импорт групп из PocketTube. Формат — `chrome.storage.sync` `{имя группы: [UC…]}` + порядок в `ysc_meta` (собственный экспорт PocketTube — та же форма, дамп `chrome.storage` — `{local, sync}`). Новый `content/pockettube.js` (`parse`/`plan`/`apply`) назначает группы **выбранному** профилю (список профилей рядом с кнопкой, по умолчанию активный) через `groups.js` и `profiles.js` (§5), каналы вне каталога пропускаются, повторный импорт идемпотентен. Закладка «Данные» — кнопка «Импорт групп из PocketTube» с превью `{profile}/{groups}/{channels}/{missing}` и confirm; виджет перекрашивается без перезагрузки вкладки только когда цель = активный профиль. Storage чужого расширения из нашего кода недоступен (MV3), поэтому путь — файл. i18n en/ru 146/146. Харнесы: `logic.mjs` 97→107, `dom.mjs` 163. §11, §16. |
| 2026-11-13 | Фикс Этапа 10 из браузерной эксплуатации: `hideShorts` не работал — свежий Short считался новым видео, а `hideLive` скрывал видео с «Live» в заголовке. Реальный RSS не помечает Shorts/трансляции в `media:title` (там заголовок видео): тип записи задаёт `link rel="alternate"` — `youtube.com/shorts/<id>` и `youtube.com/live/<id>`, обычные видео — `watch?v=`. Парсер отдаёт `kind`, `entryVisible()` фильтрует по `kind`, подстрока по `label` убрана. Кэш, написанный до появления `kind`, при включённом `hideShorts`/`hideLive` один раз уходит на рефетч (`migrating` в ответе `counters:settings`). Харнесы: `logic.mjs` 87→97 (kind в парсере, секция kind filters, миграция кэша), фикстура — реальные ссылки. §11, §16. |
| 2026-11-13 | Фикс Этапа 3 (счётчики): счётчики виджета не обновлялись во время считывания RSS — число появлялось только после F5. Шина SW→вкладки работала на `chrome.alarms` (`yga:emit-flush`, `delayInMinutes: 1.1`), поэтому `counters:counts` доходили до вкладок ~минуту после чтения очереди, а `refreshChannels` вообще ждал всю очередь перед агрегатом. Заменено на дебаунс-таймер (`EMIT_FLUSH_MS = 350` — чуть больше `REQUEST_GAP_MS`, чтобы соседние записи объединялись в одно сообщение); `refreshChannels` и обработчики `init/settings/setVisit/setVisits` сбрасывают очередь сразу по завершении. `counters.js`: перерисовка leading+trailing (200 мс), спиннер кнопки «↻» отражает очередь воркера, а не дедлайн отрисовки. Регресс-проверка `logic.mjs` 84→87 (`counts arrive before the refresh resolves`). §10, §11. |
| 2026-11-12 | В документацию добавлено, что внешние иконки для аватаров групп можно искать на `https://icons8.com/` и устанавливать через вкладку «URL» прямой ссылкой вида `https://img.icons8.com/?size=48&id=HqsZDKt3q3UW&format=png&color=000000`. §11, README. |
| 2026-11-12 | Исправлено поведение кнопки «Установить» в попапе аватара: она больше не требует повторно двигать colorpicker, если цвет уже показан в поле, и сохраняет текущее значение colorpicker для выбранной встроенной иконки сразу. Добавлены проверки `dom.mjs`. Харнесы: `logic.mjs` 84, `dom.mjs` 163. §11, §16. |
| 2026-11-12 | Кнопка «Установить» для цвета аватара усилена после обратной связи «кнопка есть, но не работает»: выбор цвета теперь сразу обновляет превью текущей иконки, а `iconPicker` при отсутствии `onApply` использует `onPick` как fallback. Харнесы: `logic.mjs` 84, `dom.mjs` 161. §11, §16. |
| 2026-11-12 | Ряд выбора цвета аватара дополнен кнопкой «Установить» справа от colorpicker: она применяет выбранный цвет к текущей встроенной иконке и сохраняет группу, не закрывая попап. Для URL-аватара и отсутствия иконки кнопка отключена. Добавлены i18n `groupAvatarColorApply`, CSS `.yga-icon-color-apply` и проверки `dom.mjs`. Харнесы: `logic.mjs` 84, `dom.mjs` 160. §11, §16. |
| 2026-11-12 | Исправлена обрезка тонированных аватаров: CSS для `.yga-avatar-tinted` использовал только `background-size`, а маска по умолчанию брала исходный размер файла, поэтому в виджете и списке групп был виден только верхний левый угол. Добавлены `mask-size: contain`, `mask-repeat: no-repeat`, `mask-position: center` и `-webkit-` варианты. Харнесы: `logic.mjs` 84, `dom.mjs` 156. §11, §16. |
| 2026-11-12 | Форма аватаров групп изменена с круглой на прямоугольную с небольшим скруглением: виджет `.yga-group-avatar`, кнопка и аватар в таблице групп, превью попапа и placeholder. Причина пользователя: круглый шаблон обрезает прямоугольные картинки и делает содержимое непонятным. Харнесы: `logic.mjs` 84, `dom.mjs` 156. §11, §16. |
| 2026-11-12 | Исправлена браузерная проблема тонировки аватаров: виджет оставлял оригинальный `img` при выборе цвета из-за инвертированного условия замены узла; аватар в таблице групп скрывался CSS-правилом `.yga-panel-avatar:not([src])`, которое применялось и к тонированному `span`. `paintGroupAvatar()` теперь удаляет аватар при очистке и меняет тип узла при переходе `img ↔ span`; CSS ограничивает скрытие только для `img`. `dom.mjs` +6 проверок. Харнесы: `logic.mjs` 84, `dom.mjs` 156. §11, §16. |
| 2026-11-12 | Этап 11 дополнен тонировкой аватаров (запрос пользователя: иконки темноватые): у встроенного аватара появился `color`, иконки перекрашиваются на лету через CSS `mask-image` без изменения PNG/JPG. `group-icons.js`: `normalizeColor`/`tinted`/`avatarNode`, цвет в `normalize`/`sig`; виджет/панель/превью попапа используют `avatarNode`; в попапе ряд «Цвет» + «Оригинал»; i18n en/ru. `dom.mjs` +9 проверок тонировки. Харнесы: `logic.mjs` 84, `dom.mjs` 150. §11, §16. |
| 2026-11-12 | Этап 11: аватары групп. Добавлен генератор каталога `test/gen-group-icons.mjs` и компактный `content/group-icons.js` (38 тем, 4830 иконок, поддержка `.png`/`.jpg`), `groups.setAvatar()`, попап `config/icon-picker.js`, кнопка аватара в «Конфигурация/Группы», отрисовка аватара в виджете слева от названия группы, i18n en/ru и CSS. Харнесы: `logic.mjs` 84, `dom.mjs` 141. §11, §16. |
| 2026-11-12 | Этап 10 закрыт по решению пользователя: браузерная проверка отложена, реализация считается завершённой. Харнесы: `logic.mjs` 84, `dom.mjs` 120. §11, §16. |
| 2026-11-12 | Этап 10 дополнен сбросом счётчиков: правый клик по группе сбрасывает все каналы группы, правый клик по общему счётчику в шапке — все видимые каналы активного профиля. Реализация через существующий батч `counters:setVisits`; `counters.js` красит total из локального снимка строк, `widget.js` — group chips/rows. `dom.mjs` добавлены проверки group/total reset. Харнесы: `logic.mjs` 84, `dom.mjs` 120. §11, §16. |
| 2026-11-12 | Этап 10: фильтры видео (Shorts / трансляции / старше N дней) — глобальные `settings.filters` (`hideShorts`/`hideLive`/`maxAgeDays`, по умолчанию выкл). Парсер (`rss-parser.js`) извлекает `label` (`media:title` в `media:group`), `duration`, `category`; worker (`service-worker.js`) применяет `entryVisible()` во всех счётчиках и по `counters:settings` пересчитывает из кэша без рефетча, рассылая counts+агрегаты; панель — новая секция «Фильтры» (`panel-sections.js`), i18n en/ru. Тесты: фикстура + секция filters в `logic.mjs` (off=5→shorts=4→live=3→age=0→off=5, без рефетча). Харнесы: `logic.mjs` 84, `dom.mjs` 115. Ждёт браузерной проверки. §11, §16. |
| 2026-11-11 | Этап 9 закрыт тринадцатой браузерной проверкой: пользователь подтвердил — все отлично; скроллинг идеален на канале и видео, прыжков нет, позиция на канале идеальна, на видео кнопки не задевают Like. Итоговая модель: оверлей на `document.body` в `position:absolute` в document-координатах, `lastLeft/lastTop`, кэш `hostW/hostH`, `watchLeftGap=10`, `topBound`, `detectPinned()`, кэш боксов ряда и гистерезис слота. Харнесы: `logic.mjs` 60, `dom.mjs` 109. Дальнейшие поправки — новая сессия. §11, §16. |
| 2026-11-11 | Этап 9, двенадцатая браузерная проверка: скроллинг идеален на канале и видео, прыжков нет; канал по позиции идеален, на видео кнопки слегка наезжают на Like. `group-picker.js`: для watch-страницы предпочтительный слот слева от Like получил увеличенный отступ `watchLeftGap=10` (обычные fallback-зазоры остались 6px) — запас на hover/padding Like и 4px ring активной кнопки профиля; диагностика добавила `data-yga-host-size`. Харнес: watch-left `68px→64px`, late-cluster `661px→657px`. `logic.mjs` 60, `dom.mjs` 109. Ждёт браузерной проверки: видео — кнопки не должны задевать Like. §11. |
| 2026-11-11 | Этап 9, одиннадцатая браузерная проверка: канал полностью устроил (кнопки корректно уезжают за край и не прыгают), на видео край корректный, но прыжки остались. `group-picker.js` + `widget.css`: хост переведён с `position:fixed` на `position:absolute` в document-координатах (`leftDoc/topDoc = viewport rect + scrollX/scrollY`); при обычном скролле координаты не меняются, `lastLeft/lastTop` подавляют повторную запись стиля, а страницу прокручивает браузер без JS-переписывания хоста. Размер хоста кэшируется (`hostW/hostH`) вместо `offsetWidth/offsetHeight` каждый кадр. Харнес: sticky-канал ожидает document-координату `top=1040px` при `scrollY=400`. `logic.mjs` 60, `dom.mjs` 109. Ждёт браузерной проверки: видео без прыжков, канал без ухудшений. §11. |
| 2026-11-11 | Этап 9, десятая браузерная проверка: на видео прилипание ушло, но кнопки «уезжают за границу»; прыжки на видео остались; на канале прилипание к верхнему краю не ушло. `group-picker.js`: (1) оверлей скрывается, когда якорь не целиком внутри полосы под фиксированной шапкой — `topBound = rect.bottom` от `ytd-masthead, #masthead, ytd-desktop-topbar-header` (меряется на mount/resize/таймере), условие `trect.top < topBound || trect.bottom > innerHeight`; (2) `detectPinned()` — липкий якорь (схлопнутая шапка канала: `|ΔscrollY| > 40` при `|Δtop| < 3` два тика подряд, снимается только движением якоря) прячет оверлей, поэтому кнопки больше не прилипают к верху канала; (3) против прыжков: `rowBoxes` кэширует боксы в document-пространстве (`rect + scrollX/scrollY`) — кадр скролла делает ровно один `getBoundingClientRect` (якорь), гистерезис `slot` держит выбранный зазор пока он свободен, боксы якоря и его обёрток исключены (`skip.contains(el) || el.contains(skip)`), диагностика вынесена из кадра в `diagnose()` (только таймер 250ms и смена якоря). Харнес: +8 регрессов. `logic.mjs` 60, `dom.mjs` 101→109. Ждёт браузерной проверки: видео — без выезда за край и без прыжков, канал — кнопки уходят со схлопнутой шапкой. §11. |
| 2026-11-11 | Этап 9, девятая браузерная проверка: канал после rowCache плавный, на видео прыжки остались; новая проблема — при скролле оверлей прилипает к верхнему краю окна. Корень прилипания: `Math.max(4, top)` в `positionHost` парковал хост на 4px, когда якорь уходил за верх вьюпорта. `group-picker.js`: clamp убран, оверлей скрывается (`yga-gp-hidden`) при rect якоря целиком вне вьюпорта (`bottom<0 || top>innerHeight`); `reanchor()` убран из покадрового rAF-пути scroll (только `positionHost`), остался на таймере 250ms — мёртвый якорь больше не вызывает глубокий `findAnchor` каждый кадр. Харнес: `innerHeight=1440`, +1 регресс (якорь за верхом → хост скрыт). `logic.mjs` 60, `dom.mjs` 100→101. Ждёт браузерной проверки скролла на канале и видео. §11. |
| 2026-11-11 | Этап 9, восьмая браузерная проверка: позиции на канале и видео подтверждены пользователем, но при скролле оверлей «зависает на старом месте, потом перепрыгивает». Scroll+rAF слушатель был на месте; корень — стоимость кадра: `positionHost` каждый кадр звал `rowBoxes` → `queryDeep(BUTTON_SELECTOR, row)` по огромным рядам (`#page-header`, `#above-the-fold`), deep-обход shadow-дерева на 60fps насыщал main thread и позиционирование уезжало на таймер 250ms. `group-picker.js`: `rowCache` {row, els} — список кнопок ряда кэшируется по элементу ряда, покадрово только `getBoundingClientRect`; инвалидация — таймер трекинга (250ms), свап якоря в `reanchor`, `mount`, `stopTracking`. `logic.mjs` 60, `dom.mjs` 100. Ждёт браузерной проверки скролла. §11. |
| 2026-11-11 | Этап 9, седьмая браузерная проверка: видео с наездом дало `anchor: watch-deep-actions` (`div#actions`), зонд — пустые `likeDislike`/`likeButton` (light и deep) при видимом Like `button.ytSpecButtonShapeNextHost` в `div#top-level-buttons-computed` (раскладка без view-model-обёрток вообще); второе видео — `watch-like`, оверлей слева от Like = спека. Корень залипания: mount поймал `#actions` до рендера like-кластера, а `reanchor()` ре-резолвил только отсоединённые якоря — ряд connected навсегда. `group-picker.js`: `ANCHOR_RANK`/`GOOD_RANK=2` — трекер ре-резолвит connected-якорь с плохим рангом и ставит первый лучший (backoff 1s→16s, максимум 5 попыток); `#top-level-buttons-computed` в `LIKE_STRUCT`. `selectors.js`: он же в цепочку `likeDislike`. Харнес: +2 регресса (пустой `#actions` → `watch-deep-actions`; поздний кластер → апгрейд `watch-like-struct` `661px/901px`). `logic.mjs` 60, `dom.mjs` 98→100. Ждёт проверки на видео с наездом. §11. |
| 2026-11-11 | Этап 9, шестая браузерная проверка: все три канала на местах (структурная подписка подтверждена), но оба тестовых видео дали якорь `watch-like-id` (ветки struct/text промахнулись, legacy-цепочка `likeButton` через `findVisible` взяла, судя по симптомам «наехала на подписку»/«исчезли», скрытый дубль-призраку). `group-picker.js`: ветка `watch-like-id` переведена с `findVisible` на `findSmallestVisible(LIKE_CHAIN)` light→deep; добавлен классовый dislike-гард `isDislikeStructural()` (текстовый гард молчит, когда у dislike-view-model имя — только счётчик, а класс содержит `like-button-view-model`); `positionHost` пишет на хост диагности `data-yga-anchor-el`/`data-yga-anchor-rect`. Зонд: цепочка `likeButton`, deep-снимки, флаги OFFSCREEN/VIS/OPACITY/SHADOW. Харнес: +2 регресса (dislike-view-model со счётчиком, широкий ghost в цепочке). `logic.mjs` 60, `dom.mjs` 96→98. Ждёт проверки на двух проблемных видео. §11. |
| 2026-11-11 | Этап 9 переоткрыт пятой проверкой: «прыгнули вправо» на втором канале, «на две строчки вниз» на третьем, плюс языковая хрупкость текстовых якорей (RU/EN). `group-picker.js`: структурные якоря первыми — `SUBSCRIBE_STRUCT`→`channel-subscribe`, `LIKE_STRUCT`→`watch-like-struct` (языконезависимые теги/классы/accessibility-id), хелпер `findSmallestVisible()` (наименьший видимый; dislike-view-model отбраковывается — класс содержит `like-button-view-model`); текстовые ветки — fallback. `positionHost`: band = rect якоря (не ряда!), `rowBoxes` фильтруются строкой якоря — это и был корень «двух строк вниз» (центрирование по перенесённому ряду). Зонд: структурные селекторы в цепочке `subscribeButton`. Харнес: +2 регресса (структурная подписка без подписи, перенос ряда), packed-watch `top` 743→745. `logic.mjs` 60, `dom.mjs` 94→96. Ждёт браузерной проверки на всех трёх каналах. Фолбэк по предложению пользователя при новом провале: перенос кнопок в виджет. §11. |
| 2026-11-11 | Этап 9, четвёртая браузерная проверка: кнопки есть на обеих страницах, но не на своих местах. Добавлен read-only зонд `test/probe-anchor.js`; снимки дали три корня. (1) Канал: якорь `channel-actions` = весь `yt-flexible-actions-view-model` (L293→R973 при вьюпорте 1030), Subscribe лежит в **нативном** shadow root (`shadyDom:false`, вывод §11.9 о light DOM устарел), а deep-поиск пробовался после контейнера → `rect.right+6` clamp'ился к правому краю. (2) Видео: ряд `#actions` начинается с x=16 и упакован без зазоров → слот «слева от Like» не существует, хост прижимался к левому краю поверх Like. (3) Хост на L10 = `102-6-86` ⇒ якорем был Dislike: `DISLIKE_TEXT_RE` с границей `\s` не отбрасывал `Поставить отметку "Не нравится"`. `group-picker.js`: dislike-guard — граница «любой не-буква» (`[^\p{L}]`, флаг `u`); `findChannelAnchor` — light-текст → deep-текст → light-loose → deep-loose (`CHANNEL_TEXT_LOOSE_RE`) → контейнер, плюс `row` в описателе (`rowFor`/`ROW_SELECTOR`); `positionHost` — выбор свободного слота ряда [желаемая сторона, после последней кнопки, обратная сторона, перед первой] с проверкой вписывания и непересечения с `rowBoxes()` (deep). Харнес: `_rect` в фикстурах, `closest()` со списками селекторов, 3 новых регресса. `logic.mjs` 60, `dom.mjs` 91→94. Ждёт браузерной проверки. §11. |
| 2026-11-10 | Этап 9, третья браузерная проверка после текстовых якорей: пользователь — «визуально ничего не изменилось», `data-yga-anchor` = `watch-deep`. Корень: RU Like «Мне нравится» содержит подстроку «не нравится», из-за чего `DISLIKE_TEXT_RE` отбрасывал Like и якорь падал в deep. `group-picker.js`: dislike-guard стал границным (`(?:^|\s)(?:dislike|не нравится)(?:\s|$)`), Like-регулярка расширена (`like`/`unlike`/`liked` + RU варианты), `findVisibleButton()` выбирает наименьший видимый матч, текстовый поиск получил deep-fallback через `selectors.queryDeep()`, deep-якоря переименованы для диагностики (`watch-like-deep`, `watch-deep-like`, `watch-deep-cluster`, `watch-deep-left`, `watch-deep-actions`). Харнес: новые регрессы на RU Like и shadowed Like. `logic.mjs` 60, `dom.mjs` 89→91. Ждёт браузерной проверки. §11. |
| 2026-11-10 | Этап 9, третья браузерная проверка: кнопки появились, но на канале прижимались к правому краю, на видео слегка наползали, а при скролле запаздывали. Браузерный зонд показал `clsLikeDislike=0` и отсутствие `#watch-download-button`, т.е. догадки по тегам Like/Dislike ненадёжны. `group-picker.js`: якорь стал текстово-геометрическим — канал сначала ищет видимую кнопку Subscribe/Subscribed/Sponsor/Join (в т.ч. RU), затем actions row, затем правую видимую кнопку внутри `#page-header`; видео сначала ищет видимую Like-кнопку по accessible name (`like this video`, `unlike this video`, `Нравится`), затем `likeButton`/cluster, затем `#actions`/metadata; `findDeep()` сохранён как fallback. Добавлен `data-yga-anchor` для диагностики, `schedulePosition()` через `requestAnimationFrame` вместо прямого позиционирования в scroll-обработчике, зазор уменьшен 8→6 px, ширина оверлея считается стабильно. `selectors.js`: добавлены `likeButton` и `watchActions`, `likeDislike` очищен от last-resort row-якорей. Харнесс: регрессы на полный `#page-header` (не должен брать край шапки) и watch без view-model тегов (должен брать Like по `aria-label`). `logic.mjs` 60, `dom.mjs` 87→89. Ждёт браузерной проверки. §11. |
| 2026-11-10 | Этап 9, корень проблемы «кнопок нет»: предположение про Shadow DOM было неверным. Живой desktop-YouTube грузится с `window.ShadyDOM={force:true,noPatch:true}` (скачанные `yt-channel.html`/`yt-watch.html`), т.е. контент Polymer — в LIGHT DOM, обычный `document.querySelector` его видит (селекторы живого PocketTube это подтверждают). Кнопки не находились из-за имён тегов: шапка/действия 2026 собраны из view-model-компонентов (`pageHeaderRenderer` → `yt-flexible-actions-view-model`, `segmentedLikeDislikeButtonViewModel` → `yt-segmented-like-dislike-button-view-model`), а цепочки `selectors.js` содержали только legacy `ytd-*-renderer`. (1) `selectors.js`: цепочки `channelHeader`/`subscribeButton`/`likeDislike` — сначала view-model, затем legacy, затем `[class*="…"]` (YouTube штампует класс `.yt-<name>-view-model`), для видео добавлен деградационный якорь `#actions`/`yt-watch-metadata`; возвращён `isVisible()` + `findVisible()` (первый матч с ненулевым `getBoundingClientRect()` — YouTube держит скрытые дубли), `findDeep()` оставлен запасным путём. (2) `group-picker.js`: `findAnchor()` = `findVisible` → `findDeep`; `positionHost()` прячет оверлей (`.yga-gp-hidden`) при якоре без бокса и прижимает `left` к краю вьюпорта (раньше `rect.right + 8` уходил за экран); `reanchor()` пере-находит якорь, если YouTube его заменил; retry стал бессрочным (400 мс → 1,5 с, журнал `group-picker-slow`) вместо отказа через 15 с; `groups.load()` перед первым `paint()`; отладочные `console.warn` убраны. (3) Харнесс: парсер селекторов поддерживает `[attr*="v"]` и `getAttribute("class")`; фикстуры этапа 9 переведены на view-model-теги + скрытый дубль, legacy-теги оставлены отдельным регрессом. `logic.mjs` 60, `dom.mjs` 86→87. Ждёт браузерной проверки. §11. |
| 2026-11-10 | Этап 9, автономный fixed-оверлей (замена PocketTube): пользователь — «моргание не исчезло, рефрешится целый ютуб; кнопок нет; не привязывайся к PocketTube, мы его заменяем». Убрана вся зависимость от PocketTube и вставка в дерево YouTube. `group-picker.js`: `div.yga-gp-group` — `position: fixed`-оверлей на `document.body` (CSS `position: fixed; z-index: 10000`), позиционируется `positionHost()` от `getBoundingClientRect()` якоря (канал — справа от подписки, видео — слева от Like/Dislike), якорь только читается. `selectors.js`: `deepQuerySelectorAll()`/`findDeep()` — прокол открытых shadow root'ов; `pocketTubeButton`/`isVisible`/`findVisible` удалены. `startTracking()` (scroll+resize+`setInterval` 250 мс) / `stopTracking()` в `unmount` и обработчиках навигации/настроек; меню на `document.body`. Тесты переписаны (оверлей на body + `styleVars.left/top`; shadow-piercing через фейковый `shadowRoot`; PocketTube-тест удалён); `report()` всегда завершает процесс. `logic.mjs` 60, `dom.mjs` 86. Ждёт браузерной проверки. §11. |
| 2026-11-10 | Этап 9, вторая браузерная проверка: кнопки на канале «на новой строке», на видео отсутствуют, страница моргает при клике на канал. (1) Откат `#page-header*`-селекторов из `subscribeButton`/`channelHeader` — вставка в Lit-управляемый `#page-header` перерисовывала всю шапку на навигации (регресс §7.5). (2) `selectors.findVisible()` — первый матч с ненулевым `getBoundingClientRect()`; PocketTube держит скрытые дубли `.add-to-collection-button-new`, `findOptional` брал скрытый ⇒ якорь вне экрана. `mount()` для PocketTube-якоря использует `findVisible`. Регресс-тест (скрытый+видимый дубль). `dom.mjs` 85. §11. |
| 2026-11-10 | Этап 9, якорь рядом с PocketTube: кнопки монтируются после `.add-to-collection-button-new` (кнопка «Добавить в группу» PocketTube, light DOM) — `selectors.js:pocketTubeButton` + тихий `findOptional()`. Причина прежних провалов — якоря YouTube в Shadow DOM, недоступном `document.querySelector`. Регресс-тест. `dom.mjs` 84→85. §11. |
| 2026-11-10 | Фикс Этапа 9 из браузерной эксплуатации: кнопки не появлялись ни на канале, ни на видео. (1) `group-picker.js` — ограниченный retry при отсутствии якоря/ответа моста (400 мс, дедлайн 15 с, журнал `group-picker-timeout`), т.к. `yt-navigate-finish` опережает отрисовку шапки/`#actions`. (2) `bridge.js:cmdGetPageChannel` — резолв канала на `/watch` через `ytInitialPlayerResponse`. Регресс-тест на поздний якорь. `dom.mjs` 82→84. §11. |
| 2026-11-10 | Этап 9: кнопки профилей (первая буква + цвет профиля) на страницах канала (справа от подписки) и видео (слева от Like/Dislike); dropdown с чекбоксами групп профиля (назначение/снятие «Без группы»); colorpicker в конфигурации профилей (`profile.color`, палитра + бэкфилл); настройка `widget.watchPageButton`. §8.8, §18.5, §11. |
| 2026-11-09 | Ctrl+F5: ошибка `Cannot read properties of undefined (reading 'applyCounts')` — `widget.render` терял `this` при передаче в `.then()` напрямую; `applyCounts` вынесен в локальную функцию, добавлен регресс-гард detached render. Этап 7. |
| 2026-11-09 | Перенумерация плана: «Дополнение к этапу 6» стал Этапом 7 (исправления из браузерной эксплуатации), прежний Этап 7 (бэклог) перенесён в Этап 99. Дальнейшие фичи предлагается добавлять отдельными этапами по мере возникновения, а не держать всё в одном бэклоге. §16, §17. |
| 2026-11-09 | Этап 6 (устойчивость и polish): телеметрия «сломалось» — журнал `yga:log` (кольцевой ≤100, debounce 1 с; selector miss + mount-timeout); CSP `extension_pages` в манифесте; аудит `innerHTML` (6 мест — только статический SVG) и локализации (114/114 ключей en/ru, диалоги через i18n); аудит layout thrash (единственный read — dropdown group-picker); README переписан (установка/архитектура/troubleshooting). UI-доработка панели (вкладки + внутренний скролл) оказалась сделана в этапе 5 (`9ab7f27`). Браузерная проверка этапов 3–6 — следующий шаг перед этапом 7. §11, §16. |
| 2026-11-09 | Зафиксирована UI-доработка панели: 7 секций нужно сделать вкладками; текущая панель обрезается без скролла, «Счётчики» и «Виджет» недоступны. §9.2.3, §11, §16. |
| 2026-11-09 | Этапы 0–2 отмечены выполненными по факту браузерной проверки (`dec7819`): чек-листы этапов 0 и 1 закрыты, зафиксированы отклонения от первоначальной формулировки (мост — `world: MAIN`, fallback-каталог — `GET /feed/channels` вместо `youtubei/v1/browse`, ключ каталога `<accountKey>` — вместе с этапом 2). Профилировка 200+ каналов отдельным прогоном не выполнялась — принято на основании 995 каналов вживую. |
| 2026-11-08 | Этап 3 (счётчики): парсер RSS — собственный сканер тегов `content/rss-parser.js`, т.к. в MV3 service worker **нет `DOMParser`**; воркер — очередь с дедупом/троттлингом/ETag и `yga:videos-index`; обмен SW↔вкладки — шина на `chrome.alarms`; `lastVisitAt` пишет только воркер, состав профиля — только `profiles.js` (защита от гонок записи); временный вход «отметить просмотренным» — правый клик по строке до этапа 4. §10, §11. |
| 2026-11-08 | Функциональные требования MVP: виджет показывает **группы каналов** вместо плоского списка (§18). Добавлен раздел 18. |
| 2026-11-08 | Этапы 0–1 проверены в браузере: виджет монтируется, список подписок = 995 каналов через `GET /feed/channels`. Поправки: мост — `content_scripts world:MAIN` (CSP), browse — только page-world (`SAPISIDHASH`), вытачка JSON — balanced-brace, own-channel фильтруется. §6, §7. |
| 2026-11-08 | Мост `page/bridge.js` доставляется как `content_scripts` с `"world": "MAIN"` (Chrome 111+) вместо `<script src=…>` — CSP YouTube блокирует такую инъекцию. WAR сокращена до `icons/*`. Этап 1: гайд-данные с retry на гонку моста, fallback browse через SW. |
| 2026-11-08 | Второй способ назначения канала в группу: инлайн-кнопка «Группа» в шапке страницы канала (§8.8, §18.5, этап 5, §13.13). |
| 2026-11-07 | Зафиксированы решения: профиль = локальный набор каналов; обнуление счётчика по клику в виджете; обновление счётчиков — гибрид (onOpen + настраиваемый scheduled); панель конфигурации — инлайн-DOM в `#content` (без iframe); целевая платформа — только Chrome MV3. Обновлены разделы 3, 4, 5, 6, 8, 10, 11, 12, 15 |

---

## 18. Группы каналов (решение 2026-11-08)

Виджет показывает **дерево групп каналов** вместо плоского списка (§9). Группы — это
наш локальный слой над подписками YouTube, а не «папки» YouTube (у YouTube своих папок
подписок нет). UI управления — экран «Настройки» §9.2; реализация — этап 5 (§11).

### 18.1. Модель

- Группа (`yga:groups`, §5): `{ id, name, collapsed, order, createdAt, updatedAt }`.
- Группа определена **внутри профиля**: один и тот же канал в разных профилях может быть
  в разных группах; составы групп профилей независимы.
- Канал принадлежит **ровно одной** группе профиля: `groupId` в
  `yga:profile-channels:<profileId>["UCxxxx"]`; `groupId: null` — псевдо-группа
  «Без группы».
- При удалении группы её каналы переходят в «Без группы» (подтверждение в UI).
  Удаление канала из профиля не требует чистки `groupId` — он живёт в записи канала.

### 18.2. Псевдо-группа «Без группы»

- Отображается в виджете последней, только если в профиле есть каналы без группы.
- Не хранится в `yga:groups`, не удаляется и не переименовывается; не имеет чипа в
  настройках (вместо чипа группы у такого канала — «＋ группу»).

### 18.3. Поведение в виджете

- Строка группы: кнопка с индикатором `[▾]/[▸]` (`aria-expanded`), имя, суммарный счётчик;
  клик по строке — toggle `collapsed` (§9, §5).
- Свёрнутая группа: каналы не в DOM → аватары не грузятся (§9).
- Сортировка каналов внутри группы: счётчик по убыванию, затем название
  (`Intl.Collator`, locale-aware).
- Сортировка групп по умолчанию: `order`, затем имя; каналы «Без группы» — в конце.
- Пустые группы (0 каналов) скрываются при `widget.hideEmptyGroups: true`
  (по умолчанию `false`).
- `yga:groups` — единственный источник истины для состава и порядка групп; DOM всегда
  перерисовывается из него.

### 18.4. Счётчики групп

- `groupCount = Σ newCount` каналов группы (включая «Без группы»); отдельного запроса
  для группы нет. Правила пересчёта и обнуления — §10.6.
- Группа с нулевым суммарным счётчиком показывается как обычная группа с незначимым
  пустым полем счётчика, при `showZeroCount: false` без числа (в свёрнутом виде — просто
  без чипа).

### 18.5. Управление (экран «Настройки» §9.2.2)

- CRUD групп: «＋ Группа» — модалка с единственным полем имени; переименование/удаление
  выделенной группы (PocketTube-образец).
- Назначение канала в группу — чип в строке канала (native `<select>` на MVP) или
  массово чекбоксами (§9.2.1).
- Фильтр-чипы групп со счётчиком `n/m` (каналов в группе / всего).
- Второй вход — кнопки профилей на страницах канала и видео (§8.8, этап 9): по кнопке
  на профиль (первая буква + цвет), dropdown с чекбоксами групп этого профиля
  (отметка/снятие = назначение/«Без группы») + быстрое создание; канал при отсутствии
  в составе профиля добавляется в него автоматически.

### 18.6. Взаимодействие с сортировкой профиля

- Группы — отдельная опция `sort: "groups"` в профиле (§5) и в настройках виджета;
  при `activity|alpha|subs|manual` каналы виджета по-прежнему сгруппированы (дерево —
  основной UI), но внутри групп порядок определяется этой сортировкой вместо
  «по счётчику». (Решение: сортировка профиля задаёт порядок каналов *внутри* групп.)

### 18.7. Вне объёма MVP

- Drag&drop каналов между группами — бэклог (§11, этап 7).
- Вложенные группы (подгруппы), общие группы между профилями, цветовые метки групп.

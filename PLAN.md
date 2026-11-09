# YouTubeAggregator.chrome — План проекта

> Документ живой: дополняется и уточняется по ходу разработки.
> План на русском. Документация (`README.md`) — на английском.

---

## 1. Продуктовая цель

Расширение для Chrome (Manifest V3), которое добавляет в левый сайдбар youtube.com
собственный виджет-агрегатор подписок:

- **Заголовок виджета:** combobox переключения профилей + кнопка открытия конфигурации.
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
    `widget.position`». Пишется кнопками ▲/▼ в футере виджета (`.yga-move-up` /
    `.yga-move-down`, `content/widget.js:moveWidget`), переживает SPA-перемонты
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
8. Кнопка «Группа» на странице канала (**инлайн-DOM, решение 2026-11-08, §18.5**):
   на каналах (`/channel/`, `/@handle`, `/c/`, `/user/`) модуль `content/group-picker.js`
   вставляет `<button class="yga-group-btn">` рядом с кнопкой подписки (якорь:
   `ytd-page-header` → `ytd-subscribe-button-renderer` в шапке; fallback — после
   `#title` / `ytd-channel-name`), идемпотентный mount по образцу виджета (пункт 2)
   и перепроверка на SPA-навигации (пункт 5). Клик открывает dropdown-меню
   (`role="menu"`, закрытие по Esc/клику вне): группы **активного профиля** +
   «Без группы» + «＋ Группа…» (быстрое создание). Выбор сразу пишет `groupId` в
   `yga:profile-channels:<activeProfileId>` (при отсутствии канала в составе — запись
   создаётся автоматически), виджет перерисовывается через общий `state.js` без
   перезагрузки. `channelId` страницы — через мост: `ytcfg` `EXTERNAL_CHANNEL_ID`
   (§7), fallback `link[rel=canonical]`. Для служебного профиля `p_1`
   (`includeAllSubs`) запись состава создаётся неявно. Кнопку можно отключить
   настройкой `widget.channelPageButton` (по умолчанию `true`).

Все известные «болючие» места (нужны `!important`, конкретная специфичность,
`z-index`, отключение анимаций) собираем в `content/widget.css` с комментариями.

---

## 9. UI виджета

Виджет показывает **дерево групп каналов** (решение 2026-11-08, §18), а не плоский список.
Группа разворачивается/сворачивается вниз кликом по её строке; каналы отображаются
с отступом под именем группы.

```
┌ yga-widget ────────────────────────────────────┐
│ [▾ профиль combobox]                    [⚙]   │  yga-header
├────────────────────────────────────────────────┤
│ [▾] 📁 Фильмы                             27  │  yga-group (развёрнута)
│       ●  Мосфильм                        3   │    yga-row (канал)
│       ●  КиноПоиск_hd                   12   │
│       ●  TrailerTime                   12   │
│ [▸] 📁 Кулинарии                        15  │  yga-group (свёрнута,
│                                                │    каналы скрыты)
│ [▸] 📁 Программирование                  8  │
│ ─ Без группы ─                          4   │  yga-group (псевдо-группа)
│       ●  Linus Tech Tips                 4   │
├────────────────────────────────────────────────┤
│ [Показать ещё 40]              [↻ обновить]   │  yga-footer (опц.)
└────────────────────────────────────────────────┘
```

- Combobox профиля: MVP — нативный `<select>` в стилизованной обёртке (доступность,
  клавиатура, нативный popup). Собственный `role="combobox"` + `role="listbox"` — позже,
  если понадобится иконка профиля и поиск внутри выпадающего списка.
- Кнопка конфигурации: `<button aria-label="Configuration">` + инлайн SVG шестерни.
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
   Общий чип (`yga.counters`) считается **из строк списка** — того же
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
      через `chrome.alarms` (SW→tabs), `storage.onChanged` — мультитэбовая
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


### Этап 99 — дальнейшие функции (бэклог)
- Drag&drop каналов в группы и между ними, ручная сортировка (без библиотек: HTML5 DnD),
  сортировка по активности/подписчикам.
- Отметка «просмотрено» по видео (не по каналу), авто-отметка при просмотре на YouTube.
- Фильтры: скрывать Shorts / трансляции / старше N дней.
- «Открыть все новые» как единый плейлист (`/watch_videos?video_ids=…`, как PocketTube).
- Глобальный поиск по каналам в виджете (инпут под заголовком).
- Pin/favorite каналов.
- Popup расширения (быстрый список топ-N новых), badge с общим числом новых.
- Экспорт/импорт подписок и настроек (JSON), сброс к значениям по умолчанию.
- Синхронизация между устройствами через `chrome.storage.sync` (без сервера).
- Поддержка нескольких аккаунтов YouTube (профиль ⇔ аккаунт) как отдельный режим.

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

Ближайший шаг — выбирать функции из Этапа 99 и оформлять каждую как отдельный этап
(`Этап 8`, `Этап 9`, …) по мере постановки новых фич.

Этап 99 — бэклог (§11): drag&drop каналов в группы (HTML5 DnD без библиотек), отметка
«просмотрено» по видео, фильтры (Shorts/трансляции/старше N дней), «Открыть все новые»
плейлистом `/watch_videos`, глобальный поиск в виджете, pin/favorite, popup с badge,
`chrome.storage.sync`, несколько аккаунтов YouTube.

Перед новыми функциями — браузерная проверка этапов 3–6 (отложена): критерии §13 на
живом youtube.com, в том числе профилировка ~300 каналов (процедура в README) и
подтверждение телеметрии `yga:log` при изменении DOM YouTube.

## 17. Журнал изменений плана

| Дата | Изменение |
|---|---|
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
- Второй вход — кнопка «Группа» в шапке страницы канала (§8.8): dropdown с группами
  активного профиля + «Без группы» + быстрое создание; запись `groupId` сразу,
  канал при отсутствии в составе профиля добавляется в него автоматически.

### 18.6. Взаимодействие с сортировкой профиля

- Группы — отдельная опция `sort: "groups"` в профиле (§5) и в настройках виджета;
  при `activity|alpha|subs|manual` каналы виджета по-прежнему сгруппированы (дерево —
  основной UI), но внутри групп порядок определяется этой сортировкой вместо
  «по счётчику». (Решение: сортировка профиля задаёт порядок каналов *внутри* групп.)

### 18.7. Вне объёма MVP

- Drag&drop каналов между группами — бэклог (§11, этап 7).
- Вложенные группы (подгруппы), общие группы между профилями, цветовые метки групп.

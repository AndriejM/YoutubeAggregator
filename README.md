# YouTubeAggregator.chrome

A Chrome extension (Manifest V3) that injects a subscription-aggregator widget into the
left sidebar of youtube.com: local profiles, channel groups, and per-channel counters of
new videos since your last visit. Built with plain HTML, CSS and JavaScript — no external
dependencies, no bundler, no backend, no OAuth, no API key.

This project is an improved take on PocketTube; the reference (obfuscated) build used for
research is kept under `examples/` and is not part of the shipped extension.

## Features

- **View-only widget in the YouTube guide** — survives SPA navigation, follows the YouTube
  theme. The header carries the total counter chip, a refresh button, a gear (⚙) to open
  settings, and ▲/▼ to reposition the widget in the guide; the profile combobox sits on its
  own line below. All editing (profiles, groups, channels) lives in the config panel.
- **Local profiles** — named channel sets ("Work", "Music"); the built-in *All subscriptions*
  profile mirrors your YouTube subscriptions. Switching a profile is instant (storage only).
- **Channel groups** — a tree in the widget: group rows with summed counters, collapsible;
  a channel belongs to exactly one group per profile.
- **Group avatars** — built-in icon themes or direct HTTPS image URLs; icons can be found on
  [icons8.com](https://icons8.com/) and installed as URLs like
  `https://img.icons8.com/?size=48&id=HqsZDKt3q3UW&format=png&color=000000`.
- **New-video counters** — per channel, from the public RSS feed
  (`/feeds/videos.xml`), batched and throttled, cached with ETags. A click on a channel
  opens its Videos tab and resets its counter; right-click resets a channel, a group or
  the total header counter.
- **Video filters** — globally hide Shorts, live streams and videos older than N days from
  the counters; Shorts/live are classified by the feed entry URL (`/shorts/`, `/live/`),
  not by the title, and edits repaint instantly from the cached entries (entries cached
  before the kind field existed are refetched once).
- **Inline configuration panel** — opens in YouTube's main content area (no iframe, no
  extra tab): profiles, groups, channels, counters, filters, widget, theme, data
  (export/import/reset, plus a PocketTube group importer that reads a JSON export and
  assigns its groups to the channels of a profile picked next to the button).
  Channel rows include an open-in-new-tab link (↗).
- **Group button on channel pages** — assign the channel to a group of the active profile
  right from the channel header.
- **Localization** — en/ru via `_locales` + `chrome.i18n`.

## Install (Load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. Open (or reload) any `youtube.com` tab — the widget appears in the left guide
   under the *Subscriptions* link.

Edge works with the same build (`edge://extensions`).

## Architecture

```
manifest.json            MV3; only host permission: https://*.youtube.com/*
page/bridge.js           MAIN-world bridge: reads ytcfg / ytInitialData, fetches
                         /feed/channels with the page session; postMessage + nonce
content/bootstrap.js     entry point: waits for the guide, idempotent mount,
                         SPA re-check on yt-navigate-finish
content/selectors.js     all YouTube DOM anchors as fallback chains + miss telemetry
content/widget.js        sidebar widget: header (total chip, refresh, gear, ▲/▼), profile
                         combobox on its own line, group tree, channel rows (view-only)
content/groups.js        group CRUD (yga:groups)
content/profiles.js      profile CRUD + composition; single writer of yga:settings
content/state.js         shared state; widget and panel repaint on any change
content/counters.js      counter view: newSince(at, lastVisitAt), header total chip
content/group-picker.js  «Group» button on channel pages (§8.8)
content/rss-parser.js    tag-scanner XML parser (MV3 service workers have no DOMParser)
background/service-worker.js  RSS fetch queue: dedup, batch of 12, throttle, ETag/304,
                         retries, cache yga:videos:<id>, scheduled refresh (alarms);
                         pushes counters to tabs on a ~350 ms window, so counts
                         repaint while the queue is still draining
config/panel.js          inline config panel in #content (tabs + internal scroll)
config/panel-sections.js seven panel tabs
```

Data flow: the content world never talks to YouTube directly. Subscriptions come through
the MAIN-world bridge (`GET /feed/channels` — the inner-API `browse` endpoint needs a
page-only `SAPISIDHASH`); RSS is fetched by the service worker (it has `host_permissions`).
All state lives in `chrome.storage.local` under `yga:*` keys; the widget and the panel
share one in-memory state module, so every change is visible in both without a reload.

Storage keys: `yga:settings`, `yga:profiles`, `yga:groups`, `yga:account`,
`yga:subs:<accountKey>`, `yga:profile-channels:<profileId>`, `yga:videos:<channelId>`,
`yga:videos-index`, `yga:log` (local failure journal — never leaves the browser).

## Development

No build step — edit files and press *Reload* on the extension tile.

```
node test/logic.mjs   # RSS parser + worker core + content view (60 checks)
node test/dom.mjs     # widget/panel DOM layer (68 checks)
```

`test/smoke.html` runs the RSS parser in a real browser. Manual checklist: see the
acceptance criteria in [PLAN.md](PLAN.md) §13.

Performance: rendering is batched and counters update in place (only the `.yga-count`
text node changes); the only forced layout read in the codebase is a single
`getBoundingClientRect` for the group-picker dropdown. To profile with ~300 channels:
DevTools → Performance → record a profile switch and a counter refresh; there should be
no long tasks and no layout thrashing (interleaved read/write).

## Troubleshooting

- **Widget does not appear.** The guide must be expanded; the widget mounts under
  *Subscriptions*. Check `chrome://extensions` → *Errors*, and the local journal:
  in the extension's service worker console run
  `chrome.storage.local.get("yga:log", console.log)` — selector misses and mount
  timeouts are recorded there. YouTube DOM changes are handled by fallback chains in
  `content/selectors.js`; if a chain breaks, extend it there.
- **Counters show `?`.** The RSS feed failed for that channel (rate limit / network);
  the previous number is kept. Press ↻ in the widget header to retry.
- **Counters capped at `15+`.** The RSS feed only exposes the ~15 latest videos per
  channel — by design.
- **Counters do not reset.** Only a click *in the widget* or right-click on a channel,
  group or total header chip resets counters; opening the channel elsewhere does not
  (MVP decision, PLAN.md §10.5).
- **Widget looks wrong after a YouTube update.** Disable the extension to confirm the
  conflict, then check `content/widget.css` (`/* YT-override */` comments) and
  `content/selectors.js`.
- **Reset everything.** Panel → *Data* → Reset (your YouTube subscriptions are untouched).
  Export first: the same tab dumps all `yga:*` keys as JSON.

## Privacy

No requests outside `*.youtube.com`. No analytics, no backend, no accounts. The failure
journal (`yga:log`) is local-only.

## Documentation

[PLAN.md](PLAN.md) (Russian) is the living design document: data model, decisions log,
milestones. Stages 0–8 are implemented; the backlog is stage 99.

## License

TBD.

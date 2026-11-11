window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Stage 9 (PLAN.md §8.8): per-profile letter buttons. On a channel page they
  // mount right after the subscribe/sponsor cluster (the PocketTube position);
  // on a watch page right before the Like/Dislike cluster. One small button per
  // profile showing its first letter in the profile color. Clicking a button
  // opens a dropdown of that profile's groups; the checkbox on each row shows
  // whether this page's channel belongs to the group. Checking assigns the
  // channel (setGroup also adds it to the profile composition, §18.5);
  // unchecking removes it from the group (groupId = null).
  const CHANNEL_PATH = /^\/(channel\/|@|c\/|user\/)/;
  const WATCH_PATH = /^\/watch/;
  const GROUPS_ATTR = "data-yga-group-buttons";
  const MENU_ATTR = "data-yga-group-menu";
  const PROFILE_ATTR = "data-yga-profile";
  const ANCHOR_ATTR = "data-yga-anchor";
  const CHANNEL_TEXT_RE =
    /^(Subscribe|Subscribed|Sponsor|Join|Подписаться|Вы подписаны|Отписаться|Спонсировать|Присоединиться)$/i;
  const LIKE_TEXT_RE =
    /(?:^|\s)(?:like|unlike|liked)(?:\s|$)|like this video|unlike this video|i like this|нравится|понравилось/i;
  const WATCH_LIKE_STRONG_RE = /like this video|unlike this video|i like this|мне нравится/i;
  // Live 2026 headers give the subscribe control a descriptive accessible name
  // ("Отменить подписку на канал «…»"), which the exact match above cannot see.
  const CHANNEL_TEXT_LOOSE_RE =
    /^(?:un)?subscribe|subscribed|отменить подписку|отписаться|подписаться|вы подписаны|спонс|sponsor|join|присоединиться/i;
  const ROW_SELECTOR =
    'yt-flexible-actions-view-model, [class*="flexible-actions-view-model"], #actions, #above-the-fold, yt-watch-metadata, ytd-watch-metadata, #page-header';
  // User report 2026-11-11: text anchors only cover the RU/EN labels we listed
  // and jump to wrong controls when they miss. Tag/class probes do not depend
  // on the UI language, so they run FIRST; the text regexes stay as fallback.
  const SUBSCRIBE_STRUCT =
    'yt-subscribe-button-view-model, ytd-subscribe-button-renderer, #subscribe-button, ' +
    '[class*="subscribe-button-view-model"], [class*="subscribe-button"]';
  // #top-level-buttons-computed: the 2026-11-11 probe found watch pages whose
  // like cluster is plain ytSpecButtonShapeNextHost buttons inside this legacy
  // id — no view-model tags anywhere, so it is the only language-independent
  // probe for that layout.
  const LIKE_STRUCT =
    '[id="id.video.like.button"], [aria-labelledby*="video.like.button"], ' +
    'yt-segmented-like-dislike-button-view-model, [class*="segmented-like-dislike"], ' +
    'yt-like-button-view-model, [class*="like-button-view-model"], ' +
    '#top-level-buttons-computed';
  // selectors.js:likeButton as one selector string — the legacy tail
  // (ytd-like-button-renderer, #like-button) is what LIKE_STRUCT misses and the
  // unguarded findVisible used to match: a hidden ghost duplicate.
  const LIKE_CHAIN = LIKE_STRUCT + ", ytd-like-button-renderer, #like-button";
  // The boundary must be any non-letter, not just whitespace: the live RU
  // accessible name is «Поставить отметку "Не нравится"», where «Не нравится» is
  // preceded by a quote — a \s-only guard let the Dislike button win the Like
  // match and anchored the overlay to the wrong control.
  const DISLIKE_TEXT_RE = /(?:^|[^\p{L}])(?:dislike|не нравится)(?:$|[^\p{L}])/iu;
  const BUTTON_SELECTOR = 'button, [role="button"], a, yt-button-view-model, [class*="button"]';

  // Anchor quality ranks (lower = better), mirroring findAnchor's branch order.
  // Mount can catch the actions row before the like cluster renders (live
  // 2026-11-11: the anchor stuck on watch-deep-actions and the overlay sat on
  // top of Subscribe), and the row stays connected forever, so the old
  // isConnected-only reanchor never re-resolved it. A rank above GOOD_RANK
  // means "anchored to the wrong control": the tracker retries findAnchor with
  // exponential backoff and swaps in the first better anchor.
  const ANCHOR_RANK = {
    "channel-subscribe": 0,
    "watch-like-struct": 0,
    "watch-like-struct-deep": 0,
    "channel-text": 1,
    "channel-text-deep": 1,
    "watch-like": 1,
    "watch-like-global": 1,
    "watch-like-deep": 1,
    "watch-like-deep-global": 1,
    "channel-text-loose": 2,
    "channel-text-loose-deep": 2,
    "watch-like-id": 2,
    "channel-actions": 3,
    "watch-cluster": 3,
    "channel-right": 4,
    "channel-right-deep": 4,
    "watch-left": 4,
    "watch-left-deep": 4,
    "channel-deep": 5,
    "watch-deep-like": 5,
    "watch-deep-cluster": 5,
    "watch-deep-left": 5,
    "channel-actions-wide": 6,
    "watch-deep-actions": 6,
    "channel-header": 7,
    "watch-cluster-wide": 7,
    "watch-actions": 7
  };
  const GOOD_RANK = 2; // a real like/subscribe control — position is correct
  const UPGRADE_BASE_MS = 1000;
  const UPGRADE_MAX_TRIES = 5; // 1s+2s+4s+8s+16s, then this page's best is a fallback
  let upgradeTries = 0;
  let lastUpgradeTry = 0;

  function anchorRank(name) {
    const r = ANCHOR_RANK[name];
    return r === undefined ? 9 : r;
  }

  let mounted = null; // { kind, anchor, host, channelId, buttons: [{btn, profileId}] }
  let unsubGroups = null;
  let unsubProfiles = null;

  // yt-navigate-finish fires before YouTube renders the subscribe cluster and
  // the like/dislike row, so the anchor is often still missing on the first
  // attempt. Retry fast for a while, then keep checking at a slow cadence: the
  // anchor can also arrive very late (long channel, slow device) or be replaced
  // without a navigation event, and giving up at a deadline is what hid the
  // buttons on slow loads. Mirrors the widget's permanent wait in bootstrap.js.
  const RETRY_MS = 400;
  const RETRY_FAST_MS = 15000;
  const RETRY_SLOW_MS = 1500;
  let retryTimer = null;
  let retryStarted = 0;
  let retryJournalled = false;

  function stopRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryStarted = 0;
    retryJournalled = false;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    if (!retryStarted) {
      retryStarted = Date.now();
      retryJournalled = false;
    }
    const fast = Date.now() - retryStarted < RETRY_FAST_MS;
    if (!fast && !retryJournalled) {
      retryJournalled = true;
      if (yga.selectors && yga.selectors.journal) {
        yga.selectors.journal("group-picker-slow", location.pathname);
      }
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      mount();
    }, fast ? RETRY_MS : RETRY_SLOW_MS);
  }

  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) {
      for (const key in attrs) {
        if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      }
    }
    return node;
  }

  function pageKind() {
    if (CHANNEL_PATH.test(location.pathname)) return "channel";
    if (WATCH_PATH.test(location.pathname)) return "watch";
    return null;
  }

  function currentMenu() {
    return document.querySelector("[" + MENU_ATTR + "]");
  }

  function closeMenu() {
    const node = currentMenu();
    if (node) node.remove();
    document.removeEventListener("pointerdown", onOutside, true);
  }

  function onOutside(ev) {
    const node = currentMenu();
    if (!node || node.contains(ev.target)) return;
    const host = document.querySelector("[" + GROUPS_ATTR + "]");
    if (host && host.contains(ev.target)) return;
    closeMenu();
  }

  async function pageChannel() {
    try {
      const res = await yga.bridge.call("getPageChannel");
      return res && res.channelId ? res : null;
    } catch (e) {
      console.debug("[yga] page channel detection failed:", e);
      return null;
    }
  }

  function firstLetter(name) {
    const chars = Array.from(String(name || "").trim());
    return chars.length ? chars[0].toUpperCase() : "?";
  }

  // Readable text color for an arbitrary profile color (WCAG-ish luminance).
  function contrastFg(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? "#0f0f0f" : "#ffffff";
  }

  // Group of this page's channel inside one profile, resolved against
  // yga:groups so a deleted group never counts (§18.1).
  async function groupOf(profileId, channelId) {
    const comp = await yga.profiles.getComposition(profileId);
    const rec = comp[channelId];
    const gid = rec && rec.groupId;
    if (!gid) return "";
    const group = yga.groups.get(gid);
    return group && group.profileId === profileId ? gid : "";
  }

  // Mark each letter button whose profile already contains the channel.
  async function paint(channelId) {
    if (!mounted) return;
    for (const entry of mounted.buttons) {
      const gid = await groupOf(entry.profileId, channelId);
      entry.btn.classList.toggle("yga-gp-on", !!gid);
    }
  }

  async function assign(profileId, channelId, groupId) {
    await yga.profiles.setGroup(profileId, [channelId], groupId || null);
    await yga.state.refreshVisible();
    await paint(channelId);
    if (yga.panel && yga.panel.isOpen()) {
      yga.panel.refresh("groups");
      yga.panel.refresh("channels");
    }
  }

  // Theme a picker surface exactly like the widget: content/theme.js writes the
  // --yga-* palette inline from YouTube's live theme (contrast enforced). The
  // menu lives on document.body and the host is an absolute overlay, so neither
  // inherits the widget's vars — each must be themed on its own. When the user
  // pins the light palette (theme.followYouTube === false) theme.clear strips
  // the inline vars so the light CSS fallback shows through.
  async function themeNode(node) {
    if (!node || !node.style) return;
    let follow = true;
    let accent = "#c00";
    try {
      const s = await yga.profiles.getSettings();
      const t = (s && s.theme) || {};
      follow = t.followYouTube !== false;
      accent = /^#[0-9a-f]{6}$/i.test(t.accent || "") ? t.accent : "#c00";
    } catch (e) {
      console.debug("[yga] group-picker theme read failed:", e);
    }
    node.style.setProperty("--yga-accent", accent);
    if (!follow) {
      if (yga.theme && yga.theme.clear) yga.theme.clear(node);
    } else if (yga.theme && yga.theme.apply) {
      yga.theme.apply(node);
    }
  }

  async function openMenu(btn, channelId, profileId) {
    closeMenu();
    await yga.groups.load();
    const groups = yga.groups.list(profileId);
    const gid = await groupOf(profileId, channelId);

    const box = el("div", "yga-gp-menu", {
      role: "menu",
      "aria-label": btn.getAttribute("title") || yga.i18n("groupButton")
    });
    box.setAttribute(MENU_ATTR, "");

    if (!groups.length) {
      const empty = el("div", "yga-gp-empty");
      empty.textContent = yga.i18n("groupsEmpty");
      box.appendChild(empty);
    }

    // One row per group: name left, checkbox right (§8.8 stage 9). Checking
    // assigns; unchecking removes the channel from that group.
    for (const g of groups) {
      const row = el("label", "yga-gp-item");
      const name = el("span", "yga-gp-name");
      name.textContent = g.name;
      const check = el("input", "yga-gp-check", {
        type: "checkbox",
        "aria-label": g.name
      });
      check.checked = gid === g.id;
      check.addEventListener("change", async () => {
        await assign(profileId, channelId, check.checked ? g.id : null);
      });
      row.appendChild(name);
      row.appendChild(check);
      box.appendChild(row);
    }

    // Quick create (§18.5): one field, Enter creates and assigns in one step.
    const quick = el("div", "yga-gp-quick");
    const input = el("input", "yga-gp-input", {
      type: "text",
      "aria-label": yga.i18n("groupNew")
    });
    input.placeholder = yga.i18n("groupNew");
    const ok = el("button", "yga-gp-item yga-gp-create", { type: "button", role: "menuitem" });
    ok.textContent = yga.i18n("groupCreateAssign");
    const create = async () => {
      const name = String(input.value || "").trim();
      if (!name) return;
      const created = await yga.groups.create(name, profileId);
      closeMenu();
      if (created) await assign(profileId, channelId, created.id);
    };
    ok.addEventListener("click", create);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        create();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
      }
    });
    quick.appendChild(input);
    quick.appendChild(ok);
    box.appendChild(quick);

    // The letter-button host is an absolute overlay, so it would be the
    // containing block for an absolutely-positioned menu. Append the menu to
    // document.body and position it fixed against the viewport instead.
    // The menu is not a descendant of the widget or the host, so it inherits no
    // --yga-* palette: theme it from YouTube's live theme (theme.apply works on
    // a detached node) BEFORE appending, so it never paints the light fallback.
    await themeNode(box);
    document.body.appendChild(box);
    // The header is not a positioned ancestor, so the menu is fixed and placed
    // from the button rect instead of relying on an offset parent.
    const rect = btn.getBoundingClientRect();
    box.style.position = "fixed";
    box.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + "px";
    box.style.top = Math.round(rect.bottom + 4) + "px";
    if (input.focus) input.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }

  // --- absolute-overlay positioning ----------------------------------------
  // The letter buttons are NEVER inserted into YouTube's DOM. They live in an
  // absolute host on document.body, placed in document coordinates from the
  // native anchor's bounding rect. A fixed host had to be rewritten on every
  // scroll frame; on the watch page those frames were late and the overlay
  // visibly jumped. Absolute placement lets the page scroll carry the host, so
  // a scroll frame that recomputes the same document position writes nothing.
  // Inserting into the subscribe cluster / actions row made YouTube's
  // Lit/Polymer renderers re-render the whole page on every navigation (the
  // Stage 7 §5 flicker); an overlay on body cannot trigger it.
  let trackTimer = 0;
  let tracking = false;
  let positionQueued = false;
  // Scroll frames must not touch layout beyond the anchor's own rect. Every
  // obstacle rect is cached in DOCUMENT space (viewport rect + scroll offset),
  // so a scroll frame costs one getBoundingClientRect: queryDeep plus per-element
  // rects per frame starved the overlay of frames — it froze, then jumped on the
  // 250ms timer (user report 2026-11-11). The cache is dropped on the tracking
  // timer and on any anchor swap, so a YouTube re-render lands within one tick.
  let rowCache = { row: null, anchor: null, boxes: null };
  // The chosen horizontal gap is held across frames (hysteresis). The row's box
  // set churns while YouTube lazy-renders the actions row, and re-picking the
  // slot every frame flipped the overlay between gaps — the watch-page jumping.
  let slot = null;
  // Bottom edge of the fixed masthead: an anchor above it is behind the header,
  // so the overlay has no business being drawn there.
  let topBound = 0;
  // A sticky anchor (the collapsed channel header pins under the masthead) keeps
  // its viewport top while the page scrolls; following it parks the buttons at
  // the top edge, which is the channel-page complaint. Detect it and leave.
  let pinned = false;
  let pinnedStreak = 0;
  let lastScrollY = 0;
  let lastAnchorTop = 0;
  // The host is absolute in document space: while the page only scrolls, its
  // left/top do not change, so the last written pair is kept and a scroll frame
  // that recomputes the same numbers writes nothing at all.
  let lastLeft = null;
  let lastTop = null;
  let hostW = 26;
  let hostH = 26;

  function resetTrackingState() {
    rowCache = { row: null, anchor: null, boxes: null };
    slot = null;
    pinned = false;
    pinnedStreak = 0;
    lastScrollY = window.scrollY || 0;
    lastAnchorTop = 0;
    lastLeft = null;
    lastTop = null;
  }

  function measureHostSize() {
    if (!mounted || !mounted.host) return;
    const w = mounted.host.offsetWidth;
    const h = mounted.host.offsetHeight;
    if (w > 0) hostW = w;
    if (h > 0) hostH = h;
  }

  function measureTopBound() {
    let b = 0;
    const m = document.querySelector("ytd-masthead, #masthead, ytd-desktop-topbar-header");
    if (m && m.getBoundingClientRect) {
      const r = m.getBoundingClientRect();
      if (r && r.height > 0) b = r.bottom;
    }
    topBound = b > 0 ? b : 0;
  }

  function detectPinned() {
    if (!mounted || !mounted.anchor) return;
    const y = window.scrollY || 0;
    const r = mounted.anchor.getBoundingClientRect();
    const dY = y - lastScrollY;
    const dT = r.top - lastAnchorTop;
    lastScrollY = y;
    lastAnchorTop = r.top;
    // The state is sticky: the anchor moving again is the only thing that clears
    // it. Requiring |dY| > 40 per tick would un-pin the moment the user pauses
    // the scroll, and the buttons would pop back at the top edge.
    if (Math.abs(dT) > 3) {
      pinned = false;
      pinnedStreak = 0;
    } else if (Math.abs(dY) > 40) {
      pinnedStreak++;
      if (pinnedStreak >= 2) pinned = true;
    }
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const box = el.getBoundingClientRect();
    return !!box && (box.width > 0 || box.height > 0);
  }

  function normalizeText(el) {
    return String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  function accessibleName(el) {
    if (!el || !el.getAttribute) return "";
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    return String(label || normalizeText(el)).replace(/\s+/g, " ").trim();
  }

  function isOwn(el) {
    return !!(el && el.closest && el.closest("[" + GROUPS_ATTR + "]"));
  }

  // One-line identity of an element for the host's data-yga-anchor-el dataset:
  // the user reports it from the console instead of pasting a full probe.
  function describeEl(el) {
    if (!el || !el.tagName) return "(none)";
    const tag = String(el.tagName).toLowerCase();
    const cls = typeof el.className === "string" ? cls0(el) : "";
    const name = accessibleName(el).slice(0, 40);
    return tag + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "") +
      (name ? " «" + name + "»" : "");
  }

  function cls0(el) {
    const first = String(el.className || "").trim().split(/\s+/)[0];
    return first || "";
  }

  function isButtonLike(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toLowerCase();
    if (tag === "button" || tag === "a") return true;
    if (el.getAttribute && el.getAttribute("role") === "button") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    return /(^|[-_\s])button([-_\s]|$)/i.test(cls) || /(^|[-_\s])btn([-_\s]|$)/i.test(cls);
  }

  function queryButtonLike(root, deep) {
    if (deep && yga.selectors && yga.selectors.queryDeep) {
      try {
        return yga.selectors.queryDeep(BUTTON_SELECTOR, root);
      } catch (e) {
        return [];
      }
    }
    try {
      return root.querySelectorAll(BUTTON_SELECTOR);
    } catch (e) {
      return [];
    }
  }

  function findVisibleButton(root, re, deep) {
    if (!root || (!deep && !root.querySelectorAll)) return null;
    let best = null;
    let bestArea = Infinity;
    for (const el of queryButtonLike(root, deep)) {
      if (isOwn(el) || !isVisible(el)) continue;
      const name = accessibleName(el);
      if (!name || DISLIKE_TEXT_RE.test(name)) continue;
      if (!re.test(name)) continue;
      const rect = el.getBoundingClientRect();
      const area = Math.max(1, rect.width * rect.height);
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // Smallest visible match of a raw selector list — structural anchors are
  // custom view-model tags, not button-like, so findVisibleButton does not fit.
  // Smallest wins so a wrapper never beats the control; dislike view-models
  // are skipped because their stamped class contains "like-button-view-model".
  // A dislike-only view-model: its stamped class contains "like-button-view-model"
  // as a substring, so LIKE_STRUCT-style selectors match it too. The text guard
  // misses it when the accessible name is just the count, and the dislike button
  // is usually smaller than the like button, so "smallest wins" would pick it.
  // The segmented cluster legitimately contains "dislike" and must survive.
  function isDislikeStructural(el) {
    const tag = el && el.tagName ? String(el.tagName).toLowerCase() : "";
    const cls = el && typeof el.className === "string" ? el.className : "";
    const s = tag + " " + cls;
    if (!/dislike/i.test(s)) return false;
    return !/segmented|like-dislike/i.test(s);
  }

  function findSmallestVisible(sel, root, deep) {
    const maxW = viewportWidth() * 0.5;
    let list;
    try {
      list = deep && yga.selectors && yga.selectors.queryDeep
        ? yga.selectors.queryDeep(sel, root)
        : (root || document).querySelectorAll(sel);
    } catch (e) {
      return null;
    }
    let best = null;
    let bestArea = Infinity;
    for (const el of list) {
      if (isOwn(el) || !isVisible(el) || isDislikeStructural(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > maxW) continue;
      if (DISLIKE_TEXT_RE.test(accessibleName(el))) continue;
      const area = Math.max(1, rect.width * rect.height);
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function viewportWidth() {
    return window.innerWidth || 1280;
  }

  function isFullWidthContainer(el) {
    if (!isVisible(el) || isButtonLike(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > viewportWidth() * 0.65;
  }

  function edgeButton(root, pickRight, deep) {
    if (!root || (!deep && !root.querySelectorAll)) return null;
    let best = null;
    let bestEdge = pickRight ? -Infinity : Infinity;
    for (const el of queryButtonLike(root, deep)) {
      if (isOwn(el) || !isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > viewportWidth() * 0.5) continue;
      const edge = pickRight ? rect.right : rect.left;
      if (pickRight ? edge > bestEdge : edge < bestEdge) {
        best = el;
        bestEdge = edge;
      }
    }
    return best;
  }

  function rowFor(el) {
    if (!el || typeof el.closest !== "function") return null;
    try {
      return el.closest(ROW_SELECTOR);
    } catch (e) {
      return null;
    }
  }

  function findChannelAnchor() {
    const s = yga.selectors;
    if (!s) return null;
    const header = s.findVisible ? s.findVisible("channelHeader") : s.findOptional("channelHeader");
    const scope = header && header.id === "page-header" ? header : document;

    // Structural first: language-independent tag/class probes, light DOM then
    // shadow-piercing. This is the anchor that survives any UI language.
    const struct =
      findSmallestVisible(SUBSCRIBE_STRUCT, scope) ||
      (scope !== document ? findSmallestVisible(SUBSCRIBE_STRUCT, document) : null) ||
      findSmallestVisible(SUBSCRIBE_STRUCT, scope, true) ||
      findSmallestVisible(SUBSCRIBE_STRUCT, document, true);
    if (struct) return { el: struct, name: "channel-subscribe", row: rowFor(struct) };

    const text = findVisibleButton(scope, CHANNEL_TEXT_RE);
    if (text) return { el: text, name: "channel-text", row: rowFor(text) };

    // 2026-11-11 browser probe: the subscribe control sits in a native shadow
    // root (ShadyDOM force mode is off), so the light-DOM probe above misses it
    // while the whole actions row is still found by tag. Piercing the shadow
    // tree has to come before the row fallback — anchoring to the row put the
    // overlay at rect.right, i.e. clamped to the viewport edge.
    const deepText =
      findVisibleButton(scope, CHANNEL_TEXT_RE, true) ||
      findVisibleButton(document, CHANNEL_TEXT_RE, true);
    if (deepText) return { el: deepText, name: "channel-text-deep", row: rowFor(deepText) };

    const loose = findVisibleButton(scope, CHANNEL_TEXT_LOOSE_RE);
    if (loose) return { el: loose, name: "channel-text-loose", row: rowFor(loose) };
    const looseDeep =
      findVisibleButton(scope, CHANNEL_TEXT_LOOSE_RE, true) ||
      findVisibleButton(document, CHANNEL_TEXT_LOOSE_RE, true);
    if (looseDeep) return { el: looseDeep, name: "channel-text-loose-deep", row: rowFor(looseDeep) };

    const actions = s.findVisible ? s.findVisible("subscribeButton") : s.findOptional("subscribeButton");
    if (actions && !isFullWidthContainer(actions)) return { el: actions, name: "channel-actions", row: actions };

    if (header) {
      const right = edgeButton(header, true);
      if (right) return { el: right, name: "channel-right", row: rowFor(right) };
    }

    if (header) {
      const right = edgeButton(header, true, true);
      if (right) return { el: right, name: "channel-right-deep", row: rowFor(right) };
    }
    if (s.findDeep) {
      const deep = s.findDeep("subscribeButton") || s.findDeep("channelHeader");
      if (deep) return { el: deep, name: "channel-deep", row: deep };
    }
    if (actions) return { el: actions, name: "channel-actions-wide", row: actions };
    if (header) return { el: header, name: "channel-header", row: header };
    return null;
  }

  function findWatchAnchor() {
    const s = yga.selectors;
    if (!s) return null;
    const scopes = ["#actions", "yt-watch-metadata", "ytd-watch-metadata", "#above-the-fold", "#info"];

    // Structural first: the accessibility id and the view-model tags are
    // language-independent contracts; accessible names are not. Scoped to the
    // watch metadata first so an inline Shorts like button cannot win.
    for (const sel of scopes) {
      const scope = document.querySelector(sel);
      const struct = scope ? findSmallestVisible(LIKE_STRUCT, scope) : null;
      if (struct) return { el: struct, name: "watch-like-struct" };
    }
    const structDeep = findSmallestVisible(LIKE_STRUCT, document, true);
    if (structDeep) return { el: structDeep, name: "watch-like-struct-deep" };

    for (const sel of scopes) {
      const scope = document.querySelector(sel);
      const like = scope ? findVisibleButton(scope, LIKE_TEXT_RE) : null;
      if (like) return { el: like, name: "watch-like" };
    }
    const globalLike = findVisibleButton(document, WATCH_LIKE_STRONG_RE);
    if (globalLike) return { el: globalLike, name: "watch-like-global" };

    for (const sel of scopes) {
      const scope =
        (s.queryDeep && s.queryDeep(sel)[0]) || document.querySelector(sel) || document;
      const like = findVisibleButton(scope, LIKE_TEXT_RE, true);
      if (like) return { el: like, name: "watch-like-deep" };
    }
    const globalDeepLike = findVisibleButton(document, WATCH_LIKE_STRONG_RE, true);
    if (globalDeepLike) return { el: globalDeepLike, name: "watch-like-deep-global" };

    // findVisible takes the FIRST boxed match — on 2026-11-11 both test videos
    // anchored to a ghost duplicate this way (overlay on top of Subscribe on one
    // page, off-screen on the other). Smallest + dislike/width guards instead.
    const like =
      findSmallestVisible(LIKE_CHAIN, document) ||
      findSmallestVisible(LIKE_CHAIN, document, true);
    if (like) return { el: like, name: "watch-like-id" };

    const cluster = s.findVisible ? s.findVisible("likeDislike") : s.findOptional("likeDislike");
    if (cluster && !isFullWidthContainer(cluster)) return { el: cluster, name: "watch-cluster" };

    const actions = s.findVisible ? s.findVisible("watchActions") : s.findOptional("watchActions");
    if (actions) {
      const left = edgeButton(actions, false);
      if (left) return { el: left, name: "watch-left" };
      const deepLeft = edgeButton(actions, false, true);
      if (deepLeft) return { el: deepLeft, name: "watch-left-deep" };
    }
    if (s.findDeep) {
      const deepLike = s.findDeep("likeButton");
      if (deepLike) return { el: deepLike, name: "watch-deep-like" };
      const deepCluster = s.findDeep("likeDislike");
      if (deepCluster) return { el: deepCluster, name: "watch-deep-cluster" };
      const deepActions = s.findDeep("watchActions");
      if (deepActions) {
        const left = edgeButton(deepActions, false, true);
        if (left) return { el: left, name: "watch-deep-left" };
        return { el: deepActions, name: "watch-deep-actions" };
      }
    }
    if (cluster) return { el: cluster, name: "watch-cluster-wide" };
    if (actions) return { el: actions, name: "watch-actions" };
    return null;
  }

  function findAnchor(kind) {
    const anchor = kind === "channel" ? findChannelAnchor() : findWatchAnchor();
    if (anchor && !anchor.row) anchor.row = rowFor(anchor.el);
    return anchor;
  }

  function onViewportChange() {
    schedulePosition();
  }

  // A resize changes both the viewport band and the row layout: the cached
  // document-space boxes and the masthead height are both stale after it.
  function onResize() {
    rowCache = { row: null, anchor: null, boxes: null };
    slot = null;
    lastLeft = null;
    lastTop = null;
    measureTopBound();
    measureHostSize();
    schedulePosition();
  }

  // Reposition only. reanchor (which can deep-query the whole page when the
  // anchor died) runs on the tracking timer, so a detached anchor costs at
  // most one findAnchor per 250ms — never one per scroll frame.
  function schedulePosition() {
    if (positionQueued) return;
    positionQueued = true;
    const run = () => {
      positionQueued = false;
      positionHost();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function stopTracking() {
    if (trackTimer) {
      clearInterval(trackTimer);
      trackTimer = 0;
    }
    if (tracking) {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onResize);
      tracking = false;
    }
    resetTrackingState();
  }

  // Visible button boxes inside the anchor's row, in DOCUMENT space, our overlay
  // and the anchor's own subtree excluded. Deep, so a control hidden behind a
  // shadow boundary still counts as taken: covering the subscribe button looked
  // worse to the user than sitting further along the same row. Document space is
  // what makes the scroll frames free: the boxes do not move when the page
  // scrolls, only the anchor's viewport rect has to be converted.
  function rowBoxes(row, skip) {
    if (rowCache.row === row && rowCache.anchor === skip && rowCache.boxes) return rowCache.boxes;
    const boxes = [];
    if (row) {
      const maxW = viewportWidth() * 0.5;
      const sx = window.scrollX || 0;
      const sy = window.scrollY || 0;
      for (const el of queryButtonLike(row, true)) {
        if (isOwn(el) || el === skip) continue;
        // The cluster container matches BUTTON_SELECTOR ([class*="button"]) and
        // spans the whole row: while it was in the set it blocked every gap and
        // the slot flipped the moment it appeared or vanished.
        if (skip && skip.contains && (skip.contains(el) || el.contains(skip))) continue;
        const r = el.getBoundingClientRect();
        if (!r || !r.width || !r.height || r.width > maxW) continue;
        boxes.push({
          left: r.left + sx,
          top: r.top + sy,
          right: r.right + sx,
          bottom: r.bottom + sy
        });
      }
    }
    rowCache = { row: row, anchor: skip, boxes: boxes };
    return boxes;
  }

  // Place the host in a free slot of the anchor's LINE. The vertical band is
  // the anchor button itself, never the row: a wrapped row spans several lines
  // and centring on the row dropped the overlay two rows down (user report
  // 2026-11-11), and boxes from other lines pushed the chosen slot away. The
  // spec side (right of Subscribe, left of Like/Dislike) is preferred, but the
  // live rows start at x=16 and are packed edge to edge, so the requested slot
  // often does not exist — then the next free gap on the same line is used.
  //
  // The host is hidden whenever the anchor is not fully inside the band the
  // masthead leaves. Clamping top to the viewport edge parked the buttons at the
  // top of the screen while the anchor was gone; dropping the clamp let them
  // slide half past the edge instead (both user reports 2026-11-11). Off-screen
  // is the honest state: the buttons leave with the anchor.
  function positionHost() {
    if (!mounted || !mounted.anchor || !mounted.host) return;
    const target = mounted.anchor;
    const host = mounted.host;
    const trect = target.getBoundingClientRect();
    if (!trect || (!trect.width && !trect.height) || pinned) {
      host.classList.add("yga-gp-hidden");
      return;
    }
    const vh = window.innerHeight || 720;
    if (trect.top < topBound || trect.bottom > vh) {
      host.classList.add("yga-gp-hidden");
      return;
    }
    host.classList.remove("yga-gp-hidden");
    const gap = 6;
    // Watch pages put the overlay left of Like. The live Like control has its
    // own hover/padding halo, and an active profile button carries a 4px ring,
    // so the preferred side gets extra clearance; the fallback gaps stay tight.
    const watchLeftGap = 10;
    const h = hostH || 26;
    const w = hostW || 26;
    const vw = viewportWidth();
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    const row = (mounted.anchorDesc && mounted.anchorDesc.row) || rowFor(target);
    const top = trect.top + (trect.height - h) / 2;
    const vTop = top + sy - gap;
    const vBottom = top + sy + h + gap;
    const boxes = rowBoxes(row, target).filter(
      (b) => b.top < trect.bottom + sy && b.bottom > trect.top + sy
    );

    function free(leftDoc) {
      const vl = leftDoc - sx;
      if (vl < 4 || vl + w > vw - 4) return false;
      const l = leftDoc - gap;
      const r = leftDoc + w + gap;
      for (const b of boxes) {
        if (b.bottom < vTop || b.top > vBottom) continue;
        if (l < b.right && r > b.left) return false;
      }
      return true;
    }

    let lastRight = -Infinity;
    let firstLeft = Infinity;
    for (const b of boxes) {
      if (b.right > lastRight) lastRight = b.right;
      if (b.left < firstLeft) firstLeft = b.left;
    }
    const dLeft = trect.left + sx;
    const dRight = trect.right + sx;
    const order =
      mounted.kind === "channel"
        ? [dRight + gap, lastRight + gap, dLeft - gap - w, firstLeft - gap - w]
        : [dLeft - watchLeftGap - w, lastRight + gap, dRight + gap, firstLeft - gap - w];
    let left = null;
    // Hold the slot already held while it stays free: the box set churns during
    // a YouTube re-render, and re-picking per frame is what made the overlay
    // flicker between two gaps on watch pages.
    if (slot && slot.anchor === target && free(slot.left)) left = slot.left;
    if (left === null) {
      for (const candidate of order) {
        if (Number.isFinite(candidate) && free(candidate)) {
          left = candidate;
          break;
        }
      }
    }
    if (left === null) left = Math.max(4 + sx, Math.min(dRight + gap, vw - w - 4 + sx));
    slot = { anchor: target, left: left };
    const leftDoc = Math.round(left);
    const topDoc = Math.round(top + sy);
    if (lastLeft !== leftDoc || lastTop !== topDoc) {
      lastLeft = leftDoc;
      lastTop = topDoc;
      host.style.setProperty("left", leftDoc + "px");
      host.style.setProperty("top", topDoc + "px");
    }
  }

  // Diagnostics are written on the tracking timer and on anchor changes only:
  // three dataset writes per scroll frame invalidate style and force layout
  // reads, which is exactly the jank the overlay is supposed to avoid.
  function diagnose() {
    if (!mounted || !mounted.host || !mounted.anchor) return;
    const ds = mounted.host.dataset;
    ds.ygaAnchorEl = describeEl(mounted.anchor);
    const trect = mounted.anchor.getBoundingClientRect();
    ds.ygaAnchorRect = trect
      ? Math.round(trect.left) + "," + Math.round(trect.top) +
        " " + Math.round(trect.width) + "x" + Math.round(trect.height)
      : "(no rect)";
    ds.ygaPinned = pinned ? "1" : "0";
    ds.ygaTopBound = String(Math.round(topBound));
    ds.ygaHostSize = Math.round(hostW) + "x" + Math.round(hostH);
  }

  // YouTube replaces the header / actions row when it re-renders, which leaves
  // us tracking a detached node. Re-resolve the anchor in place. A still-
  // connected anchor is ALSO re-resolved while its rank is above GOOD_RANK:
  // mount can catch the actions row before the like cluster renders, and the
  // row never disconnects, so without this the overlay stayed on Subscribe for
  // the whole page (live 2026-11-11). Backoff keeps the deep findAnchor cheap
  // on pages whose best anchor genuinely is a fallback.
  function reanchor() {
    if (!mounted) return;
    const dead = mounted.anchor.isConnected === false;
    const rank = anchorRank(mounted.anchorName);
    if (!dead && rank <= GOOD_RANK) return;
    if (!dead) {
      if (upgradeTries >= UPGRADE_MAX_TRIES) return;
      if (Date.now() - lastUpgradeTry < UPGRADE_BASE_MS * Math.pow(2, upgradeTries)) return;
      lastUpgradeTry = Date.now();
    }
    const anchor = findAnchor(mounted.kind);
    if (!anchor) {
      if (dead) scheduleRetry();
      else upgradeTries++;
      return;
    }
    if (!dead && anchorRank(anchor.name) >= rank) {
      upgradeTries++;
      return;
    }
    mounted.anchor = anchor.el;
    mounted.anchorName = anchor.name;
    mounted.anchorDesc = anchor;
    // The swap means the row's contents changed (that is why the better anchor
    // appeared) while the row element may be identical — drop the cached boxes
    // and the held slot, and re-baseline the pinned detector on the new element.
    resetTrackingState();
    lastAnchorTop = anchor.el.getBoundingClientRect().top;
    upgradeTries = 0;
    lastUpgradeTry = 0;
    if (mounted.host) mounted.host.setAttribute(ANCHOR_ATTR, anchor.name);
    diagnose();
    positionHost();
  }

  // Keep the overlay glued to the anchor across scroll and layout shifts.
  function startTracking() {
    stopTracking();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onResize);
    tracking = true;
    measureTopBound();
    if (mounted && mounted.anchor) lastAnchorTop = mounted.anchor.getBoundingClientRect().top;
    trackTimer = setInterval(() => {
      // One layout pass per tick: cached boxes and the masthead are stale after
      // any YouTube re-render, and the pinned check needs a fresh anchor rect.
      rowCache = { row: null, anchor: null, boxes: null };
      measureTopBound();
      detectPinned();
      diagnose();
      reanchor(); // runs here, so the queued frame only repositions
      schedulePosition();
    }, 250);
  }

  async function mount() {
    if (!yga.groups || !yga.profiles || !yga.state) {
      if (yga.selectors && yga.selectors.journal) {
        yga.selectors.journal("group-picker-deps", location.pathname);
      }
      return;
    }
    const kind = pageKind();
    const settings = await yga.profiles.getSettings();
    const w = settings.widget || {};
    const enabled =
      kind === "channel" ? w.channelPageButton !== false :
      kind === "watch" ? w.watchPageButton !== false : false;
    if (!enabled || !kind) {
      unmount();
      return;
    }
    const page = await pageChannel();
    if (!page) {
      // The bridge may not have answered yet on an early navigation: drop any
      // stale host and keep trying.
      unmount();
      scheduleRetry();
      return;
    }

    const anchor = findAnchor(kind);
    if (!anchor || !anchor.el) {
      // The native anchor (subscribe cluster / like-dislike row) is not in the
      // DOM yet: drop any stale host and retry until it appears.
      unmount();
      scheduleRetry();
      return;
    }
    stopRetry();

    let host = document.querySelector("[" + GROUPS_ATTR + "]");
    if (host && mounted && mounted.anchor === anchor.el &&
        mounted.channelId === page.channelId && mounted.kind === kind) {
      await paint(page.channelId);
      return;
    }
    if (host) host.remove();
    closeMenu();

    await yga.profiles.load();
    // paint() resolves groups through yga.groups.get(); without a load the very
    // first paint marks every button unchecked even when the channel is grouped.
    await yga.groups.load();
    // "Все подписки" (the built-in includeAllSubs profile) never carries groups,
    // so it gets no letter button here — the picker only covers curated profiles.
    const pickerProfiles = yga.profiles.list().filter((p) => !p.builtin && !p.includeAllSubs);
    if (!pickerProfiles.length) {
      unmount();
      return;
    }
    host = el("div", "yga-gp-group", {
      role: "group",
      "aria-label": yga.i18n("groupButton")
    });
    host.setAttribute(GROUPS_ATTR, "");
    host.setAttribute(ANCHOR_ATTR, anchor.name || "");
    const buttons = [];
    for (const p of pickerProfiles) {
      const btn = el("button", "yga-gp-letter", {
        type: "button",
        "aria-haspopup": "menu",
        title: p.name
      });
      btn.setAttribute(PROFILE_ATTR, p.id);
      btn.textContent = firstLetter(p.name);
      const color = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "#e05252";
      btn.style.setProperty("--yga-gp-color", color);
      btn.style.setProperty("--yga-gp-fg", contrastFg(color));
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (currentMenu()) closeMenu();
        else openMenu(btn, page.channelId, p.id);
      });
      host.appendChild(btn);
      buttons.push({ btn: btn, profileId: p.id });
    }

    // The overlay lives on document.body, never inside YouTube's tree. Theme it
    // before appending (its active-button ring reads --yga-surface).
    await themeNode(host);
    document.body.appendChild(host);
    upgradeTries = 0;
    lastUpgradeTry = 0;
    resetTrackingState();
    mounted = {
      kind: kind,
      anchor: anchor.el,
      anchorName: anchor.name,
      anchorDesc: anchor,
      host: host,
      channelId: page.channelId,
      buttons: buttons
    };
    measureHostSize();
    positionHost();
    startTracking();
    diagnose();
    await paint(page.channelId);

    if (!unsubGroups) {
      unsubGroups = yga.groups.onGroupsChanged(() => {
        if (!mounted) return;
        closeMenu();
        paint(mounted.channelId);
      });
    }
    if (!unsubProfiles && yga.profiles.onProfilesChanged) {
      // The button set mirrors the profile set: create/rename/recolor/remove
      // all rebuild it.
      unsubProfiles = yga.profiles.onProfilesChanged(() => {
        if (!mounted) return;
        mounted = null;
        mount();
      });
    }
  }

  function unmount() {
    closeMenu();
    stopTracking();
    const host = document.querySelector("[" + GROUPS_ATTR + "]");
    if (host) host.remove();
    mounted = null;
  }

  function boot() {
    mount();
    // SPA navigation: the header/actions row is rebuilt per page, re-anchor.
    window.addEventListener("yt-navigate-finish", () => {
      stopTracking(); // the old anchor is gone; stop tracking its rect
      mounted = null;
      closeMenu();
      stopRetry(); // a fresh page gets a fresh retry window
      mount();
    });
    // Either toggle can be flipped from the panel while the page stays open.
    if (yga.profiles.onSettingsChanged) {
      let buttonOn = null; // the widget keeps its own previous; so do we
      yga.profiles.onSettingsChanged((next) => {
        const w = (next && next.widget) || {};
        const on = (w.channelPageButton !== false) + "|" + (w.watchPageButton !== false);
        if (buttonOn === on) return;
        buttonOn = on;
        stopTracking();
        mounted = null;
        stopRetry();
        mount();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.yga);

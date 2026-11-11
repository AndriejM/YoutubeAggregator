window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Single source of truth for YouTube DOM anchors (PLAN.md §2.4).
  // Every entry is a fallback chain: first match wins.
  const SELECTORS = {
    app: ["ytd-app"],
    drawer: ["tp-yt-app-drawer", "ytd-guide-entry-renderer"],
    guideRoot: ["#guide-inner-content", "ytd-guide-renderer", "#guide"],
    // The Polymer-managed guide subtree — the widget must stay outside it
    // (ytd-guide-renderer re-renders its own children, see widget.js).
    guideRenderer: ["ytd-guide-renderer", "#guide-inner-content #sections", "#sections"],
    guideSections: [
      "#guide-inner-content #sections",
      "ytd-guide-renderer #sections",
      "#guide-inner-content",
      "ytd-guide-renderer"
    ],
    subscriptionsLink: [
      "#guide-inner-content a#subscriptions-link",
      '#guide-inner-content a[href="/feed/subscriptions"]',
      '#guide-inner-content a[href^="/feed/subscriptions"]',
      '#sections a[href*="/feed/subscriptions"]'
    ],
    // Config panel anchors (PLAN.md §8.7): the panel is a sibling of the
    // YouTube page inside ytd-app > #content, so the guide stays visible.
    contentRoot: ["ytd-app > #content", "ytd-app #content", "#content"],
    browseResults: [
      "ytd-two-column-browse-results-renderer",
      "ytd-browse",
      "#page-manager",
      "ytd-page-manager"
    ],
    // Stage 9 (§8.8): anchors for the letter-button overlay. We only READ their
    // bounding rect; we never insert into YouTube's tree — that re-renders the
    // page on every navigation (Stage 7 §5).
    //
    // Live-YouTube finding 2026-11-10: the desktop page boots with
    // `window.ShadyDOM={force:true,noPatch:true}`, so Polymer's "shadow" content
    // is rendered into the LIGHT DOM and plain document.querySelector reaches it
    // (PocketTube's live selectors rely on exactly this). The old assumption
    // that these anchors hide behind open shadow roots was wrong — what actually
    // broke the buttons was the tag names: the 2026 header/actions row is built
    // from the view-model components (`pageHeaderViewModel` →
    // `yt-flexible-actions-view-model`, `segmentedLikeDislikeButtonViewModel` →
    // `yt-segmented-like-dislike-button-view-model`), while our chains only
    // listed the legacy `ytd-*-renderer` names, which no longer exist.
    //
    // Every chain is therefore modern-first, then the legacy renderer, then a
    // `[class*=…]` attribute probe: YouTube stamps every view-model element with
    // a `.yt-<name>-view-model` class, so a substring match survives a rename of
    // the tag. Resolve with selectors.findVisible — the first match that has a
    // box (the DOM keeps hidden templates of both clusters).
    channelHeader: [
      "#page-header yt-flexible-actions-view-model",
      "yt-flexible-actions-view-model",
      '[class*="flexible-actions-view-model"]',
      "#page-header",
      "#page-header-inner",
      "ytd-page-header"
    ],
    // Stage 9: the subscribe/sponsor cluster on a channel page. The letter
    // buttons sit just to its right (overlay positioned from this rect).
    subscribeButton: [
      "#page-header yt-flexible-actions-view-model",
      "yt-flexible-actions-view-model",
      '[class*="flexible-actions-view-model"]',
      "#subscribe-button",
      "ytd-subscribe-button-renderer",
      '[class*="subscribe-button"]'
    ],
    // Stage 9: the Like/Dislike cluster on a watch page. The letter buttons sit
    // just to its left (overlay positioned from this rect).
    likeDislike: [
      // Precise, tag-independent probes first: the like button's view model
      // carries accessibilityId "id.video.like.button" (confirmed in live
      // ytInitialData 2026-11-10), which YouTube renders as the element id /
      // aria-labelledby target. Immune to component renames.
      '[id="id.video.like.button"]',
      '[aria-labelledby*="video.like.button"]',
      "yt-segmented-like-dislike-button-view-model",
      '[class*="segmented-like-dislike"]',
      "yt-like-button-view-model",
      '[class*="like-button-view-model"]',
      // 2026-11-11 probe: some watch pages render the cluster as plain buttons
      // inside this legacy id, with no view-model tags at all.
      "#top-level-buttons-computed",
      "ytd-segmented-like-dislike-button-renderer",
      "ytd-like-button-renderer",
      "#like-button"
    ],
    // Stage 9: the Like button itself. Browser probes showed the cluster tag and
    // class probes can both miss on some watch layouts, while the accessibility
    // id remains the stable contract from ytInitialData.
    likeButton: [
      '[id="id.video.like.button"]',
      '[aria-labelledby*="video.like.button"]',
      "yt-like-button-view-model",
      '[class*="like-button-view-model"]',
      "ytd-like-button-renderer",
      "#like-button"
    ],
    // Stage 9: the watch actions row. Used only as a last resort, after the
    // like button and the Like/Dislike cluster, because anchoring to the whole
    // row can overlap the control immediately to its left.
    watchActions: [
      "#actions",
      "yt-watch-metadata",
      "ytd-watch-metadata"
    ]
  };

  const missLog = new Set();

  // "Broken" telemetry (PLAN.md §6 stage 6): console + a bounded local journal
  // in chrome.storage.local under yga:log. Local only — nothing ever leaves
  // the browser (§12, privacy). Entries: { t, kind, detail }.
  const LOG_KEY = "yga:log";
  const LOG_MAX = 100;
  const LOG_FLUSH_MS = 1000;

  let logQueue = [];
  let flushTimer = 0;

  // chrome.storage.local.set() is async and a full navigation kills the page
  // before it resolves — that ate every row-click breadcrumb. sessionStorage
  // is synchronous and survives reloads in the same tab, so the breadcrumb
  // written just before the reload is drained by the next document.
  const PENDING_KEY = "yga:pending-log";

  function readPending() {
    try {
      const raw = window.sessionStorage.getItem(PENDING_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writePending(entries) {
    try {
      window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(entries.slice(-LOG_MAX)));
    } catch (e) {
      // sessionStorage unavailable (unit harness, quota).
    }
  }

  function appendPending(entry) {
    const entries = readPending();
    entries.push(entry);
    writePending(entries);
  }

  function clearPending() {
    try {
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }

  async function flushLog() {
    flushTimer = 0;
    if (!logQueue.length) return;
    const entries = logQueue;
    logQueue = [];
    try {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const prev = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      const next = prev.concat(entries).slice(-LOG_MAX);
      await chrome.storage.local.set({ [LOG_KEY]: next });
      clearPending();
    } catch (e) {
      // Storage unavailable (unit harness without chrome, incognito limits).
      console.debug("[yga] journal flush failed:", e);
    }
  }

  function enqueue(kind, detail, persist) {
    const entry = { t: Date.now(), kind: kind, detail: detail };
    logQueue.push(entry);
    if (persist) appendPending(entry);
    if (!flushTimer) {
      flushTimer = setTimeout(flushLog, LOG_FLUSH_MS);
      if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
    }
  }

  function journal(kind, detail) {
    enqueue(kind, detail, true);
  }

  // Restored entries are re-persisted so a second navigation before the
  // chrome.storage flush cannot lose them again.
  function drainPending() {
    const entries = readPending();
    if (!entries.length) return;
    clearPending();
    for (const entry of entries) {
      if (!entry || typeof entry.kind !== "string") continue;
      journal(entry.kind, String(entry.detail == null ? "" : entry.detail));
    }
  }

  // A full navigation unloads the page before the 1s debounce fires, which
  // silently ate the row-click entry right before the reload it was meant to
  // prove. Flush synchronously-enough on pagehide so the breadcrumb survives.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
      flushLog();
    });

    window.addEventListener("yga:journal", (ev) => {
      const text = typeof ev.detail === "string" ? ev.detail : "";
      const sep = text.indexOf("\u0000");
      if (sep < 0) return;
      const kind = text.slice(0, sep);
      if (!kind) return;
      enqueue(kind, text.slice(sep + 1), false);
    });
  }

  // A node with no layout box: display:none, an ancestor with display:none, or
  // detached from the document. Used to skip the hidden duplicates YouTube
  // keeps in the DOM.
  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const box = el.getBoundingClientRect();
    return !!box && (box.width > 0 || box.height > 0);
  }

  // YouTube renders almost everything inside open Shadow roots, so
  // document.querySelector cannot reach the subscribe cluster or the
  // like/dislike row. deepQuerySelectorAll walks every open shadow root and
  // collects matches, so findDeep can locate those native anchors. We only read
  // their bounding rect (to position the letter-button overlay); we never insert
  // into YouTube's tree, which is what caused the whole-page re-render.
  function deepQuerySelectorAll(selector, root) {
    const out = [];
    const seen = new Set();
    const roots = [root || document];
    while (roots.length) {
      const scope = roots.shift();
      let found;
      try {
        found = scope.querySelectorAll(selector);
      } catch (e) {
        found = [];
      }
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      // Descend into every element that hosts an open shadow root.
      const hosts = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
      for (const host of hosts) {
        if (host.shadowRoot && !seen.has(host.shadowRoot)) {
          seen.add(host.shadowRoot);
          roots.push(host.shadowRoot);
        }
      }
    }
    return out;
  }

  yga.selectors = {
    find(name, root) {
      const chain = SELECTORS[name];
      if (!chain) return null;
      const scope = root || document;
      for (const sel of chain) {
        const el = scope.querySelector(sel);
        if (el) return el;
      }
      this.reportMiss(name);
      return null;
    },

    // Same lookup, but a miss is expected (e.g. another extension's element that
    // is only present when that extension is installed) — never journal it.
    findOptional(name, root) {
      const chain = SELECTORS[name];
      if (!chain) return null;
      const scope = root || document;
      for (const sel of chain) {
        const el = scope.querySelector(sel);
        if (el) return el;
      }
      return null;
    },

    // First match that actually has a box. YouTube keeps several copies of the
    // subscribe and like/dislike clusters in the DOM (hidden templates, the
    // collapsed and the expanded header), and a hidden node reports a zero
    // getBoundingClientRect — anchoring the letter-button overlay to one of
    // those put the buttons off screen (§8.8 stage 9). Falls back to the first
    // match when nothing has a box yet, so the caller can still retry.
    findVisible(name, root) {
      const chain = SELECTORS[name];
      if (!chain) return null;
      const scope = root || document;
      let first = null;
      for (const sel of chain) {
        let found;
        try {
          found = scope.querySelectorAll(sel);
        } catch (e) {
          continue;
        }
        for (const el of found) {
          if (!first) first = el;
          if (isVisible(el)) return el;
        }
      }
      return first;
    },

    // Shadow-DOM-piercing lookup: first match across the chain, searching every
    // open shadow root. Used for the native subscribe / like-dislike anchors the
    // letter-button overlay is positioned against. A miss is expected while the
    // page is still rendering, so it never journals.
    findDeep(name, root) {
      const chain = SELECTORS[name];
      if (!chain) return null;
      for (const sel of chain) {
        const list = deepQuerySelectorAll(sel, root);
        if (list.length) return list[0];
      }
      return null;
    },

    // Raw shadow-piercing query by selector string (debug/probe + advanced
    // callers). Returns every match across all open shadow roots.
    queryDeep(selector, root) {
      return deepQuerySelectorAll(selector, root);
    },

    reportMiss(name) {
      if (missLog.has(name)) return;
      missLog.add(name);
      // Local telemetry only (PLAN.md §12, privacy).
      console.debug("[yga] selector miss:", name);
      journal("selector-miss", name);
    },

    // Shared journal for other failure telemetry (mount timeout, bridge loss).
    journal: journal,
    drainPending: drainPending
  };
})(window.yga);

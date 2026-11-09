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
    // Channel page header (§8.8): the «Группа» button lives next to the title.
    channelHeader: [
      "ytd-page-header #title-container-inner",
      "ytd-page-header #text-container",
      "ytd-page-header #top-bar",
      "ytd-page-header"
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

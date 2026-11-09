window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Single source of truth for YouTube DOM anchors (PLAN.md §2.4).
  // Every entry is a fallback chain: first match wins.
  const SELECTORS = {
    app: ["ytd-app"],
    drawer: ["tp-yt-app-drawer", "ytd-guide-entry-renderer"],
    guideRoot: ["#guide-inner-content", "ytd-guide-renderer", "#guide"],
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
    } catch (e) {
      // Storage unavailable (unit harness without chrome, incognito limits).
      console.debug("[yga] journal flush failed:", e);
    }
  }

  function journal(kind, detail) {
    logQueue.push({ t: Date.now(), kind: kind, detail: detail });
    if (!flushTimer) {
      flushTimer = setTimeout(flushLog, LOG_FLUSH_MS);
      if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
    }
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
    journal: journal
  };
})(window.yga);

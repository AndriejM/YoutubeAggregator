window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Single source of truth for YouTube DOM anchors (PLAN.md §2.4).
  // Every entry is a fallback chain: first match wins.
  const SELECTORS = {
    app: ["ytd-app"],
    drawer: ["tp-yt-app-drawer", "ytd-guide-entry-renderer"],
    guideRoot: ["#guide-inner-content", "ytd-guide-renderer #sections"],
    guideSections: ["#guide-inner-content #sections", "ytd-guide-renderer #sections"],
    subscriptionsLink: [
      "#guide-inner-content a#subscriptions-link",
      '#guide-inner-content a[href="/feed/subscriptions"]',
      '#guide-inner-content a[href^="/feed/subscriptions"]',
      '#sections a[href*="/feed/subscriptions"]'
    ]
  };

  const missLog = new Set();

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
    }
  };
})(window.yga);

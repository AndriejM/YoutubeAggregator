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

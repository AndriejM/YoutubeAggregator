window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Subscriptions pipeline: guide data (free, on-page) -> browse fallback via
  // service worker (PLAN.md §6). Result is merged into yga.state cache.
  function normalize(list) {
    const out = [];
    for (const item of list || []) {
      if (item && typeof item.channelId === "string" && item.title) {
        out.push({
          channelId: item.channelId,
          title: item.title,
          avatarUrl: item.avatarUrl || ""
        });
      }
    }
    return out;
  }

  async function fromGuide() {
    try {
      const data = await yga.bridge.call("getGuideSubscriptions", 3000);
      return normalize(data);
    } catch (e) {
      // First call can race the MAIN-world bridge load; retry once.
      await new Promise((r) => setTimeout(r, 1200));
      const data = await yga.bridge.call("getGuideSubscriptions");
      return normalize(data);
    }
  }

  async function fromBrowse() {
    // Page-world sources only: youtubei needs the page's SAPISIDHASH auth,
    // a service-worker fetch is 403 and a logged-out /feed/channels is empty.
    for (const cmd of ["browseSubscriptions", "getSubscriptionsPage"]) {
      try {
        // Continuation pagination can span many POSTs — allow generous time.
        const list = normalize(await yga.bridge.call(cmd, 90000));
        if (list.length) return list;
      } catch (e) {
        console.debug("[yga] " + cmd + " failed:", e);
      }
    }
    return [];
  }

  yga.api = {
    // Refresh the cached catalog; returns the catalog list.
    async refreshSubscriptions() {
      const byId = new Map();
      let guideCount = -1; // -1 = guide path failed
      let browseCount = -1; // -1 = not attempted
      try {
        const guide = await fromGuide();
        guideCount = guide.length;
        for (const s of guide) byId.set(s.channelId, s);
      } catch (e) {
        console.warn("[yga] guide unavailable:", e);
      }
      // The guide embeds only the first subscriptions — the rest hide behind
      // «Show more» — so a guide hit is not proof of a complete catalog and
      // the browse page always merges in (user report 2026-11-11: subscribed
      // channels missing from the catalog, group assignments invisible).
      try {
        const browse = await fromBrowse();
        browseCount = browse.length;
        for (const s of browse) if (!byId.has(s.channelId)) byId.set(s.channelId, s);
      } catch (e) {
        console.warn("[yga] browse fallback failed:", e);
      }
      const list = Array.from(byId.values());
      if (!list.length) {
        console.warn(`[yga] subscriptions empty: guide=${guideCount}, browse=${browseCount}`);
      } else {
        console.info(`[yga] subscriptions: guide=${guideCount}, browse=${browseCount}, merged=${list.length}`);
      }
      await yga.state.loadCache();
      if (!list.length) return yga.state.getVisibleSubs(); // keep cache on total failure
      await yga.state.updateSubs(list);
      return yga.state.getVisibleSubs();
    }
  };
})(window.yga);

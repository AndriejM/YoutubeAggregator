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
        const list = normalize(await yga.bridge.call(cmd, 12000));
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
      let list = [];
      let guideCount = -1; // -1 = guide path failed
      try {
        list = await fromGuide();
        guideCount = list.length;
      } catch (e) {
        console.warn("[yga] guide unavailable:", e);
      }
      let browseCount = -1; // -1 = not attempted
      if (!list.length) {
        try {
          list = await fromBrowse();
          browseCount = list.length;
        } catch (e) {
          console.warn("[yga] browse fallback failed:", e);
        }
      }
      if (!list.length) {
        console.warn(`[yga] subscriptions empty: guide=${guideCount}, browse=${browseCount}`);
      } else {
        console.info(`[yga] subscriptions: guide=${guideCount}, browse=${browseCount}`);
      }
      await yga.state.loadCache();
      if (!list.length) return yga.state.getSubs(); // keep cache on total failure
      await yga.state.updateSubs(list);
      return yga.state.getSubs();
    }
  };
})(window.yga);

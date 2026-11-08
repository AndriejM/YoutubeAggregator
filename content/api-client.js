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
    const data = await yga.bridge.call("getGuideSubscriptions");
    return normalize(data);
  }

  async function fromBrowse() {
    const context = await yga.bridge.call("getContext").catch(() => null);
    const resp = await chrome.runtime.sendMessage({ type: "subs:browse", context: context });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "browse failed");
    return normalize(resp.subs);
  }

  yga.api = {
    // Refresh the cached catalog; returns the catalog list.
    async refreshSubscriptions() {
      let list = [];
      try {
        list = await fromGuide();
      } catch (e) {
        console.debug("[yga] guide unavailable:", e);
      }
      if (!list.length) {
        list = await fromBrowse();
      }
      await yga.state.loadCache();
      if (!list.length) return yga.state.getSubs(); // keep cache on total failure
      await yga.state.updateSubs(list);
      return yga.state.getSubs();
    }
  };
})(window.yga);

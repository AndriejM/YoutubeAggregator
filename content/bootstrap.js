(function (yga) {
  "use strict";

  const MOUNT_TIMEOUT_MS = 15000;

  let observer = null;
  let timeoutId = 0;
  let refreshing = false;

  function observerStop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = 0;
    }
  }

  function ensureMounted() {
    const widget = yga.mountWidget();
    if (widget) {
      observerStop();
      return true;
    }
    return false;
  }

  function startWaiting() {
    const root = yga.selectors.find("app") || document.body;
    observer = new MutationObserver(() => ensureMounted());
    observer.observe(root, { childList: true, subtree: true });
    timeoutId = setTimeout(observerStop, MOUNT_TIMEOUT_MS);
  }

  async function refreshSubscriptions() {
    if (refreshing) return;
    refreshing = true;
    try {
      await yga.api.refreshSubscriptions();
    } catch (e) {
      console.debug("[yga] subscriptions refresh failed:", e);
      yga.widget.render(yga.state.getSubs()); // cache is better than nothing
    } finally {
      refreshing = false;
    }
  }

  function boot() {
    yga.state.onSubsChanged((subs) => yga.widget.render(subs));
    yga.state.loadCache().then((cache) => {
      if (cache && cache.size) yga.widget.render(yga.state.getSubs());
    });

    if (ensureMounted()) {
      refreshSubscriptions();
    } else {
      startWaiting();
    }

    // SPA re-check: guide may be rebuilt after internal navigation.
    window.addEventListener("yt-navigate-finish", () => {
      if (!document.querySelector('[data-yga="widget"]')) {
        if (ensureMounted()) return; // fresh widget already re-rendered from cache
      }
      refreshSubscriptions(); // cheap guide read; only writes storage on change
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.yga);

(function (yga) {
  "use strict";

  const MOUNT_TIMEOUT_MS = 15000;

  function ensureMounted() {
    const widget = yga.mountWidget();
    if (widget) {
      observerStop();
      return true;
    }
    return false;
  }

  let observer = null;
  let timeoutId = 0;

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

  function startWaiting() {
    const root = yga.selectors.find("app") || document.body;
    observer = new MutationObserver(() => ensureMounted());
    observer.observe(root, { childList: true, subtree: true });
    timeoutId = setTimeout(observerStop, MOUNT_TIMEOUT_MS);
  }

  function boot() {
    if (ensureMounted()) return;
    startWaiting();

    // SPA re-check: after internal navigation the guide may be rebuilt.
    window.addEventListener("yt-navigate-finish", () => {
      if (!document.querySelector('[data-yga="widget"]')) ensureMounted();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.yga);

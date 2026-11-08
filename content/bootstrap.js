(function (yga) {
  "use strict";

  const MOUNT_TIMEOUT_MS = 15000;
  const ACCOUNT_RETRY_MS = [2000, 5000, 10000];

  let observer = null;
  let timeoutId = 0;
  let refreshing = false;
  let accountReady = false;

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
      yga.state.getVisibleSubs().then(yga.widget.render); // cache beats nothing
    } finally {
      refreshing = false;
    }
  }

  // Account → accountKey must settle before the catalog matters (PLAN.md §5:
  // the cache key is yga:subs:<accountKey>). Masthead/ytInitialData may not be
  // ready at document_idle, so retry a few times and on SPA navigation.
  async function ensureAccount() {
    if (accountReady || !yga.accounts || !yga.state) return;
    try {
      const acc = await yga.accounts.detect();
      if (acc && acc.accountKey && acc.accountKey !== "default") {
        accountReady = true; // later retries become no-ops
      }
      const rekeyed = await yga.state.setAccountKey(acc && acc.accountKey);
      if (rekeyed) yga.widget.refresh(); // catalog-scoped UI (picker) must reload
    } catch (e) {
      console.debug("[yga] account detection failed:", e);
    }
  }

  function boot() {
    yga.state.onSubsChanged((subs) => yga.widget.render(subs));
    yga.state.loadCache().then((cache) => {
      if (cache && cache.size) yga.state.getVisibleSubs().then(yga.widget.render);
    });

    // Non-blocking: the cached list renders first, the account key may re-key it.
    ensureAccount();
    for (const delay of ACCOUNT_RETRY_MS.slice()) {
      setTimeout(ensureAccount, delay);
    }

    if (ensureMounted()) {
      refreshSubscriptions();
    } else {
      startWaiting();
    }

    // SPA re-check: guide may be rebuilt after internal navigation.
    window.addEventListener("yt-navigate-finish", () => {
      ensureAccount();
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

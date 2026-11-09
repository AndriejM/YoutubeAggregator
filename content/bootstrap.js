(function (yga) {
  "use strict";

  const MOUNT_TIMEOUT_MS = 15000;
  const ACCOUNT_RETRY_MS = [2000, 5000, 10000];
  // The catalog is not navigation-scoped (PLAN.md §6 stage 6). Re-reading it on
  // every yt-navigate-finish made the guide path — empty on current YouTube —
  // fall through to a page-world /feed/channels HTML fetch on every channel
  // click, which is what made the whole sidebar redraw. The worker's scheduled
  // alarm and the TTL below keep it fresh instead.
  const CATALOG_TTL_MS = 5 * 60 * 1000;
  const CATALOG_RETRY_MS = 60 * 1000;

  let observer = null;
  let timeoutId = 0;
  let refreshing = false;
  let accountReady = false;
  let countersInit = false;
  let catalogAt = 0; // last successful catalog read
  let catalogRetryAt = 0; // back off from a source that just failed
  let everMounted = false; // mount-timeout telemetry only makes sense once

  // Counters lifecycle (PLAN.md §10): counters:init pulls the cached counts
  // into the content world, then a non-forced refresh — the worker applies
  // minIntervalMs itself, so repeated page loads are cheap.
  async function ensureCounters() {
    if (!yga.state) return;
    try {
      if (!countersInit) {
        const id = yga.profiles ? await yga.profiles.activeProfileId() : "p_1";
        const res = await chrome.runtime.sendMessage({ type: "counters:init", profileId: id });
        countersInit = !!(res && res.ok);
        if (countersInit) yga.state.applyInitSnapshot(res.counts, res.aggregate, res.aggregateSeq);
      }
      yga.state.refreshCounters();
    } catch (e) {
      console.debug("[yga] counters init failed:", e);
    }
  }

  function ensureMounted(reason) {
    const widget = yga.mountWidget(reason || "unknown");
    if (widget) {
      everMounted = true;
      ensureCounters();
      return true;
    }
    return false;
  }

  // The observer is permanent once started: SPF navigation can replace the
  // guide after yt-navigate-finish has already fired, and the widget must
  // reappear as soon as the new guide is in the DOM.
  function startWaiting() {
    if (observer) return;
    const root = yga.selectors.find("app") || document.body;
    observer = new MutationObserver(() => {
      // Guide (re)built — late first paint or a post-navigation rebuild.
      // Our own insertions also mutate; only a missing widget is a signal.
      if (document.querySelector('[data-yga="widget"]')) return;
      yga.selectors.journal("widget-lost", "observer"); // flicker breadcrumb
      if (ensureMounted("observer")) refreshSubscriptions();
    });
    observer.observe(root, { childList: true, subtree: true });
    timeoutId = setTimeout(() => {
      // Guide never appeared within the timeout — "broken" telemetry (§6 stage 6).
      if (!everMounted && !document.querySelector('[data-yga="widget"]')) {
        yga.selectors.journal("mount-timeout", String(MOUNT_TIMEOUT_MS));
      }
      timeoutId = 0; // the observer stays: guide rebuilds are routine
    }, MOUNT_TIMEOUT_MS);
  }

  // TTL-gated: navigation only re-reads the catalog once it is stale, so a
  // channel click no longer triggers a full catalog fetch (PLAN.md §6 stage 6).
  async function refreshSubscriptions(force) {
    if (refreshing) return;
    const now = Date.now();
    if (!force) {
      if (catalogAt && now - catalogAt < CATALOG_TTL_MS) return;
      if (catalogRetryAt && now < catalogRetryAt) return;
    }
    refreshing = true;
    try {
      await yga.api.refreshSubscriptions();
      catalogAt = Date.now();
    } catch (e) {
      catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
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
      if (rekeyed) {
        yga.widget.refresh(); // catalog-scoped UI (picker) must reload
        ensureCounters(); // the worker's catalog key followed the account
      }
    } catch (e) {
      console.debug("[yga] account detection failed:", e);
    }
  }

  // One line per document: URL + where we came from + how the browser got
  // here. Repeated "boot" journal entries without row-click between them mean
  // the page reloads itself; ref=…/channel/… after a row-click means the click
  // did a full navigation instead of an SPF one.
  function journalDocument() {
    if (yga.selectors.drainPending) yga.selectors.drainPending();
    let navType = "?";
    try {
      const entries = performance.getEntriesByType("navigation");
      if (entries.length) navType = entries[0].type;
    } catch (e) {}
    const ref = (document.referrer || "").replace(/^https?:\/\/[^/]+/, "");
    const path = (window.location && window.location.pathname) || "?";
    yga.selectors.journal("boot-doc", path + " type=" + navType + " ref=" + (ref || "-"));
    if (yga.bridge && typeof yga.bridge.call === "function") {
      yga.bridge.call("getNavApis", 1500).then((apis) => {
        const globals = Array.isArray(apis && apis.navGlobals) ? apis.navGlobals : [];
        const compact = Object.assign({}, apis || {});
        delete compact.navGlobals;
        delete compact.ytKeys;
        delete compact.ytNavKeys;
        delete compact.ytPageManagerKeys;
        delete compact.ytglobalKeys;
        delete compact.ytCommandKeys;
        delete compact.spfKeys;
        yga.selectors.journal("boot-apis", JSON.stringify(compact).slice(0, 240));
        yga.selectors.journal("boot-apis2", JSON.stringify({
          yt: apis && apis.yt,
          ytMethods: apis && apis.ytMethods,
          ytPageManager: apis && apis.ytPageManager,
          ytglobal: apis && apis.ytglobal,
          ytCommand: apis && apis.ytCommand,
          ytSignals: apis && apis.ytSignals,
          navigation: apis && apis.navigation
        }).slice(0, 240));
        const splitKeys = [
          ["boot-ytkeys", String((apis && apis.ytKeys) || "")],
          ["boot-ytnavkeys", String((apis && apis.ytNavKeys) || "")],
          ["boot-ytpmkeys", String((apis && apis.ytPageManagerKeys) || "")],
          ["boot-ytglobal", String((apis && apis.ytglobalKeys) || "")],
          ["boot-ytcommand", String((apis && apis.ytCommandKeys) || "")],
          ["boot-spfkeys", String((apis && apis.spfKeys) || "")]
        ];
        for (const [kind, value] of splitKeys) {
          const keys = value.split(",").filter(Boolean);
          for (let i = 0; i < keys.length; i += 18) {
            yga.selectors.journal(kind, i + ":" + keys.slice(i, i + 18).join(",").slice(0, 240));
          }
        }
        for (let i = 0; i < globals.length; i += 12) {
          yga.selectors.journal("boot-globals", i + ":" + globals.slice(i, i + 12).join("|").slice(0, 240));
        }
      }).catch((e) => {
        yga.selectors.journal("boot-apis", "err " + String(e && e.message || e).slice(0, 80));
      });
    }
  }

  function boot() {
    journalDocument();
    yga.state.onSubsChanged((subs) => yga.widget.render(subs));
    yga.state.loadCache().then((cache) => {
      if (cache && cache.size) yga.state.getVisibleSubs().then(yga.widget.render);
    });

    // Non-blocking: the cached list renders first, the account key may re-key it.
    ensureAccount();
    for (const delay of ACCOUNT_RETRY_MS.slice()) {
      setTimeout(ensureAccount, delay);
    }

    if (ensureMounted("boot")) {
      refreshSubscriptions(true); // first mount: the catalog must be current
    } else {
      startWaiting();
    }

    // SPA re-check: the guide may be rebuilt after internal navigation —
    // sometimes only after this event, so the observer keeps watching.
    window.addEventListener("yt-navigate-finish", () => {
      ensureAccount();
      if (!document.querySelector('[data-yga="widget"]')) {
        yga.selectors.journal("widget-lost", "navigate-finish"); // flicker breadcrumb
        if (!ensureMounted("navigate-finish")) startWaiting(); // guide not back yet — wait for it
        else return; // fresh widget already re-rendered from cache
      }
      ensureCounters(); // cheap freshness gate; only stale channels are fetched
      refreshSubscriptions(); // TTL-gated: a channel click must not refetch
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.yga);

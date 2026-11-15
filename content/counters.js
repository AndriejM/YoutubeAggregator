window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Counter bar (PLAN.md §10), pinned above the channel list: total new videos
  // of the ACTIVE profile, one refresh button, and the stale/error honesty
  // states. Row counters live in .yga-count (widget.js); this module owns .yga-total.
  let unsubCounter = null;
  let unsubComp = null;
  const RERENDER_MS = 200; // coalesce bus windows into one repaint
  let rerenderTimer = 0;

  // Membership signature of a rendered list: ids plus their group. A count-only
  // patch (§10.7) cannot remove a row, so a channel that left the profile —
  // excluded by the user in the panel — needs a real re-render.
  function membershipSig(list) {
    if (!list) return "";
    return list.map((s) => s.channelId + ":" + (s.groupId || "")).sort().join("|");
  }

  // Per-profile view of the worker's shared cache (PLAN.md §10.4): how many
  // unwatched entries were published after this profile's lastVisitAt.
  // `at` is the newest-first timestamp array the worker ships per channel.
  function newSince(at, lastVisitAt) {
    if (!Array.isArray(at) || !at.length) return 0;
    if (!lastVisitAt) return at.length;
    let n = 0;
    for (const t of at) if (t > lastVisitAt) n++;
    return n;
  }

  function formatTotal(agg) {
    if (!agg) return "";
    // Zero total hides the chip like a zero row counter (PLAN.md §9); errors
    // stay visible even with nothing new, so the `?` state is never silent.
    if (!agg.newCount && !agg.errorCount) return "";
    let text = String(agg.newCount);
    if (agg.newCount >= 100) text = "99+";
    else if (agg.newCount >= 15) text = text + "+";
    if (agg.errorCount) text += " (?×" + agg.errorCount + ")";
    return text;
  }

  function totalTitle(agg) {
    if (!agg) return yga.i18n("refreshCounters");
    let text = yga.i18n("totalNew") + ": " + agg.newCount;
    if (agg.errorCount) text += " · " + yga.i18n("countersFailed") + ": " + agg.errorCount;
    if (agg.stale) text += " · " + yga.i18n("countersStale");
    return text;
  }

  // «Все новые» (PLAN.md backlog 1): one header button that opens every new
  // video of the active profile as a YouTube auto-playlist. The worker owns the
  // video cache (the content world only sees timestamps), so the id list is
  // fetched on click; the total chip stays the source of the enabled state.
  const WATCH_ALL_LIMIT_DEFAULT = 50;
  const PLAY_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  let watchAllLimit = WATCH_ALL_LIMIT_DEFAULT;
  let unsubWatchAllSettings = null;

  function applyWatchAllSettings(s) {
    const n = Number(((s || {}).widget || {}).watchAllLimit);
    watchAllLimit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : WATCH_ALL_LIMIT_DEFAULT;
  }

  // The cap is known before the click (settings + chip), so the tooltip can
  // promise «shown 50 of 187» without asking the worker first.
  function watchAllTitle(agg) {
    const total = agg ? agg.newCount : 0;
    if (watchAllLimit && total > watchAllLimit) {
      return yga.i18n("watchAllTruncated")
        .replace("{shown}", String(watchAllLimit))
        .replace("{total}", String(total));
    }
    return yga.i18n("watchAllNew").replace("{count}", String(total));
  }

  function updateWatchAll(widget, agg) {
    const header = widget && widget.querySelector(".yga-header");
    const btn = header && header.querySelector(".yga-watch-all");
    if (!btn) return;
    const on = !!(agg && agg.newCount);
    btn.classList.toggle("yga-hidden", !on);
    btn.disabled = !on;
    const text = watchAllTitle(on ? agg : null);
    btn.title = text;
    btn.setAttribute("aria-label", text);
  }

  async function openWatchAll(widget) {
    const profileId = yga.profiles && yga.profiles.lastActiveId();
    const header = widget && widget.querySelector(".yga-header");
    const btn = header && header.querySelector(".yga-watch-all");
    if (!profileId || !btn || btn.disabled) return;
    btn.disabled = true;
    try {
      let channelIds;
      let visits;
      try {
        const list = await yga.state.getVisibleSubs();
        const seen = new Set();
        channelIds = [];
        visits = {};
        for (const s of list || []) {
          if (!s || !s.channelId || seen.has(s.channelId)) continue;
          seen.add(s.channelId);
          channelIds.push(s.channelId);
          visits[s.channelId] = s.lastVisitAt || 0;
        }
      } catch (e) {
        console.debug("[yga] watchAll visible scope failed:", e);
      }
      await yga.state.watchAll(profileId, channelIds, visits);
    } finally {
      if (widget.isConnected) btn.disabled = false;
    }
  }

  function localAggregate() {
    const list = yga.widget && yga.widget.lastRendered && yga.widget.lastRendered();
    if (!list) return null;
    const agg = yga.state.getAggregate();
    let sum = 0;
    let errorCount = 0;
    for (const s of list) {
      if (s.counterError) errorCount++;
      sum += s.newCount || 0;
    }
    return {
      profileId: agg && agg.profileId,
      newCount: sum,
      errorCount: errorCount,
      stale: !!(agg && agg.stale)
    };
  }

  function updateTotal(widget, local) {
    const header = widget && widget.querySelector(".yga-header");
    if (!header) return;
    const total = header.querySelector(".yga-total");
    if (!total) return;
    let agg = local ? localAggregate() : yga.state.getAggregate();
    if ((!agg || !agg.newCount) && yga.state.countersReady()) {
      // Fallback: sum the visible rows (lastVisitAt view, like PocketTube's
      // badge) so the chip never contradicts the list next to it.
      agg = localAggregate() || agg;
    }
    const text = agg ? formatTotal(agg) : "";
    total.textContent = text;
    total.title = totalTitle(agg);
    total.classList.toggle("yga-hidden", !text);
    total.classList.toggle("yga-stale", !!(agg && agg.stale));
    updateWatchAll(widget, agg);
  }

  async function resetAll(widget) {
    const profileId = yga.profiles && yga.profiles.lastActiveId();
    const list = yga.widget && yga.widget.lastRendered && yga.widget.lastRendered();
    if (!profileId || !list || !list.length) return;
    const ids = list.map((s) => s.channelId).filter(Boolean);
    if (!ids.length) return;
    const visitAt = await yga.state.markVisitedBatch(profileId, ids);
    if (!visitAt) return;
    for (const s of list) {
      s.lastVisitAt = visitAt;
      s.newCount = 0;
    }
    if (yga.widget.applyCounts) yga.widget.applyCounts(list);
    updateTotal(widget, true);
  }

  yga.counters = {
    newSince: newSince,
    updateTotal(widget) {
      updateTotal(widget);
    },
    paintLocalTotal(widget) {
      updateTotal(widget, true);
    },

    // Stage 8: the total chip and the refresh button live in the widget header
    // (to the right of the title), not in a separate toolbar row. The refresh
    // button is icon-only — the header is tight on space. Backlog 1 added the
    // «Все новые» play button between the chip and the refresh.
    ensureToolbar(widget) {
      const header = widget.querySelector(".yga-header");
      if (!header) return;
      const gear = header.querySelector(".yga-config-btn");
      const before = gear || null;
      if (!header.querySelector(".yga-total")) {
        const total = document.createElement("span");
        total.className = "yga-total";
        total.addEventListener("contextmenu", (ev) => {
          if (ev.ctrlKey) return;
          ev.preventDefault();
          resetAll(widget);
        });
        header.insertBefore(total, before);
      }
      if (!header.querySelector(".yga-watch-all")) {
        const play = document.createElement("button");
        play.className = "yga-watch-all yga-hidden";
        play.type = "button";
        play.innerHTML = PLAY_SVG; // static markup, no YouTube data (PLAN.md §12)
        play.addEventListener("click", () => openWatchAll(widget));
        header.insertBefore(play, before);
      }
      if (!header.querySelector(".yga-refresh")) {
        const btn = document.createElement("button");
        btn.className = "yga-refresh";
        btn.type = "button";
        btn.setAttribute("aria-label", yga.i18n("refreshCounters"));
        btn.title = yga.i18n("refreshCounters");
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
          '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        btn.addEventListener("click", () => yga.counters.refresh(widget));
        header.insertBefore(btn, before);
      }
      updateTotal(widget);
    },

    async refresh(widget) {
      const header = widget && widget.querySelector(".yga-header");
      const btn = header && header.querySelector(".yga-refresh");
      if (!btn) return;
      btn.classList.add("yga-busy");
      btn.disabled = true;
      const total = header.querySelector(".yga-total");
      if (total) {
        total.textContent = "…";
        total.classList.remove("yga-hidden");
      }
      // The worker pushes per-channel counts as its queue drains, so rows and
      // the chip repaint during the refresh; the spinner only says the queue
      // is still running, it is not a paint deadline.
      try {
        await yga.state.refreshCounters({ force: true });
      } finally {
        if (!widget.isConnected) return;
        btn.classList.remove("yga-busy");
        btn.disabled = false;
        updateTotal(widget);
      }
    },

    // Wire once per mounted widget; unsubscribe on remount (one live listener).
    wire(widget) {
      yga.counters.ensureToolbar(widget);
      if (unsubCounter) unsubCounter();
      if (unsubComp) unsubComp();
      // The id cap of «Все новые» is a widget setting: the tooltip must follow
      // a panel edit without a reload, like every other setting (stage 4).
      if (unsubWatchAllSettings) unsubWatchAllSettings();
      if (yga.profiles) {
        unsubWatchAllSettings = yga.profiles.onSettingsChanged((s) => {
          applyWatchAllSettings(s);
          updateTotal(widget);
        });
        yga.profiles.getSettings().then((s) => {
          applyWatchAllSettings(s);
          if (widget.isConnected) updateTotal(widget);
        }).catch(() => {});
      }
      if (rerenderTimer) {
        clearTimeout(rerenderTimer);
        rerenderTimer = 0;
      }
      const paint = () => {
        if (!widget.isConnected) return;
        yga.state.getVisibleSubs().then((list) => {
          if (!widget.isConnected) return;
          const sig = membershipSig(list);
          if (sig !== membershipSig(yga.widget.lastRendered && yga.widget.lastRendered())) {
            yga.widget.render(list);
          } else {
            if (yga.widget.applyCounts) yga.widget.applyCounts(list);
          }
          updateTotal(widget);
        });
      };
      // Leading edge paints the first change of a bus window immediately, the
      // trailing edge catches the rest of it — counters track the RSS reads
      // instead of waiting for the whole refresh.
      const rerender = () => {
        if (!widget.isConnected) return;
        paint();
        if (rerenderTimer) return;
        rerenderTimer = setTimeout(() => {
          rerenderTimer = 0;
          paint();
        }, RERENDER_MS);
      };
      unsubCounter = yga.state.onCountersChanged(rerender);
      unsubComp = yga.state.onCompositionChanged(rerender);
    }
  };
})(window.yga);

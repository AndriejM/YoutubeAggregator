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
    // button is icon-only — the header is tight on space.
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
      if (rerenderTimer) {
        clearTimeout(rerenderTimer);
        rerenderTimer = 0;
      }
      const paint = () => {
        if (!widget.isConnected) return;
        yga.state.getVisibleSubs().then((list) => {
          if (widget.isConnected) yga.widget.applyCounts(list);
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

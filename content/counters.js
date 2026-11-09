window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Counter bar (PLAN.md §10), pinned above the channel list: total new videos
  // of the ACTIVE profile, one refresh button, and the stale/error honesty
  // states. Row counters live in .yga-count (widget.js); this module owns .yga-total.
  let unsubCounter = null;
  let unsubComp = null;

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

  function updateTotal(widget) {
    const toolbar = widget && widget.querySelector(".yga-toolbar");
    if (!toolbar) return;
    const total = toolbar.querySelector(".yga-total");
    if (!total) return;
    let agg = yga.state.getAggregate();
    if ((!agg || !agg.newCount) && yga.state.countersReady()) {
      // Fallback: sum the visible rows (lastVisitAt view, like PocketTube's
      // badge) so the chip never contradicts the list next to it.
      const list = yga.widget.lastRendered && yga.widget.lastRendered();
      if (list) {
        let sum = 0;
        let errorCount = 0;
        for (const s of list) {
          if (s.counterError) errorCount++;
          sum += s.newCount;
        }
        agg = { profileId: agg && agg.profileId, newCount: sum, errorCount: errorCount, stale: !!(agg && agg.stale) };
      }
    }
    const text = agg ? formatTotal(agg) : "";
    total.textContent = text;
    total.title = totalTitle(agg);
    total.classList.toggle("yga-hidden", !text);
    total.classList.toggle("yga-stale", !!(agg && agg.stale));
  }

  yga.counters = {
    newSince: newSince,

    ensureToolbar(widget) {
      let toolbar = widget.querySelector(".yga-toolbar");
      if (!toolbar) {
        toolbar = document.createElement("div");
        toolbar.className = "yga-toolbar";
        const list = widget.querySelector(".yga-list");
        if (list) widget.insertBefore(toolbar, list);
        else widget.appendChild(toolbar);
      }
      if (!toolbar.querySelector(".yga-total")) {
        const total = document.createElement("span");
        total.className = "yga-total";
        toolbar.appendChild(total);
      }
      if (!toolbar.querySelector(".yga-refresh")) {
        const btn = document.createElement("button");
        btn.className = "yga-refresh";
        btn.type = "button";
        btn.setAttribute("aria-label", yga.i18n("refreshCounters"));
        btn.title = yga.i18n("refreshCounters");
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
          '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        btn.appendChild(document.createTextNode(yga.i18n("refresh")));
        btn.addEventListener("click", () => yga.counters.refresh(widget));
        toolbar.appendChild(btn);
      }
      updateTotal(widget);
    },

    async refresh(widget) {
      const toolbar = widget && widget.querySelector(".yga-toolbar");
      const btn = toolbar && toolbar.querySelector(".yga-refresh");
      if (!btn) return;
      btn.classList.add("yga-busy");
      btn.disabled = true;
      const total = toolbar.querySelector(".yga-total");
      if (total) {
        total.textContent = "…";
        total.classList.remove("yga-hidden");
      }
      await yga.state.refreshCounters({ force: true });
      // Worker messages arrive asynchronously; drop the spinner when the
      // queue has been accepted (results keep flowing in via the bus).
      setTimeout(() => {
        if (!widget.isConnected) return;
        btn.classList.remove("yga-busy");
        btn.disabled = false;
        updateTotal(widget);
      }, 1200);
    },

    // Wire once per mounted widget; unsubscribe on remount (one live listener).
    wire(widget) {
      yga.counters.ensureToolbar(widget);
      if (unsubCounter) unsubCounter();
      if (unsubComp) unsubComp();
      const rerender = () => {
        if (!widget.isConnected) return;
        yga.state.getVisibleSubs().then((list) => {
          if (widget.isConnected) yga.widget.applyCounts(list);
          updateTotal(widget);
        });
      };
      unsubCounter = yga.state.onCountersChanged(rerender);
      unsubComp = yga.state.onCompositionChanged(rerender);
    }
  };
})(window.yga);

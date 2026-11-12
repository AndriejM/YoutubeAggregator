window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Stage 8: a cog, not a sun — the old circle-with-rays read as brightness.
  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M19.3 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.6 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.6-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.6 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.6 1z" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const ARROW_UP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const ARROW_DOWN_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M12 5v14M5 12l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Debug breadcrumb: "tp-yt-app-drawer#guide > div#guide-inner-content > …"
  function nodePath(node) {
    const parts = [];
    for (let n = node; n && parts.length < 4; n = n.parentElement) {
      const cls = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      parts.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + cls);
    }
    return parts.join(" > ");
  }

  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    return node;
  }

  function profileOptions(select, activeId) {
    lastActiveId = activeId || yga.profiles.BUILTIN_ID;
    select.textContent = "";
    for (const p of yga.profiles.list()) {
      const opt = el("option", null, { value: p.id });
      opt.textContent = p.name;
      select.appendChild(opt);
    }
    // Stage 8: no «+ New profile» entry — profile CRUD lives in the panel.
    select.value = activeId || yga.profiles.BUILTIN_ID;
  }

  let profileUnsub = null; // one live listener across SPA remounts
  let lastActiveId = null; // active profile of the mounted widget (empty states)

  // --- widget-scoped settings (stage 4, PLAN.md §9) ---
  // The config panel writes yga:settings; the widget follows through
  // profiles.onSettingsChanged, so every edit lands without a reload.
  let settings = null;
  let unsubSettings = null;
  let mountedPosition = null; // widget.position applied at the last mount
  let mountedSlot = null; // widget.guideIndex applied at the last mount
  let mountedIndex = null; // live index of the widget inside its guide host
  let themeObserver = null;

  function widgetCfg() {
    return (settings && settings.widget) || {};
  }

  function positionOf(s) {
    return ((s && s.widget) || {}).position || "afterSubscriptions";
  }

  // widget.guideIndex (PLAN.md §8.3): an explicit slot among the guide's
  // sections, written by the ▲/▼ buttons in the widget footer. null means
  // "derive the slot from widget.position" (the stage-0 behaviour).
  function guideIndexOf(s) {
    const raw = ((s && s.widget) || {}).guideIndex;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;
  }

  function widgetIndex(widget, host) {
    const kids = (host && host.children) || [];
    for (let i = 0; i < kids.length; i++) if (kids[i] === widget) return i;
    return -1;
  }

  // Rehang the widget at `index` among the host's children. The widget is
  // detached first, so `index` counts the list without it.
  function placeAt(widget, index, host) {
    const parent = host || widget.parentNode;
    if (!parent) return -1;
    widget.remove();
    const kids = parent.children;
    const at = Math.max(0, Math.min(index, kids.length));
    parent.insertBefore(widget, kids[at] || null);
    return at;
  }

  // ▲/▼ live at the widget edges: the first slot cannot go up, the last not down.
  function updateMoveButtons(widget) {
    const up = widget.querySelector(".yga-move-up");
    const down = widget.querySelector(".yga-move-down");
    if (!up || !down) return;
    const host = widget.parentNode;
    const live = widgetIndex(widget, host);
    mountedIndex = live;
    const movable = live >= 0 && host.children.length > 1;
    up.disabled = !movable || live <= 0;
    down.disabled = !movable || live >= host.children.length - 1;
    up.classList.toggle("yga-off", up.disabled);
    down.classList.toggle("yga-off", down.disabled);
  }

  // One step up/down in the guide, persisted so the slot survives the SPA
  // remounts YouTube forces on guide rebuilds (PLAN.md §8.3).
  async function moveWidget(widget, delta) {
    if (!yga.profiles) return;
    const host = widget.parentNode;
    const live = widgetIndex(widget, host);
    if (live < 0) return;
    const target = Math.max(0, Math.min(live + delta, host.children.length - 1));
    if (target === live) return;
    mountedIndex = placeAt(widget, target, host);
    mountedSlot = mountedIndex;
    updateMoveButtons(widget);
    await yga.profiles.saveSettingsPath("widget.guideIndex", mountedIndex);
  }

  // Follow a slot edit made elsewhere (the config panel, another tab). Our own
  // ▲/▼ click already moved the node, so this is usually a no-op.
  function applyGuideIndex(widget) {
    const want = guideIndexOf(settings);
    if (want === null) return;
    const host = widget.parentNode;
    if (!host) return;
    if (widgetIndex(widget, host) !== want) mountedIndex = placeAt(widget, want, host);
    mountedSlot = want;
    updateMoveButtons(widget);
  }

  function applyWidgetSettings(widget) {
    const cfg = widgetCfg();
    widget.style.setProperty("--yga-width", (Number(cfg.widthPx) || 300) + "px");
    widget.classList.toggle("yga-compact", !!cfg.compact);
    widget.classList.toggle("yga-no-counts", cfg.showCounts === false);
  }

  // Accent + theme-follow for both surfaces (widget and config panel).
  function applyTheme() {
    const t = (settings && settings.theme) || {};
    const accent = /^#[0-9a-f]{6}$/i.test(t.accent || "") ? t.accent : "#c00";
    const forceLight = t.followYouTube === false;
    const nodes = document.querySelectorAll(".yga-widget, .yga-panel");
    for (const node of nodes) {
      node.style.setProperty("--yga-accent", accent);
      if (forceLight) {
        node.classList.add("yga-force-light");
        if (yga.theme && yga.theme.clear) yga.theme.clear(node);
      } else {
        node.classList.remove("yga-force-light");
        if (yga.theme && yga.theme.apply) yga.theme.apply(node);
      }
    }
  }

  function wireTheme() {
    if (themeObserver || typeof MutationObserver !== "function") return;
    themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["dark", "class", "style"]
    });
  }

  // One settings edit, applied as cheaply as possible: width/compact/counts are
  // CSS-only, zero-count visibility is a counter repaint, position is a remount.
  function onSettings(next) {
    const previous = settings;
    settings = next;
    const widget = document.querySelector('[data-yga="widget"]');
    if (!widget) return;
    // Named position and an explicit slot are mount decisions; dropping back
    // to a derived slot can only be done by mounting again.
    if (positionOf(next) !== mountedPosition ||
        (guideIndexOf(next) === null && mountedSlot !== null)) {
      repositionWidget(widget, "settings-position");
    }
    const before = (previous && previous.widget) || {};
    const after = next.widget || {};
    applyWidgetSettings(widget);
    applyTheme();
    if (before.showZeroCount !== after.showZeroCount) yga.widget.applyCounts(lastList);
    // Tree shape settings: empty-group visibility is a redraw, not a CSS
    // repaint (§18.3). Profile sort changes arrive as a profile event, which
    // already re-renders the tree (§18.6).
    if (before.hideEmptyGroups !== after.hideEmptyGroups) yga.widget.render(lastList);
    // A slot move is a DOM rehang, not a remount: the list keeps its DOM.
    if (guideIndexOf(previous) !== guideIndexOf(next)) applyGuideIndex(widget);
  }

  function wireSettings() {
    if (!yga.profiles) return;
    if (unsubSettings) unsubSettings();
    unsubSettings = yga.profiles.onSettingsChanged(onSettings);
    // The mount above used defaults; adopt the stored settings once loaded and
    // remount only if the recorded position differs from the one we used.
    yga.profiles.getSettings().then((stored) => {
      if (settings) return; // a change event already primed the mirror
      settings = stored;
      const widget = document.querySelector('[data-yga="widget"]');
      if (!widget) return;
      if (positionOf(stored) !== mountedPosition || guideIndexOf(stored) !== mountedSlot) {
        repositionWidget(widget, "settings-stored");
      }
      applyWidgetSettings(widget);
      applyTheme();
    });
  }

  function wireProfiles(widget) {
    const select = widget.querySelector(".yga-profile-select");
    if (!yga.profiles) return;
    if (profileUnsub) profileUnsub();

    let activeId = null;
    yga.profiles.load().then(() =>
      yga.profiles.activeProfileId().then((id) => {
        activeId = id;
        select.disabled = false;
        select.removeAttribute("aria-label-placeholder");
        select.setAttribute("aria-label", yga.i18n("profilesLabel"));
        profileOptions(select, activeId);
      })
    );

    // Stage 8: the widget only switches profiles. Creating, renaming and
    // deleting them — and editing their membership — is the configuration
    // panel's job (§9.2): the widget is for viewing.
    select.addEventListener("change", async () => {
      activeId = select.value;
      await yga.profiles.setActiveProfile(activeId);
      await yga.state.refreshVisible(); // instant, no YouTube request
    });

    yga.profiles.onProfilesChanged(() => {
      profileOptions(select, activeId);
    });
  }

  function buildWidget() {
    const widget = el("div", "yga-widget", { "data-yga": "widget" });

    // Stage 8: the header carries the title and the view controls. counters.js
    // inserts the total chip and the icon-only refresh button before the gear,
    // so the order is title → total → refresh → gear → ▲ → ▼. The profile
    // combobox never fit this tight row — it gets its own line below.
    const header = el("div", "yga-header");

    const title = el("div", "yga-widget-title");
    title.textContent = yga.i18n("widgetTitle");

    const select = el("select", "yga-profile-select", {
      disabled: true,
      "aria-label": yga.i18n("profilesPlaceholder")
    });
    const placeholder = el("option", null, { value: "" });
    placeholder.textContent = yga.i18n("profilesPlaceholder");
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    const gear = el("button", "yga-config-btn", {
      type: "button",
      "aria-label": yga.i18n("configButton"),
      title: yga.i18n("configButton")
    });
    gear.innerHTML = GEAR_SVG; // static markup, no YouTube data (PLAN.md §12)
    // Stage 4: the gear opens the inline configuration panel in #content (§8.7).
    gear.addEventListener("click", () => {
      if (yga.panel) yga.panel.toggle();
    });

    // Guide slot controls (PLAN.md §8.3) — ▲/▼ rehang the widget inside the
    // guide. Stage 8 moved them from the footer into the header.
    const up = el("button", "yga-move yga-move-up", {
      type: "button",
      "aria-label": yga.i18n("moveUp"),
      title: yga.i18n("moveUp")
    });
    up.innerHTML = ARROW_UP_SVG; // static markup, no YouTube data (PLAN.md §12)
    const down = el("button", "yga-move yga-move-down", {
      type: "button",
      "aria-label": yga.i18n("moveDown"),
      title: yga.i18n("moveDown")
    });
    down.innerHTML = ARROW_DOWN_SVG;
    up.addEventListener("click", () => moveWidget(widget, -1));
    down.addEventListener("click", () => moveWidget(widget, 1));

    header.appendChild(title);
    header.appendChild(gear);
    header.appendChild(up);
    header.appendChild(down);

    // The profile combobox lives on its own line under the header: the header
    // row is too narrow to also fit a select, and the line carries nothing but
    // the combobox — no buttons.
    const profileRow = el("div", "yga-profile-row");
    profileRow.appendChild(select);

    const list = el("div", "yga-list", { "aria-live": "polite" });

    widget.appendChild(header);
    widget.appendChild(profileRow);
    widget.appendChild(list);
    return widget;
  }

  // --- subscription rows (stage 1) ---

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      observer.unobserve(img);
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
    }
  }, { rootMargin: "200px" });

  // --- counter chip (stage 3, PLAN.md §10) ---

  function countText(sub) {
    if (sub.counterError) return "?";
    if (sub.newCount >= 15) return "15+";
    return String(sub.newCount);
  }

  function countTitle(sub) {
    if (sub.counterError) return yga.i18n("counterError");
    if (sub.counterStale) return yga.i18n("counterStale");
    return yga.i18n("newVideos").replace("{count}", String(sub.newCount));
  }

  function paintCount(row, sub) {
    const count = row.querySelector(".yga-count");
    if (!count) return;
    // showZeroCount (§9): a zero chip is hidden by default, shown when asked.
    const zero = !sub.counterError && sub.newCount === 0 && !widgetCfg().showZeroCount;
    count.textContent = zero ? "" : countText(sub);
    count.title = countTitle(sub);
    count.setAttribute("aria-label", countTitle(sub));
    count.classList.toggle("yga-hidden", zero);
    count.classList.toggle("yga-err", !!sub.counterError);
    count.classList.toggle("yga-stale", !!sub.counterStale);
  }

  let navLock = false;

  function navigateSpa(href) {
    if (navLock) return;
    navLock = true;
    const from = window.location.href;
    let spaStarted = false;
    let spaLogged = false;
    const clearLock = () => { navLock = false; };
    const markSpa = () => {
      if (!spaLogged) {
        spaLogged = true;
        yga.selectors.journal("row-nav", "spa " + href);
      }
      spaStarted = true;
    };
    window.addEventListener("yt-navigate-start", markSpa, { once: true });
    window.addEventListener("yt-navigate-finish", () => {
      markSpa();
      clearLock();
    }, { once: true });

    function fallback(reason) {
      if (spaStarted || window.location.href !== from) {
        clearLock();
        return;
      }
      yga.selectors.journal("row-nav", reason + " " + href);
      clearLock();
      window.location.href = href;
    }

    if (!yga.bridge || typeof yga.bridge.call !== "function") {
      fallback("no-bridge");
      return;
    }

    yga.selectors.journal("row-nav", "bridge " + href);
    setTimeout(clearLock, 10000);
    yga.bridge.call("navigate", href, 9000).then((res) => {
      if (spaStarted || window.location.href !== from) {
        clearLock();
        return;
      }
      const api = res && res.api ? res.api : "unknown";
      if (res && res.ok) {
        yga.selectors.journal("row-nav", "bridge-ok " + api + " " + href);
        return;
      }
      const err = res && res.error ? res.error : (res && res.errors ? res.errors : "none");
      fallback("bridge-" + api + ":" + String(err).slice(0, 80));
    }).catch((e) => {
      fallback("bridge-err:" + String(e && e.message || e).slice(0, 80));
    });
  }

  function rowNode(sub) {
    // spf-link is mandatory, not cosmetic: YouTube's spf.js click handler is
    //   if (metaKey||altKey||ctrlKey||shiftKey||button>0) return null;
    //   var b = closest(target, ".spf-link");
    //   return !b || closest(target, ".spf-nolink") ? null : closestAnchor(target, b).href;
    // — no .spf-link ancestor means SPF declines the click and the browser does
    // a real page load, which is the "clicking a channel reloads YouTube" bug.
    // yt-simple-endpoint is YouTube's own endpoint class (cursor/hover/a11y).
    const row = el("a", "yga-row spf-link yt-simple-endpoint", {
      href: "/channel/" + sub.channelId + "/videos",
      title: sub.title,
      "data-yga-row": sub.channelId
    });

    const avatar = el("img", "yga-avatar", { alt: "" });
    if (sub.avatarUrl) {
      avatar.dataset.src = sub.avatarUrl;
      observer.observe(avatar);
    } else {
      avatar.classList.add("yga-avatar-empty");
    }

    const title = el("span", "yga-title");
    title.textContent = sub.title;

    const count = el("span", "yga-count", { "aria-live": "polite" });

    row.appendChild(avatar);
    row.appendChild(title);
    row.appendChild(count);
    paintCount(row, sub);

    // Click in the widget resets the counter, then navigates to /videos
    // (PLAN.md §10.5 — the decision fixed 2026-11-07).
    row.addEventListener("click", (ev) => {
      // Flicker breadcrumb: if a boot-doc follows this with the same URL,
      // the click did a full navigation (SPF declined it).
      const href = row.getAttribute("href");
      yga.selectors.journal("row-click", href);
      const profileId = yga.profiles && yga.profiles.lastActiveId();
      if (profileId) yga.state.markVisited(profileId, sub.channelId);
      // spf-link/yt-simple-endpoint classes proved NOT enough (journal:
      // type=navigate right after row-click) — YouTube's interception skips
      // foreign anchors. Try the page's own SPA entry points; if none works,
      // fall back to the plain link so a click always navigates.
      if (ev.defaultPrevented || ev.button > 0 ||
          ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (href === window.location.pathname) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      navigateSpa(href);
    });

    // No config panel yet (stage 4): right-click is the interim "mark as
    // watched" entry; Ctrl+click keeps the native context menu reachable.
    row.addEventListener("contextmenu", (ev) => {
      if (ev.ctrlKey) return;
      ev.preventDefault();
      const profileId = yga.profiles && yga.profiles.lastActiveId();
      if (!profileId) {
        console.warn("[yga] contextmenu: no active profile id");
        return;
      }
      yga.state.markVisited(profileId, sub.channelId).then((visitAt) => {
        if (!visitAt) {
          console.warn("[yga] markVisited failed for", sub.channelId, profileId);
          return;
        }
        // lastVisitAt = now ⇒ nothing cached can be newer; paint the reset
        // immediately, the counter bus confirms it a moment later. The group
        // chip is the sum of its rows (§18.4), so it follows in the same tick.
        sub.lastVisitAt = visitAt;
        sub.newCount = 0;
        paintCount(row, sub);
        paintGroupChips();
        if (yga.counters && yga.counters.paintLocalTotal) {
          yga.counters.paintLocalTotal(document.querySelector('[data-yga="widget"]'));
        }
      });
    });

    return row;
  }

  function placeholderRow(textKey) {
    const row = el("div", "yga-placeholder");
    row.textContent = yga.i18n(textKey);
    return row;
  }

  // "No subscriptions" vs "profile is empty" (§9.2.1 empty states).
  function emptyKey() {
    const p = activeProfile();
    return p && !p.includeAllSubs ? "emptyProfile" : "emptyState";
  }

  function activeProfile() {
    return (lastActiveId && yga.profiles && yga.profiles.get(lastActiveId)) || null;
  }

  // --- group tree (stage 5, PLAN.md §18) ---
  // The widget is a tree, not a flat list: one row per group (toggle + summed
  // counter) and its channels indented below. Collapsed groups keep their
  // channels out of the DOM, so their avatars are never fetched (§9).

  const UNGROUPED = ""; // pseudo-group key (§18.2)
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  let groupChips = new Map(); // groupId|"" -> { chip, members } live chips
  let ungroupedCollapsed = false; // §18.2: the pseudo-group has no storage
  let ungroupedFor = null; // profile the in-memory collapse belongs to
  let unsubGroups = null; // one live groups listener across SPA remounts

  function byTitle(a, b) {
    return collator.compare(a.title || "", b.title || "");
  }

  // Order inside a group (§18.6): the *profile* sort decides it — the tree is
  // the primary UI, so profile.sort governs the order within groups. "activity"
  // (§18.3 default) is counter desc, then locale-aware name.
  function sortWithin(list, catalogOrder) {
    const p = activeProfile();
    const mode = (p && p.sort) || "activity";
    const copy = list.slice();
    if (mode === "alpha") return copy.sort(byTitle);
    if (mode === "subs" || mode === "manual") {
      return copy.sort((a, b) =>
        (catalogOrder.get(a.channelId) || 0) - (catalogOrder.get(b.channelId) || 0) || byTitle(a, b)
      );
    }
    return copy.sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || byTitle(a, b));
  }

  function paintGroupChip(entry) {
    let sum = 0;
    let errorCount = 0;
    for (const s of entry.members) {
      if (s.counterError) errorCount++;
      sum += s.newCount || 0;
    }
    // §18.4: the group chip is the plain sum — the 15+ ceiling is a per-channel
    // RSS limit, not a group one. A zero group stays blank unless asked for.
    let text = "";
    if (sum) text = sum >= 100 ? "99+" : String(sum);
    else if (widgetCfg().showZeroCount) text = "0";
    if (errorCount) text += (text ? " " : "") + "(?×" + errorCount + ")";
    entry.chip.textContent = text;
    entry.chip.classList.toggle("yga-hidden", !text);
    const title = yga.i18n("groupTotal").replace("{count}", String(sum));
    entry.chip.title = title;
    entry.chip.setAttribute("aria-label", title);
  }

  function paintGroupChips() {
    for (const entry of groupChips.values()) paintGroupChip(entry);
  }

  // data-yga-group value of a group (the pseudo-group renders as "none").
  function dataKeyOf(g) {
    return (g.id || UNGROUPED) || "none";
  }

  // Identity of a group's contents: same ids in the same order means the
  // subtree can be reused instead of rebuilt (no flicker on re-render).
  function memberSig(members) {
    let sig = "";
    for (const m of members) sig += (sig ? "," : "") + m.channelId;
    return sig;
  }

  // The tree we want, in render order (§18.2/§18.3): declared groups by
  // storage order, then «Без группы» last and only when it has channels.
  function planGroups(list) {
    // The pseudo-group collapse is per-profile in memory only (§18.2).
    const pid = (yga.profiles && yga.profiles.lastActiveId()) || null;
    if (ungroupedFor !== pid) {
      ungroupedFor = pid;
      ungroupedCollapsed = false;
    }
    const groups = yga.groups ? yga.groups.list() : [];
    const known = new Set(groups.map((g) => g.id));
    const catalogOrder = new Map();
    list.forEach((s, i) => catalogOrder.set(s.channelId, i));

    const buckets = new Map();
    for (const sub of list) {
      // A groupId pointing at a deleted group is «Без группы», not lost data.
      const key = sub.groupId && known.has(sub.groupId) ? sub.groupId : UNGROUPED;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(sub);
    }

    const hideEmpty = !!widgetCfg().hideEmptyGroups;
    const plan = [];
    for (const g of groups) {
      const members = buckets.get(g.id) || [];
      if (!members.length && hideEmpty) continue;
      plan.push({ g: g, members: members, catalogOrder: catalogOrder });
    }
    const rest = buckets.get(UNGROUPED) || [];
    if (rest.length) {
      plan.push({
        g: { id: UNGROUPED, name: yga.i18n("groupNone"), pseudo: true },
        members: rest,
        catalogOrder: catalogOrder
      });
    }
    return plan;
  }

  async function toggleGroup(g) {
    if (g.pseudo) {
      ungroupedCollapsed = !ungroupedCollapsed;
      yga.widget.render(lastList);
      return;
    }
    if (!yga.groups) return;
    await yga.groups.setCollapsed(g.id, !g.collapsed); // emits → the tree redraws
  }

  function groupNode(g, members, catalogOrder) {
    const key = g.id || UNGROUPED;
    const collapsed = g.pseudo ? ungroupedCollapsed : !!g.collapsed;
    const boxId = "yga-gc-" + key.replace(/[^A-Za-z0-9_-]/g, "");
    const wrap = el("div", "yga-group-wrap", { "data-yga-group": key || "none" });

    const btn = el("button", "yga-group", {
      type: "button",
      "aria-expanded": collapsed ? "false" : "true",
      "aria-controls": boxId,
      title: g.name
    });
    const caret = el("span", "yga-group-caret");
    caret.innerHTML = CHEVRON_SVG; // static markup, no YouTube data (PLAN.md §12)
    if (collapsed) caret.classList.add("yga-collapsed");
    const name = el("span", "yga-group-name");
    name.textContent = g.name;
    name.title = g.name;
    const chip = el("span", "yga-count yga-group-count", { "aria-live": "polite" });

    btn.appendChild(caret);
    btn.appendChild(name);
    btn.appendChild(chip);
    btn.addEventListener("click", () => toggleGroup(g));
    btn.addEventListener("contextmenu", (ev) => {
      if (ev.ctrlKey) return;
      ev.preventDefault();
      const profileId = yga.profiles && yga.profiles.lastActiveId();
      const live = groupChips.get(key) || { members: members };
      const ids = live.members.map((s) => s.channelId).filter(Boolean);
      if (!profileId || !ids.length) return;
      yga.state.markVisitedBatch(profileId, ids).then((visitAt) => {
        if (!visitAt) return;
        for (const s of live.members) {
          s.lastVisitAt = visitAt;
          s.newCount = 0;
        }
        if (yga.widget.applyCounts) yga.widget.applyCounts(lastList);
        else paintGroupChips();
        if (yga.counters && yga.counters.paintLocalTotal) {
          yga.counters.paintLocalTotal(document.querySelector('[data-yga="widget"]'));
        }
      });
    });
    wrap.appendChild(btn);

    if (!collapsed) {
      const box = el("div", "yga-group-channels", { id: boxId });
      for (const sub of sortWithin(members, catalogOrder)) box.appendChild(rowNode(sub));
      wrap.appendChild(box);
    }

    const entry = { chip: chip, members: members };
    groupChips.set(key, entry);
    paintGroupChip(entry);
    // Reconciliation markers (renderGroups): a wrap with the same collapse
    // state and the same members is reused as-is instead of being rebuilt.
    wrap._ygaCollapsed = collapsed;
    wrap._ygaSig = memberSig(members);
    return wrap;
  }

  function renderGroups(list) {
    groupChips = new Map();
    const host = document.querySelector('[data-yga="widget"] .yga-list');
    if (!host) return;

    const plan = planGroups(list);
    const live = new Map();
    for (const node of Array.from(host.children)) {
      const key = node.getAttribute && node.getAttribute("data-yga-group");
      if (key) live.set(key, node);
    }

    let reused = 0;
    const wanted = [];
    for (const item of plan) {
      const key = dataKeyOf(item.g);
      const collapsed = item.g.pseudo ? ungroupedCollapsed : !!item.g.collapsed;
      const sig = memberSig(item.members);
      const existing = live.get(key);
      // Unchanged group: keep the node, so its rows, avatars and the scroll
      // position survive. Only the label can need a repaint (rename).
      if (existing && existing._ygaCollapsed === collapsed && existing._ygaSig === sig) {
        reused++;
        live.delete(key);
        const name = existing.querySelector(".yga-group-name");
        if (name && name.textContent !== item.g.name) {
          name.textContent = item.g.name;
          name.title = item.g.name;
        }
        const btn = existing.querySelector(".yga-group");
        if (btn) btn.title = item.g.name;
        groupChips.set(item.g.id || UNGROUPED, {
          chip: existing.querySelector(".yga-group-count"),
          members: item.members
        });
        wanted.push(existing);
        continue;
      }
      wanted.push(groupNode(item.g, item.members, item.catalogOrder));
    }

    for (const node of live.values()) node.remove();
    // Reorder only when the sequence actually drifted.
    for (let i = 0; i < wanted.length; i++) {
      if (host.children[i] !== wanted[i]) host.insertBefore(wanted[i], host.children[i] || null);
    }
    // Flicker breadcrumb: rebuilt>0 means whole groups were thrown away.
    if (wanted.length - reused > 0) {
      yga.selectors.journal("render", "rebuilt=" + (wanted.length - reused) + " reused=" + reused);
    }
  }

  // Stage 8: the channel membership picker (§9.2.1, stage 2) moved to the
  // configuration panel — the widget is for viewing, not for editing.
  let lastList = null;

  // Counter-only repaint (stage 3): patch .yga-count in place, no rebuild
  // of rows, avatars or the picker (PLAN.md §10.7). Group chips are the sum
  // of their rows (§18.4), so they are repainted in the same pass.
  function applyCounts(list) {
    if (!list) return;
    const widget = document.querySelector('[data-yga="widget"]');
    if (!widget) return;
    const byId = new Map();
    for (const sub of list) byId.set(sub.channelId, sub);
    const rows = widget.querySelectorAll(".yga-list [data-yga-row]");
    for (const row of rows) {
      const sub = byId.get(row.getAttribute("data-yga-row"));
      if (sub) paintCount(row, sub);
    }
    paintGroupChips();
  }

  yga.widget = {
    // Last list handed to render() (shared objects, decorated in place).
    lastRendered() {
      return lastList;
    },

    // Re-tint after the config panel is built (panel.js, PLAN.md §8.7).
    applyTheme: applyTheme,

    render(list) {
      lastList = list;
      const widget = document.querySelector('[data-yga="widget"]');
      if (!widget) return;
      const host = widget.querySelector(".yga-list");

      if (!list || !list.length) {
        host.textContent = "";
        groupChips = new Map();
        host.appendChild(placeholderRow(list ? emptyKey() : "loadingSubs"));
        if (yga.counters) yga.counters.ensureToolbar(widget);
        return;
      }
      // Keyed reconciliation (PLAN.md §18.3): a group whose collapse state and
      // members are unchanged keeps its DOM, so re-rendering after a catalog
      // refresh or a profile switch no longer rebuilds the whole sidebar.
      renderGroups(list);
      // Reused rows carry their previous chips — repaint them, exactly as the
      // freshly built ones are painted in rowNode (§10.4).
      applyCounts(list);
      if (yga.counters) yga.counters.ensureToolbar(widget);
    },

    applyCounts: applyCounts,

    // Repaint after an account re-key: the list must show the new catalog.
    refresh() {
      yga.state.getVisibleSubs().then((list) => yga.widget.render(list));
    }
  };

  // The element the widget actually becomes a child of — the slot index in
  // widget.guideIndex is relative to this (§8.3). Never inside the guide
  // renderer's own subtree: ytd-guide-renderer re-renders #sections when a
  // foreign child is inserted there, which removed our widget and made the
  // whole sidebar flicker on every navigation (the loop our remount observer
  // then fed). The drawer's inner-content wrapper is plain DOM — safe.
  function widgetHost() {
    return (
      yga.selectors.find("guideRoot") ||
      yga.selectors.find("guideSections")
    );
  }

  // The Polymer-managed part of the guide the widget must stay outside of:
  // a child of the host we insert beside. Null when the host itself is the
  // managed subtree — then there is nowhere safer to go and we mount in it.
  function guideManaged(host) {
    const m = yga.selectors.find("guideRenderer") || yga.selectors.find("guideSections");
    return m && m !== host ? m : null;
  }

  // Mount point chosen by widget.guideIndex, else by widget.position
  // (PLAN.md §8.3, panel section «Виджет»): a sibling of the guide renderer.
  function insertWidget(widget, position, host) {
    const slot = guideIndexOf(settings);
    if (slot !== null) {
      mountedIndex = placeAt(widget, slot, host);
      return;
    }
    const managed = guideManaged(host);
    if (position === "top") {
      host.insertBefore(widget, managed || host.children[0] || null);
      mountedIndex = widgetIndex(widget, host);
      return;
    }
    // insertBefore (not insertAdjacentElement) so a rehang from a later slot
    // lands directly after the managed subtree instead of staying put.
    if (managed) host.insertBefore(widget, managed.nextSibling || null);
    else host.appendChild(widget);
    mountedIndex = widgetIndex(widget, host);
  }

  // A mount-decision change (named position or explicit slot) is a rehang of
  // the live node, not a rebuild: the list, picker and listeners survive.
  function repositionWidget(widget, reason) {
    const host = widget.parentNode;
    if (!host) return;
    widget.remove();
    insertWidget(widget, positionOf(settings), host);
    mountedPosition = positionOf(settings);
    mountedSlot = guideIndexOf(settings);
    updateMoveButtons(widget);
    yga.selectors.journal("reposition", reason + " @ " + nodePath(host));
  }

  // Idempotent mount (PLAN.md §8.2, §8.3): reuses a live node, rehangs a detached one.
  yga.mountWidget = function mountWidget(reason) {
    const existing = document.querySelector('[data-yga="widget"]');
    if (existing && existing.isConnected) return existing;
    if (existing) existing.remove();

    const host = widgetHost();
    if (!host) return null;

    const widget = buildWidget();
    mountedPosition = positionOf(settings);
    mountedSlot = guideIndexOf(settings);
    insertWidget(widget, mountedPosition, host);
    // Flicker breadcrumb (PLAN.md §6 stage 6): every mount is a visible
    // sidebar change — the journal shows who remounts and where.
    yga.selectors.journal("mount", (reason || "?") + " @ " + nodePath(widget.parentNode));
    applyWidgetSettings(widget);
    updateMoveButtons(widget);

    if (yga.groups) {
      ungroupedCollapsed = false; // a rebuilt widget starts fully expanded
      if (unsubGroups) unsubGroups();
      // Group CRUD/renames redraw the tree through the shared state emit (§18.3).
      unsubGroups = yga.groups.onGroupsChanged(() => yga.state.refreshVisible());
    }
    if (yga.state) {
      // The tree needs the group mirror before its first paint, otherwise every
      // channel would flash through «Без группы».
      const ready = yga.groups ? yga.groups.load() : Promise.resolve();
      Promise.all([ready, yga.state.getVisibleSubs()]).then((parts) => yga.widget.render(parts[1]));
    }
    if (yga.profiles) {
      ungroupedCollapsed = false; // a rebuilt widget starts fully expanded
      wireProfiles(widget);
    }
    if (yga.counters) yga.counters.wire(widget);
    wireSettings();
    wireTheme();
    applyTheme();
    return widget;
  };
})(window.yga);

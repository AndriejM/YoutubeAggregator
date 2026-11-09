window.yga = window.yga || {};

(function (yga) {
  "use strict";

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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
    const add = el("option", null, { value: "__add__" });
    add.textContent = yga.i18n("newProfile");
    select.appendChild(add);
    select.value = activeId || yga.profiles.BUILTIN_ID;
  }

  function setButtonsEnabled(buttons, id) {
    const profile = id && yga.profiles.get(id);
    const enabled = !!(profile && !profile.builtin);
    for (const button of buttons) {
      button.disabled = !enabled;
      button.classList.toggle("yga-off", !enabled);
    }
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
    const rename = widget.querySelector(".yga-profile-rename");
    const del = widget.querySelector(".yga-profile-del");
    const editable = [rename, del];
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
        setButtonsEnabled(editable, activeId);
      })
    );

    select.addEventListener("change", async () => {
      if (select.value === "__add__") {
        const name = window.prompt(yga.i18n("newProfilePrompt"));
        const created = name ? await yga.profiles.create(name) : null;
        resetPicker(widget);
        if (created) {
          activeId = created.id;
          await yga.profiles.setActiveProfile(created.id);
          await yga.state.refreshVisible();
          profileOptions(select, activeId);
          setButtonsEnabled(editable, activeId);
          await togglePicker(widget); // a new curated profile starts by picking channels
          return;
        }
        profileOptions(select, activeId);
        setButtonsEnabled(editable, activeId);
        await yga.state.refreshVisible();
        return;
      }
      activeId = select.value;
      resetPicker(widget); // membership editor belongs to one profile only
      await yga.profiles.setActiveProfile(activeId);
      setButtonsEnabled(editable, activeId);
      await yga.state.refreshVisible(); // instant, no YouTube request
    });

    rename.addEventListener("click", async () => {
      const profile = yga.profiles.get(activeId);
      if (!profile || profile.builtin) return;
      const name = window.prompt(yga.i18n("renameProfilePrompt"), profile.name);
      if (await yga.profiles.rename(activeId, name)) {
        profileOptions(select, activeId);
      } else {
        select.value = activeId;
      }
    });

    del.addEventListener("click", async () => {
      if (await yga.profiles.remove(activeId)) {
        resetPicker(widget);
        activeId = await yga.profiles.activeProfileId();
        profileOptions(select, activeId);
        setButtonsEnabled(editable, activeId);
        await yga.state.refreshVisible();
      } else {
        select.value = activeId;
      }
    });

    yga.profiles.onProfilesChanged(() => {
      profileOptions(select, activeId);
      setButtonsEnabled(editable, activeId);
    });
  }

  function buildWidget() {
    const widget = el("div", "yga-widget", { "data-yga": "widget" });

    const header = el("div", "yga-header");

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

    const rename = el("button", "yga-profile-rename", {
      type: "button",
      "aria-label": yga.i18n("renameProfile"),
      title: yga.i18n("renameProfile"),
      disabled: true
    });
    rename.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
      '<path d="M4 20h4L20 8l-4-4L4 16v4z" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linejoin="round"/></svg>';

    const del = el("button", "yga-profile-del", {
      type: "button",
      "aria-label": yga.i18n("deleteProfile"),
      title: yga.i18n("deleteProfile"),
      disabled: true
    });
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
      '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    header.appendChild(select);
    header.appendChild(rename);
    header.appendChild(del);
    header.appendChild(gear);

    const list = el("div", "yga-list", { "aria-live": "polite" });

    // Guide slot controls (PLAN.md §8.3) — the PocketTube way of moving the
    // widget up/down the sidebar without opening the configuration panel.
    const footer = el("div", "yga-footer");
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
    footer.appendChild(up);
    footer.appendChild(down);

    widget.appendChild(header);
    widget.appendChild(list);
    widget.appendChild(footer);

    const title = el("div", "yga-widget-title");
    title.textContent = yga.i18n("widgetTitle");
    widget.insertBefore(title, header);
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

  // Curated profile = user picks channels; builtin p_1 mirrors all subscriptions.
  function curated() {
    const p = activeProfile();
    return !!(p && !p.includeAllSubs);
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

  // --- channel membership picker for curated profiles (§9.2.1, stage 2) ---

  const PICKER_LIMIT = 200; // 995 subs must not freeze the guide drawer
  const SEARCH_DEBOUNCE_MS = 150;
  let pickerOpen = false;
  let pickerFilter = "";
  let pickerTimer = 0;
  let pickerData = null; // {subs, comp} while the picker is open
  let lastList = null;

  function sortRows(list) {
    return list.slice().sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" })
    );
  }

  async function loadPickerData() {
    const p = activeProfile();
    const [subs, comp] = await Promise.all([
      yga.state.getAllSubs(),
      p ? yga.profiles.getComposition(p.id) : {}
    ]);
    pickerData = { subs: subs, comp: comp, profileId: p ? p.id : null };
    return pickerData;
  }

  function pickerRow(sub, profileId, isMember) {
    const row = el("label", "yga-picker-row");
    const box = el("input", "yga-picker-check", { type: "checkbox" });
    box.checked = isMember;
    box.addEventListener("change", async () => {
      box.disabled = true;
      if (box.checked) await yga.profiles.addChannel(profileId, sub.channelId);
      else await yga.profiles.removeChannel(profileId, sub.channelId);
      if (pickerData) pickerData.comp = await yga.profiles.getComposition(profileId);
      box.disabled = false;
      await yga.state.refreshVisible(); // the widget list follows immediately
    });

    const title = el("span", "yga-title");
    title.textContent = sub.title;
    title.title = sub.title;

    row.appendChild(box);
    row.appendChild(title);
    return row;
  }

  function fillPicker(picker) {
    const host = picker.querySelector(".yga-picker-rows");
    if (!host || !pickerData) return;
    host.textContent = "";
    const needle = pickerFilter.trim().toLowerCase();
    const all = pickerData.subs;
    const matched = needle
      ? all.filter((s) => (s.title || "").toLowerCase().indexOf(needle) >= 0)
      : all;
    const shown = sortRows(matched).slice(0, PICKER_LIMIT);

    const frag = document.createDocumentFragment();
    for (const sub of shown) {
      const rec = pickerData.comp[sub.channelId];
      frag.appendChild(pickerRow(sub, pickerData.profileId, !!rec && !rec.unsubscribed && !rec.excluded));
    }
    host.appendChild(frag);

    if (matched.length > shown.length) {
      const hint = el("div", "yga-placeholder");
      hint.textContent = yga.i18n("pickerMore").replace("{count}", String(matched.length));
      host.appendChild(hint);
    } else if (!shown.length) {
      const hint = el("div", "yga-placeholder");
      hint.textContent = yga.i18n("pickerEmpty");
      host.appendChild(hint);
    }
  }

  function buildPicker(widget) {
    const picker = el("div", "yga-picker");
    const search = el("input", "yga-picker-search", {
      type: "search",
      "aria-label": yga.i18n("pickerSearch")
    });
    search.placeholder = yga.i18n("pickerSearch");
    search.value = pickerFilter;
    search.addEventListener("input", () => {
      pickerFilter = search.value;
      if (pickerTimer) clearTimeout(pickerTimer);
      pickerTimer = setTimeout(() => fillPicker(picker), SEARCH_DEBOUNCE_MS);
    });
    picker.appendChild(search);
    picker.appendChild(el("div", "yga-picker-rows", { "aria-live": "polite" }));
    const list = widget.querySelector(".yga-list");
    const toolbar = widget.querySelector(".yga-toolbar");
    widget.insertBefore(picker, toolbar || list);
    return picker;
  }

  function resetPicker(widget) {
    pickerOpen = false;
    pickerData = null;
    pickerFilter = "";
    // Called on every profile switch: group collapse is per-profile state, and
    // the pseudo-group has no storage at all (§18.2), so it must not leak.
    ungroupedCollapsed = false;
    const picker = widget && widget.querySelector(".yga-picker");
    if (picker) picker.remove();
  }

  async function togglePicker(widget) {
    if (pickerOpen) {
      resetPicker(widget);
      renderToolbar(widget);
      return;
    }
    pickerOpen = true;
    pickerData = null;
    const picker = buildPicker(widget);
    const rows = picker.querySelector(".yga-picker-rows");
    rows.appendChild(placeholderRow("loadingSubs"));
    await loadPickerData();
    if (widget.contains(picker)) fillPicker(picker);
    renderToolbar(widget);
    const search = picker.querySelector(".yga-picker-search");
    if (search) search.focus();
  }

  function renderToolbar(widget) {
    if (yga.counters) yga.counters.ensureToolbar(widget); // total + refresh survive (stage 3)
    const toolbar = widget.querySelector(".yga-toolbar");
    if (!toolbar) return;
    const existing = toolbar.querySelector(".yga-picker-toggle");
    if (existing) existing.remove();
    if (!curated()) return;
    const btn = el("button", "yga-picker-toggle", { type: "button" });
    btn.textContent = yga.i18n(pickerOpen ? "pickerClose" : "addChannels");
    btn.addEventListener("click", () => togglePicker(widget));
    toolbar.appendChild(btn);
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
        renderToolbar(widget);
        return;
      }
      // Keyed reconciliation (PLAN.md §18.3): a group whose collapse state and
      // members are unchanged keeps its DOM, so re-rendering after a catalog
      // refresh or a profile switch no longer rebuilds the whole sidebar.
      renderGroups(list);
      // Reused rows carry their previous chips — repaint them, exactly as the
      // freshly built ones are painted in rowNode (§10.4).
      this.applyCounts(list);
      renderToolbar(widget);
      const picker = widget.querySelector(".yga-picker");
      if (picker) fillPicker(picker);
    },

    // Counter-only repaint (stage 3): patch .yga-count in place, no rebuild
    // of rows, avatars or the picker (PLAN.md §10.7). Group chips are the sum
    // of their rows (§18.4), so they are repainted in the same pass.
    applyCounts(list) {
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
    },

    // Repaint after an account re-key: the picker must see the new catalog.
    refresh() {
      const widget = document.querySelector('[data-yga="widget"]');
      const wasOpen = !!(widget && widget.querySelector(".yga-picker"));
      pickerData = null;
      yga.state.getVisibleSubs().then(async (list) => {
        yga.widget.render(list);
        if (!wasOpen) return;
        await loadPickerData();
        const picker = document.querySelector('[data-yga="widget"] .yga-picker');
        if (picker) fillPicker(picker);
      });
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
      resetPicker(widget); // a rebuilt widget never inherits an open picker
      wireProfiles(widget);
    }
    if (yga.counters) yga.counters.wire(widget);
    wireSettings();
    wireTheme();
    applyTheme();
    return widget;
  };
})(window.yga);

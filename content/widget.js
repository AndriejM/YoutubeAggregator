window.yga = window.yga || {};

(function (yga) {
  "use strict";

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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

    widget.appendChild(header);
    widget.appendChild(list);

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
    const zero = !sub.counterError && sub.newCount === 0;
    count.textContent = zero ? "" : countText(sub);
    count.title = countTitle(sub);
    count.setAttribute("aria-label", countTitle(sub));
    count.classList.toggle("yga-hidden", zero);
    count.classList.toggle("yga-err", !!sub.counterError);
    count.classList.toggle("yga-stale", !!sub.counterStale);
  }

  function rowNode(sub) {
    const row = el("a", "yga-row", {
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
    row.addEventListener("click", () => {
      const profileId = yga.profiles && yga.profiles.lastActiveId();
      if (profileId) yga.state.markVisited(profileId, sub.channelId);
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
        // immediately, the counter bus confirms it a moment later.
        sub.lastVisitAt = visitAt;
        sub.newCount = 0;
        paintCount(row, sub);
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

    render(list) {
      lastList = list;
      const widget = document.querySelector('[data-yga="widget"]');
      if (!widget) return;
      const host = widget.querySelector(".yga-list");
      host.textContent = "";

      if (!list) {
        host.appendChild(placeholderRow("loadingSubs"));
        renderToolbar(widget);
        return;
      }
      if (!list.length) {
        host.appendChild(placeholderRow(emptyKey()));
        renderToolbar(widget);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const sub of sortRows(list)) frag.appendChild(rowNode(sub));
      host.appendChild(frag);
      renderToolbar(widget);
      const picker = widget.querySelector(".yga-picker");
      if (picker) fillPicker(picker);
    },

    // Counter-only repaint (stage 3): patch .yga-count in place, no rebuild
    // of rows, avatars or the picker (PLAN.md §10.7).
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

  // Idempotent mount (PLAN.md §8.2, §8.3): reuses a live node, rehangs a detached one.
  yga.mountWidget = function mountWidget() {
    const existing = document.querySelector('[data-yga="widget"]');
    if (existing && existing.isConnected) return existing;
    if (existing) existing.remove();

    const sections =
      yga.selectors.find("guideSections") || yga.selectors.find("guideRoot");
    if (!sections) return null;

    const widget = buildWidget();
    const link = yga.selectors.find("subscriptionsLink");
    if (link) {
      const host = link.closest("yt-section") || link.parentNode;
      host.insertAdjacentElement("afterend", widget);
    } else {
      sections.appendChild(widget);
    }

    if (yga.state) yga.state.getVisibleSubs().then((list) => yga.widget.render(list));
    if (yga.profiles) {
      resetPicker(widget); // a rebuilt widget never inherits an open picker
      wireProfiles(widget);
    }
    if (yga.counters) yga.counters.wire(widget);
    return widget;
  };
})(window.yga);

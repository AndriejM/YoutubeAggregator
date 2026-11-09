window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Section builders of the configuration panel (PLAN.md §9.2, stage 4).
  // Every edit lands in chrome.storage immediately — there is no Save button
  // (§15) — and the widget follows through the shared profiles.js/state.js
  // listeners, so no page reload is needed (stage 4 acceptance criterion).
  const u = yga.panel.util;
  const el = u.el;

  const ORDER = ["profiles", "groups", "channels", "counters", "widget", "theme", "data"];
  const TITLES = {
    profiles: "sectionProfiles",
    groups: "sectionGroups",
    channels: "sectionChannels",
    counters: "sectionCounters",
    widget: "sectionWidget",
    theme: "sectionTheme",
    data: "sectionData"
  };

  const BUILDERS = {};

  const ROW_LIMIT = 300; // 995-channel catalogs must not freeze the panel
  const SEARCH_DEBOUNCE_MS = 150; // §9.2.1
  const GROUPS_KEY = "yga:groups";
  const ACCOUNT_KEY = "yga:account";

  function isMember(rec) {
    return !!rec && !rec.unsubscribed && !rec.excluded;
  }

  function countMembers(comp) {
    let n = 0;
    for (const id in comp) if (isMember(comp[id])) n++;
    return n;
  }

  // Same per-profile view the widget rows use (PLAN.md §10.4).
  function newCountFor(countsRec, lastVisitAt) {
    if (!countsRec) return 0;
    if (Array.isArray(countsRec.at)) return yga.counters.newSince(countsRec.at, lastVisitAt);
    return countsRec.newCount || 0;
  }

  function chipText(n) {
    if (!n) return "";
    return n >= 15 ? "15+" : String(n);
  }

  function hint(key, count) {
    const node = u.placeholder(key);
    node.textContent = node.textContent.replace("{count}", String(count));
    return node;
  }

  function lazyAvatars(host) {
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
    }, { root: host, rootMargin: "200px" });
    u.onCleanup(() => observer.disconnect());
    return observer;
  }

  // ---- Профили (§9.2): CRUD + подпись аккаунта (отложено с этапа 2) ----

  BUILDERS.profiles = async function profiles(host) {
    const settings = await yga.profiles.getSettings();
    const stored = await chrome.storage.local.get(ACCOUNT_KEY);
    const acc = stored[ACCOUNT_KEY] || {};

    const caption = el("div", "yga-panel-account");
    if (acc.avatarUrl) {
      caption.appendChild(el("img", "yga-panel-avatar", { alt: "", src: acc.avatarUrl }));
    }
    const who = el("div", "yga-panel-account-text");
    const whoName = el("div", "yga-panel-title");
    whoName.textContent = acc.title || yga.i18n("accountUnknown");
    const whoKey = el("div", "yga-panel-meta");
    whoKey.textContent = yga.i18n("accountLabel") + ": " + (acc.accountKey || "default");
    who.appendChild(whoName);
    who.appendChild(whoKey);
    caption.appendChild(who);
    host.appendChild(caption);

    const list = el("div", "yga-panel-rows");
    host.appendChild(list);

    for (const p of yga.profiles.list()) {
      const comp = await yga.profiles.getComposition(p.id);
      const row = el("div", "yga-panel-row");

      const radio = el("input", "yga-panel-check", {
        type: "radio",
        name: "yga-active-profile",
        "aria-label": yga.i18n("profileActive")
      });
      radio.checked = p.id === settings.activeProfileId;
      radio.addEventListener("change", async () => {
        await yga.profiles.setActiveProfile(p.id);
        await yga.state.refreshVisible(); // instant, no YouTube request (§11)
        yga.panel.refresh("profiles");
        yga.panel.refresh("channels");
      });

      const label = el("span", "yga-panel-title");
      label.textContent = p.name;
      label.title = p.name;

      const count = el("span", "yga-panel-meta");
      count.textContent = String(countMembers(comp));

      row.appendChild(radio);
      row.appendChild(label);
      row.appendChild(count);

      if (!p.builtin) {
        const rename = u.button("renameProfile", "yga-panel-icon");
        rename.addEventListener("click", async () => {
          const next = window.prompt(yga.i18n("renameProfilePrompt"), p.name);
          if (await yga.profiles.rename(p.id, next)) yga.panel.refresh("profiles");
        });
        const del = u.button("deleteProfile", "yga-panel-icon yga-panel-danger");
        del.addEventListener("click", async () => {
          if (!(await yga.profiles.remove(p.id))) return;
          await yga.state.refreshVisible();
          yga.panel.refresh("profiles");
          yga.panel.refresh("channels");
        });
        row.appendChild(rename);
        row.appendChild(del);
      }
      list.appendChild(row);
    }

    const add = u.button("newProfile", "yga-panel-primary");
    add.addEventListener("click", async () => {
      const name = window.prompt(yga.i18n("newProfilePrompt"));
      const created = name ? await yga.profiles.create(name) : null;
      if (created) {
        await yga.profiles.setActiveProfile(created.id);
        await yga.state.refreshVisible();
      }
      yga.panel.refresh("profiles");
      yga.panel.refresh("channels");
    });
    host.appendChild(add);
  };

  // ---- Группы (§9.2.2): модель yga:groups и CRUD — этап 5 (§18) ----

  BUILDERS.groups = async function groups(host) {
    const stored = await chrome.storage.local.get(GROUPS_KEY);
    const groups = stored[GROUPS_KEY];
    if (!Array.isArray(groups) || !groups.length) {
      host.appendChild(u.placeholder("groupsSoon"));
      return;
    }
    const list = el("div", "yga-panel-rows");
    for (const g of groups) {
      const row = el("div", "yga-panel-row");
      const title = el("span", "yga-panel-title");
      title.textContent = g.name;
      row.appendChild(title);
      list.appendChild(row);
    }
    host.appendChild(list);
  };

  // ---- Список каналов (§9.2.1) ----

  let channelsState = null; // survives section rebuilds, reset on profile switch

  function channelsStateFor(profileId) {
    if (!channelsState || channelsState.profileId !== profileId) {
      channelsState = {
        profileId: profileId,
        filter: "",
        sort: "title",
        showAll: false,
        selected: new Set(),
        timer: 0
      };
    }
    return channelsState;
  }

  BUILDERS.channels = async function channels(host) {
    const profileId = await yga.profiles.activeProfileId();
    const profile = yga.profiles.get(profileId);
    const st = channelsStateFor(profileId);
    const observer = lazyAvatars(host);
    let lastRows = [];

    const rows = el("div", "yga-panel-rows yga-panel-scroll");

    function selectedIds() {
      return Array.from(st.selected);
    }

    const bulkAdd = u.button("channelsAdd", "yga-panel-icon");
    const bulkRemove = u.button("channelsRemove", "yga-panel-icon yga-panel-danger");
    const bulkWatched = u.button("channelsMarkWatched", "yga-panel-icon");
    const selectedLabel = el("span", "yga-panel-meta");

    function updateBulk() {
      const n = st.selected.size;
      for (const btn of [bulkAdd, bulkRemove, bulkWatched]) btn.disabled = !n;
      selectedLabel.textContent = yga
        .i18n("channelsSelected")
        .replace("{count}", String(n));
    }

    async function fill() {
      const [catalog, comp] = await Promise.all([
        yga.state.getAllSubs(),
        yga.profiles.getComposition(profileId)
      ]);
      if (!host.isConnected) return;

      const needle = st.filter.trim().toLowerCase();
      let list = catalog.filter((sub) => st.showAll || isMember(comp[sub.channelId]));
      if (needle) list = list.filter((sub) => (sub.title || "").toLowerCase().indexOf(needle) >= 0);
      list = list.slice().sort((a, b) => {
        if (st.sort === "count") {
          const na = newCountFor(yga.state.countOf(a.channelId), (comp[a.channelId] || {}).lastVisitAt);
          const nb = newCountFor(yga.state.countOf(b.channelId), (comp[b.channelId] || {}).lastVisitAt);
          if (nb !== na) return nb - na;
        }
        return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      });

      lastRows = list.slice(0, ROW_LIMIT);
      const frag = document.createDocumentFragment();
      for (const sub of lastRows) frag.appendChild(channelRow(sub, comp[sub.channelId], observer, st));
      rows.textContent = "";
      if (!lastRows.length) {
        const curated = profile && !profile.includeAllSubs && !st.showAll;
        rows.appendChild(u.placeholder(curated ? "emptyProfile" : "pickerEmpty"));
      } else {
        rows.appendChild(frag);
      }
      if (list.length > lastRows.length) rows.appendChild(hint("channelsMore", list.length));
      updateBulk();
    }

    const bar = el("div", "yga-panel-bar");
    const search = el("input", "yga-panel-input yga-panel-search", {
      type: "search",
      "aria-label": yga.i18n("channelsSearch")
    });
    search.placeholder = yga.i18n("channelsSearch");
    search.value = st.filter;
    search.addEventListener("input", () => {
      st.filter = search.value;
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(fill, SEARCH_DEBOUNCE_MS);
    });
    bar.appendChild(search);

    const sortSel = u.select(
      [
        { value: "title", labelKey: "channelsSortTitle" },
        { value: "count", labelKey: "channelsSortCount" }
      ],
      st.sort
    );
    sortSel.addEventListener("change", () => {
      st.sort = sortSel.value;
      fill();
    });
    bar.appendChild(sortSel);

    const showAllWrap = el("label", "yga-panel-inline");
    const showAll = el("input", "yga-panel-check", { type: "checkbox" });
    showAll.checked = st.showAll;
    showAll.addEventListener("change", () => {
      st.showAll = showAll.checked;
      fill();
    });
    const showAllText = el("span");
    showAllText.textContent = yga.i18n("channelsShowAll");
    showAllWrap.appendChild(showAll);
    showAllWrap.appendChild(showAllText);
    bar.appendChild(showAllWrap);

    const bulk = el("div", "yga-panel-bar");
    const selectAll = u.button("channelsSelectAll", "yga-panel-icon");
    const selectNone = u.button("channelsSelectNone", "yga-panel-icon");
    selectAll.addEventListener("click", () => {
      for (const sub of lastRows) st.selected.add(sub.channelId);
      fill();
    });
    selectNone.addEventListener("click", () => {
      st.selected.clear();
      fill();
    });
    bulkAdd.addEventListener("click", async () => {
      await yga.profiles.addChannels(profileId, selectedIds());
      await yga.state.refreshVisible();
      yga.panel.refresh("profiles");
      fill();
    });
    bulkRemove.addEventListener("click", async () => {
      await yga.profiles.removeChannels(profileId, selectedIds());
      await yga.state.refreshVisible();
      yga.panel.refresh("profiles");
      fill();
    });
    bulkWatched.addEventListener("click", async () => {
      await yga.state.markVisitedBatch(profileId, selectedIds());
      fill();
    });
    bulk.appendChild(selectAll);
    bulk.appendChild(selectNone);
    bulk.appendChild(bulkAdd);
    bulk.appendChild(bulkRemove);
    bulk.appendChild(bulkWatched);
    bulk.appendChild(selectedLabel);

    host.appendChild(bar);
    host.appendChild(bulk);
    host.appendChild(rows);
    updateBulk();
    await fill();
  };

  function channelRow(sub, rec, observer, st) {
    const member = isMember(rec);
    const row = el("div", "yga-panel-row yga-panel-channel");

    const box = el("input", "yga-panel-check", { type: "checkbox", "aria-label": sub.title });
    box.checked = st.selected.has(sub.channelId);
    box.addEventListener("change", () => {
      if (box.checked) st.selected.add(sub.channelId);
      else st.selected.delete(sub.channelId);
      row.classList.toggle("yga-panel-selected", box.checked);
    });

    const avatar = el("img", "yga-panel-avatar", { alt: "" });
    if (sub.avatarUrl) {
      avatar.dataset.src = sub.avatarUrl;
      observer.observe(avatar);
    } else {
      avatar.classList.add("yga-panel-avatar-empty");
    }

    const title = el("span", "yga-panel-title");
    title.textContent = sub.title;
    title.title = sub.title;

    const fresh = yga.state.countOf(sub.channelId);
    const n = member ? newCountFor(fresh, (rec || {}).lastVisitAt) : 0;
    const count = el("span", "yga-panel-meta yga-panel-count");
    count.textContent = fresh && fresh.error ? "?" : chipText(n);

    const group = el("span", "yga-panel-meta yga-panel-group");
    group.textContent = yga.i18n("groupNone"); // group chips land in stage 5 (§18)

    const reset = u.button("resetCounter", "yga-panel-icon");
    reset.disabled = !n;
    reset.addEventListener("click", async () => {
      await yga.state.markVisited(st.profileId, sub.channelId);
      yga.panel.refresh("channels");
    });

    const toggle = u.button(member ? "channelsRemove" : "channelsAdd", "yga-panel-icon");
    if (!member) toggle.classList.add("yga-panel-primary");
    toggle.addEventListener("click", async () => {
      if (member) await yga.profiles.removeChannel(st.profileId, sub.channelId);
      else await yga.profiles.addChannel(st.profileId, sub.channelId);
      await yga.state.refreshVisible();
      yga.panel.refresh("profiles");
      yga.panel.refresh("channels");
    });

    row.appendChild(box);
    row.appendChild(avatar);
    row.appendChild(title);
    row.appendChild(count);
    row.appendChild(group);
    row.appendChild(reset);
    row.appendChild(toggle);
    if (box.checked) row.classList.add("yga-panel-selected");
    return row;
  }

  // ---- Счётчики (§10): режим, период, батч ----

  BUILDERS.counters = async function counters(host) {
    const settings = await yga.profiles.getSettings();
    const refresh = settings.refresh || {};
    const sched = refresh.scheduled || {};

    const mode = u.select(
      [
        { value: "onOpen", labelKey: "refreshOnOpen" },
        { value: "scheduled", labelKey: "refreshScheduled" }
      ],
      refresh.mode || "onOpen"
    );
    mode.addEventListener("change", async () => {
      await u.save("refresh.mode", mode.value);
      u.notifyWorker();
    });
    host.appendChild(u.field("refreshMode", mode, "refreshModeHint"));

    const enabled = el("input", "yga-panel-check", { type: "checkbox" });
    enabled.checked = !!sched.enabled;
    enabled.addEventListener("change", async () => {
      await u.save("refresh.scheduled.enabled", enabled.checked);
      u.notifyWorker();
    });
    host.appendChild(u.field("scheduledEnabled", enabled, "scheduledEnabledHint"));

    const period = u.number(Math.max(60, Number(sched.periodInMinutes) || 240), {
      min: "60", max: "10080", step: "30"
    });
    period.addEventListener("change", async () => {
      const value = Math.max(60, Number(period.value) || 240);
      period.value = String(value);
      await u.save("refresh.scheduled.periodInMinutes", value);
      u.notifyWorker();
    });
    host.appendChild(u.field("scheduledPeriod", period, "scheduledPeriodHint"));

    const maxChannels = u.number(Number(sched.maxChannelsPerRun) || 60, {
      min: "1", max: "1000", step: "10"
    });
    maxChannels.addEventListener("change", async () => {
      const value = Math.max(1, Number(maxChannels.value) || 60);
      maxChannels.value = String(value);
      await u.save("refresh.scheduled.maxChannelsPerRun", value);
    });
    host.appendChild(u.field("scheduledMaxChannels", maxChannels));

    const batch = u.number(Number(refresh.batch) || 12, { min: "1", max: "50", step: "1" });
    batch.addEventListener("change", async () => {
      const value = Math.min(50, Math.max(1, Number(batch.value) || 12));
      batch.value = String(value);
      await u.save("refresh.batch", value);
    });
    host.appendChild(u.field("refreshBatch", batch));

    const minInterval = u.number(Math.round((Number(refresh.minIntervalMs) || 90000) / 1000), {
      min: "0", max: "3600", step: "10"
    });
    minInterval.addEventListener("change", async () => {
      const seconds = Math.max(0, Number(minInterval.value) || 0);
      minInterval.value = String(seconds);
      await u.save("refresh.minIntervalMs", seconds * 1000);
    });
    host.appendChild(u.field("refreshMinInterval", minInterval, "refreshMinIntervalHint"));
  };

  // ---- Виджет (§8.3, §8.6, §9) ----

  BUILDERS.widget = async function widget(host) {
    const settings = await yga.profiles.getSettings();
    const w = settings.widget || {};

    const position = u.select(
      [
        { value: "afterSubscriptions", labelKey: "widgetPositionGuide" },
        { value: "top", labelKey: "widgetPositionTop" }
      ],
      w.position || "afterSubscriptions"
    );
    position.addEventListener("change", async () => {
      await u.save("widget.position", position.value);
    });
    host.appendChild(u.field("widgetPosition", position, "widgetPositionHint"));

    const width = u.number(Number(w.widthPx) || 300, { min: "200", max: "480", step: "10" });
    width.addEventListener("change", async () => {
      const value = Math.min(480, Math.max(200, Number(width.value) || 300));
      width.value = String(value);
      await u.save("widget.widthPx", value);
    });
    host.appendChild(u.field("widgetWidth", width, "widgetWidthHint"));

    const showCounts = el("input", "yga-panel-check", { type: "checkbox" });
    showCounts.checked = w.showCounts !== false;
    showCounts.addEventListener("change", async () => {
      await u.save("widget.showCounts", showCounts.checked);
    });
    host.appendChild(u.field("widgetShowCounts", showCounts));

    const showZero = el("input", "yga-panel-check", { type: "checkbox" });
    showZero.checked = !!w.showZeroCount;
    showZero.addEventListener("change", async () => {
      await u.save("widget.showZeroCount", showZero.checked);
    });
    host.appendChild(u.field("widgetShowZero", showZero));

    const compact = el("input", "yga-panel-check", { type: "checkbox" });
    compact.checked = !!w.compact;
    compact.addEventListener("change", async () => {
      await u.save("widget.compact", compact.checked);
    });
    host.appendChild(u.field("widgetCompact", compact));
  };

  // ---- Тема (§2, §8): follow YouTube + accent ----

  BUILDERS.theme = async function theme(host) {
    const settings = await yga.profiles.getSettings();
    const t = settings.theme || {};

    const follow = el("input", "yga-panel-check", { type: "checkbox" });
    follow.checked = t.followYouTube !== false;
    follow.addEventListener("change", async () => {
      await u.save("theme.followYouTube", follow.checked);
    });
    host.appendChild(u.field("themeFollow", follow, "themeFollowHint"));

    const accent = el("input", "yga-panel-color", { type: "color" });
    accent.value = /^#[0-9a-f]{6}$/i.test(t.accent || "") ? t.accent : "#c00";
    accent.addEventListener("change", async () => {
      await u.save("theme.accent", accent.value);
    });
    host.appendChild(u.field("themeAccent", accent));
  };

  // ---- Данные (§11 этап 4): экспорт/импорт JSON, сброс ----

  const EXPORT_MARKER = "ygaExport";

  async function exportKeys() {
    const all = await chrome.storage.local.get(null);
    const out = {};
    out[EXPORT_MARKER] = 1;
    out.exportedAt = Date.now();
    for (const key in all) {
      if (key.indexOf("yga:") === 0) out[key] = all[key];
    }
    return out;
  }

  BUILDERS.data = async function data(host) {
    const bar = el("div", "yga-panel-bar");
    const status = el("span", "yga-panel-meta");

    const exportBtn = u.button("dataExport", "yga-panel-icon");
    exportBtn.addEventListener("click", async () => {
      const payload = await exportKeys();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = el("a", "yga-panel-hidden-link", {
        href: url,
        download: "youtube-aggregator-" + new Date().toISOString().slice(0, 10) + ".json"
      });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = yga.i18n("dataExported");
    });

    const file = el("input", "yga-panel-file", {
      type: "file",
      accept: "application/json",
      "aria-label": yga.i18n("dataImport")
    });
    file.addEventListener("change", () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let payload = null;
        try {
          payload = JSON.parse(String(reader.result));
        } catch (e) {
          payload = null;
        }
        if (!payload || payload[EXPORT_MARKER] !== 1) {
          status.textContent = yga.i18n("dataImportFailed");
          return;
        }
        const write = {};
        let keys = 0;
        for (const key in payload) {
          if (key.indexOf("yga:") !== 0) continue;
          write[key] = payload[key];
          keys++;
        }
        if (!keys) {
          status.textContent = yga.i18n("dataImportFailed");
          return;
        }
        await chrome.storage.local.set(write);
        status.textContent = yga.i18n("dataImportDone");
        setTimeout(() => window.location.reload(), 600);
      };
      reader.readAsText(picked);
    });

    const reset = u.button("dataReset", "yga-panel-icon yga-panel-danger");
    reset.addEventListener("click", async () => {
      if (!window.confirm(yga.i18n("dataResetConfirm"))) return;
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((key) => key.indexOf("yga:") === 0);
      await chrome.storage.local.remove(keys);
      window.location.reload();
    });

    bar.appendChild(exportBtn);
    bar.appendChild(file);
    bar.appendChild(reset);
    bar.appendChild(status);
    host.appendChild(bar);
  };

  // ---- assembly ----

  function buildSection(name) {
    const node = u.section(name, TITLES[name]);
    const builder = BUILDERS[name];
    if (builder) {
      Promise.resolve(builder(node)).catch((e) => {
        console.debug("[yga] panel section " + name + " failed:", e);
        node.appendChild(u.placeholder("panelSectionError"));
      });
    }
    return node;
  }

  yga.panelSections = {
    buildAll(body) {
      for (const name of ORDER) body.appendChild(buildSection(name));
    },

    rebuild(node, name) {
      if (!BUILDERS[name]) return;
      node.replaceWith(buildSection(name));
    }
  };
})(window.yga);


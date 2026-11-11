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
  const ACCOUNT_KEY = "yga:account";
  const NO_GROUP = "\u0000none"; // filter value for «Без группы»
  const UNGROUPED_LAST = "\uffff"; // sorts after every real group name

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
    await yga.profiles.load();
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

      // Stage 9: per-profile color for the channel-page/watch-page letter
      // buttons (PLAN.md §8.8).
      const color = el("input", "yga-panel-color", {
        type: "color",
        "aria-label": yga.i18n("profileColor")
      });
      color.value = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "#e05252";
      color.addEventListener("change", async () => {
        await yga.profiles.setColor(p.id, color.value);
        yga.panel.refresh("profiles");
      });

      row.appendChild(radio);
      row.appendChild(label);
      row.appendChild(count);
      row.appendChild(color);

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

  // ---- Группы (§9.2.2): CRUD над yga:groups — этап 5 (§18) ----

  function countInGroup(comp, groupId) {
    let n = 0;
    for (const id in comp) {
      const rec = comp[id];
      if (!isMember(rec)) continue;
      if ((rec.groupId || null) === (groupId || null)) n++;
    }
    return n;
  }

  BUILDERS.groups = async function groups(host) {
    const profileId = await yga.profiles.activeProfileId();
    await yga.groups.load();
    const groups = yga.groups.list(profileId);
    const comp = await yga.profiles.getComposition(profileId);
    const total = countMembers(comp);

    const status = el("span", "yga-panel-meta");
    const bar = el("div", "yga-panel-bar");
    const add = u.button("groupNew", "yga-panel-primary");
    add.addEventListener("click", () => {
      u.modal({
        titleKey: "groupNew",
        value: "",
        onConfirm: async (raw) => {
          const name = String(raw || "").trim();
          if (!name) {
            status.textContent = yga.i18n("groupNameRequired");
            return;
          }
          await yga.groups.create(name, profileId);
          await yga.state.refreshVisible();
          yga.panel.refresh("groups");
        }
      });
    });
    bar.appendChild(add);
    bar.appendChild(status);
    host.appendChild(bar);

    if (!groups.length) {
      host.appendChild(u.placeholder("groupsEmpty"));
      return;
    }

    const list = el("div", "yga-panel-rows");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const row = el("div", "yga-panel-row");

      const name = el("span", "yga-panel-title");
      name.textContent = g.name;
      name.title = g.name;

      // §9.2.2: «n/m» — channels of this group over all channels of the profile.
      const count = el("span", "yga-panel-meta");
      count.textContent = countInGroup(comp, g.id) + "/" + total;

      const up = u.button("groupUp", "yga-panel-icon");
      up.disabled = i === 0;
      up.addEventListener("click", async () => {
        await yga.groups.move(g.id, -1);
        await yga.state.refreshVisible();
        yga.panel.refresh("groups");
      });
      const down = u.button("groupDown", "yga-panel-icon");
      down.disabled = i === groups.length - 1;
      down.addEventListener("click", async () => {
        await yga.groups.move(g.id, 1);
        await yga.state.refreshVisible();
        yga.panel.refresh("groups");
      });

      const rename = u.button("groupRename", "yga-panel-icon");
      rename.addEventListener("click", () => {
        u.modal({
          titleKey: "groupRename",
          value: g.name,
          onConfirm: async (raw) => {
            const next = String(raw || "").trim();
            if (!next || next === g.name) return;
            await yga.groups.rename(g.id, next);
            await yga.state.refreshVisible();
            yga.panel.refresh("groups");
            yga.panel.refresh("channels");
          }
        });
      });

      const del = u.button("groupDelete", "yga-panel-icon yga-panel-danger");
      del.addEventListener("click", async () => {
        const n = countInGroup(comp, g.id);
        const text = yga.i18n("groupDeleteConfirm").replace("{count}", String(n));
        if (!window.confirm(text)) return;
        await yga.groups.remove(g.id); // its channels go back to «Без группы» (§18.1)
        await yga.state.refreshVisible();
        yga.panel.refresh("groups");
        yga.panel.refresh("channels");
      });

      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(rename);
      row.appendChild(del);
      list.appendChild(row);
    }
    host.appendChild(list);

    const hint = el("div", "yga-panel-hint");
    hint.textContent = yga.i18n("groupsHint");
    host.appendChild(hint);
  };

  // ---- Список каналов (§9.2.1) ----

  let channelsState = null; // survives section rebuilds, reset on profile switch

  function channelsStateFor(profileId) {
    if (!channelsState || channelsState.profileId !== profileId) {
      channelsState = {
        profileId: profileId,
        filter: "",
        sort: "title",
        group: "",
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
    await yga.groups.load();
    const groups = yga.groups.list(profileId);
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));
    let lastRows = [];

    // §9.2.1: a channel of a deleted group shows «Без группы», never a stale name.
    function groupText(rec) {
      const gid = rec && rec.groupId;
      return gid ? groupNames.get(gid) || "" : "";
    }

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
      for (const btn of [bulkAdd, bulkRemove, bulkWatched, bulkGroup]) btn.disabled = !n;
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
      if (st.group) {
        list = list.filter((sub) => {
          const gid = (comp[sub.channelId] || {}).groupId || null;
          return st.group === NO_GROUP ? !groupText(comp[sub.channelId]) : gid === st.group;
        });
      }
      list = list.slice().sort((a, b) => {
        if (st.sort === "count") {
          const na = newCountFor(yga.state.countOf(a.channelId), (comp[a.channelId] || {}).lastVisitAt);
          const nb = newCountFor(yga.state.countOf(b.channelId), (comp[b.channelId] || {}).lastVisitAt);
          if (nb !== na) return nb - na;
        }
        if (st.sort === "group") {
          // §9.2.1: groups first in locale order, «Без группы» last.
          const ga = groupText(comp[a.channelId]) || UNGROUPED_LAST;
          const gb = groupText(comp[b.channelId]) || UNGROUPED_LAST;
          const byGroup = ga.localeCompare(gb, undefined, { sensitivity: "base" });
          if (byGroup) return byGroup;
        }
        return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      });

      lastRows = list.slice(0, ROW_LIMIT);
      const frag = document.createDocumentFragment();
      for (const sub of lastRows) {
        frag.appendChild(channelRow(sub, comp[sub.channelId], observer, st, groups));
      }
      rows.textContent = "";
      if (!lastRows.length) {
        const curated = profile && !profile.includeAllSubs && !st.showAll;
        rows.appendChild(u.placeholder(curated ? "emptyProfile" : "pickerEmpty"));
      } else {
        rows.appendChild(frag);
      }
      if (list.length > lastRows.length) rows.appendChild(hint("channelsMore", list.length));
      renderChips(comp);
      updateBulk();
    }

    // Filter chips with n/m counters (§9.2.1, §18.5) — rebuilt with every fill
    // because their counts follow the composition.
    const chips = el("div", "yga-panel-chips");

    function renderChips(comp) {
      chips.textContent = "";
      const total = countMembers(comp);
      const mk = (value, label, n) => {
        const chip = el("button", "yga-panel-chip", { type: "button" });
        chip.textContent = n == null ? label : label + " " + n + "/" + total;
        if (st.group === value) chip.classList.add("yga-active");
        chip.addEventListener("click", () => {
          st.group = value;
          fill();
        });
        chips.appendChild(chip);
      };
      mk("", yga.i18n("channelsGroupAll"), null);
      for (const g of groups) mk(g.id, g.name, countInGroup(comp, g.id));
      mk(NO_GROUP, yga.i18n("groupNone"), countInGroup(comp, null));
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
        { value: "count", labelKey: "channelsSortCount" },
        { value: "group", labelKey: "channelsSortGroup" }
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

    // Bulk group assignment (§9.2.1): one composition write for the selection.
    const groupPick = u.select(
      [{ value: "", labelKey: "groupNone" }].concat(groups.map((g) => ({ value: g.id, text: g.name }))),
      ""
    );
    const bulkGroup = u.button("channelsGroupApply", "yga-panel-icon");
    bulkGroup.disabled = true;
    bulkGroup.addEventListener("click", async () => {
      await yga.profiles.setGroup(profileId, selectedIds(), groupPick.value || null);
      await yga.state.refreshVisible();
      yga.panel.refresh("groups");
      fill();
    });

    bulk.appendChild(selectAll);
    bulk.appendChild(selectNone);
    bulk.appendChild(bulkAdd);
    bulk.appendChild(bulkRemove);
    bulk.appendChild(bulkWatched);
    bulk.appendChild(groupPick);
    bulk.appendChild(bulkGroup);
    bulk.appendChild(selectedLabel);

    host.appendChild(bar);
    host.appendChild(chips);
    host.appendChild(bulk);
    host.appendChild(rows);
    updateBulk();
    await fill();
  };

  function channelRow(sub, rec, observer, st, groups) {
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

    // §18.5: assignment is a native <select> chip in the row; «Без группы» is
    // the empty value, so an ungrouped channel shows it instead of a group chip.
    const group = el("select", "yga-panel-select yga-panel-group", {
      "aria-label": yga.i18n("channelsGroupApply")
    });
    const known = new Set(groups.map((g) => g.id));
    const current = rec && rec.groupId && known.has(rec.groupId) ? rec.groupId : "";
    const opts = [{ value: "", text: yga.i18n("groupNone") }].concat(
      groups.map((g) => ({ value: g.id, text: g.name }))
    );
    for (const opt of opts) {
      const option = el("option", null, { value: opt.value });
      option.textContent = opt.text;
      group.appendChild(option);
    }
    group.value = current;
    group.classList.toggle("yga-panel-group-none", !current);
    group.addEventListener("change", async () => {
      await yga.profiles.setGroup(st.profileId, [sub.channelId], group.value || null);
      await yga.state.refreshVisible();
      yga.panel.refresh("groups");
      yga.panel.refresh("channels");
    });

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

    // Stage 8: a link button on the right of the row opens the channel in a
    // new tab. A real <a target="_blank"> — middle-click/Ctrl+click behave as
    // the user expects, and the panel (a full-screen overlay) stays open.
    const open = el("a", "yga-panel-icon yga-panel-open", {
      href: "/channel/" + sub.channelId + "/videos",
      target: "_blank",
      rel: "noopener",
      "aria-label": yga.i18n("channelsOpen"),
      title: yga.i18n("channelsOpen")
    });
    open.textContent = "\u2197"; // ↗ static glyph, no YouTube data (§12)

    row.appendChild(box);
    row.appendChild(avatar);
    row.appendChild(title);
    row.appendChild(count);
    row.appendChild(group);
    row.appendChild(reset);
    row.appendChild(toggle);
    row.appendChild(open);
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
      // A named position replaces any manual ▲/▼ slot (PLAN.md §8.3). Both
      // keys must land in one emit, or the widget remounts twice.
      await yga.profiles.saveSettingsPaths({
        "widget.position": position.value,
        "widget.guideIndex": null
      });
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

    // §18.3: empty groups are hidden on demand (default false).
    const hideEmpty = el("input", "yga-panel-check", { type: "checkbox" });
    hideEmpty.checked = !!w.hideEmptyGroups;
    hideEmpty.addEventListener("change", async () => {
      await u.save("widget.hideEmptyGroups", hideEmpty.checked);
    });
    host.appendChild(u.field("widgetHideEmptyGroups", hideEmpty, "widgetHideEmptyGroupsHint"));

    // §8.8: the «Группа» button in the header of a channel page.
    const pageButton = el("input", "yga-panel-check", { type: "checkbox" });
    pageButton.checked = w.channelPageButton !== false;
    pageButton.addEventListener("change", async () => {
      await u.save("widget.channelPageButton", pageButton.checked);
    });
    host.appendChild(u.field("widgetChannelPageButton", pageButton, "widgetChannelPageButtonHint"));

    // Stage 9: the letter buttons left of Like/Dislike on watch pages.
    const watchButton = el("input", "yga-panel-check", { type: "checkbox" });
    watchButton.checked = w.watchPageButton !== false;
    watchButton.addEventListener("change", async () => {
      await u.save("widget.watchPageButton", watchButton.checked);
    });
    host.appendChild(u.field("widgetWatchPageButton", watchButton, "widgetWatchPageButtonHint"));

    // §18.6: the profile sort orders channels inside groups.
    const profileId = await yga.profiles.activeProfileId();
    const profile = yga.profiles.get(profileId);
    const sortSel = u.select(
      [
        { value: "activity", labelKey: "profileSortActivity" },
        { value: "alpha", labelKey: "profileSortAlpha" },
        { value: "subs", labelKey: "profileSortSubs" },
        { value: "manual", labelKey: "profileSortManual" },
        { value: "groups", labelKey: "profileSortGroups" }
      ],
      (profile && profile.sort) || "activity"
    );
    sortSel.addEventListener("change", async () => {
      await yga.profiles.setSort(profileId, sortSel.value);
      await yga.state.refreshVisible();
    });
    host.appendChild(u.field("profileSort", sortSel, "profileSortHint"));
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
        console.warn("[yga] panel section " + name + " failed:", e);
        const placeholder = u.placeholder("panelSectionError");
        placeholder.title = String((e && (e.message || e)) || e);
        node.appendChild(placeholder);
      });
    }
    return node;
  }

  yga.panelSections = {
    names() {
      return ORDER.slice();
    },

    title(name) {
      return TITLES[name] || name;
    },

    buildSection(name) {
      return buildSection(name);
    }
  };
})(window.yga);


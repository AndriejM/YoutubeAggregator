window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // «Группа» in the header of a channel page (PLAN.md §8.8, §18.5) — the second
  // entry point to groups besides the panel. A dropdown lists the groups of the
  // active profile plus «Без группы» and quick create. The choice writes
  // groupId immediately, and a channel missing from the profile composition is
  // added to it automatically (§18.5) — setGroup() does both in one write.
  const CHANNEL_PATH = /^\/(channel\/|@|c\/|user\/)/;
  const BUTTON_ATTR = "data-yga-group-button";
  const MENU_ATTR = "data-yga-group-menu";

  let mounted = null; // { host, btn, channelId }
  let menu = null;
  let unsubGroups = null;

  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) {
      for (const key in attrs) {
        if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      }
    }
    return node;
  }

  function onChannelPage() {
    return CHANNEL_PATH.test(location.pathname);
  }

  function currentMenu() {
    return document.querySelector("[" + MENU_ATTR + "]");
  }

  function closeMenu() {
    const node = currentMenu();
    if (node) node.remove();
    document.removeEventListener("pointerdown", onOutside, true);
  }

  function onOutside(ev) {
    const node = currentMenu();
    if (!node || node.contains(ev.target)) return;
    if (mounted && mounted.btn && mounted.btn.contains(ev.target)) return;
    closeMenu();
  }

  async function pageChannel() {
    try {
      const res = await yga.bridge.call("getPageChannel");
      return res && res.channelId ? res : null;
    } catch (e) {
      console.debug("[yga] page channel detection failed:", e);
      return null;
    }
  }

  // Current group of this page's channel, resolved against yga:groups so a
  // deleted group never shows a stale name (§18.1).
  async function currentGroup(channelId) {
    const profileId = await yga.profiles.activeProfileId();
    const comp = await yga.profiles.getComposition(profileId);
    const rec = comp[channelId];
    const gid = rec && rec.groupId;
    if (!gid) return { profileId: profileId, groupId: "", group: null };
    const group = yga.groups.get(gid);
    return { profileId: profileId, groupId: group && group.profileId === profileId ? gid : "", group: group };
  }

  async function paint(btn, channelId) {
    const state = await currentGroup(channelId);
    if (!mounted || mounted.btn !== btn) return;
    const label = state.group ? state.group.name : yga.i18n("groupNone");
    btn.textContent = yga.i18n("groupButton") + ": " + label;
    btn.title = yga.i18n("groupButton");
    btn.classList.toggle("yga-gp-set", !!state.group);
  }

  async function assign(btn, channelId, groupId) {
    const profileId = await yga.profiles.activeProfileId();
    await yga.profiles.setGroup(profileId, [channelId], groupId || null);
    await yga.state.refreshVisible();
    await paint(btn, channelId);
    if (yga.panel && yga.panel.isOpen()) {
      yga.panel.refresh("groups");
      yga.panel.refresh("channels");
    }
  }

  async function openMenu(btn, channelId) {
    closeMenu();
    const profileId = await yga.profiles.activeProfileId();
    await yga.groups.load();
    const groups = yga.groups.list(profileId);
    const state = await currentGroup(channelId);

    const box = el("div", "yga-gp-menu", {
      role: "menu",
      "aria-label": yga.i18n("groupButton")
    });
    box.setAttribute(MENU_ATTR, "");

    const item = (label, active, onClick) => {
      const node = el("button", "yga-gp-item" + (active ? " yga-active" : ""), {
        type: "button",
        role: "menuitem"
      });
      node.textContent = label;
      node.addEventListener("click", async () => {
        closeMenu();
        await onClick();
      });
      box.appendChild(node);
      return node;
    };

    item(yga.i18n("groupNone"), !state.group, () => assign(btn, channelId, ""));
    for (const g of groups) {
      item(g.name, state.groupId === g.id, () => assign(btn, channelId, g.id));
    }

    // Quick create (§18.5): one field, Enter creates and assigns in one step.
    const quick = el("div", "yga-gp-quick");
    const input = el("input", "yga-gp-input", {
      type: "text",
      "aria-label": yga.i18n("groupNew")
    });
    input.placeholder = yga.i18n("groupNew");
    const ok = el("button", "yga-gp-item yga-gp-create", { type: "button", role: "menuitem" });
    ok.textContent = yga.i18n("groupCreateAssign");
    const create = async () => {
      const name = String(input.value || "").trim();
      if (!name) return;
      const created = await yga.groups.create(name, profileId);
      closeMenu();
      if (created) await assign(btn, channelId, created.id);
    };
    ok.addEventListener("click", create);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        create();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
      }
    });
    quick.appendChild(input);
    quick.appendChild(ok);
    box.appendChild(quick);

    const host = (mounted && mounted.host) || document.body;
    host.appendChild(box);
    // The header is not a positioned ancestor, so the menu is fixed and placed
    // from the button rect instead of relying on an offset parent.
    const rect = btn.getBoundingClientRect();
    box.style.position = "fixed";
    box.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + "px";
    box.style.top = Math.round(rect.bottom + 4) + "px";
    if (input.focus) input.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }

  async function mount() {
    if (!yga.groups || !yga.profiles || !yga.state) return;
    const settings = await yga.profiles.getSettings();
    const enabled = (settings.widget || {}).channelPageButton !== false;
    if (!enabled || !onChannelPage()) {
      unmount();
      return;
    }
    const page = await pageChannel();
    if (!page) {
      unmount();
      return;
    }
    const host = yga.selectors.find("channelHeader");
    if (!host) return;

    let btn = document.querySelector("[" + BUTTON_ATTR + "]");
    if (btn && mounted && mounted.host === host && mounted.channelId === page.channelId) {
      await paint(btn, page.channelId);
      return;
    }
    if (btn) btn.remove();
    closeMenu();

    btn = el("button", "yga-gp-btn", { type: "button", "aria-haspopup": "menu" });
    btn.setAttribute(BUTTON_ATTR, "");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (currentMenu()) closeMenu();
      else openMenu(btn, page.channelId);
    });
    host.appendChild(btn);
    mounted = { host: host, btn: btn, channelId: page.channelId };
    await paint(btn, page.channelId);

    if (!unsubGroups) {
      unsubGroups = yga.groups.onGroupsChanged(() => {
        if (mounted) paint(mounted.btn, mounted.channelId);
      });
    }
  }

  function unmount() {
    closeMenu();
    const btn = document.querySelector("[" + BUTTON_ATTR + "]");
    if (btn) btn.remove();
    mounted = null;
  }

  function boot() {
    mount();
    // SPA navigation: the header is rebuilt per channel, so re-anchor there.
    window.addEventListener("yt-navigate-finish", () => {
      mounted = null;
      closeMenu();
      mount();
    });
    // The setting can be flipped from the panel while the page stays open.
    if (yga.profiles.onSettingsChanged) {
      let buttonOn = null; // the widget keeps its own previous; so do we
      yga.profiles.onSettingsChanged((next) => {
        const on = ((next && next.widget) || {}).channelPageButton !== false;
        if (buttonOn === on) return;
        buttonOn = on;
        mounted = null;
        mount();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.yga);

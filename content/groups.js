window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Channel groups (PLAN.md §18, stage 5). A group is defined inside one
  // profile (§18.1), so every entry carries its profileId while the single
  // documented key yga:groups (§5) stays the only source of truth for names,
  // order and collapsed state — the widget tree always redraws from here.
  const GROUPS_KEY = "yga:groups";

  let groups = null; // array mirror of yga:groups
  const listeners = new Set();
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });

  function profileId() {
    return (yga.profiles && yga.profiles.lastActiveId()) || null;
  }

  function now() {
    return Date.now();
  }

  function emit() {
    for (const cb of listeners) {
      try {
        cb();
      } catch (e) {
        console.debug("[yga] group listener failed:", e);
      }
    }
  }

  async function persist() {
    const payload = {};
    payload[GROUPS_KEY] = groups || [];
    await chrome.storage.local.set(payload);
    emit();
  }

  function sorted(list) {
    return list.slice().sort((a, b) => {
      const byOrder = (a.order || 0) - (b.order || 0);
      if (byOrder) return byOrder;
      return collator.compare(a.name || "", b.name || "");
    });
  }

  function nextOrder(id) {
    let max = -1;
    for (const g of groups || []) if (g.profileId === id) max = Math.max(max, g.order || 0);
    return max + 1;
  }

  function normalizeAvatar(avatar) {
    if (yga.groupIcons && typeof yga.groupIcons.normalize === "function") {
      return yga.groupIcons.normalize(avatar);
    }
    return null;
  }

  // Cross-tab convergence: another tab's panel edited yga:groups.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[GROUPS_KEY]) return;
    const next = changes[GROUPS_KEY].newValue;
    if (!Array.isArray(next)) return;
    if (groups && JSON.stringify(next) === JSON.stringify(groups)) return;
    groups = next;
    emit();
  });

  yga.groups = {
    GROUPS_KEY: GROUPS_KEY,

    async load() {
      if (groups) return groups;
      const stored = await chrome.storage.local.get(GROUPS_KEY);
      groups = Array.isArray(stored[GROUPS_KEY]) ? stored[GROUPS_KEY] : [];
      return groups;
    },

    // Groups of one profile (defaults to the active one), §18.3 order.
    list(id) {
      const pid = id || profileId();
      return sorted((groups || []).filter((g) => g.profileId === pid));
    },

    get(id) {
      if (!id) return null;
      for (const g of groups || []) if (g.id === id) return g;
      return null;
    },

    async create(name, id) {
      const pid = id || profileId();
      const trimmed = String(name || "").trim();
      if (!pid || !trimmed) return null;
      await this.load();
      const group = {
        id: "g_" + Math.random().toString(36).slice(2, 10),
        name: trimmed,
        collapsed: false,
        order: nextOrder(pid),
        profileId: pid,
        createdAt: now(),
        updatedAt: now()
      };
      groups.push(group);
      await persist();
      return group;
    },

    async rename(id, name) {
      await this.load();
      const g = this.get(id);
      const trimmed = String(name || "").trim();
      if (!g || !trimmed) return false;
      g.name = trimmed;
      g.updatedAt = now();
      await persist();
      return true;
    },

    // §18.1: the channels of a deleted group fall back to «Без группы».
    async remove(id) {
      await this.load();
      const g = this.get(id);
      if (!g) return false;
      groups = groups.filter((x) => x.id !== id);
      if (yga.profiles) await yga.profiles.clearGroup(g.profileId, id);
      await persist();
      return true;
    },

    async setCollapsed(id, collapsed) {
      await this.load();
      const g = this.get(id);
      if (!g || !!g.collapsed === !!collapsed) return false;
      g.collapsed = !!collapsed;
      g.updatedAt = now();
      await persist();
      return true;
    },

    async setAvatar(id, avatar) {
      await this.load();
      const g = this.get(id);
      if (!g) return false;
      const next = normalizeAvatar(avatar);
      const current = normalizeAvatar(g.avatar);
      if (JSON.stringify(next || null) === JSON.stringify(current || null)) return false;
      if (next) g.avatar = next;
      else delete g.avatar;
      g.updatedAt = now();
      await persist();
      return true;
    },

    // Reorder inside one profile (§9.2.2 ↑/↓): swap the order value with the
    // neighbour and renumber the profile, so gaps never accumulate.
    async move(id, delta) {
      await this.load();
      const g = this.get(id);
      if (!g || !delta) return false;
      const ordered = this.list(g.profileId);
      const at = ordered.indexOf(g);
      const to = at + (delta < 0 ? -1 : 1);
      if (at < 0 || to < 0 || to >= ordered.length) return false;
      const order = ordered.map((x) => x.order);
      const tmp = order[at];
      order[at] = order[to];
      order[to] = tmp;
      ordered.forEach((x, i) => {
        x.order = order[i];
      });
      g.updatedAt = now();
      await persist();
      return true;
    },

    onGroupsChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
})(window.yga);

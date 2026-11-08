window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Local profile sets (PLAN.md §5, §11 stage 2). Profiles are our own layer;
  // the Google account is only a subs source (accounts.js).
  const PROFILES_KEY = "yga:profiles";
  const SETTINGS_KEY = "yga:settings";
  const BUILTIN_ID = "p_1";

  let profiles = null; // id -> profile
  const profileListeners = new Set();

  function now() {
    return Date.now();
  }

  function builtinProfile() {
    return {
      id: BUILTIN_ID, name: yga.i18n("profileAllSubs"), builtin: true,
      createdAt: now(), updatedAt: now(),
      sort: "activity",
      filters: { hideWatched: false, excludeShorts: false, excludeLive: false },
      includeAllSubs: true
    };
  }

  function defaults() {
    return {
      version: 1,
      activeProfileId: BUILTIN_ID,
      refresh: { mode: "onOpen", scheduled: { enabled: false, periodInMinutes: 240, maxChannelsPerRun: 60 }, batch: 12, minIntervalMs: 90000 },
      widget: { position: "afterSubscriptions", widthPx: 300, showCounts: true, showZeroCount: false, sort: "activity", hideWatched: false, compact: false, hideEmptyGroups: false, channelPageButton: true },
      theme: { followYouTube: true, accent: "#c00" }
    };
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const s = stored[SETTINGS_KEY];
    return s && s.version === 1 ? s : defaults();
  }

  async function saveSettings(patch) {
    const settings = await loadSettings();
    const merged = Object.assign({}, settings, patch);
    const payload = {};
    payload[SETTINGS_KEY] = merged;
    await chrome.storage.local.set(payload);
    return merged;
  }

  async function persistProfiles() {
    const payload = {};
    payload[PROFILES_KEY] = profiles;
    await chrome.storage.local.set(payload);
    emitProfiles();
  }

  function emitProfiles() {
    const list = yga.profiles.list();
    for (const cb of profileListeners) {
      try {
        cb(list);
      } catch (e) {
        console.debug("[yga] profile listener failed:", e);
      }
    }
  }

  function compositionKey(id) {
    return "yga:profile-channels:" + id;
  }

  function entry() {
    return {
      addedAt: now(), lastVisitAt: 0, groupId: null,
      pinned: false, muted: false, tags: [], order: 0
    };
  }

  // A channel is shown when it is a live subscription and the user has not
  // excluded it from this profile. `unsubscribed` is automatic (dropped by
  // YouTube), `excluded` is the user's choice and never resets by itself.
  function isMember(rec) {
    return !rec.unsubscribed && !rec.excluded;
  }

  yga.profiles = {
    BUILTIN_ID: BUILTIN_ID,

    async load() {
      if (profiles) return profiles;
      const stored = await chrome.storage.local.get(PROFILES_KEY);
      profiles = stored[PROFILES_KEY] || {};
      if (!profiles[BUILTIN_ID]) {
        profiles[BUILTIN_ID] = builtinProfile();
        await persistProfiles();
      }
      return profiles;
    },

    async getSettings() {
      return loadSettings();
    },

    async activeProfileId() {
      const settings = await loadSettings();
      const id = settings.activeProfileId;
      await this.load();
      return profiles[id] ? id : BUILTIN_ID;
    },

    async setActiveProfile(id) {
      await this.load();
      if (!profiles[id]) return null;
      await saveSettings({ activeProfileId: id });
      return id;
    },

    list() {
      const ids = Object.keys(profiles || {});
      ids.sort((a, b) => {
        if (a === BUILTIN_ID) return -1;
        if (b === BUILTIN_ID) return 1;
        return (profiles[a].name || "").localeCompare(profiles[b].name || "");
      });
      return ids.map((id) => profiles[id]);
    },

    get(id) {
      return (profiles && profiles[id]) || null;
    },

    async create(name) {
      await this.load();
      const trimmed = String(name || "").trim();
      if (!trimmed) return null;
      let id;
      do {
        id = "p_" + Math.random().toString(36).slice(2, 10);
      } while (profiles[id]);
      profiles[id] = {
        id: id, name: trimmed, builtin: false,
        createdAt: now(), updatedAt: now(),
        sort: "activity",
        filters: { hideWatched: false, excludeShorts: false, excludeLive: false },
        includeAllSubs: false
      };
      await persistProfiles();
      const payload = {};
      payload[compositionKey(id)] = {};
      await chrome.storage.local.set(payload);
      return profiles[id];
    },

    // Double confirm for destructive action until the settings screen (stage 4).
    async remove(id) {
      await this.load();
      const p = profiles[id];
      if (!p || p.builtin) return false;
      const again = window.confirm(
        yga.i18n("deleteProfile") + "\n" + yga.i18n("deleteProfileConfirm")
      );
      if (!again) return false;
      delete profiles[id];
      await persistProfiles();
      await chrome.storage.local.remove(compositionKey(id));
      const settings = await loadSettings();
      if (settings.activeProfileId === id) await saveSettings({ activeProfileId: BUILTIN_ID });
      return true;
    },

    async rename(id, name) {
      await this.load();
      const p = profiles[id];
      if (!p || p.builtin) return false;
      const trimmed = String(name || "").trim();
      if (!trimmed) return false;
      p.name = trimmed;
      p.updatedAt = now();
      await persistProfiles();
      return true;
    },

    // Composition = yga:profile-channels:<id> (addedAt/lastVisitAt/groupId/...)
    async getComposition(id) {
      const stored = await chrome.storage.local.get(compositionKey(id));
      return stored[compositionKey(id)] || {};
    },

    // Merge fresh subs into the profile composition (PLAN.md §11 stage 2).
    // includeAllSubs profiles get an implicit entry per subscription (so
    // lastVisitAt has a home); curated profiles only gain entries through
    // addChannel. Unsubscribed channels leave the list but keep their history
    // in case the subscription returns. Returns the ids to show in the widget.
    async syncProfile(profileId, subsList) {
      const profile = this.get(profileId);
      if (!profile) return null;
      const key = compositionKey(profileId);
      const stored = await chrome.storage.local.get(key);
      const comp = stored[key] || {};
      const fresh = new Set(subsList.map((s) => s.channelId));
      let dirty = false;
      for (const id of fresh) {
        if (!comp[id]) {
          if (!profile.includeAllSubs) continue; // curated: added explicitly
          comp[id] = entry();
          dirty = true;
        } else if (comp[id].unsubscribed) {
          delete comp[id].unsubscribed; // re-subscribed, lastVisitAt history kept
          dirty = true;
        }
      }
      // Unsubscribed: out of the list but lastVisitAt/groupId history retained
      // in case the subscription returns (PLAN.md §11 stage 2).
      for (const id of Object.keys(comp)) {
        if (!fresh.has(id) && !comp[id].unsubscribed) {
          comp[id].unsubscribed = true;
          dirty = true;
        }
      }
      if (dirty) {
        const payload = {};
        payload[key] = comp;
        chrome.storage.local.set(payload);
      }
      if (profile.includeAllSubs) {
        return Array.from(fresh).filter((id) => !comp[id] || isMember(comp[id]));
      }
      return Object.keys(comp).filter((id) => isMember(comp[id]));
    },

    // Membership of a curated profile (includeAllSubs: false); also the
    // exclude/restore switch for includeAllSubs profiles (§9.2.1 delete icon).
    async addChannel(profileId, channelId) {
      const profile = this.get(profileId);
      if (!profile || !channelId) return false;
      const key = compositionKey(profileId);
      const stored = await chrome.storage.local.get(key);
      const comp = stored[key] || {};
      if (comp[channelId] && isMember(comp[channelId])) return false;
      comp[channelId] = Object.assign(entry(), comp[channelId] || {});
      delete comp[channelId].unsubscribed;
      delete comp[channelId].excluded;
      const payload = {};
      payload[key] = comp;
      await chrome.storage.local.set(payload);
      return true;
    },

    async removeChannel(profileId, channelId) {
      const profile = this.get(profileId);
      if (!profile || !channelId) return false;
      const key = compositionKey(profileId);
      const stored = await chrome.storage.local.get(key);
      const comp = stored[key] || {};
      if (!comp[channelId]) comp[channelId] = entry();
      if (comp[channelId].excluded) return false;
      comp[channelId].excluded = true; // lastVisitAt history kept
      const payload = {};
      payload[key] = comp;
      await chrome.storage.local.set(payload);
      return true;
    },

    onProfilesChanged(cb) {
      profileListeners.add(cb);
      return () => profileListeners.delete(cb);
    }
  };
})(window.yga);

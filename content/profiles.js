window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Local profile sets (PLAN.md §5, §11 stage 2). Profiles are our own layer;
  // the Google account is only a subs source (accounts.js).
  const PROFILES_KEY = "yga:profiles";
  const SETTINGS_KEY = "yga:settings";
  const BUILTIN_ID = "p_1";

  let profiles = null; // id -> profile
  let lastActive = null; // active profile id seen by this world (widget/footer fast path)
  const profileListeners = new Set();
  const compositionMirrors = new Map(); // profileId -> last known comp object (cross-tab adopt)

  // yga:settings mirror (stage 4). The panel writes single fields through
  // saveSettingsPath; the widget subscribes through onSettingsChanged so every
  // change lands without a page reload (PLAN.md §11 stage 4 criterion).
  let settings = null;
  const settingsListeners = new Set();
  let settingsTimer = 0;
  const SETTINGS_WRITE_DEBOUNCE_MS = 300; // §5 write-amplification guard

  // The single writer of yga:profile-channels:<id> (stage 3). state.js bridges
  // storage.onChanged from OTHER contexts into these mirrors (adopt), so reads
  // here never serve a stale composition after another tab edited it.
  function readComposition(id) {
    const mirror = compositionMirrors.get(id);
    if (mirror) return Promise.resolve(mirror);
    return chrome.storage.local.get(compositionKey(id)).then(function (stored) {
      const comp = stored[compositionKey(id)] || {};
      compositionMirrors.set(id, comp);
      return comp;
    });
  }

  function writeComposition(id, comp) {
    compositionMirrors.set(id, comp);
    const payload = {};
    payload[compositionKey(id)] = comp;
    return chrome.storage.local.set(payload);
  }

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
    if (settings) return settings;
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const s = stored[SETTINGS_KEY];
    settings = s && s.version === 1 ? s : defaults();
    return settings;
  }

  function cloneSettings(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function emitSettings() {
    const snapshot = settings || defaults();
    for (const cb of settingsListeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.debug("[yga] settings listener failed:", e);
      }
    }
  }

  function flushSettingsWrite() {
    settingsTimer = 0;
    if (!settings) return;
    const payload = {};
    payload[SETTINGS_KEY] = settings;
    chrome.storage.local.set(payload);
  }

  // Debounced write for inline edits; the mirror is already updated, so the
  // widget repaints immediately while storage catches up (PLAN.md §5).
  function scheduleSettingsWrite() {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettingsWrite, SETTINGS_WRITE_DEBOUNCE_MS);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    settings = Object.assign(cloneSettings(current), patch);
    const payload = {};
    payload[SETTINGS_KEY] = settings;
    await chrome.storage.local.set(payload);
    emitSettings();
    return settings;
  }

  // Write one nested field ("widget.widthPx", "refresh.scheduled.enabled").
  async function saveSettingsPath(path, value) {
    const next = cloneSettings(await loadSettings());
    const parts = String(path).split(".");
    let node = next;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    settings = next;
    scheduleSettingsWrite();
    emitSettings();
    return next;
  }

  // Cross-tab settings convergence: another tab's panel edit must reach this
  // widget too. Equal payloads are skipped so our own write never re-renders.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    const next = changes[SETTINGS_KEY].newValue;
    if (!next || next.version !== 1) return;
    if (settings && JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    emitSettings();
  });

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

    // Inline edit of one nested field (config panel, stage 4).
    async saveSettingsPath(path, value) {
      return saveSettingsPath(path, value);
    },

    defaults() {
      return defaults();
    },

    onSettingsChanged(cb) {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },

    async activeProfileId() {
      const settings = await loadSettings();
      const id = settings.activeProfileId;
      await this.load();
      lastActive = profiles[id] ? id : BUILTIN_ID;
      return lastActive;
    },

    // Synchronous fast path for render paths inside the same world (widget
    // decorate); null until activeProfileId() has resolved at least once.
    lastActiveId() {
      return lastActive;
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
      await writeComposition(id, {});
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
      compositionMirrors.delete(id);
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
      return readComposition(id);
    },

    // Merge fresh subs into the profile composition (PLAN.md §11 stage 2).
    // includeAllSubs profiles get an implicit entry per subscription (so
    // lastVisitAt has a home); curated profiles only gain entries through
    // addChannel. Unsubscribed channels leave the list but keep their history
    // in case the subscription returns. Returns the ids to show in the widget.
    async syncProfile(profileId, subsList) {
      const profile = this.get(profileId);
      if (!profile) return null;
      const comp = await readComposition(profileId);
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
      if (dirty) await writeComposition(profileId, comp);
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
      const comp = await readComposition(profileId);
      if (comp[channelId] && isMember(comp[channelId])) return false;
      comp[channelId] = Object.assign(entry(), comp[channelId] || {});
      delete comp[channelId].unsubscribed;
      delete comp[channelId].excluded;
      await writeComposition(profileId, comp);
      return true;
    },

    // Bulk membership for the config panel (§9.2.1): one read and one write
    // per selection, never one storage write per channel.
    async addChannels(profileId, channelIds) {
      const profile = this.get(profileId);
      if (!profile || !Array.isArray(channelIds) || !channelIds.length) return 0;
      const comp = await readComposition(profileId);
      let changed = 0;
      for (const channelId of channelIds) {
        if (!channelId || (comp[channelId] && isMember(comp[channelId]))) continue;
        comp[channelId] = Object.assign(entry(), comp[channelId] || {});
        delete comp[channelId].unsubscribed;
        delete comp[channelId].excluded;
        changed++;
      }
      if (changed) await writeComposition(profileId, comp);
      return changed;
    },

    async removeChannels(profileId, channelIds) {
      const profile = this.get(profileId);
      if (!profile || !Array.isArray(channelIds) || !channelIds.length) return 0;
      const comp = await readComposition(profileId);
      const stamp = now();
      let changed = 0;
      for (const channelId of channelIds) {
        if (!channelId || !comp[channelId] || comp[channelId].excluded) continue;
        comp[channelId].excluded = true;
        comp[channelId].lastVisitAt = stamp;
        changed++;
      }
      if (changed) await writeComposition(profileId, comp);
      return changed;
    },

    async removeChannel(profileId, channelId) {
      const profile = this.get(profileId);

      if (!profile || !channelId) return false;
      const comp = await readComposition(profileId);
      if (!comp[channelId]) comp[channelId] = entry();
      if (comp[channelId].excluded) return false;
      // lastVisitAt=now closes the channel: its counter is history, and the
      // stage-5 "restore" button will not resurrect a stale count (PLAN.md §10.5).
      comp[channelId].excluded = true;
      comp[channelId].lastVisitAt = now();
      await writeComposition(profileId, comp);
      return true;
    },

    onProfilesChanged(cb) {
      profileListeners.add(cb);
      return () => profileListeners.delete(cb);
    }
  };

  // The single composition writer: state.js feeds cross-tab storage changes
  // into the mirrors so readComposition never regresses another tab's edit.
  if (yga.state && yga.state._registerCompWriter) {
    yga.state._registerCompWriter({
      adopt: function (profileId, newValue) {
        compositionMirrors.set(profileId, newValue || {});
      }
    });
  }
})(window.yga);

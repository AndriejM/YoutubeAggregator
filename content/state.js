window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Subs cache yga:subs:<accountKey> (PLAN.md §5); the key is set by
  // accounts.js detection (fallback "default"). Legacy fixed key is migrated.
  let accountKey = "default";
  let CACHE_KEY = "yga:subs:default";
  const WRITE_DEBOUNCE_MS = 300; // storage write-amplification guard (PLAN.md §5)

  const listeners = new Set();
  let subs = null; // last known catalog, keyed by channelId
  let writeTimer = 0;

  function serialize(map) {
    return JSON.stringify(Array.from(map.values()).map((s) => ({
      c: s.channelId, t: s.title, a: s.avatarUrl, u: s.lastSeenAt || 0
    })));
  }

  function deserialize(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    for (const s of raw) {
      map.set(s.c, { channelId: s.c, title: s.t, avatarUrl: s.a, lastSeenAt: s.u });
    }
    return map;
  }

  function flushWrite() {
    writeTimer = 0;
    if (!subs) return;
    const payload = {};
    payload[CACHE_KEY] = JSON.parse(serialize(subs));
    chrome.storage.local.set(payload);
  }

  function scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
  }

  // Channels of the active profile (PLAN.md §5 composition rules).
  // null = catalog not loaded yet → the widget shows its loading placeholder.
  async function profileView() {
    if (!subs) return null;
    const all = Array.from(subs.values());
    if (!yga.profiles) return all;
    const id = await yga.profiles.activeProfileId();
    const ids = await yga.profiles.syncProfile(id, all);
    if (!ids) return all;
    const wanted = new Set(ids);
    return all.filter((s) => wanted.has(s.channelId));
  }

  // Returns true if the catalog changed (PLAN.md §11: refresh only on YouTube-side change).
  function mergeIntoCache(list) {
    if (!subs) return true;
    let changed = false;
    const now = Date.now();
    const seen = new Set();
    for (const item of list) {
      seen.add(item.channelId);
      const prev = subs.get(item.channelId);
      if (
        !prev ||
        prev.title !== item.title ||
        prev.avatarUrl !== item.avatarUrl
      ) {
        subs.set(item.channelId, {
          channelId: item.channelId,
          title: item.title,
          avatarUrl: item.avatarUrl,
          lastSeenAt: now
        });
        changed = true;
      } else {
        prev.lastSeenAt = now;
      }
    }
    if (seen.size !== subs.size) changed = true;
    // Drop unsubscribed channels only when the fresh list looks complete:
    // a partial deep-scan must never wipe the cache.
    if (list.length > 0 && list.length >= subs.size * 0.5) {
      for (const id of Array.from(subs.keys())) {
        if (!seen.has(id)) {
          subs.delete(id);
          changed = true;
        }
      }
    }
    return changed;
  }

  yga.state = {
    // Called after account detection; migrates the legacy stage-1 cache and
    // re-renders listeners under the new key (PLAN.md §5). Returns true when
    // the key actually changed, so the widget can drop account-scoped UI state.
    async setAccountKey(key) {
      if (!key || key === accountKey) return false;
      accountKey = key;
      CACHE_KEY = "yga:subs:" + key;
      const stored = await chrome.storage.local.get(CACHE_KEY);
      if (stored[CACHE_KEY]) {
        subs = null; // force reload under the new key
      } else {
        const legacy = await chrome.storage.local.get("yga:subs:default");
        subs = legacy["yga:subs:default"] ? deserialize(legacy["yga:subs:default"]) : null;
        if (subs) {
          flushWrite();
          await chrome.storage.local.remove("yga:subs:default");
        }
      }
      if (!subs) await this.loadCache();
      await emit();
      return true;
    },

    async loadCache() {
      if (subs) return subs;
      const stored = await chrome.storage.local.get(CACHE_KEY);
      subs = deserialize(stored[CACHE_KEY]);
      return subs;
    },

    // Merge a fresh catalog from bridge/browse into the cache; persist only on change.
    async updateSubs(list) {
      if (!subs) await this.loadCache();
      const changed = mergeIntoCache(list);
      if (changed) {
        scheduleWrite();
        await emit();
      }
      return subs;
    },

    // Channels of the ACTIVE profile (stage 2), not the whole catalog.
    async getVisibleSubs() {
      if (!subs) await this.loadCache();
      return profileView();
    },

    // The whole catalog, ignoring membership — for the channel picker (§9.2.1).
    async getAllSubs() {
      if (!subs) await this.loadCache();
      return subs ? Array.from(subs.values()) : [];
    },

    // Re-render listeners from cache after a profile switch (§11 stage 2:
    // switching must not trigger a YouTube request).
    async refreshVisible() {
      await emit();
    },

    onSubsChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };

  async function emit() {
    const snapshot = await profileView();
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.debug("[yga] subs listener failed:", e);
      }
    }
  }
})(window.yga);

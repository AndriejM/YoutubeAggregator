window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Subs cache yga:subs:<accountKey> (PLAN.md §5). Stage 1 uses a fixed key;
  // real account detection arrives in stage 2 (PLAN.md §11).
  const ACCOUNT_KEY = "default";
  const CACHE_KEY = "yga:subs:" + ACCOUNT_KEY;
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
        emit();
      }
      return subs;
    },

    getSubs() {
      return subs ? Array.from(subs.values()) : [];
    },

    onSubsChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };

  function emit() {
    const snapshot = Array.from(subs.values());
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.debug("[yga] subs listener failed:", e);
      }
    }
  }
})(window.yga);

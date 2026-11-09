window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Subs cache yga:subs:<accountKey> (PLAN.md §5); the key is set by
  // accounts.js detection (fallback "default"). Legacy fixed key is migrated.
  let accountKey = "default";
  let CACHE_KEY = "yga:subs:default";
  const WRITE_DEBOUNCE_MS = 300; // storage write-amplification guard (PLAN.md §5)
  const STALE_MS = 24 * 60 * 60 * 1000; // "stale" counter style (PLAN.md §10)

  const listeners = new Set();
  const counterListeners = new Set();
  const compListeners = new Set();
  let subs = null; // last known catalog, keyed by channelId
  let writeTimer = 0;

  // New-video counters (stage 3, PLAN.md §10). The worker owns the RSS cache
  // and reports unbounded counts (lastVisitAt = 0); the per-profile view
  // applies lastVisitAt from the composition. Errors follow the channel.
  const counts = new Map(); // channelId -> { newCount, fetchedAt, error }
  let aggregate = null; // worker aggregate of the active profile
  let aggregateSeq = -1; // freshness of the applied aggregate (SW counter; -1 = none)
  let activeId = null; // active profile at last render (footer target)
  let countsPending = false; // a refresh call may fire before counters load
  let compWriter = null; // profiles.js registers the only composition writer

  function registerCompWriter(fn) {
    compWriter = fn;
  }

  // Cross-tab convergence of yga:profile-channels:<id> (stage 3). Only one
  // writer (profiles.js) writes this key; the bridge is best-effort — storage
  // is the truth and a remount reloads it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    for (const key in changes) {
      if (key.indexOf("yga:profile-channels:") === 0) {
        const id = key.slice("yga:profile-channels:".length);
        if (compWriter) compWriter.adopt(id, changes[key].newValue);
        touched = true;
      }
    }
    if (touched) for (const cb of compListeners) {
      try {
        cb();
      } catch (e) {
        console.debug("[yga] comp listener failed:", e);
      }
    }
  });

  // Worker → tabs bus (chrome.alarms-driven; see service-worker.js).
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "counters:counts") {
        const fresh = msg.counts || {};
        let changed = false;
        for (const id in fresh) {
          counts.set(id, fresh[id]);
          changed = true;
        }
        if (changed) emitCounters();
      } else if (msg.type === "counters:aggregate") {
        // seq orders bus messages against request-response snapshots
        if (msg.seq == null || aggregateSeq < 0 || msg.seq > aggregateSeq) {
          aggregate = {
            profileId: msg.profileId,
            newCount: msg.newCount,
            errorCount: msg.errorCount,
            stale: !!msg.stale
          };
          aggregateSeq = msg.seq == null ? aggregateSeq : msg.seq;
          emitCounters();
        }
      }
    });
  } catch (e) {
    console.debug("[yga] counters bus unavailable:", e);
  }

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

  // Adds derived counter fields to channels of the ACTIVE profile in place
  // (channel records are owned by subs, so this is a map write, no copy).
  function decorate(list) {
    if (!list || !yga.profiles) return null;
    const id = yga.profiles.lastActiveId();
    activeId = id;
    return yga.profiles.getComposition(id).then(function (comp) {
      const now = Date.now();
      for (const s of list) {
        const rec = comp[s.channelId] || {};
        const c = counts.get(s.channelId);
        const lastVisitAt = rec.lastVisitAt || 0;
        const newCount = countFor(c, lastVisitAt);
        s.newCount = newCount;
        s.lastVisitAt = lastVisitAt;
        s.groupId = rec.groupId || null; // group tree (§18)
        s.counterFetchedAt = c ? c.fetchedAt : 0;
        s.counterError = c && c.error ? c.error : 0;
        s.counterStale = !!c && !!c.fetchedAt && now - c.fetchedAt > STALE_MS;
      }
      // Footer totals come from the rows: they are the active profile's view
      // (lastVisitAt applied), so the chip can never contradict the list next
      // to it. The worker aggregate only covers the pre-catalog phase.
      let sum = 0;
      let errorCount = 0;
      let stale = false;
      for (const s of list) {
        if (s.counterError) errorCount++;
        if (s.counterStale) stale = true;
        sum += s.newCount;
      }
      aggregate = { profileId: id, newCount: sum, errorCount: errorCount, stale: stale };
      return list;
    });
  }

  // Per-profile view of the worker's shared cache (PLAN.md §10.4):
  // new videos = unwatched entries published after this profile's lastVisitAt.
  // Records written before the `at` payload existed fall back to the
  // unbounded count until the next refresh repopulates the timestamps.
  function countFor(c, lastVisitAt) {
    if (!c) return 0;
    if (Array.isArray(c.at)) return yga.counters ? yga.counters.newSince(c.at, lastVisitAt) : c.at.length;
    return c.newCount || 0;
  }

  // A refresh may rotate entries without changing newCount — compare the
  // timestamps too, otherwise the tab keeps a stale view.
  function sameSnapshot(a, b) {
    if (a.fetchedAt !== b.fetchedAt || a.newCount !== b.newCount || a.error !== b.error) return false;
    const x = a.at || [];
    const y = b.at || [];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
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

  function emitCounters() {
    for (const cb of counterListeners) {
      try {
        cb();
      } catch (e) {
        console.debug("[yga] counter listener failed:", e);
      }
    }
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

    // Channels of the ACTIVE profile (stage 2) with counter fields (§10),
    // not the whole catalog.
    async getVisibleSubs() {
      if (!subs) await this.loadCache();
      const list = await profileView();
      return decorate(list);
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

    // ---- counters (stage 3) ----

    // Direct snapshot from counters:init — the tab paints without waiting for
    // the worker→tabs alarm bus.
    applyInitSnapshot(countsMap, agg, seq) {
      const fresh = countsMap || {};
      let changed = false;
      for (const id in fresh) {
        const prev = counts.get(id);
        const next = fresh[id];
        if (!prev || !sameSnapshot(prev, next)) {
          counts.set(id, next);
          changed = true;
        }
      }
      if (agg) {
        aggregate = { profileId: agg.profileId, newCount: agg.newCount, errorCount: agg.errorCount, stale: !!agg.stale };
        aggregateSeq = typeof seq === "number" ? seq : aggregateSeq;
        changed = true;
      }
      if (changed) emitCounters();
    },

    // Kick the worker refresh for the active profile (PLAN.md §10.1).
    // minIntervalMs freshness is the worker's decision, not ours.
    async refreshCounters(opts) {
      if (countsPending) return null;
      countsPending = true;
      try {
        const id = yga.profiles ? await yga.profiles.activeProfileId() : "p_1";
        const res = await chrome.runtime.sendMessage({
          type: "counters:refresh",
          profileId: id,
          force: !!(opts && opts.force)
        });
        if (res && res.ok === false) console.debug("[yga] counters refresh:", res.error);
        if (res && res.ok && res.aggregate) {
          this.applyInitSnapshot(null, res.aggregate, res.aggregateSeq);
        }
        return res;
      } catch (e) {
        console.debug("[yga] counters refresh failed:", e);
        return null;
      } finally {
        countsPending = false;
      }
    },

    // Reset a channel counter: single writer (the worker) avoids a storage
    // race with the composition writer (profiles.js). The shared count cache
    // is profile-blind and must NOT be rewritten here — the reset lives in
    // lastVisitAt, which decorate() applies per profile.
    async markVisited(profileId, channelId) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "counters:setVisit",
          profileId: profileId,
          channelId: channelId
        });
        if (res && res.ok) {
          // The worker wrote composition directly to storage; adopt the value
          // into our mirror or the next syncProfile write would resurrect the
          // stale lastVisitAt=0.
          if (compWriter) {
            const comp = await yga.profiles.getComposition(profileId);
            comp[channelId] = Object.assign({}, comp[channelId], { lastVisitAt: res.lastVisitAt });
            compWriter.adopt(profileId, comp);
          }
          emitCounters();
          return res.lastVisitAt;
        }
      } catch (e) {
        console.warn("[yga] markVisited failed:", e);
      }
      return 0;
    },

    // Bulk "mark watched" for the config panel (§9.2.1): one worker write and
    // one mirror adopt for the whole selection, so a 200-channel bulk op does
    // not become 200 composition writes.
    async markVisitedBatch(profileId, channelIds) {
      if (!profileId || !channelIds || !channelIds.length) return 0;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "counters:setVisits",
          profileId: profileId,
          channelIds: channelIds
        });
        if (res && res.ok) {
          if (compWriter) {
            const comp = await yga.profiles.getComposition(profileId);
            for (const id of channelIds) {
              if (!id) continue;
              comp[id] = Object.assign({}, comp[id], { lastVisitAt: res.lastVisitAt });
            }
            compWriter.adopt(profileId, comp);
          }
          emitCounters();
          return res.lastVisitAt;
        }
        if (res && res.error) console.debug("[yga] markVisitedBatch:", res.error);
      } catch (e) {
        console.warn("[yga] markVisitedBatch failed:", e);
      }
      return 0;
    },

    getAggregate() {
      return aggregate;
    },

    countersReady() {
      return counts.size > 0;
    },

    // Raw worker record for one channel (config panel §9.2.1): lets the panel
    // derive the same lastVisitAt view as decorate() without re-running
    // syncProfile on every keystroke.
    countOf(channelId) {
      return counts.get(channelId) || null;
    },

    onCountersChanged(cb) {
      counterListeners.add(cb);
      return () => counterListeners.delete(cb);
    },

    // Composition convergence across tabs; profiles.js drives adopt().
    onCompositionChanged(cb) {
      compListeners.add(cb);
      return () => compListeners.delete(cb);
    },

    _registerCompWriter: registerCompWriter,

    onSubsChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };

  async function emit() {
    const snapshot = await profileView();
    await decorate(snapshot);
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.debug("[yga] subs listener failed:", e);
      }
    }
  }
})(window.yga);

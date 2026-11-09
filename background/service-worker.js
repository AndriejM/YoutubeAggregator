// Service worker (PLAN.md §7, §10): the only place that fetches
// /feeds/videos.xml (auth-free, host_permissions). Owns the RSS cache
// yga:videos:<channelId>, the per-profile newCount cache, the throttled
// batch queue, and the scheduled-refresh alarm (mode switch lands in stage 4).
// MV3 service workers have no DOMParser — the parser lives in the shared
// content/rss-parser.js so the Node harness and test/smoke.html reuse it.
import "../content/rss-parser.js";

const parser = globalThis.yga.rssParser;

const VIDEO_PREFIX = "yga:videos:";
const VIDEOS_INDEX = "yga:videos-index";
const ACCOUNT_KEY = "yga:account";
const SETTINGS_KEY = "yga:settings";
const ALARM_NAME = "yga:scheduled-refresh";
const EMIT_ALARM = "yga:emit-flush";
const MIN_ALARM_MINUTES = 60; // PLAN.md §10: scheduled period floor
const REQUEST_GAP_MS = 300; // 200–400 ms pause between fetches (PLAN.md §10.2)
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRIES = 1; // 429/5xx/network: one retry after backoff
const STALE_MS = 24 * 60 * 60 * 1000; // "stale" marker threshold (PLAN.md §10)
const MAX_ENTRIES_KEPT = 20; // RSS ships ~15 (PLAN.md §6); watched flags need headroom

// Freshness floor if yga:settings is missing or unreadable.
const DEFAULT_MIN_INTERVAL_MS = 90000;

// SW-local state: the worker restarts freely, all durable state is in
// storage (PLAN.md §12 "MV3 service worker sleeps").
let queue = []; // { channelId, force, priority, seq, done }
let pumpRunning = false;
const countCache = new Map(); // channelId -> { newCount, fetchedAt, error }
const profileCounts = new Map(); // profileId -> { newCount, errorCount, stale, at }
let emitQueue = []; // pending bus messages, one alarm each (SW→tabs)
let aggregateSeq = 0; // SW-lifetime freshness tag for counters:aggregate
let lastRun = null; // { at, mode, requested, errors }

function now() {
  return Date.now();
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const s = stored[SETTINGS_KEY];
  return s && s.version === 1 ? s : null;
}

function refreshCfg(settings) {
  const r = (settings && settings.refresh) || {};
  return {
    minIntervalMs:
      Number.isFinite(r.minIntervalMs) && r.minIntervalMs >= 0
        ? r.minIntervalMs
        : DEFAULT_MIN_INTERVAL_MS,
    batch:
      Number.isInteger(r.batch) && r.batch >= 1 && r.batch <= 50
        ? r.batch
        : 12
  };
}

function videoKey(id) {
  return VIDEO_PREFIX + id;
}

async function loadVideoRecords(ids) {
  const out = new Map();
  const CHUNK = 900; // storage.local.get stays responsive on 1000+ keys
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).map(videoKey);
    const stored = await chrome.storage.local.get(chunk);
    for (const key of chunk) {
      const rec = stored[key];
      if (rec) out.set(key.slice(VIDEO_PREFIX.length), rec);
    }
  }
  return out;
}

// { ids, comp } — comp is the raw composition map, needed for per-profile
// lastVisitAt (PLAN.md §5: counters reset independently per profile).
async function profileData(profileId) {
  const accountStore = await chrome.storage.local.get(ACCOUNT_KEY);
  const accountKey = (accountStore[ACCOUNT_KEY] || {}).accountKey || "default";
  const subsKey = "yga:subs:" + accountKey;
  const [profilesStore, compStore, subsStore] = await Promise.all([
    chrome.storage.local.get("yga:profiles"),
    chrome.storage.local.get("yga:profile-channels:" + profileId),
    chrome.storage.local.get(subsKey)
  ]);
  const profile = (profilesStore["yga:profiles"] || {})[profileId];
  if (!profile) return null;
  const comp = compStore["yga:profile-channels:" + profileId] || {};
  // The subs cache is stored compactly as [{c,t,a,u}] (state.js serialize);
  // accept a plain map too so the worker never reads array indices as ids.
  const subsRaw = subsStore[subsKey] || {};
  const subIds = Array.isArray(subsRaw)
    ? subsRaw.map(function (s) { return s && s.c; }).filter(Boolean)
    : Object.keys(subsRaw);

  // Mirrors profiles.js isMember(): unsubscribed is automatic, excluded is
  // the user's choice (PLAN.md §5). includeAllSubs = the subscription catalog.
  const member = (id) => {
    const rec = comp[id];
    return !rec || (!rec.unsubscribed && !rec.excluded);
  };
  if (profile.includeAllSubs) return { ids: subIds.filter(member), comp: comp };
  return {
    ids: Object.keys(comp).filter((id) => !comp[id].unsubscribed && !comp[id].excluded),
    comp: comp
  };
}

async function loadProfileChannels(profileId) {
  const data = await profileData(profileId);
  return data ? data.ids : null;
}

// Unbounded count (lastVisitAt = 0): "everything not manually marked watched".
function computeCounts(record) {
  const entries = (record && record.entries) || [];
  let newCount = 0;
  for (const e of entries) {
    if (!e.watched) newCount++;
  }
  return newCount;
}

// publishedAt of every unwatched entry, newest first. The worker stays
// profile-blind: the content world derives the per-profile view as
// `at.filter(t => t > lastVisitAt).length` (PLAN.md §10.4), so one shared
// cache serves every profile and a reset in one profile cannot leak into
// another.
function unwatchedAt(record) {
  const entries = (record && record.entries) || [];
  const at = [];
  for (const e of entries) {
    if (!e.watched && e.publishedAt) at.push(e.publishedAt);
  }
  return at.sort((a, b) => b - a);
}

function countValue(record) {
  return {
    newCount: (record && record.newCount) || 0,
    fetchedAt: (record && record.fetchedAt) || 0,
    error: (record && record.error) || 0,
    at: unwatchedAt(record)
  };
}

// Profile-scoped count: unwatched AND published after that profile's visit.
function countSince(record, lastVisitAt) {
  const at = unwatchedAt(record);
  if (!lastVisitAt) return at.length;
  let n = 0;
  for (const t of at) if (t > lastVisitAt) n++;
  return n;
}

// A feed refresh can rotate entries while newCount stays the same (one video
// out, one in) — the timestamps changed, so the tabs must still be told.
function sameCountValue(a, b) {
  if (a.newCount !== b.newCount || a.error !== b.error || a.fetchedAt !== b.fetchedAt) return false;
  const x = a.at || [];
  const y = b.at || [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function recomputeAllCounts() {
  const index = await chrome.storage.local.get(VIDEOS_INDEX);
  const ids = Object.keys(index[VIDEOS_INDEX] || {});
  const records = await loadVideoRecords(ids);
  countCache.clear();
  profileCounts.clear();
  const counts = {};
  for (const id of ids) {
    const rec = records.get(id) || {};
    const value = countValue(rec);
    countCache.set(id, value);
    counts[id] = value;
  }
  await emitToAlarms({ type: "counters:counts", counts: counts });
  return counts;
}

async function bumpVideosIndex(ids) {
  if (!ids.length) return;
  const stored = await chrome.storage.local.get(VIDEOS_INDEX);
  const index = stored[VIDEOS_INDEX] || {};
  const stamp = now();
  for (const id of ids) index[id] = stamp;
  const payload = {};
  payload[VIDEOS_INDEX] = index;
  await chrome.storage.local.set(payload);
}

// Profile-scoped aggregate → alarms bus so other tabs learn about resets
// without a full refresh (alarms do not fire in the sending context).
// The number is lastVisitAt-aware (per-profile composition), so it matches the
// sum of the row counters a tab renders; force=true still emits so a visit
// reset travels even when the total happens to be unchanged.
async function emitProfileCounts(profileId, force) {
  const data = await profileData(profileId);
  if (!data) return;
  const ids = data.ids;
  const comp = data.comp;
  const records = await loadVideoRecords(ids);
  let newCount = 0;
  let errorCount = 0;
  let stale = false;
  for (const id of ids) {
    const rec = records.get(id) || {};
    newCount += countSince(rec, (comp[id] || {}).lastVisitAt);
    if (rec.error) errorCount++;
    if (rec.fetchedAt && now() - rec.fetchedAt > STALE_MS) stale = true;
  }
  const prev = profileCounts.get(profileId);
  if (!force && prev && prev.newCount === newCount && prev.errorCount === errorCount && prev.stale === stale) return;
  profileCounts.set(profileId, { newCount: newCount, errorCount: errorCount, stale: stale, at: now() });
  const agg = { profileId: profileId, newCount: newCount, errorCount: errorCount, stale: stale };
  await emitToAlarms({
    type: "counters:aggregate",
    profileId: profileId,
    newCount: newCount,
    errorCount: errorCount,
    stale: stale,
    seq: ++aggregateSeq
  });
  return agg;
}

// Bus: one shared flush alarm instead of one per message — with 1000+ channels
// the per-write emits used to outrun Chrome's per-extension alarm quota and
// silently starve the tabs (counters stuck at 0 despite fresh storage).
async function flushEmitAlarm() {
  try {
    await chrome.alarms.create(EMIT_ALARM, { delayInMinutes: 1.1 });
  } catch (e) {
    console.debug("[yga] emit alarm failed:", e);
  }
}

async function emitToAlarms(message) {
  emitQueue.push(message);
  await flushEmitAlarm();
}

async function flushEmitQueue() {
  while (emitQueue.length) {
    const batch = emitQueue.splice(0, emitQueue.length);
    const merged = {};
    const other = [];
    for (const m of batch) {
      if (m && m.type === "counters:counts") Object.assign(merged, m.counts || {});
      else other.push(m);
    }
    const out = [];
    if (Object.keys(merged).length) out.push({ type: "counters:counts", counts: merged });
    out.push(...other);
    for (const m of out) {
      try {
        await chrome.runtime.sendMessage(m);
      } catch (e) {
        // no receiving tab / self-echo — the counters:init snapshot covers tabs
      }
    }
  }
}

// RSS ships ~15 entries (PLAN.md §6): keep the 15 newest plus headroom so a
// user-watched flag survives one refresh; flags are merged before trimming.
function mergeEntries(feed, prev) {
  const watchedAt = new Map();
  for (const e of (prev && prev.entries) || []) {
    if (e.watched && e.watchedAt) watchedAt.set(e.videoId, e.watchedAt);
  }
  const merged = feed.entries.map((e) => {
    const known = watchedAt.get(e.videoId);
    return known ? Object.assign({}, e, { watched: true, watchedAt: known }) : e;
  });
  return merged.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ENTRIES_KEPT);
}

async function writeRecord(channelId, record) {
  record.newCount = computeCounts(record);
  const payload = {};
  payload[videoKey(channelId)] = record;
  await chrome.storage.local.set(payload);
  await bumpVideosIndex([channelId]);

  const value = countValue(record);
  const prev = countCache.get(channelId);
  countCache.set(channelId, value);
  const changed = !prev || !sameCountValue(prev, value);
  if (changed) await emitToAlarms({ type: "counters:counts", counts: { [channelId]: value } });
}

async function fetchOne(channelId, force) {
  const settings = await getSettings();
  const cfg = refreshCfg(settings);
  const records = await loadVideoRecords([channelId]);
  const prev = records.get(channelId) || null;
  const fresh = prev && prev.fetchedAt && !prev.error && now() - prev.fetchedAt < cfg.minIntervalMs;
  if (fresh && !force) return { skipped: true };

  let lastError = "network";
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const headers = { Accept: "application/atom+xml" };
    if (prev && prev.etag) headers["If-None-Match"] = prev.etag;
    let response;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      response = await fetch(
        "https://www.youtube.com/feeds/videos.xml?channel_id=" + encodeURIComponent(channelId),
        { headers: headers, signal: ctrl.signal }
      );
      clearTimeout(timer);
    } catch (e) {
      lastError = "network";
      continue;
    }
    if (response.status === 304 && prev) {
      prev.fetchedAt = now();
      prev.error = 0;
      await writeRecord(channelId, prev);
      return { ok: true, notModified: true };
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = "throttled";
      continue;
    }
    if (!response.ok) {
      lastError = "http";
      break;
    }
    const text = await response.text();
    const feed = parser.parseVideosXml(text);
    if (!feed) {
      lastError = "parse";
      break;
    }
    await writeRecord(channelId, {
      entries: mergeEntries(feed, prev),
      fetchedAt: now(),
      etag: response.headers.get("ETag") || (prev && prev.etag) || "",
      title: feed.title || (prev && prev.title) || "",
      channelId: feed.channelId || channelId,
      error: 0
    });
    return { ok: true };
  }

  // Honest failure: keep old entries, mark the error, never reset the counter.
  const record = prev || { entries: [], fetchedAt: 0, etag: "", title: "", channelId: channelId };
  record.fetchedAt = now();
  record.error = now();
  await writeRecord(channelId, record);
  return { error: lastError };
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
      const job = queue.shift();
      let result = { error: "aborted" };
      try {
        result = await fetchOne(job.channelId, job.force);
      } catch (e) {
        console.debug("[yga] RSS job failed for " + job.channelId + ":", e);
      }
      job.done(result);
      if (queue.length) await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
    }
  } finally {
    pumpRunning = false;
  }
}

let jobSeq = 0;

// One live job per channel: duplicates (in-request or already queued) resolve
// immediately — the running job will have refreshed the cache by the time the
// caller proceeds. Returns { jobs, expected } where jobs fills as the pump
// drains and expected is the number of jobs that will resolve.
function enqueue(channelIds, opts) {
  const jobs = [];
  const pending = new Set();
  for (const job of queue) pending.add(job.channelId);
  let expected = 0;
  for (const channelId of channelIds) {
    if (!channelId || pending.has(channelId)) continue;
    pending.add(channelId);
    expected++;
    const job = {
      channelId: channelId,
      force: !!opts.force,
      priority: opts.priority ? 1 : 0,
      seq: ++jobSeq,
      done: function (result) {
        jobs.push({ channelId: this.channelId, result: result });
      }
    };
    queue.push(job);
  }
  pump();
  return { jobs: jobs, expected: expected };
}

async function refreshChannels(profileId, channelIds, opts) {
  const started = now();
  const enq = enqueue(channelIds, opts);
  while (enq.jobs.length < enq.expected) await new Promise((r) => setTimeout(r, 100));
  let errors = 0;
  for (const j of enq.jobs) if (j.result && j.result.error) errors++;
  const agg = profileId ? await emitProfileCounts(profileId) : null;
  lastRun = {
    at: started,
    mode: opts.scheduled ? "scheduled" : "onOpen",
    requested: enq.expected,
    errors: errors
  };
  return { requested: enq.expected, queued: channelIds.length - enq.expected, errors: errors, lastRun: lastRun, aggregate: agg, aggregateSeq: aggregateSeq };
}

// ---- scheduled mode (PLAN.md §10; the on/off switch is stage 4) ----

async function syncAlarm() {
  const settings = await getSettings();
  const sched = ((settings && settings.refresh) || {}).scheduled || {};
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!sched.enabled) {
    if (alarm) await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const periodInMinutes = Math.max(
    MIN_ALARM_MINUTES,
    Number(sched.periodInMinutes) || MIN_ALARM_MINUTES
  );
  if (alarm && alarm.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodInMinutes });
}

async function scheduledRun() {
  const settings = await getSettings();
  const sched = ((settings && settings.refresh) || {}).scheduled || {};
  if (!sched.enabled) return;
  const profileId = (settings && settings.activeProfileId) || "p_1";
  const ids = await loadProfileChannels(profileId);
  if (!ids || !ids.length) return;
  const capped = ids.slice(0, Math.max(1, Number(sched.maxChannelsPerRun) || 60));
  await refreshChannels(profileId, capped, { scheduled: true });
}

// ---- message API (PLAN.md §11 stage 3: refreshNewCounts worker API) ----

function handleCounters(msg) {
  switch (msg.type) {
    case "counters:refresh":
      return (async () => {
        const ids = Array.isArray(msg.channelIds) && msg.channelIds.length
          ? msg.channelIds
          : await loadProfileChannels(msg.profileId || "p_1");
        if (!ids) return { ok: false, error: "unknownProfile" };
        const res = await refreshChannels(msg.profileId, ids, {
          force: !!msg.force,
          scheduled: !!msg.scheduled,
          priority: !msg.scheduled
        });
        return Object.assign({ ok: true }, res);
      })();

    case "counters:setVisit":
      return (async () => {
        const { profileId, channelId } = msg;
        if (!profileId || !channelId) return { ok: false, error: "badArgs" };
        const key = "yga:profile-channels:" + profileId;
        const stored = await chrome.storage.local.get(key);
        const comp = stored[key] || {};
        const rec = comp[channelId] || { addedAt: now() };
        rec.lastVisitAt = Number(msg.lastVisitAt) || now();
        comp[channelId] = rec;
        const payload = {};
        payload[key] = comp;
        await chrome.storage.local.set(payload);
        await emitProfileCounts(profileId, true);
        return { ok: true, lastVisitAt: rec.lastVisitAt };
      })();

    case "counters:get":
      return (async () => {
        const ids = Array.isArray(msg.channelIds) ? msg.channelIds : [];
        const records = await loadVideoRecords(ids);
        const channelCounts = {};
        for (const [id, rec] of records) {
          channelCounts[id] = countValue(rec);
          channelCounts[id].total = (rec.entries || []).length;
        }
        return {
          ok: true,
          channelCounts: channelCounts,
          aggregate: profileCounts.get(msg.profileId) || null,
          lastRun: lastRun
        };
      })();

    case "counters:init":
      return (async () => {
        // The response carries the snapshot itself: tabs must not depend on
        // the alarm bus for their initial paint.
        const counts = await recomputeAllCounts();
        await syncAlarm();
        const pid = msg.profileId || "p_1";
        const aggregate = await emitProfileCounts(pid, true);
        return { ok: true, counts: counts, aggregate: aggregate, aggregateSeq: aggregateSeq };
      })();

    case "counters:settings":
      return (async () => {
        await syncAlarm();
        return { ok: true };
      })();

    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || msg.type.indexOf("counters:") !== 0) return false;
  const promise = handleCounters(msg);
  if (!promise) return false;
  promise.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === ALARM_NAME) {
    scheduledRun().catch((e) => console.debug("[yga] scheduled run failed:", e));
    return;
  }
  if (alarm.name === EMIT_ALARM) {
    flushEmitQueue().catch((e) => console.debug("[yga] emit flush failed:", e));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncAlarm().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  syncAlarm().catch(() => {});
});

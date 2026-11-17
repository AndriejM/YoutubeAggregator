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
const MIN_ALARM_MINUTES = 60; // PLAN.md §10: scheduled period floor
const REQUEST_GAP_MS = 300; // 200–400 ms pause between fetches (PLAN.md §10.2)
// Bus window: slightly above REQUEST_GAP_MS so consecutive writes coalesce
// into one message while the pump still paints every few hundred ms.
const EMIT_FLUSH_MS = 350;
const EMIT_SEND_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRIES = 1; // 429/5xx/network: one retry after backoff
const STALE_MS = 24 * 60 * 60 * 1000; // "stale" marker threshold (PLAN.md §10)
const MAX_ENTRIES_KEPT = 20; // RSS ships ~15 (PLAN.md §6); watched flags need headroom
// Consecutive throttled feeds end the pass: the rest of the queue would only
// hit the same 429 wall and burn the retry budget of every channel in it.
const THROTTLE_STOP = 3;
// «Все новые» (PLAN.md backlog 1): how many ids one /watch_videos URL carries.
// 50 ids ≈ 600 characters, well inside Chrome's URL budget; 100 is the ceiling
// the settings field accepts.
const DEFAULT_WATCH_ALL_LIMIT = 50;
const MAX_WATCH_ALL_LIMIT = 100;

// Freshness floor if yga:settings is missing or unreadable.
const DEFAULT_MIN_INTERVAL_MS = 90000;

// SW-local state: the worker restarts freely, all durable state is in
// storage (PLAN.md §12 "MV3 service worker sleeps").
let queue = []; // { channelId, force, priority, seq, done }
let pumpRunning = false;
const inFlight = new Set();
let recomputeLock = null;
const countCache = new Map(); // channelId -> { newCount, fetchedAt, error }
const profileCounts = new Map(); // profileId -> { newCount, errorCount, stale, at }
let emitQueue = []; // pending bus messages, coalesced by one timer (SW→tabs)
let emitTimer = 0; // pending flush window
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

// Stage 10 (PLAN.md §19): video filters are global settings, not per profile —
// the shared count cache stays profile-blind (§10.4) and one recompute serves
// every tab. Defaults = all filters off (behaviour identical to stage 9).
const DAY_MS = 24 * 60 * 60 * 1000;

function filtersCfg(settings) {
  const f = (settings && settings.filters) || {};
  return {
    hideShorts: !!f.hideShorts,
    hideLive: !!f.hideLive,
    maxAgeDays: Number.isFinite(f.maxAgeDays) && f.maxAgeDays > 0 ? f.maxAgeDays : 0
  };
}

// Shorts and live streams are marked by the entry's alternate link
// (youtube.com/shorts/<id>, youtube.com/live/<id>); media:title is the video
// title, so matching the label missed every real Short and hid videos titled
// «…Live…». Records cached before `kind` existed stay unclassified until the
// next fetch (counters:settings refetches them).
function entryVisible(e, filters, at) {
  if (!e || !e.publishedAt) return false;
  const kind = String(e.kind || "video");
  if (filters.hideShorts && kind === "shorts") return false;
  if (filters.hideLive && kind === "live") return false;
  if (filters.maxAgeDays && at - e.publishedAt > filters.maxAgeDays * DAY_MS) return false;
  return true;
}

function videoKey(id) {
  return VIDEO_PREFIX + id;
}

// «Все новые» (PLAN.md backlog 1): the id cap lives with the other widget
// settings; anything out of range falls back to the default.
function watchAllCfg(settings) {
  const w = (settings && settings.widget) || {};
  const n = Number(w.watchAllLimit);
  return Number.isFinite(n) && n >= 1 && n <= MAX_WATCH_ALL_LIMIT
    ? Math.floor(n)
    : DEFAULT_WATCH_ALL_LIMIT;
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

// Unbounded count (lastVisitAt = 0): "everything not manually marked watched"
// and not hidden by the stage-10 filters.
function computeCounts(record, filters, at) {
  const entries = (record && record.entries) || [];
  let newCount = 0;
  for (const e of entries) {
    if (!e.watched && e.videoId && entryVisible(e, filters, at)) newCount++;
  }
  return newCount;
}

// publishedAt of every unwatched, filter-visible entry, newest first. The
// worker stays profile-blind: the content world derives the per-profile view
// as `at.filter(t => t > lastVisitAt).length` (PLAN.md §10.4), so one shared
// cache serves every profile and a reset in one profile cannot leak into
// another.
function unwatchedAt(record, filters, at) {
  const entries = (record && record.entries) || [];
  const out = [];
  for (const e of entries) {
    if (!e.watched && e.publishedAt && e.videoId && entryVisible(e, filters, at)) out.push(e.publishedAt);
  }
  return out.sort((a, b) => b - a);
}

function countValue(record, filters, at) {
  return {
    // Recomputed from entries, never the stored record.newCount: a filter
    // change must repaint counts without a refetch.
    newCount: computeCounts(record, filters, at),
    fetchedAt: (record && record.fetchedAt) || 0,
    error: (record && record.error) || 0,
    streak: (record && record.errorStreak) || 0,
    at: unwatchedAt(record, filters, at)
  };
}

// Profile-scoped count: unwatched AND filter-visible AND published after that
// profile's visit.
function countSince(record, lastVisitAt, filters, at) {
  const at2 = unwatchedAt(record, filters, at);
  if (!lastVisitAt) return at2.length;
  let n = 0;
  for (const t of at2) if (t > lastVisitAt) n++;
  return n;
}

// «Все новые» (PLAN.md backlog 1): the ids of every new video of ONE profile,
// newest first, ready for /watch_videos?video_ids=. Pure on purpose — records,
// comp and filters come from the caller, so the ordering, the lastVisitAt cut,
// the filters and the cap are testable without storage. `records` is the Map
// loadVideoRecords returns; a plain id→record object is accepted too.
// Returns { ids, total, limit }: `total` is the uncut count, so the caller can
// say «shown 50 of 187» without a second pass.
function newVideoIds(records, comp, filters, at, limit, visits) {
  const found = [];
  const visitOf = (channelId) => {
    const fromView = visits && visits[channelId];
    if (Number.isFinite(fromView)) return fromView;
    return ((comp || {})[channelId] || {}).lastVisitAt || 0;
  };
  const collect = (record, channelId) => {
    const lastVisitAt = visitOf(channelId);
    const entries = (record && record.entries) || [];
    for (const e of entries) {
      if (!e || e.watched || !e.publishedAt || !e.videoId) continue;
      if (!entryVisible(e, filters, at)) continue;
      if (e.publishedAt <= lastVisitAt) continue;
      found.push({ id: e.videoId, publishedAt: e.publishedAt });
    }
  };
  if (records && typeof records.forEach === "function") records.forEach(collect);
  else for (const channelId in records || {}) collect(records[channelId], channelId);
  found.sort((a, b) => b.publishedAt - a.publishedAt);
  const seen = new Set();
  const ids = [];
  for (const f of found) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    ids.push(f.id);
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return { ids: cap ? ids.slice(0, cap) : ids, total: ids.length, limit: cap };
}

// One new video goes straight to the watch page; several become a YouTube
// auto-playlist. Video ids are [A-Za-z0-9_-]{11}, so the encoding is a
// formality — the URL stays readable in the address bar either way.
function watchAllUrl(ids) {
  if (!ids || !ids.length) return "";
  if (ids.length === 1) return "https://www.youtube.com/watch?v=" + encodeURIComponent(ids[0]);
  return "https://www.youtube.com/watch_videos?video_ids=" + ids.map(encodeURIComponent).join(",");
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
  if (recomputeLock) return recomputeLock;
  recomputeLock = (async () => {
    const settings = await getSettings();
    const filters = filtersCfg(settings);
    const at = now();
    const index = await chrome.storage.local.get(VIDEOS_INDEX);
    const ids = Object.keys(index[VIDEOS_INDEX] || {});
    const records = await loadVideoRecords(ids);
    countCache.clear();
    profileCounts.clear();
    const counts = {};
    for (const id of ids) {
      const rec = records.get(id) || {};
      const value = countValue(rec, filters, at);
      countCache.set(id, value);
      counts[id] = value;
    }
    await emitToTabs({ type: "counters:counts", counts: counts });
    return counts;
  })();
  try {
    return await recomputeLock;
  } finally {
    recomputeLock = null;
  }
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

// Profile-scoped aggregate → tabs bus so other tabs learn about resets
// without a full refresh.
// The number is lastVisitAt-aware (per-profile composition), so it matches the
// sum of the row counters a tab renders; force=true still emits so a visit
// reset travels even when the total happens to be unchanged.
async function emitProfileCounts(profileId, force) {
  const [data, settings] = await Promise.all([profileData(profileId), getSettings()]);
  if (!data) return;
  const filters = filtersCfg(settings);
  const at = now();
  const ids = data.ids;
  const comp = data.comp;
  const records = await loadVideoRecords(ids);
  let newCount = 0;
  let errorCount = 0;
  let stale = false;
  for (const id of ids) {
    const rec = records.get(id) || {};
    newCount += countSince(rec, (comp[id] || {}).lastVisitAt, filters, at);
    if (rec.error) errorCount++;
    if (rec.fetchedAt && now() - rec.fetchedAt > STALE_MS) stale = true;
  }
  const prev = profileCounts.get(profileId);
  if (!force && prev && prev.newCount === newCount && prev.errorCount === errorCount && prev.stale === stale) return;
  profileCounts.set(profileId, { newCount: newCount, errorCount: errorCount, stale: stale, at: now() });
  const agg = { profileId: profileId, newCount: newCount, errorCount: errorCount, stale: stale };
  await emitToTabs({
    type: "counters:aggregate",
    profileId: profileId,
    newCount: newCount,
    errorCount: errorCount,
    stale: stale,
    seq: ++aggregateSeq
  });
  return agg;
}

// Bus: one debounced flush window instead of one message per write — with
// 1000+ channels the per-write emits used to outrun Chrome's per-extension
// alarm quota and silently starve the tabs (counters stuck at 0 despite fresh
// storage). The alarm bus delivered ~1 min after the fetches, so counters
// stayed empty while the pump was still reading RSS; a timer drains the queue
// in sync with the refresh (the SW stays awake while fetches are in flight).
function scheduleEmitFlush() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = 0;
    flushEmitQueue().catch((e) => console.debug("[yga] emit flush failed:", e));
  }, EMIT_FLUSH_MS);
}

async function emitToTabs(message) {
  emitQueue.push(message);
  scheduleEmitFlush();
}

// The widget lives in the page, so the bus must go out through tabs.sendMessage.
// runtime.sendMessage from the service worker only reaches extension contexts
// (popup, options page) and is never delivered to content scripts — the counters
// stayed frozen during the pump while every payload was correct.
async function targetTabs() {
  try {
    return await Promise.race([
      chrome.tabs.query({ url: "https://*.youtube.com/*" }),
      new Promise((resolve) => setTimeout(() => resolve([]), EMIT_SEND_TIMEOUT_MS))
    ]);
  } catch (e) {
    return [];
  }
}

async function flushEmitQueue() {
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = 0;
  }
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
    const tabs = await targetTabs();
    for (const m of out) {
      // A tab without the content script yet (still loading, prerendered)
      // rejects; the counters:init snapshot covers it when it boots.
      await Promise.all(tabs.map((tab) => Promise.race([
        chrome.tabs.sendMessage(tab.id, m).then(() => 1, () => 0),
        new Promise((resolve) => setTimeout(() => resolve(0), EMIT_SEND_TIMEOUT_MS))
      ])));
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
  const settings = await getSettings();
  const filters = filtersCfg(settings);
  const at = now();
  record.newCount = computeCounts(record, filters, at);
  const payload = {};
  payload[videoKey(channelId)] = record;
  await chrome.storage.local.set(payload);
  await bumpVideosIndex([channelId]);

  const value = countValue(record, filters, at);
  const prev = countCache.get(channelId);
  countCache.set(channelId, value);
  const changed = !prev || !sameCountValue(prev, value);
  if (changed) await emitToTabs({ type: "counters:counts", counts: { [channelId]: value } });
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
      prev.errorStreak = 0;
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
      error: 0,
      errorStreak: 0
    });
    return { ok: true };
  }

  // Honest failure: keep old entries, mark the error, never reset the counter.
  const record = prev || { entries: [], fetchedAt: 0, etag: "", title: "", channelId: channelId };
  record.fetchedAt = now();
  record.error = now();
  // Consecutive failures, not a total: one network hiccup in a long streak must
  // not bury a live channel (PLAN.md §10). The streak drives the row's `?×N`
  // indicator; the worker never removes a channel on its own (user decision
  // 2026-11-14: a YouTube RSS outage must not auto-exclude live channels).
  record.errorStreak = ((prev && prev.errorStreak) || 0) + 1;
  await writeRecord(channelId, record);
  return {
    error: lastError,
    throttled: lastError === "throttled"
  };
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  let throttledRun = 0;
  try {
    while (queue.length) {
      queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
      const job = queue.shift();
      if (inFlight.has(job.channelId)) {
        job.done({ skipped: true });
        continue;
      }

      inFlight.add(job.channelId);
      let result = { error: "aborted" };
      try {
        result = await fetchOne(job.channelId, job.force);
      } catch (e) {
        console.debug("[yga] RSS job failed for " + job.channelId + ":", e);
      } finally {
        inFlight.delete(job.channelId);
      }
      throttledRun = result.throttled ? throttledRun + 1 : 0;
      job.done(result);
      // YouTube is pushing back on the whole pass, not on this one channel:
      // drop the rest of the queue instead of spending every channel's retry
      // budget against the same 429 wall (user report 2026-11-14).
      if (throttledRun >= THROTTLE_STOP) {
        while (queue.length) queue.shift().done({ skipped: true, throttled: true });
        break;
      }
      if (queue.length && !result.skipped) {
        await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      }
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
  const queued = new Map();
  for (const job of queue) {
    pending.add(job.channelId);
    queued.set(job.channelId, job);
  }
  for (const channelId of inFlight) pending.add(channelId);
  let expected = 0;
  for (const channelId of channelIds) {
    if (!channelId) continue;
    const existing = queued.get(channelId);
    if (existing) {
      if (opts.force) existing.force = true;
      continue;
    }
    if (pending.has(channelId)) continue;
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
  const deadline = now() + Math.max(60000, enq.expected * (REQUEST_GAP_MS + 15000));
  while (enq.jobs.length < enq.expected && now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  let errors = 0;
  if (enq.jobs.length < enq.expected) {
    console.debug("[yga] refreshChannels timeout", enq.jobs.length, enq.expected);
    errors += enq.expected - enq.jobs.length;
  }
  for (const j of enq.jobs) {
    if (j.result && j.result.error) errors++;
  }
  // Per-channel counts travelled through the bus while the pump was draining;
  // deliver the window still pending before the aggregate so the tabs never
  // wait for the whole refresh to finish.
  await flushEmitQueue();
  const agg = profileId ? await emitProfileCounts(profileId) : null;
  await flushEmitQueue();
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
        await flushEmitQueue();
        return { ok: true, lastVisitAt: rec.lastVisitAt };
      })();

    // Bulk reset (config panel §9.2.1 "mark watched" on many channels): one
    // composition write and one aggregate emit for the whole batch, otherwise
    // a 200-channel selection floods the bus.
    case "counters:setVisits":
      return (async () => {
        const { profileId, channelIds } = msg;
        if (!profileId || !Array.isArray(channelIds) || !channelIds.length) {
          return { ok: false, error: "badArgs" };
        }
        const key = "yga:profile-channels:" + profileId;
        const stored = await chrome.storage.local.get(key);
        const comp = stored[key] || {};
        const stamp = Number(msg.lastVisitAt) || now();
        for (const channelId of channelIds) {
          if (!channelId) continue;
          const rec = comp[channelId] || { addedAt: now() };
          rec.lastVisitAt = stamp;
          comp[channelId] = rec;
        }
        const payload = {};
        payload[key] = comp;
        await chrome.storage.local.set(payload);
        await emitProfileCounts(profileId, true);
        await flushEmitQueue();
        return { ok: true, lastVisitAt: stamp, updated: channelIds.length };
      })();

    case "counters:get":
      return (async () => {
        const ids = Array.isArray(msg.channelIds) ? msg.channelIds : [];
        const settings = await getSettings();
        const filters = filtersCfg(settings);
        const at = now();
        const records = await loadVideoRecords(ids);
        const channelCounts = {};
        for (const [id, rec] of records) {
          channelCounts[id] = countValue(rec, filters, at);
          channelCounts[id].total = (rec.entries || []).length;
        }
        return {
          ok: true,
          channelCounts: channelCounts,
          aggregate: profileCounts.get(msg.profileId) || null,
          lastRun: lastRun
        };
      })();

    // «Все новые» (PLAN.md backlog 1): the id list of every new video of one
    // profile, built from the RSS cache — no YouTube request. open=true lets
    // the worker create the tab itself: a content-side window.open after an
    // await has lost the user gesture and gets popup-blocked, while an
    // extension-initiated chrome.tabs.create is never blocked.
    case "counters:watchAll":
      return (async () => {
        const profileId = msg.profileId;
        if (!profileId) return { ok: false, error: "badArgs" };
        const [data, settings] = await Promise.all([profileData(profileId), getSettings()]);
        if (!data) return { ok: false, error: "unknownProfile" };
        // The widget header is the source of truth for what the user sees as
        // "new" for this profile. When the content world sends its rendered
        // channel set, use it instead of re-deriving membership here: a stale
        // worker-side subs/composition snapshot otherwise opens only the subset
        // it happens to know about (user report 2026-11-15: 15 visible new
        // videos, but one tab with one video).
        const ids = Array.isArray(msg.channelIds) && msg.channelIds.length
          ? msg.channelIds
          : data.ids;
        const records = await loadVideoRecords(ids);
        const res = newVideoIds(records, data.comp, filtersCfg(settings), now(), watchAllCfg(settings), msg.visits);
        const url = watchAllUrl(res.ids);
        if (msg.open && url) await chrome.tabs.create({ url: url });
        return { ok: true, ids: res.ids, total: res.total, limit: res.limit, url: url };
      })();

    case "counters:init":
      return (async () => {
        // The response carries the snapshot itself: tabs must not depend on
        // the alarm bus for their initial paint.
        const counts = await recomputeAllCounts();
        await syncAlarm();
        const pid = msg.profileId || "p_1";
        const aggregate = await emitProfileCounts(pid, true);
        await flushEmitQueue();
        return { ok: true, counts: counts, aggregate: aggregate, aggregateSeq: aggregateSeq };
      })();

    // Filter edits (stage 10): counts are derived from cached entries, so a
    // filter change needs no refetch — recompute from storage and push both
    // the per-channel counts and every profile's aggregate to the tabs.
    case "counters:settings":
      return (async () => {
        await syncAlarm();
        await recomputeAllCounts();
        // Entries cached before `kind` existed cannot be classified from
        // storage, so a Shorts/live edit must refetch them — otherwise the
        // counter keeps counting Shorts until the next refresh.
        const settings = await getSettings();
        const filters = filtersCfg(settings);
        let migrating = 0;
        if (filters.hideShorts || filters.hideLive) {
          const index = await chrome.storage.local.get(VIDEOS_INDEX);
          const records = await loadVideoRecords(Object.keys(index[VIDEOS_INDEX] || {}));
          const unclassified = [];
          for (const [id, rec] of records) {
            const entries = rec.entries || [];
            if (entries.length && entries.every((e) => !e.kind)) unclassified.push(id);
          }
          if (unclassified.length) {
            enqueue(unclassified, { force: true, priority: 1 });
            migrating = unclassified.length;
          }
        }
        const stored = await chrome.storage.local.get("yga:profiles");
        for (const profileId of Object.keys(stored["yga:profiles"] || {})) {
          await emitProfileCounts(profileId, true);
        }
        await flushEmitQueue();
        return { ok: true, migrating: migrating };
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
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncAlarm().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  syncAlarm().catch(() => {});
});

// Node logic harness (no browser): RSS parser + service worker counter core +
// content-world view (state.js/profiles.js/counters.js). Run: node test/logic.mjs
// — exit code 0 = all checks pass. Shared chrome/SW stubs live in harness.mjs.
import vm from "node:vm";
import {
  read, parserSrc, swSrc, fixture, CH1, CH2,
  check, report, failures, clone, flush, makeSandbox, loadInto
} from "./harness.mjs";

const chains = []; // async sections; the report waits for all of them
// --- 1. parser (fixture-feed.xml) ---------------------------------------

{
  const env = makeSandbox();
  vm.createContext(env.sandbox);
  vm.runInContext(parserSrc, env.sandbox, { filename: "rss-parser.js" });
  const feed = env.sandbox.yga.rssParser.parseVideosXml(fixture);

  check("parser: feed parsed", !!feed);
  check("parser: 5 entries", feed && feed.entries.length === 5, feed && String(feed.entries.length));
  check(
    "parser: ids",
    feed && feed.entries.map((e) => e.videoId).join(",") === "aaa11111111,bbb22222222,ccc33333333,ddd44444444,eee55555555",
    feed && feed.entries.map((e) => e.videoId).join(",")
  );
  check(
    "parser: CDATA entity decode",
    feed && feed.entries[0].title === 'New & "bold" <video> #1 — entities',
    feed && JSON.stringify(feed.entries[0].title)
  );
  check(
    "parser: double-encoded &amp;amp;",
    feed && feed.entries[1].title === "Second video &amp; more",
    feed && JSON.stringify(feed.entries[1].title)
  );
  check(
    "parser: em-dash survives",
    feed && feed.entries[0].title.indexOf("#1 —") >= 0,
    feed && JSON.stringify(feed.entries[0].title)
  );
  check("parser: publishedAt", feed && feed.entries[0].publishedAt === Date.parse("2026-11-08T09:00:00.000Z"));
  check(
    "parser: thumbnail height=1",
    feed && feed.entries[0].thumbnail === "https://yt3.ggpht.com/avatar=s160-c-k-c0x00ffffff-no-rj",
    feed && feed.entries[0].thumbnail
  );
  check("parser: views", feed && feed.entries[0].views === 1234);
  check("parser: feed channelId", feed && feed.channelId === "UCtestchannel0000000000A", feed && feed.channelId);
  check("parser: feed title entity", feed && feed.title === "RSS Test Channel & Co.");
  check("parser: feed url", feed && feed.url === "https://www.youtube.com/channel/UC001");
  check("parser: watched flag default", feed && feed.entries[0].watched === false);
  check("parser: label from media:title", feed && feed.entries[0].label === 'New "bold" <video> #1 — entities', feed && JSON.stringify(feed.entries[0].label));
  check("parser: duration default 0", feed && feed.entries[0].duration === 0);
  check("parser: category default empty", feed && feed.entries[1].category === "");
  check(
    "parser: shorts kind + category",
    feed && feed.entries[3].kind === "shorts" && feed.entries[3].category === "video",
    feed && JSON.stringify([feed.entries[3].kind, feed.entries[3].category])
  );
  check("parser: live kind", feed && feed.entries[4].kind === "live", feed && feed.entries[4].kind);
  check(
    "parser: watch links are video",
    feed && feed.entries.slice(0, 3).every((e) => e.kind === "video"),
    feed && feed.entries.map((e) => e.kind).join(",")
  );
  // Real feeds put the video title in media:title, so a title that merely
  // mentions Shorts/Live must not classify the entry (stage-10 filter bug).
  const titled = env.sandbox.yga.rssParser.parseVideosXml(
    "<feed><entry><title>Shorts roundup &amp; Live recap</title>" +
      "<link rel=\"alternate\" href=\"https://www.youtube.com/watch?v=abcdef12345\"/>" +
      "<yt:videoId>abcdef12345</yt:videoId>" +
      "<published>2026-11-08T09:00:00.000Z</published>" +
      "<media:group><media:title>Shorts roundup &amp; Live recap</media:title></media:group>" +
      "</entry></feed>"
  );
  check(
    "parser: title mentioning Shorts/Live stays video",
    titled && titled.entries[0].kind === "video",
    JSON.stringify(titled && titled.entries[0])
  );
  check("parser: html page rejected", env.sandbox.yga.rssParser.parseVideosXml("<html><body>hi</body></html>") === null);
  check("parser: empty rejected", env.sandbox.yga.rssParser.parseVideosXml("") === null);
  check("parser: feed without entries rejected", env.sandbox.yga.rssParser.parseVideosXml("<feed></feed>") === null);
}

// --- 2. worker: refresh + minInterval + dedup ----------------------------

{
  const env = makeSandbox();
  loadInto(env);

  chains.push(env.sandbox.chrome.storage.local.set({
    "yga:profiles": {
      p_1: { id: "p_1", builtin: true, includeAllSubs: true },
      p_2: { id: "p_2", includeAllSubs: false }
    },
    "yga:account": { accountKey: "UCme" },
    "yga:subs:UCme": [{ c: CH1, t: "One" }, { c: CH2, t: "Two" }],
    "yga:profile-channels:p_2": { [CH1]: { addedAt: 1 } }
  }).then(async () => {
    let res = await env.send({ type: "counters:refresh", profileId: "nope" });
    check("worker: unknown profile rejected", res && res.ok === false && res.error === "unknownProfile", JSON.stringify(res));

    res = await env.send({ type: "counters:refresh", profileId: "p_1" });
    check("worker: refresh builtin p_1 queues both subs", res && res.ok && res.requested === 2, JSON.stringify(res));
    await flush();

    let counts = await env.send({ type: "counters:get", profileId: "p_1", channelIds: [CH1, CH2] });
    check(
      "worker: newCount from fixture",
      counts && counts.channelCounts[CH1].newCount === 5 && counts.channelCounts[CH2].newCount === 5,
      JSON.stringify(counts.channelCounts)
    );
    check("worker: total kept at 5", counts && counts.channelCounts[CH1].total === 5);
    check("worker: no error", counts && !counts.channelCounts[CH1].error);
    const at1 = counts && counts.channelCounts[CH1].at;
    check(
      "worker: counts carry unwatched timestamps",
      Array.isArray(at1) && at1.length === counts.channelCounts[CH1].newCount,
      JSON.stringify(counts.channelCounts[CH1])
    );
    check(
      "worker: at sorted newest first",
      Array.isArray(at1) && at1.every((t, i) => i === 0 || at1[i - 1] >= t),
      JSON.stringify(at1)
    );

    const fetches1 = env.fetchCalls.length;
    res = await env.send({ type: "counters:refresh", profileId: "p_1" });
    await flush();
    check("worker: minInterval suppresses refetch", env.fetchCalls.length === fetches1, env.fetchCalls.length + " vs " + fetches1);

    env.setResponder((url) => ({ status: 304, body: "", etag: null }));
    res = await env.send({ type: "counters:refresh", profileId: "p_1", force: true });
    await flush();
    check("worker: force refetches", env.fetchCalls.length > fetches1);
    const inm = env.fetchCalls[fetches1] && env.fetchCalls[fetches1].opts.headers["If-None-Match"];
    check("worker: ETag sent on 304 path", inm === "etag-v1", String(inm));
    counts = await env.send({ type: "counters:get", channelIds: [CH1] });
    check("worker: 304 keeps entries", counts.channelCounts[CH1].total === 5 && counts.channelCounts[CH1].newCount === 5);

    // 429 both retries → honest error state, cache preserved
    const before429 = env.fetchCalls.length;
    env.setResponder((url) => ({ status: 429, body: "slow down", etag: null }));
    res = await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1] });
    check(
      "worker: refresh response carries aggregate",
      res && res.ok && !!res.aggregate && res.aggregate.profileId === "p_1" && typeof res.aggregateSeq === "number",
      JSON.stringify(res && res.aggregate)
    );
    await flush(30);
    check("worker: 429 retried once", env.fetchCalls.length - before429 === 2, String(env.fetchCalls.length - before429));
    counts = await env.send({ type: "counters:get", channelIds: [CH1] });
    check("worker: 429 marks error", counts.channelCounts[CH1].error > 0);
    check("worker: 429 keeps old counts", counts.channelCounts[CH1].newCount === 5 && counts.channelCounts[CH1].total === 5);

    // dedup inside one request; CH2's watched flag makes both writes
    // "changed" so both must reach the tabs
    const recB = clone(env.storage.get("yga:videos:" + CH2));
    recB.entries[0].watched = true;
    recB.entries[0].watchedAt = Date.now();
    await env.sandbox.chrome.storage.local.set({ ["yga:videos:" + CH2]: recB });
    env.setResponder((url) => ({ status: 200, body: fixture, etag: "etag-v2" }));
    const busDedup = env.bus.length;
    res = await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1, CH1, CH2] });
    check("worker: duplicate ids deduped", res && res.requested === 2, JSON.stringify(res));
    // progressive delivery: every channel's count reaches the tabs while the
    // queue drains, merged per flush window when writes land together
    let arrived = [];
    for (let i = 0; i < 45 && !(arrived.some((m) => m.counts[CH1]) && arrived.some((m) => m.counts[CH2])); i++) {
      await new Promise((r) => setTimeout(r, 100));
      arrived = env.bus.slice(busDedup).filter((m) => m.type === "counters:counts");
    }
    check(
      "worker: per-channel counts reach the tabs during the refresh",
      arrived.length >= 1 && arrived.some((m) => m.counts[CH1]) && arrived.some((m) => m.counts[CH2]),
      JSON.stringify(arrived.map((m) => Object.keys(m.counts)))
    );

    // watched merge: mark entry watched via storage, re-fetch, flag survives
    const rec = clone(env.storage.get("yga:videos:" + CH1));
    rec.entries[0].watched = true;
    rec.entries[0].watchedAt = Date.now();
    await env.sandbox.chrome.storage.local.set({ ["yga:videos:" + CH1]: rec });
    await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1] });
    await flush();
    counts = await env.send({ type: "counters:get", channelIds: [CH1] });
    check("worker: watched merge drops from newCount", counts.channelCounts[CH1].newCount === 4, JSON.stringify(counts.channelCounts));

    // setVisit writes composition + a lastVisitAt-aware aggregate (always
    // emitted, so every tab re-derives its view of this profile)
    const busBefore = env.bus.length;
    res = await env.send({ type: "counters:setVisit", profileId: "p_1", channelId: CH1 });
    const comp = env.storage.get("yga:profile-channels:p_1") || {};
    check("worker: setVisit stores lastVisitAt", res && res.ok && comp[CH1] && comp[CH1].lastVisitAt > 0);
    await flush();
    const agg = env.bus.slice(busBefore).filter((m) => m.type === "counters:aggregate");
    check("worker: setVisit emits aggregate", agg.length > 0 && agg[agg.length - 1].profileId === "p_1", JSON.stringify(env.bus.slice(busBefore)));
    // Oracle: unwatched entries published after the visit, per profile.
    const since = (id, visitAt) =>
      (env.storage.get("yga:videos:" + id).entries || []).filter(
        (e) => !e.watched && e.publishedAt > (visitAt || 0)
      ).length;
    const visit1 = comp[CH1].lastVisitAt;
    const p1Expected = since(CH1, visit1) + since(CH2, 0);
    check(
      "worker: aggregate applies lastVisitAt",
      agg.length > 0 && agg[agg.length - 1].newCount === p1Expected && p1Expected <= 4,
      JSON.stringify(agg[agg.length - 1]) + " expected " + p1Expected
    );

    // curated profile composition respected
    res = await env.send({ type: "counters:refresh", profileId: "p_2" });
    check("worker: curated profile refreshes only its channels", res && res.requested === 1, JSON.stringify(res));
    // PLAN.md §5: lastVisitAt is per profile — p_2 still counts CH1's two
    // unwatched entries while p_1 (just visited) counts none of them.
    check(
      "worker: aggregate is per-profile (reset does not leak)",
      !!res.aggregate && res.aggregate.newCount === since(CH1, 0) && since(CH1, 0) > since(CH1, visit1),
      JSON.stringify(res.aggregate) + " vs p_1 CH1 " + since(CH1, visit1)
    );

    // counts bus message shape
    const countsMsg = env.bus.find((m) => m.type === "counters:counts");
    check(
      "worker: counts bus message",
      !!countsMsg && countsMsg.counts[CH1] && typeof countsMsg.counts[CH1].newCount === "number",
      JSON.stringify(countsMsg && countsMsg.counts)
    );

    // init snapshot: tabs get counts+aggregate directly, no bus dependency
    const init = await env.send({ type: "counters:init", profileId: "p_1" });
    check(
      "worker: init returns snapshot counts",
      init && init.ok && init.counts[CH1] && init.counts[CH1].newCount === 4,
      JSON.stringify(init && init.counts && init.counts[CH1])
    );
    check(
      "worker: init returns aggregate",
      !!init.aggregate && init.aggregate.profileId === "p_1" && init.aggregate.newCount === p1Expected,
      JSON.stringify(init.aggregate) + " expected " + p1Expected
    );
    check(
      "worker: init counts carry at",
      !!init.counts[CH1] && Array.isArray(init.counts[CH1].at) && init.counts[CH1].at.length === init.counts[CH1].newCount,
      JSON.stringify(init.counts[CH1])
    );

    // scheduled alarm
    await env.sandbox.chrome.storage.local.set({
      "yga:settings": {
        version: 1,
        activeProfileId: "p_1",
        refresh: { mode: "scheduled", scheduled: { enabled: true, periodInMinutes: 240, maxChannelsPerRun: 60 }, batch: 12, minIntervalMs: 0 }
      }
    });
    await env.send({ type: "counters:settings" });
    check("worker: alarm created at >=60min", env.alarms.has("yga:scheduled-refresh") && env.alarms.get("yga:scheduled-refresh").periodInMinutes === 240);
    await env.sandbox.chrome.storage.local.set({ "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { scheduled: { enabled: true, periodInMinutes: 10 }, batch: 12 } } });
    await env.send({ type: "counters:settings" });
    check("worker: alarm floor 60min", env.alarms.get("yga:scheduled-refresh").periodInMinutes === 60);

    // alarm run
    env.setResponder((url, opts, idx) => (idx % 2 ? { status: 200, body: fixture, etag: "etag-v3" } : { status: 200, body: fixture, etag: "etag-v3" }));
    for (const fn of env.listeners.alarm) fn({ name: "yga:scheduled-refresh" });
    await flush(40);
    check("worker: scheduled run executed (lastRun)", true);

    // alarm disabled → cleared
    await env.sandbox.chrome.storage.local.set({
      "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { scheduled: { enabled: false }, batch: 12 } }
    });
    await env.send({ type: "counters:settings" });
    check("worker: disabled schedule clears alarm", !env.alarms.has("yga:scheduled-refresh"));

    // parse error keeps prior cache
    env.setResponder(() => ({ status: 200, body: "<html>challenge</html>", etag: null }));
    await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH2] });
    await flush();
    counts = await env.send({ type: "counters:get", channelIds: [CH2] });
    check("worker: garbage XML → error + cache kept", counts.channelCounts[CH2].error > 0 && counts.channelCounts[CH2].newCount === 4);

    // --- content-side view math (content/counters.js newSince) ------------
    const cenv = makeSandbox();
    vm.createContext(cenv.sandbox);
    vm.runInContext(read("content/counters.js"), cenv.sandbox, { filename: "counters.js" });
    const ns = cenv.sandbox.yga.counters.newSince;
    check("newSince: empty/missing", ns([], 0) === 0 && ns(undefined, 0) === 0);
    check("newSince: no visit counts all", ns([5, 4, 3], 0) === 3);
    check("newSince: strict > lastVisitAt", ns([5, 4, 3], 4) === 1 && ns([5, 4, 3], 5) === 0);
    check("newSince: future visit zeroes", ns([5, 4, 3], 9) === 0);
  })
    .catch((e) => failures.push("worker section crashed: " + e)));
}

// --- 2b. worker: progressive bus delivery ---------------------------------
// The counters must reach the tabs while the queue is still draining, not
// after the whole refresh (the old alarm bus delivered ~1 min later, so the
// widget stayed empty until a page reload).

{
  const env = makeSandbox();
  loadInto(env);

  chains.push(env.sandbox.chrome.storage.local.set({
    "yga:profiles": { p_1: { id: "p_1", builtin: true, includeAllSubs: true } },
    "yga:account": { accountKey: "UCme" },
    "yga:subs:UCme": [{ c: CH1, t: "One" }, { c: CH2, t: "Two" }],
    "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { mode: "onOpen", scheduled: { enabled: false }, batch: 12, minIntervalMs: 0 } }
  }).then(async () => {
    env.setResponder(() => new Promise((r) => setTimeout(() => r({ status: 200, body: fixture, etag: "etag-prog" }), 120)));
    const refresh = env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1, CH2] });
    await new Promise((r) => setTimeout(r, 180)); // CH1 done, CH2 still fetching
    const early = env.bus.filter((m) => m.type === "counters:counts");
    check(
      "bus: counts arrive before the refresh resolves",
      early.some((m) => m.counts[CH1]) && !env.bus.some((m) => m.type === "counters:aggregate"),
      JSON.stringify(env.bus.map((m) => m.type))
    );
    const res = await refresh;
    check("bus: refresh still reports both channels", res && res.ok && res.requested === 2, JSON.stringify(res));
    await flush();
    const all = env.bus.filter((m) => m.type === "counters:counts");
    check(
      "bus: every channel delivered",
      all.some((m) => m.counts[CH1]) && all.some((m) => m.counts[CH2]),
      JSON.stringify(all.map((m) => Object.keys(m.counts)))
    );
  })
    .catch((e) => failures.push("progressive bus section crashed: " + e)));
}

// --- 3. worker: stage-10 filters (Shorts / live / maxAgeDays) -------------
// Filter edits must repaint counts from the cached entries — no refetch —
// and push both per-channel counts and per-profile aggregates to the tabs.

{
  const env = makeSandbox();
  loadInto(env);

  chains.push(env.sandbox.chrome.storage.local.set({
    "yga:profiles": { p_1: { id: "p_1", builtin: true, includeAllSubs: true } },
    "yga:account": { accountKey: "UCme" },
    "yga:subs:UCme": [{ c: CH1, t: "One" }],
    "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { mode: "onOpen", scheduled: { enabled: false }, batch: 12, minIntervalMs: 0 } }
  }).then(async () => {
    let res = await env.send({ type: "counters:refresh", profileId: "p_1" });
    check("filters: refresh queued", res && res.ok && res.requested === 1, JSON.stringify(res));
    await flush();

    const get = async () =>
      (await env.send({ type: "counters:get", profileId: "p_1", channelIds: [CH1] })).channelCounts[CH1];
    const setFilters = async (filters) => {
      const s = env.storage.get("yga:settings");
      s.filters = filters;
      await env.sandbox.chrome.storage.local.set({ "yga:settings": s });
      await env.send({ type: "counters:settings" });
      await flush();
    };

    let counts = await get();
    check("filters: off counts every entry", counts.newCount === 5 && counts.at.length === 5, JSON.stringify(counts));
    const fetches = env.fetchCalls.length;

    await setFilters({ hideShorts: true });
    counts = await get();
    check("filters: hideShorts drops the short", counts.newCount === 4, JSON.stringify(counts));

    await setFilters({ hideShorts: true, hideLive: true });
    counts = await get();
    check("filters: hideLive drops the live entry", counts.newCount === 3, JSON.stringify(counts));

    await setFilters({ hideShorts: true, hideLive: true, maxAgeDays: 1 });
    counts = await get();
    check("filters: maxAgeDays drops old entries", counts.newCount === 0 && counts.at.length === 0, JSON.stringify(counts));

    await setFilters({ hideShorts: true, hideLive: true, maxAgeDays: 0 });
    counts = await get();
    check("filters: maxAgeDays 0 disables the age filter", counts.newCount === 3, JSON.stringify(counts));

    await setFilters({});
    counts = await get();
    check("filters: off restores the full count", counts.newCount === 5, JSON.stringify(counts));
    check("filters: recompute never refetches", env.fetchCalls.length === fetches, env.fetchCalls.length + " vs " + fetches);

    const countsMsgs = env.bus.filter((m) => m.type === "counters:counts" && m.counts[CH1]);
    check("filters: counts pushed to tabs", countsMsgs.length > 0, String(countsMsgs.length));
    const aggs = env.bus.filter((m) => m.type === "counters:aggregate" && m.profileId === "p_1");
    check("filters: aggregate pushed to tabs", aggs.length > 0 && aggs[aggs.length - 1].newCount === 5, JSON.stringify(aggs[aggs.length - 1]));
  })
    .catch((e) => failures.push("filters section crashed: " + e)));
}

// --- 3b. worker: filter kind comes from the feed URL, not the title --------
// Browser report 2026-11-13: with hideShorts on, a fresh Short still counted
// as a new video (media:title is the video title), and a video titled
// «…Live…» was hidden by hideLive. Kind is the entry's alternate-link path.

{
  const env = makeSandbox();
  loadInto(env);

  const kindFeed =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\" xmlns:media=\"http://search.yahoo.com/mrss/\" xmlns=\"http://www.w3.org/2005/Atom\">\n" +
    " <title>Kind Feed</title>\n" +
    " <yt:channelId>" + CH1 + "</yt:channelId>\n" +
    " <entry>\n  <title>Shorts roundup &amp; Live recap</title>\n" +
    "  <link rel=\"alternate\" href=\"https://www.youtube.com/watch?v=k1aaaaaaaaa\"/>\n" +
    "  <yt:videoId>k1aaaaaaaaa</yt:videoId>\n  <yt:channelId>" + CH1 + "</yt:channelId>\n" +
    "  <published>2026-11-12T09:00:00.000Z</published>\n" +
    "  <media:group><media:title>Shorts roundup &amp; Live recap</media:title></media:group>\n" +
    " </entry>\n" +
    " <entry>\n  <title>Fresh short</title>\n" +
    "  <link rel=\"alternate\" href=\"https://www.youtube.com/shorts/k2bbbbbbbbb\"/>\n" +
    "  <yt:videoId>k2bbbbbbbbb</yt:videoId>\n  <yt:channelId>" + CH1 + "</yt:channelId>\n" +
    "  <published>2026-11-12T08:00:00.000Z</published>\n" +
    "  <media:group><media:title>Fresh short</media:title></media:group>\n" +
    " </entry>\n" +
    " <entry>\n  <title>Weekly stream</title>\n" +
    "  <link rel=\"alternate\" href=\"https://www.youtube.com/live/k3ccccccccc\"/>\n" +
    "  <yt:videoId>k3ccccccccc</yt:videoId>\n  <yt:channelId>" + CH1 + "</yt:channelId>\n" +
    "  <published>2026-11-12T07:00:00.000Z</published>\n" +
    "  <media:group><media:title>Weekly stream</media:title></media:group>\n" +
    " </entry>\n" +
    "</feed>\n";

  chains.push(env.sandbox.chrome.storage.local.set({
    "yga:profiles": { p_1: { id: "p_1", builtin: true, includeAllSubs: true } },
    "yga:account": { accountKey: "UCme" },
    "yga:subs:UCme": [{ c: CH1, t: "One" }],
    "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { mode: "onOpen", scheduled: { enabled: false }, batch: 12, minIntervalMs: 0 }, filters: {} }
  }).then(async () => {
    env.setResponder(() => ({ status: 200, body: kindFeed, etag: "etag-kind" }));
    await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1] });
    await flush();

    const get = async () =>
      (await env.send({ type: "counters:get", profileId: "p_1", channelIds: [CH1] })).channelCounts[CH1];
    const setFilters = async (filters) => {
      const s = env.storage.get("yga:settings");
      s.filters = filters;
      await env.sandbox.chrome.storage.local.set({ "yga:settings": s });
      return env.send({ type: "counters:settings" });
    };

    let counts = await get();
    check("kind filters: off counts all three", counts.newCount === 3, JSON.stringify(counts));

    await setFilters({ hideShorts: true });
    counts = await get();
    check("kind filters: hideShorts drops the /shorts entry", counts.newCount === 2, JSON.stringify(counts));
    check("kind filters: title mentioning Shorts still counts", counts.at.length === 2, JSON.stringify(counts));

    await setFilters({ hideShorts: true, hideLive: true });
    counts = await get();
    check("kind filters: hideLive drops the /live entry", counts.newCount === 1, JSON.stringify(counts));
    check("kind filters: title mentioning Live still counts", counts.at.length === 1, JSON.stringify(counts));

    await setFilters({});
    counts = await get();
    check("kind filters: off restores three", counts.newCount === 3, JSON.stringify(counts));

    // A cache written before `kind` existed cannot be classified from storage.
    const legacy = clone(env.storage.get("yga:videos:" + CH1));
    for (const e of legacy.entries) delete e.kind;
    await env.sandbox.chrome.storage.local.set({ ["yga:videos:" + CH1]: legacy });
    const res = await setFilters({ hideShorts: true });
    check("kind filters: unclassified cache triggers refetch", res && res.ok && res.migrating === 1, JSON.stringify(res));
    await flush(40);
    counts = await get();
    check("kind filters: refetch reclassifies the cache", counts.newCount === 2, JSON.stringify(counts));
  })
    .catch((e) => failures.push("kind filter section crashed: " + e)));
}

// --- 4. content world end-to-end: right-click reset must reach the row ----
// PLAN.md §10.5/§10.7: the row counter is a per-profile view (lastVisitAt) of
// the shared worker cache. content/state.js + profiles.js + counters.js run
// against the real worker over a shared storage with onChanged delivery.
{
  const env = makeSandbox();
  loadInto(env);

  const shared = env.storage;
  const content = { storageChanged: [], message: [] };
  const changes = [];

  // The worker's bus (chrome.runtime.sendMessage from the SW) must arrive in
  // the content world's onMessage listeners, like in Chrome.
  const wsend = env.sandbox.chrome.runtime.sendMessage;
  env.sandbox.chrome.runtime.sendMessage = async (msg) => {
    content.message.push(msg);
    return wsend(msg);
  };

  function record(key, oldValue) {
    changes.push({ key: key, oldValue: oldValue, newValue: shared.has(key) ? clone(shared.get(key)) : undefined });
  }

  // Worker writes must reach the content world's storage.onChanged, exactly
  // like in Chrome — otherwise a content-side mirror bug stays hidden.
  const wlocal = env.sandbox.chrome.storage.local;
  const wset = wlocal.set;
  wlocal.set = async function (payload) {
    const before = {};
    for (const k in payload) before[k] = shared.has(k) ? clone(shared.get(k)) : undefined;
    await wset(payload);
    for (const k in payload) record(k, before[k]);
  };

  const cchrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list =
            keys === undefined ? Array.from(shared.keys())
            : typeof keys === "string" ? [keys]
            : Array.isArray(keys) ? keys
            : Object.keys(keys);
          for (const k of list) if (shared.has(k)) out[k] = clone(shared.get(k));
          return out;
        },
        set: async (payload) => {
          for (const k in payload) {
            const old = shared.has(k) ? clone(shared.get(k)) : undefined;
            shared.set(k, clone(payload[k]));
            record(k, old);
          }
        },
        remove: async (key) => {
          for (const k of typeof key === "string" ? [key] : key) {
            const old = shared.has(k) ? clone(shared.get(k)) : undefined;
            shared.delete(k);
            record(k, old);
          }
        }
      },
      onChanged: { addListener: (fn) => content.storageChanged.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => content.message.push(fn) },
      sendMessage: async (msg) => env.send(msg)
    },
    i18n: { getMessage: (k) => k }
  };

  async function deliver() {
    await flush(40); // the SW bus flushes on an alarm; give it room to fire
    while (changes.length) {
      const batch = changes.splice(0, changes.length);
      const payload = {};
      for (const c of batch) payload[c.key] = { oldValue: c.oldValue, newValue: c.newValue };
      for (const fn of content.storageChanged) fn(payload, "local");
      await flush(40);
    }
  }

  const csandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    Map,
    Set,
    String,
    Number,
    RegExp,
    chrome: cchrome,
    yga: { i18n: (k) => k }
  };
  csandbox.globalThis = csandbox;
  csandbox.window = csandbox;
  vm.createContext(csandbox);
  vm.runInContext(read("content/state.js"), csandbox, { filename: "state.js" });
  vm.runInContext(read("content/profiles.js"), csandbox, { filename: "profiles.js" });
  vm.runInContext(read("content/counters.js"), csandbox, { filename: "counters.js" });

  const c = csandbox.yga;

  chains.push(env.sandbox.chrome.storage.local
    .set({
      "yga:profiles": { p_1: { id: "p_1", name: "All", builtin: true, includeAllSubs: true } },
      "yga:account": { accountKey: "UCme" },
      "yga:subs:UCme": [{ c: CH1, t: "One" }],
      "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { mode: "onOpen", scheduled: { enabled: false }, batch: 12, minIntervalMs: 0 } }
    })
    .then(async () => {
      await env.send({ type: "counters:refresh", profileId: "p_1" });
      await flush(40);

      await c.profiles.load();
      const pid = await c.profiles.activeProfileId();
      check("content: active profile p_1", pid === "p_1", String(pid));
      await c.state.setAccountKey("UCme");

      const init = await env.send({ type: "counters:init", profileId: "p_1" });
      c.state.applyInitSnapshot(init.counts, init.aggregate, init.aggregateSeq);

      let list = await c.state.getVisibleSubs();
      check(
        "content: row counts all unwatched before visit",
        !!list && list.length === 1 && list[0].newCount === 5,
        JSON.stringify(list && list.map((s) => s.newCount))
      );

      // The right-click path (content/widget.js contextmenu → markVisited).
      const visitAt = await c.state.markVisited(pid, CH1);
      check("content: markVisited returns lastVisitAt", visitAt > 0, String(visitAt));
      await deliver();

      list = await c.state.getVisibleSubs();
      check(
        "content: row resets after markVisited",
        !!list && list[0].newCount === 0,
        "newCount=" + (list && list[0].newCount) + " lastVisitAt=" + (list && list[0].lastVisitAt)
      );
      check(
        "content: footer chip follows the rows",
        !!c.state.getAggregate() && c.state.getAggregate().newCount === 0,
        JSON.stringify(c.state.getAggregate())
      );

      // A worker-side refresh must not resurrect the reset count (bus path).
      await env.send({ type: "counters:refresh", profileId: "p_1", force: true, channelIds: [CH1] });
      await deliver();
      const msg = content.message.filter((m) => m && m.type === "counters:counts");
      check("content: counts bus delivered", msg.length > 0, String(msg.length));
      list = await c.state.getVisibleSubs();
      check(
        "content: reset survives a refresh",
        !!list && list[0].newCount === 0,
        "newCount=" + (list && list[0].newCount)
      );

      // PLAN.md §5: the reset is per profile — a second profile still counts.
      const p2 = await c.profiles.create("Curated");
      await c.profiles.addChannel(p2.id, CH1);
      await c.profiles.setActiveProfile(p2.id);
      await c.state.refreshVisible();
      list = await c.state.getVisibleSubs();
      check(
        "content: other profile keeps its own count",
        !!list && list.length === 1 && list[0].newCount === 5,
        "newCount=" + (list && list[0].newCount)
      );
    })
    .catch((e) => failures.push("content section crashed: " + e)));
}

// --- 4. page bridge: getPageChannel after SPA navigation -------------------
// Regression (user report 2026-11-11): window.ytInitialData is only assigned
// on full page loads, so reading it first made the letter buttons assign a
// different channel after in-tab navigation. The live canonical link /
// channel meta tag must win over the stale initial data.

{
  const bridgeSrc = read("page/bridge.js");

  function loadBridge(page) {
    const listeners = {};
    const responses = [];
    const nodes = {};
    if (page.canonical) nodes['link[rel="canonical"]'] = { getAttribute: () => page.canonical };
    if (page.metaChannel) nodes['meta[itemprop="channelId"]'] = { getAttribute: () => page.metaChannel };
    const sandbox = {
      console,
      JSON,
      Promise,
      Object,
      Array,
      String,
      Number,
      RegExp,
      Date,
      setTimeout,
      CustomEvent: function () {},
      location: { origin: "https://www.youtube.com", href: page.href || "https://www.youtube.com/" },
      document: { querySelector: (sel) => nodes[sel] || null }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.addEventListener = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };
    sandbox.postMessage = (msg) => { responses.push(msg); };
    sandbox.dispatchEvent = () => {};
    if (page.ytInitialData) sandbox.ytInitialData = page.ytInitialData;
    if (page.ytInitialPlayerResponse) sandbox.ytInitialPlayerResponse = page.ytInitialPlayerResponse;
    vm.createContext(sandbox);
    vm.runInContext(bridgeSrc, sandbox, { filename: "bridge.js" });
    // Inside the context `window` is the global proxy, not the sandbox object,
    // so the bridge's `event.source !== window` guard only accepts events
    // dispatched from the inner global.
    const inner = vm.runInContext("globalThis", sandbox);
    return async () => {
      listeners.message[0]({ source: inner, data: { __yga: "cmd", id: 1, nonce: "n", cmd: "getPageChannel" } });
      await flush(10);
      const resp = responses[responses.length - 1];
      return (resp && resp.ok && resp.data) || null;
    };
  }

  const staleData = { metadata: { channelMetadataRenderer: { externalId: CH1, title: "Old Channel" } } };

  chains.push((async () => {
    const nav = await loadBridge({
      canonical: "https://www.youtube.com/channel/" + CH2,
      ytInitialData: staleData
    })();
    check(
      "bridge: live canonical beats stale ytInitialData after SPA navigation",
      !!nav && nav.channelId === CH2,
      JSON.stringify(nav)
    );
    check(
      "bridge: stale metadata title is not reused",
      !!nav && nav.title === "",
      JSON.stringify(nav && nav.title)
    );

    const fresh = await loadBridge({ ytInitialData: staleData })();
    check(
      "bridge: ytInitialData still serves full page loads",
      !!fresh && fresh.channelId === CH1 && fresh.title === "Old Channel",
      JSON.stringify(fresh)
    );

    const handle = await loadBridge({
      canonical: "https://www.youtube.com/@handle",
      metaChannel: CH2
    })();
    check(
      "bridge: meta itemprop channelId on /@handle pages",
      !!handle && handle.channelId === CH2,
      JSON.stringify(handle)
    );

    const watch = await loadBridge({
      canonical: "https://www.youtube.com/watch?v=aaa11111111",
      ytInitialPlayerResponse: { videoDetails: { channelId: CH2, author: "Two" } }
    })();
    check(
      "bridge: watch page resolves the video owner from the player response",
      !!watch && watch.channelId === CH2 && watch.title === "Two",
      JSON.stringify(watch)
    );
  })().catch((e) => failures.push("bridge section crashed: " + e)));
}

// --- 5. api-client: guide truncation must not hide browse channels ---------
// Regression (user report 2026-11-11): the guide embeds only the first
// subscriptions, so browse used to run only when the guide was empty and
// subscribed channels beyond the guide cap never entered the catalog.

{
  chains.push((async () => {
    const guideList = [{ channelId: CH1, title: "One", avatarUrl: "" }];
    const browseList = [
      { channelId: CH1, title: "One", avatarUrl: "" },
      { channelId: CH2, title: "Two", avatarUrl: "" }
    ];
    let merged = null;
    const sandbox = {
      console, JSON, Promise, Map, Object, Array, String, Number, setTimeout,
      yga: {
        bridge: {
          call: async (cmd) => {
            if (cmd === "getGuideSubscriptions") return guideList;
            if (cmd === "browseSubscriptions") return browseList;
            throw new Error("unexpected cmd " + cmd);
          }
        },
        state: {
          loadCache: async () => [],
          updateSubs: async (list) => { merged = list; },
          getVisibleSubs: async () => []
        }
      }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read("content/api-client.js"), sandbox, { filename: "api-client.js" });
    await sandbox.yga.api.refreshSubscriptions();
    check(
      "api: browse merges in even when the guide is non-empty",
      !!merged && merged.length === 2 && merged.some((s) => s.channelId === CH2),
      JSON.stringify(merged)
    );
    check(
      "api: guide entries are not duplicated by browse overlap",
      !!merged && merged.filter((s) => s.channelId === CH1).length === 1,
      JSON.stringify(merged)
    );
  })().catch((e) => failures.push("api-client section crashed: " + e)));
}

// --- 6. page bridge: browseSubscriptions follows continuations -------------
// Regression (user report 2026-11-11): the first /feed/channels page embeds
// only part of the subscriptions («Show more» hides the rest), so the catalog
// missed channels assigned to groups.

{
  const sub = (id, title) => ({ channelRenderer: { channelId: id, title: { simpleText: title } } });
  const cont = (token) => ({
    continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: token } } }
  });
  const pageHtml = (items) =>
    '<script>var ytInitialData = ' + JSON.stringify({ items: items }) + ';</script>';
  const contJson = (items) => ({
    onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }]
  });

  chains.push((async () => {
    const calls = [];
    const listeners = {};
    const responses = [];
    const sandbox = {
      console, JSON, Promise, Object, Array, String, Number, RegExp, Date, setTimeout,
      CustomEvent: function () {},
      location: { origin: "https://www.youtube.com", href: "https://www.youtube.com/" },
      document: { querySelector: () => null },
      ytcfg: { data_: { INNERTUBE_API_KEY: "k", INNERTUBE_CONTEXT: { client: { hl: "en" } } } },
      fetch: (url, opts) => {
        calls.push(url);
        if (url === "/feed/channels") {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(pageHtml([sub(CH1, "One"), cont("T1")]))
          });
        }
        if (String(url).indexOf("/youtubei/v1/browse") === 0) {
          const body = JSON.parse(opts.body);
          if (body.continuation === "T1") {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(contJson([sub(CH2, "Two"), cont("T2")]))
            });
          }
          if (body.continuation === "T2") {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(contJson([sub(CH1, "One")]))
            });
          }
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.addEventListener = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };
    sandbox.postMessage = (msg) => { responses.push(msg); };
    sandbox.dispatchEvent = () => {};
    vm.createContext(sandbox);
    vm.runInContext(read("page/bridge.js"), sandbox, { filename: "bridge.js" });
    const inner = vm.runInContext("globalThis", sandbox);
    listeners.message[0]({ source: inner, data: { __yga: "cmd", id: 1, nonce: "n", cmd: "browseSubscriptions" } });
    await flush(40);
    const resp = responses[responses.length - 1];
    const list = (resp && resp.ok && resp.data) || [];
    check(
      "bridge: browse follows continuation tokens to the end",
      !!resp && resp.ok && list.length === 2 &&
      list.some((s) => s.channelId === CH1) && list.some((s) => s.channelId === CH2),
      JSON.stringify(list)
    );
    check(
      "bridge: continuation POSTs carry the token",
      calls.length === 3 && calls[1].indexOf("/youtubei/v1/browse") === 0,
      JSON.stringify(calls)
    );
  })().catch((e) => failures.push("browse continuation section crashed: " + e)));
}

Promise.all(chains).then(() => report());

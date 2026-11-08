// Main-world bridge (PLAN.md §7). Fixed command set only: no eval, no arbitrary args.
// Protocol: isolated world posts {__yga:"cmd", id, nonce, cmd}; we answer
// {__yga:"resp", id, nonce, ok, data} back to location.origin.
(function () {
  "use strict";
  if (window.__ygaBridgeInstalled) return;
  window.__ygaBridgeInstalled = true;

  const ORIGIN = location.origin;

  function txt(t) {
    if (!t) return "";
    if (typeof t === "string") return t;
    if (t.simpleText) return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || "").join("");
    if (t.content) return String(t.content);
    return "";
  }

  function img(t) {
    if (!t) return "";
    if (typeof t === "string") return t;
    const th = t.thumbnails;
    if (Array.isArray(th) && th.length) return th[th.length - 1].url || "";
    if (Array.isArray(t.sources) && t.sources.length) return t.sources[0].url || "";
    return "";
  }

  function avatarOf(obj) {
    return img(obj.avatar) ||
      img(obj.thumbnail) ||
      img(obj.thumbnailViewModel && obj.thumbnailViewModel.image) ||
      img(obj.entityImageViewModel);
  }

  function titleOf(obj) {
    return txt(obj.title) ||
      txt(obj.snippet && obj.snippet.title) ||
      txt(obj.lockupMetadataViewModel && obj.lockupMetadataViewModel.title) ||
      txt(obj.metadata && obj.metadata.lockupMetadataViewModel &&
        obj.metadata.lockupMetadataViewModel.title) ||
      (typeof obj.content === "string" ? "" : "");
  }

  function walk(node, visit, depth) {
    if (!node || typeof node !== "object" || depth > 16) return;
    visit(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit, depth + 1);
    } else {
      for (const key of Object.keys(node)) walk(node[key], visit, depth + 1);
    }
  }

    function pickId(obj) {
      const be = obj.browseEndpoint ||
        obj.navigationEndpoint && obj.navigationEndpoint.browseEndpoint;
      if (be && typeof be.browseId === "string" && be.browseId.indexOf("UC") === 0) {
        return be.browseId;
      }
      const direct = obj.channelId || obj.externalId || obj.contentId || obj.browseId;
      if (typeof direct === "string" && direct.indexOf("UC") === 0) return direct;
      return null;
    }

    function extractSubs(root) {
      const found = new Map();
      walk(root, (obj) => {
        const id = pickId(obj);
        if (!id || found.has(id)) return;
        const title = titleOf(obj);
        if (!title) return;
        found.set(id, { channelId: id, title: title, avatarUrl: avatarOf(obj) });
      }, 0);
      return Array.from(found.values());
    }

  function guideRoot() {
    return window.ytInitialGuideData || window.ytInitialGuide || null;
  }

  function cmdGetGuideSubscriptions() {
    const guide = guideRoot();
    if (!guide) return [];
    let subs = [];
    walk(guide, (obj) => {
      if (obj.guideSubscriptionsSectionRenderer) {
        subs = subs.concat(extractSubs(obj.guideSubscriptionsSectionRenderer));
      }
    }, 0);
    if (!subs.length) subs = extractSubs(guide);
    const seen = new Map();
    for (const s of subs) if (!seen.has(s.channelId)) seen.set(s.channelId, s);
    return Array.from(seen.values());
  }

  function cmdGetContext() {
    const cfg = window.ytcfg && ytcfg.data_;
    if (!cfg) return null;
    const context = cfg.INNERTUBE_CONTEXT || null;
    return {
      hl: context && context.context && context.context.client && context.context.client.hl || cfg.HL || "en",
      gl: context && context.context && context.context.client && context.context.client.gl || cfg.GL || "US",
      apiKey: cfg.INNERTUBE_API_KEY || "",
      context: context,
      visitorData: cfg.VISITOR_DATA || ""
    };
  }

    function unwrapContext() {
      const raw = window.ytcfg && ytcfg.get && ytcfg.get("INNERTUBE_CONTEXT");
      if (!raw) return null;
      return raw.context ? raw.context : raw;
    }

    // browseSubscriptions runs in the page: same origin, cookies and visitorData
    // — youtubei rejects SW-origin calls (403). PLAN.md §6, §7.
    function cmdBrowseSubscriptions() {
      const ctx = unwrapContext();
      if (!ctx) return Promise.reject(new Error("no INNERTUBE_CONTEXT"));
      const body = { context: ctx, browseId: "FEED_SUBSCRIPTIONS" };
      return fetch("/youtubei/v1/browse?prettyPrint=false", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then((res) => {
        if (!res.ok) throw new Error("browse HTTP " + res.status);
        return res.json();
      }).then((json) => extractSubs(json));
    }

    const COMMANDS = {
      getGuideSubscriptions: cmdGetGuideSubscriptions,
      getContext: cmdGetContext,
      browseSubscriptions: cmdBrowseSubscriptions
      // getAccountInfo() arrives in stage 2 (PLAN.md §7).
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.__yga !== "cmd") return;
      const handler = COMMANDS[msg.cmd];
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error("unknown command");
          return handler();
        })
        .then(
          (data) => window.postMessage(
            { __yga: "resp", id: msg.id, nonce: msg.nonce, ok: true, data: data }, ORIGIN),
          (err) => window.postMessage(
            { __yga: "resp", id: msg.id, nonce: msg.nonce, ok: false,
              error: String(err && err.message || err) }, ORIGIN)
        );
    });
})();

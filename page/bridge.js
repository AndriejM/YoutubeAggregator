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
    if (typeof obj.channelId === "string" && obj.channelId.indexOf("UC") === 0) {
      return obj.channelId;
    }
    if (typeof obj.externalId === "string" && obj.externalId.indexOf("UC") === 0) {
      return obj.externalId;
    }
    return null;
  }

  function extractSubs(root) {
    const found = new Map();
    walk(root, (obj) => {
      const id = pickId(obj);
      if (!id || found.has(id)) return;
      const title = txt(obj.title) || txt(obj.snippet && obj.snippet.title);
      if (!title) return;
      const avatarUrl = img(obj.avatar) || img(obj.thumbnail);
      found.set(id, { channelId: id, title: title, avatarUrl: avatarUrl });
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

  const COMMANDS = {
    getGuideSubscriptions: cmdGetGuideSubscriptions,
    getContext: cmdGetContext
    // browseSubscriptions() and getAccountInfo() arrive in later stages (PLAN.md §7).
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__yga !== "cmd") return;
    const handler = COMMANDS[msg.cmd];
    let resp;
    try {
      if (!handler) throw new Error("unknown command");
      resp = { __yga: "resp", id: msg.id, nonce: msg.nonce, ok: true, data: handler() };
    } catch (err) {
      resp = { __yga: "resp", id: msg.id, nonce: msg.nonce, ok: false, error: String(err.message || err) };
    }
    window.postMessage(resp, ORIGIN);
  });
})();

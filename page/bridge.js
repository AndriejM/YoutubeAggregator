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
      // Exact known paths first (channelRenderer family).
      for (const p of [obj.subscriberContent, obj.channelRenderer, obj.videoOwnerRenderer]) {
        if (p && typeof p.channelId === "string" && p.channelId.indexOf("UC") === 0) {
          return p.channelId;
        }
      }
      const be = obj.browseEndpoint ||
        obj.navigationEndpoint && obj.navigationEndpoint.browseEndpoint;
      if (be && typeof be.browseId === "string" && be.browseId.indexOf("UC") === 0) {
        return be.browseId;
      }
      const cvo = obj.collectionViewModel;
      if (cvo && typeof cvo.collectionId === "string" && cvo.collectionId.indexOf("UC") === 0) {
        return cvo.collectionId;
      }
      const direct = obj.channelId || obj.externalId || obj.contentId || obj.browseId;
      if (typeof direct === "string" && direct.indexOf("UC") === 0) return direct;
      // Any endpoint payload carrying a UC id (browse/watch/listWatch).
      for (const key of ["browseEndpoint", "watchEndpoint", "listWatchEndpoint", "browseByIdEndpoint"]) {
        for (const ep of [obj[key], obj[key] && obj[key].commandMetadata &&
          obj[key].commandMetadata.webCommandMetadata]) {
          if (ep && typeof ep.browseId === "string" && ep.browseId.indexOf("UC") === 0) {
            return ep.browseId;
          }
          if (ep && typeof ep.videoId === "string" && obj[key].browseId &&
              String(obj[key].browseId).indexOf("UC") === 0) {
            return obj[key].browseId;
          }
        }
      }
      return null;
    }

    function avatarFromAny(obj) {
      let url = "";
      walk(obj, (inner) => {
        if (url) return;
        const cand = inner.thumbnails && inner.thumbnails[inner.thumbnails.length - 1] ||
          inner.sources && inner.sources[0];
        const u = cand && cand.url;
        if (typeof u === "string" && /ytimg|i\.ytimg|googleusercontent/.test(u)) url = u;
      }, 0);
      return url;
    }

    function extractSubs(root) {
      const found = new Map();
      const own = ownChannelId();
      walk(root, (obj) => {
        const id = pickId(obj);
        if (!id || found.has(id) || (own && id === own)) return;
        let title = titleOf(obj);
        if (!title) {
          // collectionViewModel: title/avatar live in child view models.
          walk(obj, (inner) => {
            if (title) return;
            const lm = inner.lockupMetadataViewModel;
            if (lm) title = lm.title && lm.title.content || lm.title && titleOf(lm.title) || "";
            if (!title) title = titleOf(inner);
          }, 0);
        }
        if (!title) return;
        const avatarUrl = avatarOf(obj) || avatarFromAny(obj);
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
    const raw = cfg.INNERTUBE_CONTEXT || null;
    const context = raw && raw.context ? raw.context : raw;
    const client = (context && context.client) || {};
    return {
      hl: client.hl || cfg.HL || "en",
      gl: client.gl || cfg.GL || "US",
      apiKey: cfg.INNERTUBE_API_KEY || "",
      context: context,
      visitorData: client.visitorData || cfg.VISITOR_DATA || ""
    };
  }

    // Own channel id from ytcfg ("Create post" chip in feeds points here).
    function ownChannelId() {
      try {
        const cfg = window.ytcfg && ytcfg.data_;
        if (!cfg) return "";
        if (typeof cfg.EXTERNAL_CHANNEL_ID === "string") return cfg.EXTERNAL_CHANNEL_ID;
        const svc = (cfg.SERVICES || []).find((s) => s && s.authUser);
        return svc && svc.channelId || "";
      } catch (e) {
        return "";
      }
    }

    // Full subscriptions page (PLAN.md §6 fallback2): plain HTML with
    // ytInitialData — works with the page session, unlike youtubei/browse,
    // which requires the page-only SAPISIDHASH authorization header.
    function fetchChannelsPage(path) {
      return fetch(path, { credentials: "same-origin" }).then((res) => {
        if (!res.ok) throw new Error(path + " HTTP " + res.status);
        return res.text();
      }).then((html) => {
        const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ||
          html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
        if (!m) return [];
        const json = JSON.parse(m[1]);
        const subs = extractSubs(json);
        if (!subs.length) {
          const jm = html.match(/ytInitialJSONLData\s*=\s*(\{.+?\});\s*<\/script>/s);
          if (jm) subs.push(...extractSubs(JSON.parse(jm[1])));
        }
        return subs;
      });
    }

    function cmdBrowseSubscriptions() {
      return fetchChannelsPage("/feed/channels");
    }

    function cmdGetSubscriptionsPage() {
      return fetchChannelsPage("/feed/subscriptions");
    }

    function cmdGetAccountInfo() {
      const cfg = window.ytcfg && ytcfg.data_;
      if (!cfg) return null;
      return {
        apiKey: cfg.INNERTUBE_API_KEY || "",
        dataOnEmbedUrl: cfg.DATA_ON_EMBEDDED_UI_URL || "",
        pageHostname: location.hostname,
        loggedIn: !!cfg.LOGGED_IN
      };
    }

    const COMMANDS = {
      getGuideSubscriptions: cmdGetGuideSubscriptions,
      getContext: cmdGetContext,
      browseSubscriptions: cmdBrowseSubscriptions,
      getSubscriptionsPage: cmdGetSubscriptionsPage,
      getAccountInfo: cmdGetAccountInfo
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

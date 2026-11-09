// Main-world bridge (PLAN.md §7). Fixed command set only: no eval, no arbitrary args.
// Protocol: isolated world posts {__yga:"cmd", id, nonce, cmd}; we answer
// {__yga:"resp", id, nonce, ok, data} back to location.origin.
(function () {
  "use strict";
  if (window.__ygaBridgeInstalled) return;
  window.__ygaBridgeInstalled = true;

  const ORIGIN = location.origin;
  const PENDING_KEY = "yga:pending-log";
  const PENDING_MAX = 100;

  function journal(kind, detail) {
    const text = String(detail == null ? "" : detail);
    try {
      window.dispatchEvent(new CustomEvent("yga:journal", {
        detail: kind + "\u0000" + text
      }));
    } catch (e) {}
    try {
      const raw = window.sessionStorage.getItem(PENDING_KEY);
      const entries = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(entries) ? entries : [];
      list.push({ t: Date.now(), kind: kind, detail: text });
      window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-PENDING_MAX)));
    } catch (e) {}
  }

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
      if (!node || typeof node !== "object" || depth > 40) return;
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

    // Balanced-brace JSON extractor: regex over megabyte scripts is fragile
    // (lazy .+? truncates, greedy .+ overshoots into sibling script tags).
    function grabJson(text, marker) {
      const at = text.indexOf(marker);
      if (at < 0) return "";
      const start = text.indexOf("{", at);
      if (start < 0) return "";
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          if (--depth === 0) return text.slice(start, i + 1);
        }
      }
      return "";
    }

    function parseEmbedded(jsonText, label, sink) {
      if (!jsonText) return;
      try {
        sink(extractSubs(JSON.parse(jsonText)));
      } catch (e) {
        console.warn("[yga] failed to parse " + label + ":", e);
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
        const merged = new Map();
        const absorb = (subs) => subs.forEach((s) => {
          if (!merged.has(s.channelId)) merged.set(s.channelId, s);
        });
        parseEmbedded(grabJson(html, 'ytInitialData = {'), "ytInitialData", absorb);
        if (!merged.size) parseEmbedded(grabJson(html, 'ytInitialJSONLData = {'), "ytInitialJSONLData", absorb);
        return Array.from(merged.values());
      });
    }

    function cmdBrowseSubscriptions() {
      return fetchChannelsPage("/feed/channels");
    }

    function cmdGetSubscriptionsPage() {
      return fetchChannelsPage("/feed/subscriptions");
    }

    // Current account. ytcfg is the only source guaranteed on every page:
    // EXTERNAL_CHANNEL_ID / SERVICES.authUser carry the logged-in channel id
    // (already proven by own-channel filtering of the subscriptions list).
    // The masthead account item is shadow-DOM and often absent from
    // ytInitialData, so it only adds the human title/avatar when present.
    function findAccountItem() {
      const data = window.ytInitialData;
      if (!data) return null;
      let best = null;
      walk(data, (obj) => {
        const it = obj.accountItemRenderer || obj.switchAccountItemRenderer ||
          obj.myAccountRenderer;
        if (it && !best) best = it;
      }, 0);
      return best;
    }

    function accountHandleFrom(item) {
      let handle = "";
      walk(item, (inner) => {
        if (handle) return;
        const ep = inner.navigationEndpoint && inner.navigationEndpoint.browseEndpoint;
        if (ep && typeof ep.canonicalBaseUrl === "string" &&
            ep.canonicalBaseUrl.indexOf("/@") === 0) {
          handle = ep.canonicalBaseUrl.slice(2);
        }
        const wcm = inner.webCommandMetadata;
        if (!handle && wcm && typeof wcm.url === "string" && wcm.url.indexOf("/@") === 0) {
          handle = wcm.url.slice(2);
        }
      }, 0);
      return handle;
    }

    function cmdGetAccountInfo() {
      const cfg = window.ytcfg && ytcfg.data_;
      const channelId = ownChannelId();
      const account = {
        apiKey: cfg && cfg.INNERTUBE_API_KEY || "",
        loggedIn: !!(cfg && cfg.LOGGED_IN),
        pageHostname: location.hostname,
        accountKey: channelId,
        channelId: channelId,
        sessionIndex: cfg && typeof cfg.SESSION_INDEX === "number" ? cfg.SESSION_INDEX : null,
        title: "", avatarUrl: "", handle: ""
      };
      const item = findAccountItem();
      if (item) {
        account.title = txt(item.title) || txt(item.selectedAccountName) ||
          txt(item.fullName) || "";
        account.avatarUrl = (item.accountPortrait && avatarOf(item.accountPortrait)) ||
          avatarOf(item) || avatarFromAny(item);
        account.handle = accountHandleFrom(item);
        if (!account.accountKey) account.accountKey = account.handle || account.title || "";
      }
      return account;
    }

    // Channel of the page being viewed (§8.8). Deliberately NOT ytcfg
    // EXTERNAL_CHANNEL_ID: that is the signed-in user, not the channel on
    // screen. channelMetadataRenderer and a canonical /channel/UC… link are
    // page-scoped, so they stay correct on someone else's channel.
    function cmdGetPageChannel() {
      const data = window.ytInitialData;
      const meta = data && data.metadata && data.metadata.channelMetadataRenderer;
      const externalId = meta && meta.externalId;
      let channelId = typeof externalId === "string" && externalId.indexOf("UC") === 0 ? externalId : "";
      const title = meta ? txt(meta.title) : "";
      if (!channelId) {
        const link = document.querySelector('link[rel="canonical"]');
        const href = (link && link.getAttribute("href")) || "";
        const m = href.match(/\/channel\/(UC[0-9A-Za-z_-]{10,})/);
        if (m) channelId = m[1];
      }
      if (!channelId) {
        const tag = document.querySelector('meta[itemprop="channelId"]');
        const content = (tag && tag.getAttribute("content")) || "";
        if (content.indexOf("UC") === 0) channelId = content;
      }
      return { channelId: channelId, title: title };
    }

    function apiKind(obj, method) {
      if (!obj) return "-";
      if (typeof obj[method] === "function") return "fn";
      return typeof obj;
    }

    function keysOf(obj) {
      try {
        return obj && typeof obj === "object" ? Object.keys(obj).slice(0, 80).join(",") : "";
      } catch (e) {
        return "";
      }
    }

    function keysMatching(obj, re) {
      try {
        return obj && typeof obj === "object"
          ? Object.keys(obj).filter((key) => re.test(key)).slice(0, 80).join(",")
          : "";
      } catch (e) {
        return "";
      }
    }

    function ytPageManager() {
      const yt = window.yt;
      if (!yt || typeof yt !== "object") return null;
      const names = [
        "pageManager", "pageManager_", "pageManagerInstance", "pageManagerInstance_",
        "pageManagerInstanceInstance_", "pageManagerInstanceInstance"
      ];
      for (const name of names) {
        const value = yt[name];
        if (value && (typeof value === "object" || typeof value === "function")) return value;
      }
      return null;
    }

    function methodKind(obj, methods) {
      if (!obj) return "-";
      const parts = methods.filter((method) => typeof obj[method] === "function");
      return parts.length ? "fn:" + parts.join(",") : typeof obj;
    }

    function navGlobals() {
      const out = [];
      const seen = new Set();
      const re = /(^|_)(nav|page|spf|history|route|router|endpoint|content|app)|^yt/i;
      for (const key of Object.getOwnPropertyNames(window)) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!re.test(key)) continue;
        let value;
        try {
          value = window[key];
        } catch (e) {
          out.push(key + "=err");
          continue;
        }
        if (typeof value === "function") {
          out.push(key + "=fn");
        } else if (value && typeof value === "object") {
          const kind = methodKind(value, ["navigate", "load", "push", "replace", "go", "dispatch"]);
          out.push(key + "=" + kind);
        }
      }
      return out;
    }

    function cmdGetNavApis() {
      return {
        ytPageManagerApi: apiKind(window.ytPageManagerApi, "load"),
        ytPageManagerApiKeys: keysOf(window.ytPageManagerApi),
        ytspb: apiKind(window.ytspb, "navigate"),
        ytspbKeys: keysOf(window.ytspb),
        yt: methodKind(window.yt, ["navigate", "load", "push", "replace", "go", "dispatch"]),
        ytMethods: methodKind(window.yt, ["navigate", "load", "push", "replace", "go", "dispatch", "setPageData", "setNext"]),
        ytKeys: keysOf(window.yt),
        ytNavKeys: keysMatching(window.yt, /page|nav|load|route|command|manager|spf|history|dispatch/i),
        ytPageManager: methodKind(ytPageManager(), ["navigate", "load", "prefetch", "process", "request"]),
        ytPageManagerKeys: keysOf(ytPageManager()),
        ytglobal: methodKind(window.ytglobal, ["navigate", "load", "prefetch", "process", "request"]),
        ytglobalKeys: keysOf(window.ytglobal),
        ytCommand: methodKind(window.ytCommand, ["navigate", "load", "request", "process", "dispatch"]),
        ytCommandKeys: keysMatching(window.ytCommand, /nav|page|load|command|url|endpoint|action/i),
        ytSignals: methodKind(window.ytSignals, ["navigate", "load", "dispatch"]),
        spf: methodKind(window.spf, ["navigate", "load", "request", "init", "dispatch", "process"]),
        spfKeys: keysOf(window.spf),
        navigation: methodKind(window.navigation, ["navigate", "traverseTo"]),
        navGlobals: navGlobals()
      };
    }

    function safeHref(href) {
      return typeof href === "string" &&
        href.length > 1 &&
        href.length < 2048 &&
        href.charAt(0) === "/" &&
        href.charAt(1) !== "/";
    }

    function anchorSelector(href) {
      const attr = String(href).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return 'a[href="' + attr + '"]:not([data-yga-row])';
    }

    function findNativeAnchor(href) {
      let a = null;
      try {
        a = document.querySelector(anchorSelector(href));
        if (!a) {
          const attr = String(href).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          a = document.querySelector('a[href$="' + attr + '"]:not([data-yga-row])');
        }
        if (a && (a.closest("[data-yga]") || (a.target && a.target !== "_self"))) a = null;
      } catch (e) {
        a = null;
      }
      return a;
    }

    function anchorClick(href, from) {
      if (!document.body) return false;
      let a = findNativeAnchor(href);
      let temp = false;
      if (!a) {
        a = document.createElement("a");
        a.href = href;
        a.className = "spf-link yt-simple-endpoint";
        a.setAttribute("data-yga-anchor", "1");
        a.style.display = "none";
        document.body.appendChild(a);
        temp = true;
      }

      const ev = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0
      });
      const onFinal = (e) => {
        if (e !== ev) return;
        if (!e.defaultPrevented) e.preventDefault();
      };

      window.addEventListener("click", onFinal, false);
      try {
        a.dispatchEvent(ev);
      } finally {
        window.removeEventListener("click", onFinal, false);
        if (temp) a.remove();
      }
      // YouTube may intercept the synthetic click asynchronously: it does not
      // always preventDefault() during dispatch, but yt-navigate-start fires a
      // tick later. Returning false here made cmdNavigate() fall through before
      // the successful SPA event could be observed.
      return true;
    }

    function spaApis(from) {
      const apis = [];
      const w = window;
      const pm = ytPageManager();
      const cmd = w.ytCommand;

      if (cmd && typeof cmd.navigate === "function") {
        const nav = cmd.navigate.bind(cmd);
        apis.push({ name: "ytcommand-nav-url", run: (href) => nav({ url: href, refer: from }) });
        apis.push({ name: "ytcommand-nav-args", run: (href) => nav(href, { refer: from }, "content") });
        apis.push({ name: "ytcommand-nav-url-current", run: (href) => nav({ url: href, current: from }) });
      }
      if (cmd && typeof cmd.load === "function") {
        const load = cmd.load.bind(cmd);
        apis.push({ name: "ytcommand-load-url", run: (href) => load({ url: href, refer: from }) });
      }
      if (w.ytglobal && typeof w.ytglobal.navigate === "function") {
        const nav = w.ytglobal.navigate.bind(w.ytglobal);
        apis.push({ name: "ytglobal-nav-refer", run: (href) => nav(href, { refer: from }, "content") });
        apis.push({ name: "ytglobal-nav-current", run: (href) => nav(href, { current: from }, "content") });
        apis.push({ name: "ytglobal-nav-url", run: (href) => nav({ url: href, current: from }, null, "content") });
      }
      if (w.ytglobal && typeof w.ytglobal.load === "function") {
        const load = w.ytglobal.load.bind(w.ytglobal);
        apis.push({ name: "ytglobal-load-refer", run: (href) => load(href, { refer: from }, "content") });
      }
      if (w.ytPageManagerApi && typeof w.ytPageManagerApi.load === "function") {
        const load = w.ytPageManagerApi.load.bind(w.ytPageManagerApi);
        apis.push({ name: "pma-url", run: (href) => load({ url: href }) });
      }
      if (w.ytPageManagerApi && typeof w.ytPageManagerApi.navigate === "function") {
        const nav = w.ytPageManagerApi.navigate.bind(w.ytPageManagerApi);
        apis.push({ name: "pma-navigate-url", run: (href) => nav({ url: href }) });
      }
      if (w.ytspb && typeof w.ytspb.navigate === "function") {
        const nav = w.ytspb.navigate.bind(w.ytspb);
        apis.push({ name: "ytspb", run: (href) => nav(href, { current: from }) });
      }
      if (pm && typeof pm.navigate === "function") {
        const nav = pm.navigate.bind(pm);
        apis.push({ name: "pm-nav-refer", run: (href) => nav(href, { refer: from }, "content") });
      }
      if (w.yt && typeof w.yt.load === "function") {
        const load = w.yt.load.bind(w.yt);
        apis.push({ name: "yt-load-url", run: (href) => load({ url: href }) });
      }
      apis.push({ name: "anchor-click", wait: 1500, run: (href) => anchorClick(href, from) });
      return apis;
    }

    function cmdNavigate(href) {
      return new Promise((resolve) => {
        if (!safeHref(href)) {
          resolve({ ok: false, error: "badHref" });
          return;
        }
        const from = window.location.href;
        const errors = [];
        let done = false;
        let cleanup = () => {};
        const finish = (res) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(res);
        };
        let eventFired = false;
        let currentApi = "";
        const onStart = () => {
          eventFired = true;
          journal("page-nav", "event start " + (currentApi || "?") + " " + href);
          finish({ ok: true, api: currentApi || "event" });
        };
        const onFinish = () => {
          eventFired = true;
          journal("page-nav", "event finish " + (currentApi || "?") + " " + href);
          finish({ ok: true, api: currentApi || "event" });
        };
        window.addEventListener("yt-navigate-start", onStart, { once: true });
        window.addEventListener("yt-navigate-finish", onFinish, { once: true });
        cleanup = () => {
          window.removeEventListener("yt-navigate-start", onStart);
          window.removeEventListener("yt-navigate-finish", onFinish);
        };

        const apis = spaApis(from);
        journal("page-nav", "start " + href + " apis=" + apis.map((a) => a.name).join(","));
        function waitApi(api, index) {
          setTimeout(() => {
            if (done || eventFired) return;
            if (window.location.href !== from) {
              journal("page-nav", "url-no-event " + api.name + " " + href);
              finish({ ok: false, api: api.name, error: "url-no-event" });
              return;
            }
            journal("page-nav", "noop " + api.name + " " + href);
            tryApi(index + 1);
          }, api.wait || 500);
        }
        function tryApi(index) {
          if (done) return;
          if (eventFired) return;
          if (index >= apis.length) {
            journal("page-nav", "none " + href + " errors=" + errors.join(";"));
            finish({ ok: false, api: "none", errors: errors.join(";"), apis: cmdGetNavApis() });
            return;
          }
          const api = apis[index];
          currentApi = api.name;
          journal("page-nav", "try " + api.name + " " + href);
          try {
            const ret = api.run(href);
            if (ret === false) {
              errors.push(api.name + ":false");
              journal("page-nav", "false " + api.name + " " + href);
              tryApi(index + 1);
              return;
            }
            if (ret && typeof ret.then === "function") {
              ret.then(
                () => {},
                (e) => {
                  errors.push(api.name + ":promise:" + String(e && e.message || e));
                  journal("page-nav", "promise-err " + api.name + " " + String(e && e.message || e));
                  if (!done && !eventFired && window.location.href === from) tryApi(index + 1);
                }
              );
            }
            if (eventFired) return;
            if (window.location.href !== from) {
              journal("page-nav", "url-wait " + api.name + " " + href);
              waitApi(api, index);
              return;
            }
          } catch (e) {
            errors.push(api.name + ":" + String(e && e.message || e));
            journal("page-nav", "err " + api.name + " " + String(e && e.message || e));
            tryApi(index + 1);
            return;
          }
          waitApi(api, index);
        }

        tryApi(0);
        setTimeout(() => finish({ ok: false, error: "timeout", apis: cmdGetNavApis() }), 8000);
      });
    }

    const COMMANDS = {
      getGuideSubscriptions: cmdGetGuideSubscriptions,
      getContext: cmdGetContext,
      browseSubscriptions: cmdBrowseSubscriptions,
      getSubscriptionsPage: cmdGetSubscriptionsPage,
      getAccountInfo: cmdGetAccountInfo,
      getPageChannel: cmdGetPageChannel,
      getNavApis: cmdGetNavApis,
      navigate: cmdNavigate
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.__yga !== "cmd") return;
      const handler = COMMANDS[msg.cmd];
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error("unknown command");
          return handler(msg.arg);
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

// Shared Node harness (no browser, no deps): chrome stubs + service-worker
// sandbox + check/report. Used by test/logic.mjs (worker + content logic) and
// test/dom.mjs (widget DOM layer). Run those files, not this one.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

export const parserSrc = read("content/rss-parser.js");
export const swSrc = read("background/service-worker.js").replace(/^import .*$/m, "");
export const fixture = read("test/fixture-feed.xml");

export const CH1 = "UCtestchannel0000000000A";
export const CH2 = "UCtestchannel0000000000B";

let passed = 0;
export const failures = [];

export function check(name, cond, extra) {
  if (cond) {
    passed++;
  } else {
    failures.push(name + (extra ? " — " + extra : ""));
    console.error("FAIL " + name + (extra ? " — " + extra : ""));
  }
}

export function report() {
  console.log("passed " + passed + (failures.length ? ", FAILED " + failures.length : ""));
  // Always exit: the content scripts now keep a setInterval alive (the group
  // button overlay tracks its anchor), which would otherwise hang the runner.
  process.exit(failures.length ? 1 : 0);
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export const flush = async (n) => {
  for (let i = 0; i < (n || 20); i++) await new Promise((r) => setTimeout(r, 2));
};

// --- chrome stubs -------------------------------------------------------

// Enough of Chrome's match-pattern grammar for the patterns this extension
// declares (https://*.youtube.com/*): scheme, optional wildcard host, path.
function urlMatches(pattern, url) {
  if (!pattern || pattern === "<all_urls>") return true;
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const at = pattern.indexOf("://");
  if (at < 0) return false;
  const scheme = pattern.slice(0, at) === "*" ? "https?" : esc(pattern.slice(0, at));
  const rest = pattern.slice(at + 3);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "/*" : rest.slice(slash);
  const hostRe = host === "*" ? "[^/]+" : host.startsWith("*.") ? "(?:.+\\.)?" + esc(host.slice(2)) : esc(host);
  const pathRe = esc(path).replace(/\*/g, ".*");
  return new RegExp("^" + scheme + "://" + hostRe + pathRe + "$").test(url);
}

export function makeSandbox() {
  const storage = new Map(); // key -> value
  const alarms = new Map();
  const listeners = { message: [], alarm: [], installed: [], startup: [] };
  const bus = []; // payloads the worker broadcast to the tabs
  const opened = []; // chrome.tabs.create payloads («Все новые» opens a tab)
  const tabs = []; // open tabs: { id, url, listeners } — listeners = content-script world
  function addTab(url) {
    const tab = { id: tabs.length + 1, url: url || "https://www.youtube.com/", listeners: [] };
    tabs.push(tab);
    return tab;
  }
  addTab("https://www.youtube.com/feed/subscriptions");
  let fetchCalls = [];
  let fetchResponder = function () {
    return { status: 200, body: fixture, etag: "etag-v1" };
  };

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list =
            keys === undefined ? Array.from(storage.keys())
            : typeof keys === "string" ? [keys]
            : Array.isArray(keys) ? keys
            : Object.keys(keys);
          for (const k of list) if (storage.has(k)) out[k] = clone(storage.get(k));
          return out;
        },
        set: async (payload) => {
          for (const k in payload) storage.set(k, clone(payload[k]));
        },
        remove: async (key) => {
          const list = typeof key === "string" ? [key] : key;
          for (const k of list) storage.delete(k);
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      sendMessage: async (msg) => {
        bus.push(msg);
        return {};
      },
      getURL: (p) => "chrome-extension://test/" + p
    },
    alarms: {
      create: async (name, opts) => {
        alarms.set(name, opts || {});
        if (opts && (opts.when || opts.delayInMinutes)) {
          setTimeout(() => {
            for (const fn of listeners.alarm) fn({ name: name });
          }, opts.when ? Math.max(0, opts.when - Date.now()) : Math.max(1, Math.round((opts.delayInMinutes || 0) * 50)));
        }
      },
      get: async (name) => (alarms.has(name) ? { name: name, periodInMinutes: alarms.get(name).periodInMinutes } : undefined),
      clear: async (name) => {
        alarms.delete(name);
        return true;
      },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    i18n: { getMessage: () => "" },
    tabs: {
      create: async (opts) => {
        opened.push(opts || {});
        return { id: opened.length, url: (opts || {}).url || "" };
      },
      // Chrome only exposes tabs the extension has host access to; the worker
      // queries by match pattern, so the stub has to honour the pattern.
      query: async (info) => {
        const pattern = info && info.url;
        return tabs
          .filter((t) => urlMatches(pattern, t.url))
          .map((t) => ({ id: t.id, url: t.url }));
      },
      // Only a tab whose content script registered an onMessage listener can
      // receive; anything else rejects exactly like Chrome's
      // "Could not establish connection. Receiving end does not exist."
      sendMessage: async (tabId, msg) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error("No tab with id: " + tabId);
        bus.push(msg);
        if (!tab.listeners.length) throw new Error("Could not establish connection. Receiving end does not exist.");
        // A throwing content listener must not reject the sender's promise,
        // same as in Chrome — surface it on the console instead.
        for (const fn of tab.listeners.slice()) {
          try {
            fn(msg, { id: tabId }, () => {});
          } catch (e) {
            console.error("[harness] content onMessage listener threw:", e);
          }
        }
        return {};
      }
    }
  };

  const realSetTimeout = setTimeout;
  // Clamped timers: the SW throttles with real ms; the harness must not sleep.
  const sandbox = {
    console,
    setTimeout: (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      const res = fetchResponder(url, opts, fetchCalls.length);
      if (res && res.then) return res;
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 400,
        headers: { get: (h) => (h.toLowerCase() === "etag" ? res.etag : null) },
        text: async () => res.body
      };
    },
    AbortController: globalThis.AbortController,
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
    parseInt,
    encodeURIComponent,
    RegExp,
    chrome
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox; // content modules (counters.js) hang off window.yga
  return {
    sandbox,
    storage,
    alarms,
    bus,
    opened,
    tabs,
    addTab,
    listeners,
    fetchCalls,
    setResponder(fn) {
      fetchResponder = fn;
    },
    async send(msg) {
      const fn = listeners.message[0];
      return new Promise((resolve) => {
        const async2 = fn(msg, {}, resolve);
        if (!async2) resolve(undefined);
      });
    },
    async flush(times) {
      for (let i = 0; i < (times || 6); i++) await new Promise((r) => realSetTimeout(r, 1));
    }
  };
}

export function loadInto(env) {
  vm.createContext(env.sandbox);
  vm.runInContext(parserSrc, env.sandbox, { filename: "rss-parser.js" });
  vm.runInContext(swSrc, env.sandbox, { filename: "service-worker.js" });
}

// A feed with `n` entries, newest first, so the 15+ display ceiling
// (content/widget.js countText) is reachable in tests.
export function feedWith(n, channelId) {
  const id = channelId || CH1;
  const base = Date.parse("2026-11-08T09:00:00.000Z");
  let entries = "";
  for (let i = 0; i < n; i++) {
    const vid = "v" + String(i).padStart(10, "0");
    const at = new Date(base - i * 3600000).toISOString();
    entries +=
      " <entry>\n" +
      "  <title>Video " + (i + 1) + "</title>\n" +
      "  <id>yt:video:" + vid + "</id>\n" +
      "  <yt:videoId>" + vid + "</yt:videoId>\n" +
      "  <yt:channelId>" + id + "</yt:channelId>\n" +
      "  <published>" + at + "</published>\n" +
      "  <media:group>\n" +
      "   <media:thumbnail url=\"https://yt3.ggpht.com/a" + i + "=s68\" height=\"1\" width=\"1\"/>\n" +
      "  </media:group>\n" +
      " </entry>\n";
  }
  return (
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\" xmlns:media=\"http://search.yahoo.com/mrss/\" xmlns=\"http://www.w3.org/2005/Atom\">\n" +
    " <link rel=\"alternate\" type=\"text/html\" href=\"https://www.youtube.com/channel/" + id + "\"/>\n" +
    " <title>Feed Channel</title>\n" +
    " <yt:channelId>" + id + "</yt:channelId>\n" +
    entries +
    "</feed>\n"
  );
}

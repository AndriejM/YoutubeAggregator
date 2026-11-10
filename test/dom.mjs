// Widget + config-panel DOM harness (no browser, no deps): runs the real
// content and config scripts (state.js, profiles.js, counters.js, widget.js,
// panel.js, panel-sections.js) against a minimal DOM and the real service
// worker from harness.mjs. Covers what logic.mjs cannot: row painting, the
// contextmenu "mark as watched" entry, applyCounts and the stage-4 panel.
// Run: node test/dom.mjs — exit code 0 = all checks pass.
import vm from "node:vm";
import {
  read, CH1, check, report, failures, flush, makeSandbox, loadInto, feedWith
} from "./harness.mjs";

// --- minimal DOM ---------------------------------------------------------

function parseSimple(s) {
  const sel = { tag: null, cls: [], attr: [] };
  const re = /([.#]?)([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[3]) sel.attr.push({ name: m[3], value: m[4] });
    else if (m[1] === ".") sel.cls.push(m[2]);
    else if (m[1] === "#") sel.attr.push({ name: "id", value: m[2] });
    else sel.tag = m[2].toLowerCase();
  }
  return sel;
}

function matches(node, sel) {
  if (!node.tagName) return false;
  if (sel.tag && node.tagName.toLowerCase() !== sel.tag) return false;
  for (const c of sel.cls) if (!node.classList.contains(c)) return false;
  for (const a of sel.attr) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  return true;
}

class TextNode {
  constructor(text) { this._text = text; this.parentNode = null; this.isText = true; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = Object.create(null);
    this.dataset = Object.create(null);
    this._text = "";
    this._listeners = Object.create(null);
    this._styleVars = Object.create(null);
    this.className = "";
    this.parentNode = null;
    const self = this;
    this.classList = {
      add(...c) { self._cls(new Set([...self._cls(), ...c])); },
      remove(...c) { const s = new Set(self._cls()); for (const x of c) s.delete(x); self._cls(s); },
      contains(c) { return self._cls().includes(c); },
      toggle(c, force) {
        const has = self.classList.contains(c);
        const on = force === undefined ? !has : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      }
    };
  }
  _cls(set) {
    if (set) { this.className = Array.from(set).join(" "); return this.className; }
    return this.className ? this.className.split(/\s+/).filter(Boolean) : [];
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return !!n.isRoot;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  set innerHTML(v) { this._html = v; } // static SVG markup only — never parsed here
  get innerHTML() { return this._html || ""; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  appendChild(node) {
    if (node.isFragment) { for (const c of node.children.slice()) this.appendChild(c); return node; }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    return node;
  }
  insertAdjacentElement(where, node) {
    if (where === "afterend" && this.parentNode) this.parentNode.insertBefore(node, this.nextSibling);
    else this.appendChild(node);
    return node;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.children[p.children.indexOf(this) + 1] || null;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  // Config panel (stage 4) touches these: style vars, focus, in-place rebuild.
  get style() {
    if (!this._style) {
      const self = this;
      this._style = {
        setProperty(k, v) { self._styleVars[k] = String(v); },
        removeProperty(k) { delete self._styleVars[k]; }
      };
    }
    return this._style;
  }
  get styleVars() { return this._styleVars; }
  focus() { this._focused = true; }
  scrollIntoView() {}
  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    p.insertBefore(node, this);
    this.remove();
  }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  closest(sel) {
    const parsed = parseSimple(sel);
    let n = this;
    while (n && n.tagName) { if (matches(n, parsed)) return n; n = n.parentNode; }
    return null;
  }
  _query(sel, all) {
    const out = [];
    for (const group of String(sel).split(",")) {
      const parts = group.trim().split(/\s+/).filter(Boolean).map(parseSimple);
      let level = [this];
      for (const part of parts) {
        const next = [];
        for (const ctx of level) {
          for (const child of ctx.children) {
            if (child.isText) continue;
            if (matches(child, part) && !next.includes(child)) next.push(child);
            collect(child, part, next);
          }
        }
        level = next;
      }
      for (const n of level) if (all ? !out.includes(n) : !out.length) out.push(n);
    }
    return all ? out : out[0] || null;
  }
  querySelector(sel) { return this._query(sel, false); }
  querySelectorAll(sel) { return this._query(sel, true); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const a = this._listeners[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let n = this;
    while (n) {
      ev.currentTarget = n;
      for (const fn of (n._listeners && n._listeners[ev.type]) || []) fn.call(n, ev);
      n = n.parentNode;
    }
    return !ev.defaultPrevented;
  }
}

function collect(node, sel, out) {
  for (const child of node.children) {
    if (child.isText) continue;
    if (matches(child, sel) && !out.includes(child)) out.push(child);
    collect(child, sel, out);
  }
}

// Real enough event plumbing for the panel: document-level keydown (capture)
// and window-level yt-navigate-finish both need to be dispatchable.
function makeTarget() {
  const map = Object.create(null);
  return {
    addEventListener(type, fn) { (map[type] = map[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = map[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) {
      const event = Object.assign(
        {
          type,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
          stopImmediatePropagation() { this.propagationStopped = true; }
        },
        ev
      );
      for (const fn of (map[type] || []).slice()) fn(event);
      return event;
    }
  };
}

const docEvents = makeTarget();
const windowEvents = makeTarget();

const document = {
  isRoot: true,
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => { const f = new Element("#fragment"); f.isFragment = true; return f; },
  createTextNode: (t) => new TextNode(t),
  querySelector: (sel) => root.querySelector(sel),
  querySelectorAll: (sel) => root.querySelectorAll(sel),
  addEventListener: docEvents.addEventListener,
  removeEventListener: docEvents.removeEventListener,
  readyState: "complete"
};
const root = new Element("#document");
root.isRoot = true;
root.parentNode = null;
document.body = root;
document.documentElement = new Element("html");
document.documentElement._styleVars["--yt-spec-text-primary"] = "#0f0f0f";
document.documentElement._styleVars["--yt-spec-text-secondary"] = "#aaaaaa";
document.documentElement._styleVars["--yt-spec-general-background-a"] = "#ffffff";

globalThis.getComputedStyle = (node) => ({
  getPropertyValue: (name) => (node && node._styleVars ? node._styleVars[name] || "" : ""),
  color: (node && node._computedColor) || "",
  backgroundColor: (node && node._computedBg) || ""
});

class IntersectionObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

// MutationObserver stand-in for the bootstrap remount test: records are only
// queued for subtrees under an observed root; flushMutations() delivers them.
const liveObservers = [];
let mutationQueue = [];
class MutationObserver {
  constructor(cb) { this.cb = cb; }
  observe(root) { liveObservers.push({ obs: this, root }); }
  disconnect() {
    for (let i = liveObservers.length - 1; i >= 0; i--) {
      if (liveObservers[i].obs === this) liveObservers.splice(i, 1);
    }
  }
}
function underObserved(node) {
  let n = node;
  while (n) {
    for (const entry of liveObservers) if (entry.root === n) return true;
    n = n.parentNode;
  }
  return false;
}
function recordMutation(node, oldParent) {
  if (underObserved(node) || underObserved(oldParent)) mutationQueue.push(node);
}
{
  const origAppend = Element.prototype.appendChild;
  const origRemove = Element.prototype.removeChild;
  Element.prototype.appendChild = function (node) {
    const res = origAppend.call(this, node);
    recordMutation(node, null);
    return res;
  };
  Element.prototype.removeChild = function (node) {
    const oldParent = node.parentNode;
    const res = origRemove.call(this, node);
    recordMutation(node, oldParent);
    return res;
  };
}
function flushMutations() {
  const records = mutationQueue;
  mutationQueue = [];
  if (!records.length) return;
  for (const entry of liveObservers.slice()) {
    if (records.some((r) => entry.root.contains(r))) entry.obs.cb(records, entry.obs);
  }
}

// --- content world over the real worker ---------------------------------

const env = makeSandbox();
loadInto(env);
env.setResponder(() => ({ status: 200, body: feedWith(16), etag: "etag-dom" }));

const shared = env.storage;
const content = { storageChanged: [], message: [] };
const changes = [];

const wsend = env.sandbox.chrome.runtime.sendMessage;
env.sandbox.chrome.runtime.sendMessage = async (msg) => {
  content.message.push(msg);
  return wsend(msg);
};
const wlocal = env.sandbox.chrome.storage.local;
const wset = wlocal.set;
wlocal.set = async function (payload) {
  for (const k in payload) {
    const old = shared.has(k) ? JSON.parse(JSON.stringify(shared.get(k))) : undefined;
    await wset({ [k]: payload[k] });
    changes.push({ key: k, oldValue: old, newValue: JSON.parse(JSON.stringify(shared.get(k))) });
  }
};

globalThis.window = globalThis;
globalThis.addEventListener = windowEvents.addEventListener;
globalThis.removeEventListener = windowEvents.removeEventListener;
globalThis.document = document;
globalThis.IntersectionObserver = IntersectionObserver;
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        const list =
          keys === undefined ? Array.from(shared.keys())
          : typeof keys === "string" ? [keys]
          : Array.isArray(keys) ? keys
          : Object.keys(keys);
        for (const k of list) if (shared.has(k)) out[k] = JSON.parse(JSON.stringify(shared.get(k)));
        return out;
      },
      set: async (payload) => {
        for (const k in payload) {
          const old = shared.has(k) ? JSON.parse(JSON.stringify(shared.get(k))) : undefined;
          shared.set(k, JSON.parse(JSON.stringify(payload[k])));
          changes.push({ key: k, oldValue: old, newValue: JSON.parse(JSON.stringify(shared.get(k))) });
        }
      },
      remove: async (key) => {
        for (const k of typeof key === "string" ? [key] : key) shared.delete(k);
      }
    },
    onChanged: { addListener: (fn) => content.storageChanged.push(fn) }
  },
  runtime: {
    onMessage: { addListener: (fn) => content.message.push(fn) },
    sendMessage: async (msg) => env.send(msg),
    getURL: (p) => "chrome-extension://test/" + p
  },
  i18n: { getMessage: (k) => k }
};

async function deliver() {
  await flush(40);
  while (changes.length) {
    const batch = changes.splice(0, changes.length);
    const payload = {};
    for (const c of batch) payload[c.key] = { oldValue: c.oldValue, newValue: c.newValue };
    for (const fn of content.storageChanged) fn(payload, "local");
    await flush(40);
  }
}

for (const f of [
  "content/selectors.js",
  "content/state.js",
  "content/profiles.js",
  "content/groups.js",
  "content/counters.js",
  "content/theme.js",
  "content/widget.js",
  "config/panel.js",
  "config/panel-sections.js"
]) {
  vm.runInThisContext(read(f), { filename: f });
}

const yga = globalThis.yga;
yga.i18n = (k) => k;
// bootstrap.js wires subs→render; the harness mirrors it so a profile switch
// repaints rows the same way the widget does in the browser.
yga.state.onSubsChanged((subs) => yga.widget.render(subs));

// --- scenario: 16 new videos, right-click must clear the chip ------------

const widget = document.createElement("div");
widget.className = "yga-widget";
widget.setAttribute("data-yga", "widget");
const listHost = document.createElement("div");
listHost.className = "yga-list";
widget.appendChild(listHost);
root.appendChild(widget);

env.sandbox.chrome.storage.local
  .set({
    "yga:profiles": { p_1: { id: "p_1", name: "All", builtin: true, includeAllSubs: true } },
    "yga:account": { accountKey: "UCme" },
    "yga:subs:UCme": [{ c: CH1, t: "One", a: "" }],
    "yga:settings": { version: 1, activeProfileId: "p_1", refresh: { mode: "onOpen", scheduled: { enabled: false }, batch: 12, minIntervalMs: 0 } }
  })
  .then(async () => {
    await env.send({ type: "counters:refresh", profileId: "p_1" });
    await flush(40);

    await yga.profiles.load();
    const pid = await yga.profiles.activeProfileId();
    await yga.state.setAccountKey("UCme");
    const init = await env.send({ type: "counters:init", profileId: "p_1" });
    yga.state.applyInitSnapshot(init.counts, init.aggregate, init.aggregateSeq);

    const subs = await yga.state.getVisibleSubs();
    yga.widget.render(subs);
    yga.counters.wire(widget);

    let detachedRenderOk = true;
    try {
      await Promise.resolve(subs).then(yga.widget.render);
    } catch (e) {
      detachedRenderOk = false;
    }
    check(
      "render: detached render keeps applyCounts",
      detachedRenderOk && !!widget.querySelector('[data-yga-row="' + CH1 + '"]'),
      "Promise.resolve(subs).then(yga.widget.render) threw"
    );

    const row = widget.querySelector('[data-yga-row="' + CH1 + '"]');
    const chip = () => row.querySelector(".yga-count");
    check("dom: row rendered", !!row);
    // YouTube's spf.js only claims a click when a .spf-link ancestor exists;
    // without it the browser does a real page load (the "channel click reloads
    // YouTube" bug). See content/widget.js rowNode.
    check(
      "dom: channel row carries spf-link so YouTube SPA-navigates it",
      !!row && row.classList.contains("spf-link") && row.classList.contains("yt-simple-endpoint")
    );
    check("dom: 16 new videos show as 15+", chip().textContent === "15+", JSON.stringify(chip().textContent));

    // PLAN.md §10.5: right-click = "mark as watched" until the stage-4 panel.
    const ev = { type: "contextmenu", ctrlKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    row.dispatchEvent(ev);
    check("dom: contextmenu default prevented", ev.defaultPrevented);
    await flush(20);

    check(
      "dom: right-click clears the chip immediately",
      chip().textContent === "" && chip().classList.contains("yga-hidden"),
      JSON.stringify(chip().textContent)
    );

    await deliver();
    check(
      "dom: chip stays cleared after storage/bus converge",
      chip().textContent === "" && chip().classList.contains("yga-hidden"),
      JSON.stringify(chip().textContent)
    );
    const total = widget.querySelector(".yga-total");
    check("dom: footer chip follows", !total || total.textContent === "" || total.classList.contains("yga-hidden"), JSON.stringify(total && total.textContent));

    // A second profile keeps its own view (PLAN.md §5) — the row repaints.
    const p2 = await yga.profiles.create("Curated");
    await yga.profiles.addChannel(p2.id, CH1);
    await yga.profiles.setActiveProfile(p2.id);
    await yga.state.refreshVisible();
    await flush(20);
    const row2 = widget.querySelector('[data-yga-row="' + CH1 + '"]');
    check(
      "dom: other profile still counts 15+",
      !!row2 && row2.querySelector(".yga-count").textContent === "15+",
      JSON.stringify(row2 && row2.querySelector(".yga-count").textContent)
    );

    // --- stage 4: inline configuration panel (PLAN.md §8.7, §9.2) ---------
    // A YouTube-shaped page so the panel gets a real ytd-app > #content anchor.
    widget.remove();
    const app = document.createElement("ytd-app");
    const content = document.createElement("div");
    content.setAttribute("id", "content");
    const page = document.createElement("ytd-two-column-browse-results-renderer");
    content.appendChild(page);
    app.appendChild(content);
    const guide = document.createElement("div");
    guide.setAttribute("id", "guide-inner-content");
    const sections = document.createElement("div");
    sections.setAttribute("id", "sections");
    const subLink = document.createElement("a");
    subLink.setAttribute("href", "/feed/subscriptions");
    sections.appendChild(subLink);
    guide.appendChild(sections);
    app.appendChild(guide);
    root.appendChild(app);

    const mounted = yga.mountWidget();
    check(
      "panel: widget mounted in the guide",
      !!mounted && mounted.parentNode === guide,
      JSON.stringify(mounted && mounted.parentNode && mounted.parentNode.id)
    );
    // ytd-guide-renderer re-renders its own subtree when a foreign child is
    // inserted there — that removed the widget and flickered the sidebar on
    // every navigation. The widget must live beside the managed subtree.
    check(
      "mount: widget stays outside the Polymer-managed guide subtree",
      !!mounted && !sections.contains(mounted) && mounted.parentNode === guide
    );

    const gear = mounted && mounted.querySelector(".yga-config-btn");
    check("panel: gear button present", !!gear);
    check("panel: closed before the gear", !yga.panel.isOpen());
    gear.dispatchEvent({ type: "click" });
    await flush(40); // section builders are async

    // --- stage 8: view-only widget chrome (PLAN.md §9) ---------------------
    // Title, total chip, icon-only refresh, gear and ▲/▼ live in the header;
    // the profile combobox sits on its own line below it (no buttons there);
    // profile CRUD and the membership picker moved to the panel.
    const header = mounted.querySelector(".yga-header");
    check(
      "stage8: profile combobox is NOT in the header row",
      !!header && !header.querySelector(".yga-profile-select"),
      JSON.stringify(header && header.children.map((c) => c.className))
    );
    check(
      "stage8: profile combobox lives on its own line below the header",
      !!mounted.querySelector(".yga-profile-row .yga-profile-select") &&
        mounted.children.indexOf(mounted.querySelector(".yga-profile-row")) ===
          mounted.children.indexOf(header) + 1 &&
        !mounted.querySelector(".yga-profile-row").querySelector("button"),
      JSON.stringify(mounted.children.map((c) => c.className))
    );
    check(
      "stage8: header carries total, refresh, gear and the move buttons",
      !!header &&
        !!header.querySelector(".yga-total") &&
        !!header.querySelector(".yga-refresh") &&
        !!header.querySelector(".yga-config-btn") &&
        !!header.querySelector(".yga-move-up") &&
        !!header.querySelector(".yga-move-down"),
      JSON.stringify(header && header.children.map((c) => c.className))
    );
    check(
      "stage8: refresh button is icon-only (no text label)",
      !!header && header.querySelector(".yga-refresh").textContent === "",
      JSON.stringify(header && header.querySelector(".yga-refresh").textContent)
    );
    check(
      "stage8: no rename/delete profile buttons in the widget",
      !mounted.querySelector(".yga-profile-rename") && !mounted.querySelector(".yga-profile-del")
    );
    check(
      "stage8: profile select has no «+ New profile» option",
      !Array.from(mounted.querySelector(".yga-profile-select").children).some((o) => o.value === "__add__")
    );
    check("stage8: no footer / toolbar row left in the widget",
      !mounted.querySelector(".yga-footer") && !mounted.querySelector(".yga-toolbar"));

    check("panel: gear opens the panel", yga.panel.isOpen());
    const panel = content.querySelector('[data-yga="panel"]');
    check("panel: panel is a child of #content", !!panel && panel.parentNode === content);
    check("panel: YouTube page hidden behind it", page.classList.contains("yga-hidden"));
    check(
      "panel: page scroll locked",
      document.documentElement.classList.contains("yga-scroll-lock") &&
        root.classList.contains("yga-scroll-lock")
    );
    check(
      "panel: seven tabs, one section built (§9.2.3)",
      panel.querySelectorAll(".yga-panel-tab").length === 7 &&
        panel.querySelectorAll("[data-section]").length === 1,
      panel.querySelectorAll(".yga-panel-tab").length + "/" +
        panel.querySelectorAll("[data-section]").length
    );
    check("panel: no section failed to load", panel.textContent.indexOf("panelSectionError") < 0);
    check(
      "panel: follows YouTube surface",
      panel.styleVars["--yga-surface"] === "rgb(255, 255, 255)",
      JSON.stringify(panel.styleVars["--yga-surface"])
    );
    check(
      "panel: follows YouTube text",
      panel.styleVars["--yga-fg"] === "rgb(15, 15, 15)",
      JSON.stringify(panel.styleVars["--yga-fg"])
    );
    check(
      "panel: dim text is contrast-adjusted",
      !!panel.styleVars["--yga-fg-dim"] && panel.styleVars["--yga-fg-dim"] !== "rgb(170, 170, 170)",
      JSON.stringify(panel.styleVars["--yga-fg-dim"])
    );

    // §11 stage-4 criterion: an edit lands live, no reload and no Save button.
    await yga.profiles.saveSettingsPath("widget.widthPx", 360);
    await yga.profiles.saveSettingsPath("widget.compact", true);
    await flush(20);
    check(
      "panel: width edit applied live",
      mounted.styleVars["--yga-width"] === "360px",
      JSON.stringify(mounted.styleVars["--yga-width"])
    );
    check("panel: compact edit applied live", mounted.classList.contains("yga-compact"));
    await yga.profiles.saveSettingsPath("widget.showCounts", false);
    await flush(20);
    check("panel: showCounts edit applied live", mounted.classList.contains("yga-no-counts"));

    // Zero counters: hidden by default, shown the moment the box is ticked.
    await yga.profiles.saveSettingsPath("widget.showCounts", true);
    await yga.state.markVisited(p2.id, CH1);
    await yga.state.refreshVisible();
    await flush(20);
    const row3 = mounted.querySelector('[data-yga-row="' + CH1 + '"]');
    check(
      "panel: zero counter hidden by default",
      !!row3 && row3.querySelector(".yga-count").textContent === "",
      JSON.stringify(row3 && row3.querySelector(".yga-count").textContent)
    );
    await yga.profiles.saveSettingsPath("widget.showZeroCount", true);
    await flush(20);
    check(
      "panel: showZeroCount edit repaints live",
      row3.querySelector(".yga-count").textContent === "0",
      JSON.stringify(row3.querySelector(".yga-count").textContent)
    );

    // Esc closes the panel and hands the page back to YouTube (§8.7).
    docEvents.fire("keydown", { key: "Escape" });
    check("panel: Esc closes the panel", !yga.panel.isOpen());
    check("panel: panel removed from #content", !content.querySelector('[data-yga="panel"]'));
    check("panel: YouTube page restored", !page.classList.contains("yga-hidden"));
    check(
      "panel: scroll unlocked",
      !document.documentElement.classList.contains("yga-scroll-lock") &&
        !root.classList.contains("yga-scroll-lock")
    );

    // --- stage 5: group tree (PLAN.md §18) --------------------------------
    // A fresh profile: the stage-4 checks above marked CH1 watched in p2.
    const p3 = await yga.profiles.create("Groups");
    await yga.profiles.addChannel(p3.id, CH1);
    await yga.profiles.setActiveProfile(p3.id);
    await yga.state.refreshVisible();
    await flush(20);

    const group = await yga.groups.create("News", p3.id);
    check("groups: created inside the active profile (§18.1)", !!group && group.profileId === p3.id);
    await yga.profiles.setGroup(p3.id, [CH1], group.id);
    await yga.state.refreshVisible();
    await flush(20);

    // Renders target the mounted widget (document.querySelector), not the
    // stage-3 fixture widget.
    const groupRow = mounted.querySelector(".yga-group");
    const gname = groupRow && groupRow.querySelector(".yga-group-name");
    const gchip = groupRow && groupRow.querySelector(".yga-group-count");
    check("tree: group row rendered (§18.3)", !!groupRow);
    check(
      "tree: group name shown",
      !!gname && gname.textContent === "News",
      JSON.stringify(gname && gname.textContent)
    );
    check(
      "tree: channel indented under its group",
      !!mounted.querySelector('.yga-group-channels [data-yga-row="' + CH1 + '"]')
    );
    check(
      "tree: group counter is the plain sum, not the 15+ ceiling (§18.4)",
      !!gchip && gchip.textContent === "16",
      JSON.stringify(gchip && gchip.textContent)
    );

    groupRow.dispatchEvent({ type: "click" });
    await flush(40);
    check(
      "tree: collapsed group keeps its channels out of the DOM (§9)",
      !mounted.querySelector('[data-yga-row="' + CH1 + '"]')
    );
    const persisted = await chrome.storage.local.get("yga:groups");
    check(
      "tree: collapsed persisted to yga:groups (§5)",
      !!(persisted["yga:groups"] || []).find((g) => g.id === group.id && g.collapsed)
    );

    mounted.querySelector(".yga-group").dispatchEvent({ type: "click" });
    await flush(40);
    check(
      "tree: expanding brings the channels back",
      !!mounted.querySelector('[data-yga-row="' + CH1 + '"]')
    );

    yga.panel.open("groups");
    await flush(40);
    const gsection = content.querySelector('[data-section="groups"]');
    check("panel: groups tab built (§9.2.2)", !!gsection);
    check(
      "panel: group row carries the n/m counter (§18.5)",
      !!gsection && gsection.textContent.indexOf("1/1") >= 0,
      JSON.stringify(gsection && gsection.textContent)
    );

    gsection.querySelector(".yga-panel-primary").dispatchEvent({ type: "click" });
    await flush(10);
    const modal = content.querySelector(".yga-panel-modal");
    check(
      "panel: «+ Группа» is a modal with one name field (§9.2.2)",
      !!modal && modal.querySelectorAll(".yga-panel-input").length === 1
    );
    modal.querySelector(".yga-panel-input").value = "Music";
    modal.querySelector(".yga-panel-primary").dispatchEvent({ type: "click" });
    await flush(40);
    check(
      "panel: modal created the group",
      !!yga.groups.list(p3.id).find((g) => g.name === "Music")
    );

    globalThis.confirm = () => true;
    content
      .querySelector('[data-section="groups"] .yga-panel-danger')
      .dispatchEvent({ type: "click" });
    await flush(60);
    check(
      "groups: deleting moves its channels back to «Без группы» (§18.1)",
      (await yga.profiles.getComposition(p3.id))[CH1].groupId === null
    );
    const pseudo = mounted.querySelector('[data-yga-group="none"]');
    check(
      "tree: pseudo-group renders with its channels (§18.2)",
      !!pseudo &&
        pseudo.querySelector(".yga-group-name").textContent === "groupNone" &&
        !!pseudo.querySelector('[data-yga-row="' + CH1 + '"]')
    );

    // --- stage 8: open-channel link on the panel's channel rows (§9.2.1) ----
    yga.panel.open("channels");
    await flush(40);
    const csection = content.querySelector('[data-section="channels"]');
    const openLink = csection && csection.querySelector(".yga-panel-channel .yga-panel-open");
    check(
      "stage8: channel row has an open-in-new-tab link (§9.2.1)",
      !!openLink &&
        openLink.tagName === "A" &&
        openLink.getAttribute("href") === "/channel/" + CH1 + "/videos" &&
        openLink.getAttribute("target") === "_blank",
      JSON.stringify(openLink && [openLink.tagName, openLink.getAttribute("href"), openLink.getAttribute("target")])
    );
    yga.panel.close();
    await flush(10);

    // --- incremental render (PLAN.md §18.3) --------------------------------
    // A re-render of an unchanged tree must not rebuild the sidebar: the same
    // nodes have to survive, otherwise every navigation flickers the guide.
    const wrapBefore = mounted.querySelector('[data-yga-group="none"]');
    const rowBefore = mounted.querySelector('[data-yga-row="' + CH1 + '"]');
    await yga.state.refreshVisible();
    await flush(20);
    check(
      "render: unchanged group keeps its DOM node instead of rebuilding (§18.3)",
      !!wrapBefore &&
        mounted.querySelector('[data-yga-group="none"]') === wrapBefore &&
        mounted.querySelector('[data-yga-row="' + CH1 + '"]') === rowBefore
    );

    // --- widget guide slot (PLAN.md §8.3) ----------------------------------
    const host = mounted.parentNode;
    host.appendChild(document.createElement("div"));
    host.appendChild(document.createElement("div"));
    const slotOf = () => host.children.indexOf(mounted);

    const moveUp = mounted.querySelector(".yga-move-up");
    const moveDown = mounted.querySelector(".yga-move-down");
    check("slot: header move buttons rendered (§8.3)", !!moveUp && !!moveDown);
    check("slot: widget sits after the guide renderer", slotOf() === 1, String(slotOf()));

    moveDown.dispatchEvent({ type: "click" });
    await flush(20);
    check("slot: ▼ rehangs the widget one slot down (§8.3)", slotOf() === 2, String(slotOf()));
    await new Promise((r) => setTimeout(r, 400)); // §5 write debounce
    const slotStored = await chrome.storage.local.get("yga:settings");
    const savedWidget = (slotStored["yga:settings"] || {}).widget || {};
    check(
      "slot: the slot is persisted to widget.guideIndex",
      savedWidget.guideIndex === 2,
      JSON.stringify(savedWidget)
    );

    moveUp.dispatchEvent({ type: "click" });
    await flush(20);
    moveUp.dispatchEvent({ type: "click" });
    await flush(20);
    check("slot: ▲ rehangs the widget back to the first slot", slotOf() === 0, String(slotOf()));
    check("slot: ▲ is disabled at the top", !!moveUp.disabled);

    // The slot must survive the SPA remounts YouTube forces on guide rebuilds.
    mounted.remove();
    const remounted = yga.mountWidget();
    check(
      "slot: remount honours the stored guideIndex (§8.3)",
      !!remounted && host.children.indexOf(remounted) === 0,
      String(host.children.indexOf(remounted))
    );

    // The panel's named position select replaces a manual slot.
    await yga.profiles.saveSettingsPaths({
      "widget.position": "afterSubscriptions",
      "widget.guideIndex": null
    });
    await flush(20);
    const back = document.querySelector('[data-yga="widget"]');
    check(
      "slot: clearing guideIndex returns to the named position",
      !!back && host.children.indexOf(back) === 1,
      String(host.children.indexOf(back))
    );

    // --- combobox contrast (white-on-white regression guard) ---------------
    const css = read("content/widget.css");
    check(
      "combobox: the select paints a solid surface, not transparent",
      /\.yga-profile-select\s*\{[^}]*background:\s*var\(--yga-surface\)/.test(css),
      "no surface on .yga-profile-select"
    );
    check(
      "combobox: option rows follow the widget theme",
      /\.yga-profile-select option\s*\{[^}]*background:\s*var\(--yga-surface\)/.test(css),
      "no themed option background"
    );

    // --- guide rebuild after SPA navigation (bootstrap remount) ------------
    // SPF navigation can replace the guide after yt-navigate-finish has fired;
    // the widget must come back with the new guide instead of vanishing.
    globalThis.MutationObserver = MutationObserver;
    vm.runInThisContext(read("content/bootstrap.js"), { filename: "bootstrap.js" });

    const oldGuide = app.querySelector("#guide-inner-content");
    const newGuide = document.createElement("div");
    newGuide.setAttribute("id", "guide-inner-content");
    const newSections = document.createElement("div");
    newSections.setAttribute("id", "sections");
    const newSubLink = document.createElement("a");
    newSubLink.setAttribute("href", "/feed/subscriptions");
    newSections.appendChild(newSubLink);
    newGuide.appendChild(newSections);

    oldGuide.remove();
    windowEvents.fire("yt-navigate-finish", {});
    await flush(20);
    check(
      "rebuild: widget stays gone while the guide is still missing",
      !document.querySelector('[data-yga="widget"]')
    );

    app.appendChild(newGuide);
    flushMutations();
    await flush(20);
    const remountedAfterRebuild = document.querySelector('[data-yga="widget"]');
    check(
      "rebuild: widget remounts once the rebuilt guide lands (§8.2)",
      !!remountedAfterRebuild && newGuide.contains(remountedAfterRebuild),
      JSON.stringify(remountedAfterRebuild && remountedAfterRebuild.parentNode && remountedAfterRebuild.parentNode.id)
    );
    check(
      "rebuild: remounted widget stays outside the new managed subtree",
      !!remountedAfterRebuild &&
        !newSections.contains(remountedAfterRebuild) &&
        remountedAfterRebuild.parentNode === newGuide
    );

    // Stage 6: "broken" telemetry — selector misses land in the yga:log journal.
    yga.selectors.reportMiss("test-miss-anchor");
    await new Promise((r) => setTimeout(r, 1200));
    const logged = await env.sandbox.chrome.storage.local.get("yga:log");
    const entries = logged["yga:log"] || [];
    check(
      "telemetry: selector miss is journaled to yga:log (stage 6)",
      entries.some((e) => e.kind === "selector-miss" && e.detail === "test-miss-anchor"),
      JSON.stringify(entries)
    );

    report();
  })
  .catch((e) => {
    failures.push("dom section crashed: " + e);
    console.error("CRASH", e && e.stack ? e.stack : e);
    report();
  });

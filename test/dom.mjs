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
  const re = /([.#]?)([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(\*?=)"([^"]*)"\]|\[([A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[3]) sel.attr.push({ name: m[3], op: m[4], value: m[5] });
    else if (m[6]) sel.attr.push({ name: m[6] });
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
    if (a.value === undefined) continue;
    if (a.op === "*=") { if (String(v).indexOf(a.value) < 0) return false; }
    else if (v !== a.value) return false;
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
  getAttribute(k) {
    if (k === "class" && !this.hasAttribute("class")) return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
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
    else if (where === "beforebegin" && this.parentNode) this.parentNode.insertBefore(node, this);
    else this.appendChild(node);
    return node;
  }
  getBoundingClientRect() {
    // Hidden nodes (display:none / detached) report a zero box; tests set
    // _hidden to exercise the hidden-anchor guard in group-picker.positionHost.
    // _rect = [left, top, width, height] reproduces a live layout (the stage 9
    // actions rows are packed edge to edge, so the default box is not enough).
    if (this._hidden) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    if (this._rect) {
      const [l, t, w, h] = this._rect;
      return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
    }
    return { left: 100, top: 200, right: 160, bottom: 226, width: 60, height: 26 };
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
    for (const group of String(sel).split(",")) {
      const parsed = parseSimple(group.trim());
      let n = this;
      while (n && n.tagName) {
        if (matches(n, parsed)) return n;
        n = n.parentNode;
      }
    }
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
    if (typeof ev.preventDefault !== "function") {
      ev.defaultPrevented = false;
      ev.preventDefault = function () { this.defaultPrevented = true; };
      ev.stopPropagation = function () { ev._stopped = true; };
    }
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

// Stage 9: group-picker.js keys off location.pathname and the page bridge.
// The initial path is neutral so its boot() is a no-op until the scenario
// navigates.
globalThis.location = { pathname: "/" };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 1440;

for (const f of [
  "content/selectors.js",
  "content/state.js",
  "content/profiles.js",
  "content/groups.js",
  "content/counters.js",
  "content/theme.js",
  "content/widget.js",
  "content/group-picker.js",
  "config/panel.js",
  "config/panel-sections.js"
]) {
  vm.runInThisContext(read(f), { filename: f });
}

const yga = globalThis.yga;
yga.i18n = (k) => k;
yga.bridge = {
  call: async (cmd) => (cmd === "getPageChannel" ? { channelId: CH1, title: "One" } : null)
};
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

    // --- stage 9: per-profile letter buttons (PLAN.md §8.8) ----------------
    // A channel page: the buttons mount right after the subscribe cluster.
    // Fixture mirrors live YouTube 2026: the header is a light-DOM #page-header
    // and the actions row is the view-model component (the legacy
    // ytd-subscribe-button-renderer is gone). A hidden duplicate of the row is
    // appended first — anchoring to it is what put the buttons off screen.
    globalThis.location.pathname = "/channel/" + CH1;
    const pageHeader = document.createElement("div");
    pageHeader.setAttribute("id", "page-header");
    const hiddenActions = document.createElement("yt-flexible-actions-view-model");
    hiddenActions.className = "yt-flexible-actions-view-model";
    hiddenActions._hidden = true;
    const subBtn = document.createElement("yt-flexible-actions-view-model");
    subBtn.className = "yt-flexible-actions-view-model";
    pageHeader.appendChild(hiddenActions);
    pageHeader.appendChild(subBtn);
    root.appendChild(pageHeader);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);

    const gpHost = document.querySelector("[data-yga-group-buttons]");
    check("stage9: letter buttons mount on a channel page", !!gpHost);
    check(
      "stage9: buttons are a body overlay placed right of the subscribe cluster",
      !!gpHost && gpHost.parentNode === document.body &&
        !pageHeader.contains(gpHost) &&
        gpHost.styleVars.left === "166px" && gpHost.styleVars.top === "200px",
      JSON.stringify(gpHost && gpHost.styleVars)
    );
    check(
      "stage9: overlay is visible, not parked on the hidden duplicate actions row",
      !!gpHost && !gpHost.classList.contains("yga-gp-hidden")
    );
    const letters = gpHost ? gpHost.querySelectorAll(".yga-gp-letter") : [];
    check(
      "stage9: one button per curated profile, first letter as label (no «Все подписки»)",
      letters.length === 2 && letters.map((b) => b.textContent).join("") === "CG",
      JSON.stringify(letters.map((b) => b.textContent))
    );
    check(
      "stage9: the built-in all-subs profile has no letter button",
      !!gpHost && !gpHost.querySelector('[data-yga-profile="p_1"]')
    );
    check(
      "stage9: buttons carry the profile color",
      letters.every((b) => /^#[0-9a-f]{6}$/i.test(b.styleVars["--yga-gp-color"] || "")),
      JSON.stringify(letters.map((b) => b.styleVars["--yga-gp-color"]))
    );

    // The p3 button ("G") opens the dropdown of p3's groups.
    const music = yga.groups.list(p3.id).find((g) => g.name === "Music");
    const gBtn = letters.find((b) => b.getAttribute("data-yga-profile") === p3.id);
    gBtn.dispatchEvent({ type: "click" });
    await flush(40);
    const gpMenu = document.querySelector("[data-yga-group-menu]");
    check("stage9: click opens the group dropdown", !!gpMenu);
    const gpChecks = gpMenu ? gpMenu.querySelectorAll(".yga-gp-check") : [];
    const musicRow = gpChecks.length === 1 ? gpChecks[0].closest(".yga-gp-item") : null;
    check(
      "stage9: one checkbox row per group, unchecked for a free channel",
      !!musicRow && musicRow.querySelector(".yga-gp-name").textContent === "Music" &&
        gpChecks[0].checked === false,
      JSON.stringify(musicRow && musicRow.textContent)
    );
    gpChecks[0].checked = true;
    gpChecks[0].dispatchEvent({ type: "change" });
    await flush(40);
    check(
      "stage9: checking a row assigns the channel to the group",
      (await yga.profiles.getComposition(p3.id))[CH1].groupId === (music && music.id),
      JSON.stringify((await yga.profiles.getComposition(p3.id))[CH1])
    );

    docEvents.fire("pointerdown", { target: root });
    await flush(10);
    check("stage9: outside click closes the dropdown", !document.querySelector("[data-yga-group-menu]"));

    // Re-open and uncheck → the channel leaves the group (§8.8 stage 9).
    gBtn.dispatchEvent({ type: "click" });
    await flush(40);
    const menu2 = document.querySelector("[data-yga-group-menu]");
    const check2 = menu2 && menu2.querySelector(".yga-gp-check");
    check("stage9: checkbox reflects the current group", !!check2 && check2.checked === true);
    check2.checked = false;
    check2.dispatchEvent({ type: "change" });
    await flush(40);
    check(
      "stage9: unchecking removes the channel from the group",
      (await yga.profiles.getComposition(p3.id))[CH1].groupId === null,
      JSON.stringify((await yga.profiles.getComposition(p3.id))[CH1])
    );

    // Watch page: the buttons mount left of Like/Dislike. Again the live tag is
    // the view-model component, not the legacy renderer.
    globalThis.location.pathname = "/watch?v=x";
    const actions = document.createElement("div");
    actions.setAttribute("id", "actions");
    const likeDislike = document.createElement("yt-segmented-like-dislike-button-view-model");
    likeDislike.className = "yt-segmented-like-dislike-button-view-model";
    actions.appendChild(likeDislike);
    root.appendChild(actions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWatch = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: watch page overlays the buttons left of Like/Dislike (never inside the actions row)",
      !!gpWatch && gpWatch.parentNode === document.body &&
        !actions.contains(gpWatch) &&
        gpWatch.styleVars.left === "64px" && gpWatch.styleVars.top === "200px",
      JSON.stringify(gpWatch && gpWatch.styleVars)
    );

    // Profile colorpicker (§9.2.1): the panel edits profile colors live and
    // the letter buttons repaint.
    yga.panel.open("profiles");
    await flush(40);
    const psection = content.querySelector('[data-section="profiles"]');
    const colorInputs = psection ? psection.querySelectorAll(".yga-panel-color") : [];
    check(
      "stage9: every profile row carries a colorpicker",
      colorInputs.length === 3,
      String(colorInputs.length)
    );
    colorInputs[1].value = "#123456";
    colorInputs[1].dispatchEvent({ type: "change" });
    await flush(40);
    check(
      "stage9: colorpicker writes the profile color",
      yga.profiles.get(p2.id).color === "#123456",
      JSON.stringify(yga.profiles.get(p2.id))
    );
    const gpAfter = document.querySelector("[data-yga-group-buttons]");
    const aBtn = gpAfter && gpAfter.querySelector('[data-yga-profile="' + p2.id + '"]');
    check(
      "stage9: letter button repaints with the new profile color",
      !!aBtn && aBtn.styleVars["--yga-gp-color"] === "#123456",
      JSON.stringify(aBtn && aBtn.styleVars)
    );
    yga.panel.close();
    await flush(10);

    // --- stage 9 regression: late anchor (real YouTube timing) --------------
    // yt-navigate-finish fires before the subscribe cluster renders, so the
    // first mount finds no anchor. The picker must retry and mount once the
    // anchor appears — this is the bug that hid the buttons in the browser.
    const oldHeader = document.querySelector("#page-header");
    if (oldHeader) oldHeader.remove();
    globalThis.location.pathname = "/channel/" + CH1;
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40); // 80ms: inside the retry window, anchor still absent
    check(
      "stage9: no buttons while the subscribe anchor is missing",
      !document.querySelector("[data-yga-group-buttons]")
    );
    // The late anchor uses the LEGACY tag: the chain must keep matching older
    // YouTube builds, not only the 2026 view-model components.
    const lateHeader = document.createElement("div");
    lateHeader.setAttribute("id", "page-header");
    lateHeader.appendChild(document.createElement("ytd-subscribe-button-renderer"));
    root.appendChild(lateHeader);
    await flush(300); // 600ms: past the 400ms retry tick
    const gpLate = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: buttons mount once the late anchor appears (retry)",
      !!gpLate && gpLate.querySelectorAll(".yga-gp-letter").length === 2,
      JSON.stringify(gpLate && gpLate.querySelectorAll(".yga-gp-letter").length)
    );

    // --- stage 9: shadow-piercing fallback ---------------------------------
    // Live desktop YouTube renders its Polymer content into the LIGHT DOM
    // (ShadyDOM force/noPatch), which is what the fixtures above model. findDeep
    // stays as the fallback for a native-shadow build: if the subscribe cluster
    // ever moves behind a real shadow root, the picker must still find it and
    // mount the overlay — standalone, without leaning on another extension.
    const staleHeader = document.querySelector("#page-header");
    if (staleHeader) staleHeader.remove();
    globalThis.location.pathname = "/channel/" + CH1;
    const shadowHost = document.createElement("ytd-page-header");
    const shadowRoot = document.createElement("div");
    shadowRoot.appendChild(document.createElement("ytd-subscribe-button-renderer"));
    shadowHost.shadowRoot = shadowRoot; // open shadow root, invisible to querySelector
    root.appendChild(shadowHost);
    check(
      "stage9: a light-DOM query cannot see the shadowed subscribe anchor",
      !document.querySelector("ytd-subscribe-button-renderer")
    );
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpShadow = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: buttons mount by piercing the shadow root (standalone)",
      !!gpShadow && gpShadow.querySelectorAll(".yga-gp-letter").length === 2,
      JSON.stringify(gpShadow && gpShadow.querySelectorAll(".yga-gp-letter").length)
    );
    shadowHost.remove();

    // --- stage 9: browser regressions from the 2026-11-10 check -------------
    // Channel: when the view-model actions row is absent, anchoring to the
    // full-width #page-header put the buttons at the viewport edge. The picker
    // must fall back to the visible Subscribe button inside the header.
    const staleHeader2 = document.querySelector("#page-header");
    if (staleHeader2) staleHeader2.remove();
    globalThis.location.pathname = "/channel/" + CH1;
    const wideHeader = document.createElement("div");
    wideHeader.setAttribute("id", "page-header");
    const subscribeBtn = document.createElement("button");
    subscribeBtn.textContent = "Subscribe";
    wideHeader.appendChild(subscribeBtn);
    root.appendChild(wideHeader);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWide = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: full-width header anchors to Subscribe, not the header edge",
      !!gpWide && gpWide.getAttribute("data-yga-anchor") === "channel-text" &&
        gpWide.styleVars.left === "166px",
      JSON.stringify(gpWide && [gpWide.getAttribute("data-yga-anchor"), gpWide.styleVars.left])
    );

    // Watch: the cluster tag/class probes can both miss, but the Like button's
    // accessible label is stable. Anchor to that button, not the whole actions row.
    const oldActions = document.querySelector("#actions");
    if (oldActions) oldActions.remove();
    globalThis.location.pathname = "/watch?v=x";
    const watchActions = document.createElement("div");
    watchActions.setAttribute("id", "actions");
    const likeBtn = document.createElement("button");
    likeBtn.setAttribute("aria-label", "like this video along with 123 other people");
    watchActions.appendChild(likeBtn);
    root.appendChild(watchActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWatchText = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: watch page anchors to the accessible Like button",
      !!gpWatchText && gpWatchText.getAttribute("data-yga-anchor") === "watch-like" &&
        gpWatchText.styleVars.left === "64px",
      JSON.stringify(gpWatchText && [gpWatchText.getAttribute("data-yga-anchor"), gpWatchText.styleVars.left])
    );

    // Russian UI: "Мне нравится" contains the dislike phrase "не нравится" as a
    // substring, so the dislike guard must not reject the Like button.
    const oldActionsRu = document.querySelector("#actions");
    if (oldActionsRu) oldActionsRu.remove();
    globalThis.location.pathname = "/watch?v=x";
    const watchActionsRu = document.createElement("div");
    watchActionsRu.setAttribute("id", "actions");
    const dislikeRu = document.createElement("button");
    dislikeRu.setAttribute("aria-label", "Не нравится");
    const likeRu = document.createElement("button");
    likeRu.setAttribute("aria-label", "Мне нравится");
    watchActionsRu.appendChild(dislikeRu);
    watchActionsRu.appendChild(likeRu);
    root.appendChild(watchActionsRu);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWatchRu = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: Russian Like is not rejected as Dislike",
      !!gpWatchRu && gpWatchRu.getAttribute("data-yga-anchor") === "watch-like" &&
        gpWatchRu.styleVars.left === "64px",
      JSON.stringify(gpWatchRu && [gpWatchRu.getAttribute("data-yga-anchor"), gpWatchRu.styleVars.left])
    );

    // Native-shadow fallback: if the Like button is behind an open shadow root,
    // the text anchor must still be found by piercing the shadow tree.
    const oldActionsDeep = document.querySelector("#actions");
    if (oldActionsDeep) oldActionsDeep.remove();
    globalThis.location.pathname = "/watch?v=x";
    const commentLike = document.createElement("button");
    commentLike.setAttribute("aria-label", "Like");
    root.appendChild(commentLike);
    const watchShadowHost = document.createElement("yt-watch-metadata");
    const watchShadowRoot = document.createElement("div");
    const likeShadow = document.createElement("button");
    likeShadow.setAttribute("aria-label", "Мне нравится");
    watchShadowRoot.appendChild(likeShadow);
    watchShadowHost.shadowRoot = watchShadowRoot;
    root.appendChild(watchShadowHost);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWatchDeep = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: shadowed Like button is found by the deep text anchor",
      !!gpWatchDeep && gpWatchDeep.getAttribute("data-yga-anchor") === "watch-like-deep" &&
        gpWatchDeep.styleVars.left === "64px",
      JSON.stringify(gpWatchDeep && [gpWatchDeep.getAttribute("data-yga-anchor"), gpWatchDeep.styleVars.left])
    );
    watchShadowHost.remove();
    commentLike.remove();

    // --- stage 9: live 2026-11-11 browser probe shapes ----------------------
    // The probe (test/probe-anchor.js) showed the channel actions row reaching
    // the viewport edge while the Subscribe button sits in a native shadow root
    // (ShadyDOM force mode is off) and only Sponsor is light DOM. Anchoring to
    // the row clamped the overlay to the right screen edge.
    globalThis.innerWidth = 1030;
    const oldProbeHeader = document.querySelector("#page-header");
    if (oldProbeHeader) oldProbeHeader.remove();
    globalThis.location.pathname = "/channel/" + CH1;
    const probeHeader = document.createElement("div");
    probeHeader.setAttribute("id", "page-header");
    probeHeader._rect = [72, 194, 945, 216];
    const probeRow = document.createElement("yt-flexible-actions-view-model");
    probeRow.className = "yt-flexible-actions-view-model";
    probeRow._rect = [293, 358, 680, 40];
    const probeSponsor = document.createElement("button");
    probeSponsor.setAttribute("aria-label", "Стать спонсором этого канала");
    probeSponsor._rect = [491, 358, 176, 40];
    const probeRowShadow = document.createElement("div");
    const probeSubscribe = document.createElement("button");
    probeSubscribe.setAttribute("aria-label", "Вы подписаны");
    probeSubscribe._rect = [675, 358, 115, 40];
    probeRowShadow.appendChild(probeSubscribe);
    probeRow.shadowRoot = probeRowShadow;
    probeRow.appendChild(probeSponsor);
    probeHeader.appendChild(probeRow);
    root.appendChild(probeHeader);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpProbeChannel = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: shadowed Subscribe wins over the actions row (no edge clamp)",
      !!gpProbeChannel &&
        gpProbeChannel.getAttribute("data-yga-anchor") === "channel-text-deep" &&
        gpProbeChannel.styleVars.left === "796px" && gpProbeChannel.styleVars.top === "365px",
      JSON.stringify(gpProbeChannel &&
        [gpProbeChannel.getAttribute("data-yga-anchor"), gpProbeChannel.styleVars.left, gpProbeChannel.styleVars.top])
    );

    // Watch: the actions row starts at x=16 and is packed edge to edge, so the
    // requested slot left of Like does not exist. The overlay must take the
    // free gap after the last button of the row instead of covering controls.
    const oldProbeActions = document.querySelector("#actions");
    if (oldProbeActions) oldProbeActions.remove();
    globalThis.location.pathname = "/watch?v=x";
    const probeActions = document.createElement("div");
    probeActions.setAttribute("id", "actions");
    probeActions._rect = [16, 738, 649, 36];
    const probeLike = document.createElement("button");
    probeLike.setAttribute("aria-label", "поставить отметку \"Нравится\" (это видео понравилось 437 пользователям)");
    probeLike._rect = [16, 738, 86, 40];
    const probeDislike = document.createElement("button");
    probeDislike.setAttribute("aria-label", "Поставить отметку \"Не нравится\"");
    probeDislike._rect = [102, 738, 70, 40];
    const probeShare = document.createElement("button");
    probeShare.setAttribute("aria-label", "Поделиться");
    probeShare._rect = [180, 738, 40, 40];
    const probeMore = document.createElement("button");
    probeMore.setAttribute("aria-label", "Ещё");
    probeMore._rect = [324, 738, 40, 40];
    for (const b of [probeLike, probeDislike, probeShare, probeMore]) probeActions.appendChild(b);
    root.appendChild(probeActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpProbeWatch = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: quoted RU Dislike is not the Like anchor",
      !!gpProbeWatch && gpProbeWatch.getAttribute("data-yga-anchor") === "watch-like" &&
        gpProbeWatch.styleVars.left !== "10px",
      JSON.stringify(gpProbeWatch &&
        [gpProbeWatch.getAttribute("data-yga-anchor"), gpProbeWatch.styleVars.left])
    );
    check(
      "stage9: packed watch row takes the free gap after the last button",
      !!gpProbeWatch && gpProbeWatch.styleVars.left === "370px" &&
        gpProbeWatch.styleVars.top === "745px",
      JSON.stringify(gpProbeWatch && gpProbeWatch.styleVars)
    );
    probeHeader.remove();
    probeActions.remove();
globalThis.innerWidth = 1280;

    // --- stage 9: language-independent structural anchors -------------------
    // User report 2026-11-11: on channels whose labels are not in the RU/EN
    // text lists the anchors missed and the overlay jumped around. YouTube
    // stamps the subscribe view-model tag/class in every UI language, so the
    // structural probe must anchor with NO label text anywhere.
    const oldStructHeader = document.querySelector("#page-header");
    if (oldStructHeader) oldStructHeader.remove();
    globalThis.location.pathname = "/channel/" + CH1;
    const structHeader = document.createElement("div");
    structHeader.setAttribute("id", "page-header");
    structHeader._rect = [72, 194, 945, 216];
    const structRow = document.createElement("yt-flexible-actions-view-model");
    structRow.className = "yt-flexible-actions-view-model";
    structRow._rect = [293, 358, 680, 40];
    const structSubscribe = document.createElement("yt-subscribe-button-view-model");
    structSubscribe.className = "yt-subscribe-button-view-model";
    structSubscribe._rect = [293, 358, 120, 40];
    const structSponsor = document.createElement("yt-button-view-model");
    structSponsor.className = "yt-button-view-model";
    structSponsor._rect = [421, 358, 176, 40];
    structRow.appendChild(structSubscribe);
    structRow.appendChild(structSponsor);
    structHeader.appendChild(structRow);
    root.appendChild(structHeader);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpStruct = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: subscribe view-model anchors without any label text (language-independent)",
      !!gpStruct &&
        gpStruct.getAttribute("data-yga-anchor") === "channel-subscribe" &&
        gpStruct.styleVars.left === "603px" && gpStruct.styleVars.top === "365px",
      JSON.stringify(gpStruct &&
        [gpStruct.getAttribute("data-yga-anchor"), gpStruct.styleVars.left, gpStruct.styleVars.top])
    );

    // A wrapped actions row must not drag the overlay to the second line:
    // only boxes on the anchor's own line may push the slot (user report:
    // «прыгнули на две строчки вниз» on a channel with a wrapping row).
    const oldWrapActions = document.querySelector("#actions");
    if (oldWrapActions) oldWrapActions.remove();
    globalThis.location.pathname = "/watch?v=x";
    const wrapActions = document.createElement("div");
    wrapActions.setAttribute("id", "actions");
    wrapActions._rect = [16, 738, 649, 80];
    const wrapLike = document.createElement("button");
    wrapLike.setAttribute("aria-label", "Нравится");
    wrapLike._rect = [16, 738, 86, 40];
    const wrapSave = document.createElement("button");
    wrapSave.setAttribute("aria-label", "Сохранить");
    wrapSave._rect = [16, 782, 100, 40];
    wrapActions.appendChild(wrapLike);
    wrapActions.appendChild(wrapSave);
    root.appendChild(wrapActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpWrap = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: wrapped row keeps the overlay on the anchor's line",
      !!gpWrap && gpWrap.styleVars.top === "745px" && gpWrap.styleVars.left === "108px",
      JSON.stringify(gpWrap && gpWrap.styleVars)
    );
    structHeader.remove();
    wrapActions.remove();

    // Dislike-only view-models carry the stamped class "yt-dislike-button-view-
    // model", which contains "like-button-view-model" as a substring, so the
    // structural selector matches them too. Their accessible name is just the
    // count, so the text guard misses them and — being smaller than the like
    // button — they would win "smallest". The class guard must reject them.
    globalThis.location.pathname = "/watch?v=x";
    const disActions = document.createElement("div");
    disActions.setAttribute("id", "actions");
    disActions._rect = [16, 738, 649, 36];
    const disLike = document.createElement("yt-like-button-view-model");
    disLike.className = "yt-like-button-view-model";
    disLike._rect = [16, 738, 86, 40];
    disLike.textContent = "437 тыс.";
    const disDislike = document.createElement("yt-dislike-button-view-model");
    disDislike.className = "yt-dislike-button-view-model";
    disDislike._rect = [102, 738, 50, 40];
    disDislike.textContent = "12 тыс.";
    disActions.appendChild(disLike);
    disActions.appendChild(disDislike);
    root.appendChild(disActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpDis = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: count-only dislike view-model never beats the like view-model",
      !!gpDis && gpDis.getAttribute("data-yga-anchor") === "watch-like-struct" &&
        gpDis.styleVars.left === "158px" && gpDis.styleVars.top === "745px",
      JSON.stringify(gpDis &&
        [gpDis.getAttribute("data-yga-anchor"), gpDis.styleVars.left, gpDis.styleVars.top])
    );
    disActions.remove();

    // The legacy chain branch must not take the first boxed match either: the
    // 2026-11-11 browser check anchored to a wide hidden ghost (#like-button
    // template) on both videos. Width guard + smallest wins must pick the real
    // button instead.
    const ghostActions = document.createElement("div");
    ghostActions.setAttribute("id", "actions");
    ghostActions._rect = [16, 738, 649, 36];
    const ghostLike = document.createElement("div");
    ghostLike.setAttribute("id", "like-button");
    ghostLike._rect = [0, 738, 600, 40];
    const realLike = document.createElement("ytd-like-button-renderer");
    realLike._rect = [16, 738, 86, 40];
    ghostActions.appendChild(ghostLike);
    ghostActions.appendChild(realLike);
    root.appendChild(ghostActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpGhost = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: chain branch skips the wide ghost duplicate for the real like",
      !!gpGhost && gpGhost.getAttribute("data-yga-anchor") === "watch-like-id" &&
        gpGhost.styleVars.left === "108px" && gpGhost.styleVars.top === "745px",
      JSON.stringify(gpGhost &&
        [gpGhost.getAttribute("data-yga-anchor"), gpGhost.styleVars.left, gpGhost.styleVars.top])
    );
    ghostActions.remove();

    // --- stage 9: late like cluster upgrades a row anchor (live 2026-11-11) --
    // Mount caught #actions before the like cluster rendered, so the anchor
    // stuck on watch-deep-actions and the overlay sat on top of Subscribe. The
    // row stays connected forever, so only a rank-aware reanchor can move the
    // overlay once the cluster (here: the legacy #top-level-buttons-computed
    // the 2026 probe found) appears.
    globalThis.location.pathname = "/watch?v=x";
    const lateActions = document.createElement("div");
    lateActions.setAttribute("id", "actions");
    lateActions._rect = [585, 891, 400, 43];
    root.appendChild(lateActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpLateRow = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: empty actions row anchors as watch-deep-actions",
      !!gpLateRow && gpLateRow.getAttribute("data-yga-anchor") === "watch-deep-actions",
      JSON.stringify(gpLateRow && gpLateRow.getAttribute("data-yga-anchor"))
    );
    const lateCluster = document.createElement("div");
    lateCluster.setAttribute("id", "top-level-buttons-computed");
    lateCluster.className = "top-level-buttons";
    lateCluster._rect = [693, 894, 196, 40];
    const lateLike = document.createElement("button");
    lateLike.setAttribute("aria-label", "поставить отметку \"Нравится\" (это видео понравилось 89 пользователям)");
    lateLike._rect = [693, 894, 78, 40];
    lateCluster.appendChild(lateLike);
    lateActions.appendChild(lateCluster);
    await flush(200); // past the 250ms tracker tick; first upgrade attempt is immediate
    const gpUpgraded = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: late like cluster upgrades the row anchor off Subscribe",
      !!gpUpgraded && gpUpgraded.getAttribute("data-yga-anchor") === "watch-like-struct" &&
        gpUpgraded.styleVars.left === "657px" && gpUpgraded.styleVars.top === "901px",
      JSON.stringify(gpUpgraded &&
        [gpUpgraded.getAttribute("data-yga-anchor"), gpUpgraded.styleVars.left, gpUpgraded.styleVars.top])
    );
    lateActions.remove();

    // --- stage 9: off-screen anchor hides the overlay (live 2026-11-11) ------
    // Scrolling past the anchor used to clamp top to 4px and park the buttons
    // at the top edge of the viewport; they must leave with the anchor instead.
    const goneActions = document.createElement("div");
    goneActions.setAttribute("id", "actions");
    goneActions._rect = [585, -140, 400, 43];
    const goneCluster = document.createElement("div");
    goneCluster.setAttribute("id", "top-level-buttons-computed");
    goneCluster.className = "top-level-buttons";
    goneCluster._rect = [693, -140, 196, 40];
    goneActions.appendChild(goneCluster);
    root.appendChild(goneActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpGone = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: anchor scrolled above the viewport hides the overlay",
      !!gpGone && gpGone.getAttribute("data-yga-anchor") === "watch-like-struct" &&
        gpGone.classList.contains("yga-gp-hidden"),
      JSON.stringify(gpGone &&
        [gpGone.getAttribute("data-yga-anchor"), gpGone.classList.contains("yga-gp-hidden")])
    );
    goneActions.remove();

    // --- stage 9: the masthead band (live 2026-11-11) -----------------------
    // Dropping the top clamp let a partially scrolled anchor slide the buttons
    // half past the top edge. The overlay must be gone as soon as the anchor is
    // not FULLY inside the band the fixed masthead leaves.
    const masthead = document.createElement("ytd-masthead");
    masthead._rect = [0, 0, 1280, 56];
    root.appendChild(masthead);
    const bandActions = document.createElement("div");
    bandActions.setAttribute("id", "actions");
    bandActions._rect = [16, 40, 649, 36];
    const bandCluster = document.createElement("div");
    bandCluster.setAttribute("id", "top-level-buttons-computed");
    bandCluster.className = "top-level-buttons";
    bandCluster._rect = [16, 40, 196, 40];
    bandActions.appendChild(bandCluster);
    root.appendChild(bandActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpBand = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: anchor under the masthead hides the overlay instead of sliding off the edge",
      !!gpBand && gpBand.getAttribute("data-yga-anchor") === "watch-like-struct" &&
        gpBand.classList.contains("yga-gp-hidden"),
      JSON.stringify(gpBand &&
        [gpBand.dataset.ygaTopBound, gpBand.classList.contains("yga-gp-hidden")])
    );
    bandActions._rect = [16, 70, 649, 36];
    bandCluster._rect = [16, 70, 196, 40];
    windowEvents.fire("scroll", {});
    await flush(40);
    check(
      "stage9: anchor back below the masthead shows the overlay again",
      !!gpBand && !gpBand.classList.contains("yga-gp-hidden") &&
        gpBand.styleVars.left === "218px" && gpBand.styleVars.top === "77px",
      JSON.stringify(gpBand && [gpBand.styleVars.left, gpBand.styleVars.top])
    );
    bandActions.remove();
    masthead.remove();

    // --- stage 9: a sticky channel header must not drag the buttons to the top -
    // Live 2026-11-11: on channel pages the collapsed header pins under the
    // masthead, so the subscribe anchor keeps its viewport top while the page
    // scrolls and the overlay stuck to the top edge. An anchor that does not
    // move while the page does is pinned: the overlay leaves with the header.
    globalThis.location.pathname = "/channel/" + CH1;
    const pinHeader = document.createElement("div");
    pinHeader.setAttribute("id", "page-header");
    const pinSubscribe = document.createElement("yt-subscribe-button-view-model");
    pinSubscribe.className = "yt-subscribe-button-view-model";
    pinHeader.appendChild(pinSubscribe);
    root.appendChild(pinHeader);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpPin = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: channel overlay follows the subscribe anchor while it scrolls",
      !!gpPin && gpPin.getAttribute("data-yga-anchor") === "channel-subscribe" &&
        !gpPin.classList.contains("yga-gp-hidden"),
      JSON.stringify(gpPin && gpPin.getAttribute("data-yga-anchor"))
    );
    // Two scroll ticks with the anchor's viewport top unchanged = pinned.
    globalThis.scrollY = 900;
    pinSubscribe._rect = [100, 200, 60, 26];
    await new Promise((r) => setTimeout(r, 300));
    await flush(10);
    globalThis.scrollY = 1800;
    await new Promise((r) => setTimeout(r, 300));
    await flush(10);
    check(
      "stage9: pinned (sticky-header) anchor hides the overlay",
      !!gpPin && gpPin.dataset.ygaPinned === "1" && gpPin.classList.contains("yga-gp-hidden"),
      JSON.stringify(gpPin && [gpPin.dataset.ygaPinned, gpPin.classList.contains("yga-gp-hidden")])
    );
    // Scrolling back: the header expands, the anchor moves again → visible.
    globalThis.scrollY = 400;
    pinSubscribe._rect = [100, 640, 60, 26];
    await new Promise((r) => setTimeout(r, 300));
    await flush(10);
    check(
      "stage9: the overlay returns once the anchor scrolls with the page",
      !!gpPin && gpPin.dataset.ygaPinned === "0" && !gpPin.classList.contains("yga-gp-hidden") &&
        gpPin.styleVars.top === "1040px",
      JSON.stringify(gpPin && [gpPin.dataset.ygaPinned, gpPin.styleVars.top])
    );
    globalThis.scrollY = 0;
    pinHeader.remove();

    // --- stage 9: the held slot survives row churn (watch jumping) ----------
    // The actions row re-renders during scroll; every re-pick from a changed box
    // set flipped the overlay to another gap. The slot already held is kept
    // while it stays free, and only re-picked once it is blocked.
    globalThis.location.pathname = "/watch?v=x";
    const churnActions = document.createElement("div");
    churnActions.setAttribute("id", "actions");
    churnActions._rect = [16, 738, 649, 36];
    const churnLike = document.createElement("button");
    churnLike.setAttribute("aria-label", "поставить отметку \"Нравится\" (это видео понравилось 437 пользователям)");
    churnLike._rect = [16, 738, 86, 40];
    const churnGhost = document.createElement("div");
    churnGhost.className = "wide-button-ghost";
    churnGhost._rect = [16, 738, 500, 40];
    churnActions.appendChild(churnLike);
    churnActions.appendChild(churnGhost);
    root.appendChild(churnActions);
    windowEvents.fire("yt-navigate-finish", {});
    await flush(40);
    const gpChurn = document.querySelector("[data-yga-group-buttons]");
    check(
      "stage9: packed row with a wide box takes the gap after it",
      !!gpChurn && gpChurn.styleVars.left === "522px" && gpChurn.styleVars.top === "745px",
      JSON.stringify(gpChurn && gpChurn.styleVars)
    );
    churnGhost.remove();
    await new Promise((r) => setTimeout(r, 300)); // the 250ms tick drops the box cache
    await flush(10);
    check(
      "stage9: row churn does not flip the overlay to another gap",
      gpChurn.styleVars.left === "522px",
      JSON.stringify(gpChurn.styleVars)
    );
    const churnBlocker = document.createElement("button");
    churnBlocker.setAttribute("aria-label", "Поделиться");
    churnBlocker._rect = [500, 738, 60, 40];
    churnActions.appendChild(churnBlocker);
    await new Promise((r) => setTimeout(r, 300));
    await flush(10);
    check(
      "stage9: a blocked slot is re-picked, not held over the control",
      gpChurn.styleVars.left === "566px",
      JSON.stringify(gpChurn.styleVars)
    );
    churnActions.remove();

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

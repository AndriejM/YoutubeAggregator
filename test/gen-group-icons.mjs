import fs from "node:fs";
import path from "node:path";

const root = "icons/groups";
const out = "content/group-icons.js";

const themes = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const files = fs.readdirSync(path.join(root, d.name));
    const nums = files
      .map((f) => {
        const m = f.match(/^(\d+)\.(png|jpg|jpeg|webp|svg)$/i);
        return m ? { n: Number(m[1]), ext: m[2].toLowerCase() } : null;
      })
      .filter(Boolean);
    const exts = [...new Set(nums.map((x) => x.ext))];
    if (exts.length !== 1) throw new Error(`mixed extensions in ${d.name}`);
    return {
      id: d.name,
      label: d.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      ext: exts[0],
      count: Math.max(...nums.map((x) => x.n))
    };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

const body = `window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Stage 11: bundled group avatars. The icons live under icons/groups/<theme>/
  // as contiguous numeric files (1.ext .. count.ext), so the catalog stays small.
  const THEMES = ${JSON.stringify(themes, null, 2)};

  function theme(id) {
    for (const t of THEMES) if (t.id === id) return t;
    return null;
  }

  function path(id, index) {
    const t = theme(id);
    const n = Number(index);
    if (!t || !Number.isInteger(n) || n < 1 || n > t.count) return "";
    return "icons/groups/" + t.id + "/" + n + "." + t.ext;
  }

  function url(id, index) {
    const p = path(id, index);
    return p ? chrome.runtime.getURL(p) : "";
  }

  function normalizeColor(color) {
    const c = String(color || "").trim().toLowerCase();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(c) ? c : "";
  }

  function normalize(avatar) {
    if (!avatar || typeof avatar !== "object") return null;
    if (avatar.type === "builtin") {
      const p = path(avatar.theme, avatar.index);
      if (!p) return null;
      const out = { type: "builtin", theme: String(avatar.theme), index: Number(avatar.index) };
      const color = normalizeColor(avatar.color);
      if (color) out.color = color;
      return out;
    }
    if (avatar.type === "url") {
      const raw = String(avatar.url || "").trim();
      if (/^https:\\/\\//i.test(raw)) return { type: "url", url: raw };
    }
    return null;
  }

  function src(avatar) {
    const a = normalize(avatar);
    if (!a) return "";
    return a.type === "builtin" ? url(a.theme, a.index) : a.url;
  }

  function sig(avatar) {
    const a = normalize(avatar);
    if (!a) return "";
    if (a.type === "url") return "u:" + a.url;
    return "b:" + a.theme + ":" + a.index + (a.color ? ":" + a.color : "");
  }

  // Tinted avatars are painted with CSS mask-image: the PNG/JPG alpha channel
  // becomes the shape and background-color becomes the fill, so the bundled
  // files stay untouched and the color is chosen per group at runtime.
  function tinted(avatar) {
    const a = normalize(avatar);
    return !!(a && a.type === "builtin" && a.color);
  }

  function avatarNode(avatar, cls, attrs) {
    const s = src(avatar);
    if (!s) return null;
    const a = normalize(avatar);
    if (a.type === "builtin" && a.color) {
      const node = document.createElement("span");
      node.className = cls + " yga-avatar-tinted";
      node.style.setProperty("-webkit-mask-image", "url(" + s + ")");
      node.style.setProperty("mask-image", "url(" + s + ")");
      node.style.setProperty("background-color", a.color);
      if (attrs) for (const key in attrs) node.setAttribute(key, attrs[key]);
      return node;
    }
    const img = document.createElement("img");
    img.className = cls;
    img.setAttribute("src", s);
    if (attrs) for (const key in attrs) img.setAttribute(key, attrs[key]);
    return img;
  }

  yga.groupIcons = {
    themes: THEMES,
    theme: theme,
    path: path,
    url: url,
    normalize: normalize,
    normalizeColor: normalizeColor,
    src: src,
    sig: sig,
    tinted: tinted,
    avatarNode: avatarNode
  };
})(window.yga);
`;

fs.writeFileSync(out, body);
console.log(`wrote ${out} (${themes.length} themes, ${themes.reduce((n, t) => n + t.count, 0)} icons)`);

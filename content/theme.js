window.yga = window.yga || {};

(function (yga) {
  "use strict";

  const VARS = ["--yga-fg", "--yga-fg-dim", "--yga-hover", "--yga-border", "--yga-surface"];

  function computedStyle(node) {
    if (!node || typeof getComputedStyle !== "function") return null;
    try {
      return getComputedStyle(node);
    } catch (e) {
      return null;
    }
  }

  function cssVar(name) {
    const nodes = [document.documentElement];
    if (yga.selectors && yga.selectors.find) {
      nodes.push(yga.selectors.find("guideRoot"));
      nodes.push(yga.selectors.find("app"));
    }
    for (const node of nodes) {
      const cs = computedStyle(node);
      if (!cs || !cs.getPropertyValue) continue;
      const value = String(cs.getPropertyValue(name) || "").trim();
      if (value) return value;
    }
    return "";
  }

  function parseColor(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s || s === "transparent" || s === "currentColor" || s === "inherit") return null;

    let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a
      };
    }

    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const num = (v, max) => (v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v));
      const r = num(parts[0], 255);
      const g = num(parts[1], 255);
      const b = num(parts[2], 255);
      const a = parts.length > 3 ? num(parts[3], 1) : 1;
      if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
      if (a <= 0.05) return null;
      return { r, g, b, a };
    }
    return null;
  }

  function toCss(c) {
    if (!c) return "";
    const r = Math.max(0, Math.min(255, Math.round(c.r)));
    const g = Math.max(0, Math.min(255, Math.round(c.g)));
    const b = Math.max(0, Math.min(255, Math.round(c.b)));
    const a = Math.max(0, Math.min(1, c.a === undefined ? 1 : c.a));
    return a >= 1 ? "rgb(" + r + ", " + g + ", " + b + ")" : "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
  }

  function opaque(c, bg) {
    if (!c) return null;
    if (c.a >= 1 || !bg) return { r: c.r, g: c.g, b: c.b, a: 1 };
    return {
      r: bg.r * (1 - c.a) + c.r * c.a,
      g: bg.g * (1 - c.a) + c.g * c.a,
      b: bg.b * (1 - c.a) + c.b * c.a,
      a: 1
    };
  }

  function mix(a, b, amount) {
    if (!a || !b) return a || b;
    return {
      r: a.r * (1 - amount) + b.r * amount,
      g: a.g * (1 - amount) + b.g * amount,
      b: a.b * (1 - amount) + b.b * amount,
      a: 1
    };
  }

  function luminance(c) {
    if (!c) return 0;
    const channel = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function ensureContrast(c, bg, min) {
    if (!c || !bg) return c;
    if (contrast(c, bg) >= min) return c;
    const target = luminance(bg) > 0.5 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    let best = c;
    for (let step = 1; step <= 10; step++) {
      best = mix(c, target, step / 10);
      if (contrast(best, bg) >= min) return best;
    }
    return best;
  }

  function effectiveBackground(node, fallback) {
    let n = node;
    while (n && n.nodeType !== 9) {
      const cs = computedStyle(n);
      const c = cs ? parseColor(cs.backgroundColor) : null;
      if (c && c.a > 0.05) return c;
      n = n.parentNode || n.host;
    }
    return fallback;
  }

  function effectiveColor(node, fallback) {
    let n = node;
    while (n && n.nodeType !== 9) {
      const cs = computedStyle(n);
      const c = cs ? parseColor(cs.color) : null;
      if (c) return c;
      n = n.parentNode || n.host;
    }
    return fallback;
  }

  function readYouTubeTheme() {
    if (typeof document === "undefined") return null;
    const root = document.documentElement;
    const dark = !!(root && root.hasAttribute && root.hasAttribute("dark"));
    const fallbackBg = dark ? { r: 15, g: 15, b: 15, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    const source =
      (yga.selectors &&
        yga.selectors.find &&
        (yga.selectors.find("guideRoot") || yga.selectors.find("app"))) ||
      document.body ||
      root;

    let surface = null;
    for (const name of [
      "--yt-spec-general-background-a",
      "--yt-spec-base-background",
      "--yt-spec-brand-background-solid"
    ]) {
      surface = opaque(parseColor(cssVar(name)), fallbackBg);
      if (surface) break;
    }
    if (!surface) surface = opaque(effectiveBackground(source, fallbackBg), fallbackBg) || fallbackBg;

    let fg = parseColor(cssVar("--yt-spec-text-primary"));
    if (!fg) fg = effectiveColor(source, null);
    if (!fg) fg = luminance(surface) > 0.5 ? { r: 15, g: 15, b: 15, a: 1 } : { r: 241, g: 241, b: 241, a: 1 };
    fg = ensureContrast(opaque(fg, surface), surface, 7);

    let dim = parseColor(cssVar("--yt-spec-text-secondary"));
    if (!dim) dim = mix(fg, surface, 0.65);
    dim = ensureContrast(opaque(dim, surface), surface, 3.5);

    return {
      "--yga-surface": toCss(surface),
      "--yga-fg": toCss(fg),
      "--yga-fg-dim": toCss(dim),
      "--yga-hover": toCss({ r: fg.r, g: fg.g, b: fg.b, a: 0.08 }),
      "--yga-border": toCss({ r: fg.r, g: fg.g, b: fg.b, a: 0.22 })
    };
  }

  function apply(node) {
    if (!node || !node.style) return;
    const vars = readYouTubeTheme();
    if (!vars) return;
    for (const name of VARS) {
      if (vars[name]) node.style.setProperty(name, vars[name]);
      else node.style.removeProperty(name);
    }
  }

  function clear(node) {
    if (!node || !node.style) return;
    for (const name of VARS) node.style.removeProperty(name);
  }

  yga.theme = { vars: VARS, read: readYouTubeTheme, apply: apply, clear: clear };
})(window.yga);

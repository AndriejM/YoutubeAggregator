// Browser probe for the Stage 9 letter-button anchors (PLAN.md §11 п.10).
// Paste the whole file into the DevTools console on a channel page and on a
// watch page, then send the printed output. Read-only: nothing is mutated.
(() => {
  const d = (e) => {
    const r = e.getBoundingClientRect();
    const cls = typeof e.className === "string" ? clsOf(e) : "";
    let flags = "";
    if (!(r.width || r.height)) flags += " HIDDEN";
    else if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) flags += " OFFSCREEN";
    try {
      const cs = getComputedStyle(e);
      if (cs.visibility !== "visible") flags += " VIS:" + cs.visibility;
      if (Number(cs.opacity) < 0.05) flags += " OPACITY";
    } catch (err) {}
    if (e.getRootNode && e.getRootNode() !== document) flags += " SHADOW";
    return (
      e.tagName.toLowerCase() +
      (e.id ? "#" + e.id : "") +
      (cls ? "." + cls : "") +
      " " + Math.round(r.width) + "x" + Math.round(r.height) +
      " L" + Math.round(r.left) + " R" + Math.round(r.right) +
      " T" + Math.round(r.top) + flags
    );
  };
  const clsOf = (e) => String(e.className || "").trim().split(/\s+/)[0] || "";
  const name = (e) =>
    String(e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

  // Standalone deep query: content scripts live in an isolated world, so the
  // page console cannot see yga.selectors.queryDeep.
  const deepAll = (sel) => {
    const out = [];
    const seen = new Set();
    const roots = [document];
    while (roots.length) {
      const scope = roots.shift();
      let found;
      try { found = scope.querySelectorAll(sel); } catch (e) { found = []; }
      for (const el of found) if (!seen.has(el)) { seen.add(el); out.push(el); }
      let hosts;
      try { hosts = scope.querySelectorAll("*"); } catch (e) { hosts = []; }
      for (const host of hosts) {
        if (host.shadowRoot && !seen.has(host.shadowRoot)) {
          seen.add(host.shadowRoot);
          roots.push(host.shadowRoot);
        }
      }
    }
    return out;
  };

  const CHAINS = {
    channelHeader: [
      "#page-header yt-flexible-actions-view-model",
      "yt-flexible-actions-view-model",
      '[class*="flexible-actions-view-model"]',
      "#page-header"
    ],
    subscribeButton: [
      "yt-subscribe-button-view-model",
      "ytd-subscribe-button-renderer",
      "#subscribe-button",
      '[class*="subscribe-button"]',
      "#page-header yt-flexible-actions-view-model",
      "yt-flexible-actions-view-model",
      '[class*="flexible-actions-view-model"]',
      "#page-header"
    ],
    likeDislike: [
      '[id="id.video.like.button"]',
      '[aria-labelledby*="video.like.button"]',
      "yt-segmented-like-dislike-button-view-model",
      '[class*="segmented-like-dislike"]',
      "yt-like-button-view-model",
      '[class*="like-button-view-model"]'
    ],
    likeButton: [
      '[id="id.video.like.button"]',
      '[aria-labelledby*="video.like.button"]',
      "yt-like-button-view-model",
      '[class*="like-button-view-model"]',
      "ytd-like-button-renderer",
      "#like-button"
    ],
    watchActions: ["#actions", "yt-watch-metadata", "ytd-watch-metadata", "#above-the-fold", "#info"]
  };

  const host = document.querySelector("[data-yga-group-buttons]");
  const out = {
    url: location.pathname.slice(0, 48),
    viewport: window.innerWidth + "x" + window.innerHeight,
    shadyDom: !!(window.ShadyDOM && window.ShadyDOM.force),
    anchor: host ? host.dataset.ygaAnchor : "(no host)",
    anchorEl: host ? host.dataset.ygaAnchorEl || "(old build)" : null,
    anchorRect: host ? host.dataset.ygaAnchorRect || "(old build)" : null,
    hostHidden: host ? host.classList.contains("yga-gp-hidden") : null,
    hostRect: host ? d(host) : null,
    hostStyle: host ? host.style.left + " / " + host.style.top : null,
    chains: {},
    deep: {},
    buttons: []
  };

  for (const key in CHAINS) {
    const rows = [];
    for (const sel of CHAINS[key]) {
      document.querySelectorAll(sel).forEach((e) => rows.push(sel + "  ->  " + d(e)));
    }
    out.chains[key] = rows;
  }

  // Deep (shadow-piercing) view of the two like chains — what findSmallestVisible
  // (…, true) sees when the light-DOM structural branch misses.
  for (const key of ["likeDislike", "likeButton"]) {
    const rows = [];
    for (const sel of CHAINS[key]) {
      deepAll(sel).forEach((e) => rows.push(sel + "  ->  " + d(e)));
    }
    out.deep[key] = rows;
  }

  const scopes = ["#page-header", "#actions", "yt-watch-metadata", "ytd-watch-metadata", "#above-the-fold", "#info"];
  const seen = new Set();
  for (const sel of scopes) {
    document.querySelectorAll(sel).forEach((root) => {
      root.querySelectorAll('button, [role="button"], a, [class*="button"]').forEach((e) => {
        if (seen.has(e) || e.closest("[data-yga-group-buttons]")) return;
        seen.add(e);
        const r = e.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const n = name(e);
        if (!n || n.length > 70) return;
        out.buttons.push('"' + n + '"  ' + d(e));
      });
    });
  }

  const json = JSON.stringify(out, null, 1);
  console.log("=== YGA PROBE START ===\n" + json + "\n=== YGA PROBE END ===");
  try {
    copy(json);
    console.log("[yga] probe copied to clipboard — paste it here");
  } catch (e) {
    console.log("[yga] copy() unavailable, copy the block above");
  }
  return json;
})();

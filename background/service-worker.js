// Service worker: browse fallback for subscriptions (PLAN.md §6, §7).
// All state lives in the page or storage; the worker is stateless (PLAN.md §12).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "subs:browse") {
    browseSubscriptions(msg.context).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String(err.message || err) })
    );
    return true; // async response
  }
});

const BROWSE_BODY = {
  context: null,
  browseId: "FEED_SUBSCRIPTIONS"
};

async function browseSubscriptions(pageContext) {
  const body = Object.assign({}, BROWSE_BODY);
  if (pageContext && pageContext.context) {
    // Bridge already returns the unwrapped context; tolerate the wrapped form too.
    const ctx = pageContext.context;
    body.context = ctx.context ? ctx.context : ctx;
  } else {
    body.context = {
      client: {
        clientName: "WEB",
        clientVersion: "2.20240101.00.00",
        hl: "en",
        gl: "US"
      }
    };
  }

  const res = await fetch("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    return { ok: false, error: "browse HTTP " + res.status };
  }
  const json = await res.json();
  const subs = extractChannelRenderers(json);
  return { ok: true, subs: subs };
}

function txt(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || "").join("");
  return "";
}

function img(t) {
  if (!t || !Array.isArray(t.thumbnails) || !t.thumbnails.length) return "";
  return t.thumbnails[t.thumbnails.length - 1].url || "";
}

function walk(node, visit, depth) {
  if (!node || typeof node !== "object" || depth > 24) return;
  visit(node);
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
  } else {
    for (const key of Object.keys(node)) walk(node[key], visit, depth + 1);
  }
}

function extractChannelRenderers(root) {
  const seen = new Map();
  walk(root, (obj) => {
    const cr = obj.channelRenderer;
    if (!cr || !cr.channelId || seen.has(cr.channelId)) return;
    const title = txt(cr.title);
    if (!title) return;
    seen.set(cr.channelId, {
      channelId: cr.channelId,
      title: title,
      avatarUrl: img(cr.thumbnail)
    });
  }, 0);
  return Array.from(seen.values());
}

// Stage 3 placeholder: RSS fetch and counter logic arrive in PLAN.md §10.

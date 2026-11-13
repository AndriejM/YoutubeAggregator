// Shared RSS parser for https://www.youtube.com/feeds/videos.xml (PLAN.md §6, §10).
// Side-effect module: exposes `yga.rssParser` on the global. Loaded as an ESM
// import in the service worker (MV3 service workers have NO DOMParser — hence
// this token scanner), as a classic content script, and in test/smoke.html.
// Input is trusted YouTube RSS; the scanner is bounded and never executes data.
(function (root) {
  "use strict";

  const MAX_TEXT = 500; // titles are cosmetic; a megabyte title means a broken feed
  const MAX_ENTRIES = 40; // feed ships ~15 entries, 15+ display ceiling (PLAN.md §12)

  function codePoint(n) {
    if (!n || n > 0x10ffff) return "";
    try {
      return String.fromCodePoint(n);
    } catch (e) {
      return "";
    }
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return codePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return codePoint(parseInt(d, 10)); })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  // CDATA bodies are text: neutralize markup so the tag scanner can ignore it,
  // decodeEntities restores the literal characters later.
  function unwrapCdata(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (_, body) {
      return body.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    });
  }

  // start = index right after the tag name; returns content start after `>`,
  // or start itself for a self-closing `<tag/>` (innerText then yields "").
  function findEnd(s, lower, start) {
    const gt = s.indexOf(">", start);
    if (gt < 0) return -1;
    return lower[gt - 1] === "/" ? start : gt + 1;
  }

  // First `<tag ...>` … matching `</tag>` content, starting at fromIndex.
  function innerText(s, lower, tag, fromIndex) {
    const openRe = new RegExp("<" + tag + "(?=[\\s/>])", "g");
    openRe.lastIndex = fromIndex;
    const open = openRe.exec(s);
    if (!open) return "";
    let i = findEnd(s, lower, open.index + tag.length);
    if (i < 0) return "";
    const closeRe = new RegExp("</" + tag + "\\s*>", "g");
    closeRe.lastIndex = i;
    const close = closeRe.exec(s);
    if (!close) return "";
    let text = s.slice(i, close.index);
    if (text.length > MAX_TEXT * 2) text = text.slice(0, MAX_TEXT * 2);
    return decodeEntities(text.replace(/\s+/g, " ").trim());
  }

  function localName(name) {
    const colon = name.lastIndexOf(":");
    return colon >= 0 ? name.slice(colon + 1) : name;
  }

  // `<media:group>` block → { thumbnail, community, label, duration }:
  // media:thumbnail with height=1 (feed order: [0] = channel avatar,
  // [1] = video thumb), media:community statistics views/ratings and the
  // stage-10 filter fields: media:title label (the video title — the filter
  // kind comes from kindOf(), not from this text) and media:duration seconds.
  function mediaGroup(block, lower) {
    const open = lower.indexOf("<media:group");
    if (open < 0) return {};
    const close = lower.indexOf("</media:group>", open);
    const body = block.slice(open, close < 0 ? block.length : close);
    const bodyLower = lower.slice(open, close < 0 ? block.length : close);
    const out = {};

    out.label = innerText(body, bodyLower, "media:title", 0);
    const duration = parseInt(innerText(body, bodyLower, "media:duration", 0), 10);
    out.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;

    const thumbs = [];
    const re = /<media:thumbnail[^>]*>/g;
    let m;
    while ((m = re.exec(body))) {
      const attrs = m[0];
      const url = /url="([^"]*)"/.exec(attrs);
      const h = /height="(\d+)"/.exec(attrs);
      thumbs.push({ url: url ? url[1] : "", height: h ? Number(h[1]) : 0 });
    }
    for (const t of thumbs) {
      if (t.height === 1 && t.url) {
        out.thumbnail = t.url;
        break;
      }
    }
    if (!out.thumbnail && thumbs.length > 1) out.thumbnail = thumbs[1].url || "";

    // media:community is a self-closing attribute carrier, not an element.
    const commTag = /<media:community[^>]*>/i.exec(body);
    if (commTag) {
      const stats = /media:statistics="([^"]*)"/i.exec(commTag[0]);
      if (stats) {
        const views = /views=(\d+)/.exec(stats[1]);
        const ratings = /ratings=(\d+)/.exec(stats[1]);
        out.community = {
          views: views ? Number(views[1]) : 0,
          ratings: ratings ? Number(ratings[1]) : 0
        };
      }
    }
    return out;
  }

  // Entry kind comes from the entry's alternate link: youtube.com/shorts/<id>
  // and youtube.com/live/<id>; plain videos use /watch?v=<id>. Real feeds put the
  // video title in media:title (no «YouTube Shorts»/«Live» marker there), so the
  // URL path is the only structural signal for the stage-10 filters.
  function kindOf(block) {
    const tag = /<link[^>]*rel="alternate"[^>]*>/i.exec(block);
    const href = tag && /href="([^"]*)"/i.exec(tag[0]);
    if (!href) return "video";
    const kind = /youtube\.com\/(shorts|live)\/[A-Za-z0-9_-]+/i.exec(href[1]);
    return kind ? kind[1].toLowerCase() : "video";
  }

  function entryFrom(block) {
    const lower = block.toLowerCase();
    const videoId = innerText(block, lower, "yt:videoId", 0);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const publishedAt = Date.parse(innerText(block, lower, "published", 0) || "") || 0;
    if (!publishedAt) return null;
    const media = mediaGroup(block, lower);
    // Stage 10 filters: the top-level <category scheme> distinguishes
    // movies/episodes/shows from plain videos (absent = "video").
    const cat = /<category[^>]*scheme="([^"]*)"/i.exec(block);
    const categoryValue = cat ? cat[1].trim().split(/[\/#\s]+/).pop().toLowerCase() : "";
    return {
      videoId: videoId,
      title: innerText(block, lower, "title", 0).slice(0, MAX_TEXT),
      publishedAt: publishedAt,
      thumbnail: media.thumbnail || "",
      views: media.community ? media.community.views : 0,
      label: media.label || "",
      kind: kindOf(block),
      duration: media.duration || 0,
      category: categoryValue,
      watched: false
    };
  }

  // Top-level feed elements (title/link) sit before the first <entry>.
  function feedFrom(header) {
    const lower = header.toLowerCase();
    const out = {};
    const id = innerText(header, lower, "yt:channelId", 0);
    if (/^UC[A-Za-z0-9_-]{22}$/.test(id)) out.channelId = id;
    out.title = innerText(header, lower, "title", 0).slice(0, MAX_TEXT);
    const alt = /<link[^>]*rel="alternate"[^>]*>/i.exec(header);
    const href = alt && /href="([^"]*)"/i.exec(alt[0]);
    const url = href ? href[1] : "";
    if (/^https:\/\/www\.youtube\.com\//.test(url)) out.url = url;
    return out;
  }

  // Returns { channelId, title, url, entries: [...] } newest-first as fed,
  // or null when the document is not an Atom feed with entries.
  function parseVideosXml(text) {
    if (!text || typeof text !== "string") return null;
    const s = unwrapCdata(text);
    const lower = s.toLowerCase();
    const feedOpen = lower.indexOf("<feed");
    if (feedOpen < 0 || lower.indexOf("<entry", feedOpen) < 0) return null;

    const header = s.slice(0, lower.indexOf("<entry", feedOpen));
    const entries = [];
    const entryRe = /<entry[\s/>]/gi;
    let m;
    while ((m = entryRe.exec(s)) && entries.length < MAX_ENTRIES) {
      const close = lower.indexOf("</entry>", m.index);
      if (close < 0) break;
      const entry = entryFrom(s.slice(m.index, close));
      if (entry) entries.push(entry);
    }
    if (!entries.length) return null;

    const feed = feedFrom(header);
    feed.entries = entries;
    return feed;
  }

  root.yga = root.yga || {};
  root.yga.rssParser = { parseVideosXml: parseVideosXml };
})(typeof globalThis !== "undefined" ? globalThis : this);

window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Stage 11: bundled group avatars. The icons live under icons/groups/<theme>/
  // as contiguous numeric files (1.ext .. count.ext), so the catalog stays small.
  const THEMES = [
  {
    "id": "business",
    "label": "Business",
    "ext": "png",
    "count": 145
  },
  {
    "id": "celebration",
    "label": "Celebration",
    "ext": "png",
    "count": 115
  },
  {
    "id": "christmas",
    "label": "Christmas",
    "ext": "png",
    "count": 105
  },
  {
    "id": "cloud-computing",
    "label": "Cloud Computing",
    "ext": "png",
    "count": 75
  },
  {
    "id": "communication",
    "label": "Communication",
    "ext": "png",
    "count": 125
  },
  {
    "id": "construction",
    "label": "Construction",
    "ext": "png",
    "count": 110
  },
  {
    "id": "design-and-development",
    "label": "Design And Development",
    "ext": "png",
    "count": 165
  },
  {
    "id": "education",
    "label": "Education",
    "ext": "png",
    "count": 170
  },
  {
    "id": "electronics",
    "label": "Electronics",
    "ext": "png",
    "count": 185
  },
  {
    "id": "engineering",
    "label": "Engineering",
    "ext": "png",
    "count": 85
  },
  {
    "id": "fashion-and-clothes",
    "label": "Fashion And Clothes",
    "ext": "png",
    "count": 270
  },
  {
    "id": "finance",
    "label": "Finance",
    "ext": "png",
    "count": 125
  },
  {
    "id": "fitness",
    "label": "Fitness",
    "ext": "png",
    "count": 105
  },
  {
    "id": "food",
    "label": "Food",
    "ext": "png",
    "count": 315
  },
  {
    "id": "furniture",
    "label": "Furniture",
    "ext": "png",
    "count": 100
  },
  {
    "id": "gaming",
    "label": "Gaming",
    "ext": "png",
    "count": 120
  },
  {
    "id": "hair-salon",
    "label": "Hair Salon",
    "ext": "png",
    "count": 105
  },
  {
    "id": "hotel-and-restaurant",
    "label": "Hotel And Restaurant",
    "ext": "png",
    "count": 145
  },
  {
    "id": "industrial",
    "label": "Industrial",
    "ext": "png",
    "count": 110
  },
  {
    "id": "logistics-delivery",
    "label": "Logistics Delivery",
    "ext": "png",
    "count": 85
  },
  {
    "id": "love-and-romance",
    "label": "Love And Romance",
    "ext": "png",
    "count": 120
  },
  {
    "id": "map-and-navigation",
    "label": "Map And Navigation",
    "ext": "png",
    "count": 75
  },
  {
    "id": "medical-and-health",
    "label": "Medical And Health",
    "ext": "png",
    "count": 260
  },
  {
    "id": "multimedia",
    "label": "Multimedia",
    "ext": "png",
    "count": 130
  },
  {
    "id": "nature",
    "label": "Nature",
    "ext": "png",
    "count": 135
  },
  {
    "id": "networking",
    "label": "Networking",
    "ext": "png",
    "count": 85
  },
  {
    "id": "real-estate",
    "label": "Real Estate",
    "ext": "png",
    "count": 105
  },
  {
    "id": "science-and-technology",
    "label": "Science And Technology",
    "ext": "png",
    "count": 105
  },
  {
    "id": "security",
    "label": "Security",
    "ext": "png",
    "count": 110
  },
  {
    "id": "seo-and-internet-marketing",
    "label": "Seo And Internet Marketing",
    "ext": "jpg",
    "count": 105
  },
  {
    "id": "shopping",
    "label": "Shopping",
    "ext": "png",
    "count": 105
  },
  {
    "id": "sports",
    "label": "Sports",
    "ext": "png",
    "count": 140
  },
  {
    "id": "summer",
    "label": "Summer",
    "ext": "png",
    "count": 135
  },
  {
    "id": "trade",
    "label": "Trade",
    "ext": "png",
    "count": 90
  },
  {
    "id": "transport",
    "label": "Transport",
    "ext": "png",
    "count": 95
  },
  {
    "id": "travel",
    "label": "Travel",
    "ext": "png",
    "count": 95
  },
  {
    "id": "weather",
    "label": "Weather",
    "ext": "png",
    "count": 65
  },
  {
    "id": "wedding",
    "label": "Wedding",
    "ext": "jpg",
    "count": 115
  }
];

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
      if (/^https:\/\//i.test(raw)) return { type: "url", url: raw };
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

window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Current YouTube account → accountKey for the subs catalog (§5, §6).
  // The page's ytcfg is the only source guaranteed on every page, so the
  // bridge is authoritative; the masthead DOM is a fallback and ytcfg carries
  // the identity even though the masthead lives in a shadow root.
  const ACCOUNT_KEY = "yga:account";

  // ytd-* renderers keep their markup in a shadow root: plain
  // document.querySelector("#avatar-btn") never matches (found 2026-11-08).
  function deepQuery(selector) {
    const direct = document.querySelector(selector);
    if (direct) return direct;
    const hosts = document.querySelectorAll("ytd-masthead, ytd-topbar-switcher-renderer");
    for (const host of hosts) {
      if (!host.shadowRoot) continue;
      const found = host.shadowRoot.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function domAccount() {
    const avatar = deepQuery("#avatar-btn");
    if (!avatar) return null;
    const title = String(
      avatar.getAttribute("aria-label") || avatar.getAttribute("title") || ""
    ).trim();
    const link = avatar.closest("a") || deepQuery('ytd-masthead a[href^="/@"]');
    const href = link ? link.getAttribute("href") || "" : "";
    const m = href.match(/^\/@([^/?#]+)/);
    const img = (avatar.querySelector("img") || {}).src || "";
    const key = m ? m[1] : title;
    if (!key) return null;
    return { accountKey: key, title: title, avatarUrl: img, handle: m ? m[1] : "" };
  }

  async function bridgeAccount() {
    try {
      const info = await yga.bridge.call("getAccountInfo", 4000);
      if (info && info.accountKey) return info;
    } catch (e) {
      console.debug("[yga] bridge getAccountInfo failed:", e);
    }
    return null;
  }

  yga.accounts = {
    // Best-effort detection: bridge (ytcfg) first, masthead DOM second.
    async detect() {
      const fromBridge = await bridgeAccount();
      const acc = fromBridge || domAccount();
      if (!acc || !acc.accountKey) {
        console.debug("[yga] account not detected, using fallback key");
        return { accountKey: "default", title: "", avatarUrl: "", handle: "", channelId: "" };
      }
      const record = {
        accountKey: acc.accountKey,
        title: acc.title || "",
        avatarUrl: acc.avatarUrl || "",
        channelId: acc.channelId || "",
        detectedAt: Date.now()
      };
      const prev = await chrome.storage.local.get(ACCOUNT_KEY);
      if (!prev[ACCOUNT_KEY] || prev[ACCOUNT_KEY].accountKey !== record.accountKey) {
        const payload = {};
        payload[ACCOUNT_KEY] = record;
        chrome.storage.local.set(payload);
      }
      return record;
    }
  };
})(window.yga);

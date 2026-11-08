window.yga = window.yga || {};

(function (yga) {
  "use strict";

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    return node;
  }

  function buildWidget() {
    const widget = el("div", "yga-widget", { "data-yga": "widget" });

    const header = el("div", "yga-header");

    const select = el("select", "yga-profile-select", {
      disabled: true,
      "aria-label": yga.i18n("profilesPlaceholder")
    });
    const placeholder = el("option", null, { value: "" });
    placeholder.textContent = yga.i18n("profilesPlaceholder");
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    const gear = el("button", "yga-config-btn", {
      type: "button",
      "aria-label": yga.i18n("configButton"),
      title: yga.i18n("configButton")
    });
    gear.innerHTML = GEAR_SVG; // static markup, no YouTube data (PLAN.md §12)

    header.appendChild(select);
    header.appendChild(gear);

    const list = el("div", "yga-list", { "aria-live": "polite" });

    widget.appendChild(header);
    widget.appendChild(list);
    return widget;
  }

  // --- subscription rows (stage 1) ---

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      observer.unobserve(img);
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
    }
  }, { rootMargin: "200px" });

  function rowNode(sub) {
    const row = el("a", "yga-row", {
      href: "/channel/" + sub.channelId + "/videos",
      title: sub.title
    });

    const avatar = el("img", "yga-avatar", { alt: "" });
    if (sub.avatarUrl) {
      avatar.dataset.src = sub.avatarUrl;
      observer.observe(avatar);
    } else {
      avatar.classList.add("yga-avatar-empty");
    }

    const title = el("span", "yga-title");
    title.textContent = sub.title;

    row.appendChild(avatar);
    row.appendChild(title);
    return row;
  }

  function placeholderRow(textKey) {
    const row = el("div", "yga-placeholder");
    row.textContent = yga.i18n(textKey);
    return row;
  }

  yga.widget = {
    render(list) {
      const widget = document.querySelector('[data-yga="widget"]');
      if (!widget) return;
      const host = widget.querySelector(".yga-list");
      host.textContent = "";

      if (!list) {
        host.appendChild(placeholderRow("loadingSubs"));
        return;
      }
      if (!list.length) {
        host.appendChild(placeholderRow("emptyState"));
        return;
      }
      const sorted = list.slice().sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
      );
      const frag = document.createDocumentFragment();
      for (const sub of sorted) frag.appendChild(rowNode(sub));
      host.appendChild(frag);
    }
  };

  // Idempotent mount (PLAN.md §8.2, §8.3): reuses a live node, rehangs a detached one.
  yga.mountWidget = function mountWidget() {
    const existing = document.querySelector('[data-yga="widget"]');
    if (existing && existing.isConnected) return existing;
    if (existing) existing.remove();

    const sections =
      yga.selectors.find("guideSections") || yga.selectors.find("guideRoot");
    if (!sections) return null;

    const widget = buildWidget();
    const link = yga.selectors.find("subscriptionsLink");
    if (link && link.parentNode === sections) {
      link.insertAdjacentElement("afterend", widget);
    } else {
      sections.appendChild(widget);
    }

    if (yga.state) yga.widget.render(yga.state.getSubs());
    return widget;
  };
})(window.yga);

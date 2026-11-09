window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Configuration panel (PLAN.md §8.7, §9.2 — stage 4): inline DOM inserted
  // into ytd-app > #content, in the same isolated world as the widget. No
  // iframe, no web_accessible_resources, no cross-world messaging — sections
  // read and write chrome.storage through profiles.js / state.js directly.
  const PANEL_ATTR = "data-yga-panel";
  const SCROLL_LOCK = "yga-scroll-lock";
  const HIDDEN = "yga-hidden"; // widget.css: display:none !important (§8.7)

  const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M6 6l12 12M18 6L7 18" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"/></svg>';

  let panel = null;
  let hiddenHosts = []; // YouTube nodes we hid, to restore on close
  let cleanups = []; // section unsubscribers, dropped on close
  let keydownHandler = null;
  let navHandler = null;
  let activeSection = null;

  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) {
      for (const key in attrs) {
        if (attrs[key] === true) node.setAttribute(key, "");
        else node.setAttribute(key, attrs[key]);
      }
    }
    return node;
  }

  // Direct child of #content that owns the YouTube page (PLAN.md §8.7:
  // "ищем ytd-two-column-browse-results-renderer и его родителя").
  function pageHost() {
    const content = yga.selectors.find("contentRoot");
    if (!content) return null;
    const browse = yga.selectors.find("browseResults");
    let node = browse;
    while (node && node.parentNode !== content) node = node.parentNode;
    if (node) return node;
    return content.querySelector("#page-manager, ytd-page-manager");
  }

  function hideYouTube() {
    const host = pageHost();
    if (!host || hiddenHosts.indexOf(host) >= 0) return;
    host.classList.add(HIDDEN);
    hiddenHosts.push(host);
  }

  function restoreYouTube() {
    for (const host of hiddenHosts) host.classList.remove(HIDDEN);
    hiddenHosts = [];
  }

  function lockScroll(on) {
    document.documentElement.classList.toggle(SCROLL_LOCK, on);
    if (document.body) document.body.classList.toggle(SCROLL_LOCK, on);
  }

  function runCleanups() {
    for (const off of cleanups) {
      try {
        off();
      } catch (e) {
        console.debug("[yga] panel cleanup failed:", e);
      }
    }
    cleanups = [];
  }

  function detachEvents() {
    if (keydownHandler) {
      document.removeEventListener("keydown", keydownHandler, true);
      keydownHandler = null;
    }
    if (navHandler) {
      window.removeEventListener("yt-navigate-finish", navHandler);
      navHandler = null;
    }
  }

  function buildPanel() {
    const node = el("div", "yga-panel", {
      "data-yga": "panel",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": yga.i18n("configButton")
    });
    node.setAttribute(PANEL_ATTR, "");

    const header = el("div", "yga-panel-header");
    const title = el("h2", "yga-panel-title");
    title.textContent = yga.i18n("panelTitle");
    const close = el("button", "yga-panel-close", {
      type: "button",
      "aria-label": yga.i18n("panelClose"),
      title: yga.i18n("panelClose")
    });
    close.innerHTML = CLOSE_SVG; // static markup (PLAN.md §12)
    close.addEventListener("click", closePanel);
    header.appendChild(title);
    header.appendChild(close);

    const body = el("div", "yga-panel-body");
    node.appendChild(header);
    node.appendChild(body);
    yga.panelSections.buildAll(body);
    return node;
  }

  // Insert the panel next to the (hidden) YouTube page. Returns false when the
  // page has no #content anchor — the caller must not lock the scroll then.
  function insert() {
    const content = yga.selectors.find("contentRoot");
    const host = pageHost();
    if (!content || !host) return false;
    hideYouTube();
    content.insertBefore(panel, host.nextSibling);
    return true;
  }

  function closePanel() {
    if (!panel) return;
    const node = panel;
    panel = null;
    activeSection = null;
    runCleanups();
    detachEvents();
    node.remove();
    restoreYouTube();
    lockScroll(false);
  }

  function openPanel(section) {
    if (panel && panel.isConnected) {
      if (section) yga.panel.activate(section);
      return panel;
    }
    panel = null;
    runCleanups();
    detachEvents();
    restoreYouTube();

    panel = buildPanel();
    if (!insert()) {
      console.debug("[yga] config panel: no #content anchor on this page");
      panel = null;
      runCleanups();
      return null;
    }
    lockScroll(true);

    keydownHandler = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closePanel();
      }
    };
    document.addEventListener("keydown", keydownHandler, true);

    // SPA navigation may replace #content: re-anchor instead of losing the panel.
    navHandler = () => {
      if (!panel) return;
      if (!panel.isConnected) {
        panel.remove();
        panel = buildPanel();
      }
      restoreYouTube(); // the old host may be gone, but never leave it hidden
      if (!insert()) closePanel();
    };
    window.addEventListener("yt-navigate-finish", navHandler);

    if (section) yga.panel.activate(section);
    // Accent / theme-follow are owned by widget.js (one source for both surfaces).
    if (yga.widget && yga.widget.applyTheme) yga.widget.applyTheme();
    const close = panel.querySelector(".yga-panel-close");
    if (close) close.focus();
    return panel;
  }

  yga.panel = {
    util: {
      el: el,
      i18n: function (key) {
        return yga.i18n(key);
      },
      // Labelled control row: label on the left, control on the right.
      field: function (labelKey, control, hintKey) {
        const row = el("div", "yga-panel-field");
        const label = el("label", "yga-panel-label");
        label.textContent = yga.i18n(labelKey);
        row.appendChild(label);
        const box = el("div", "yga-panel-control");
        box.appendChild(control);
        if (hintKey) {
          const hint = el("div", "yga-panel-hint");
          hint.textContent = yga.i18n(hintKey);
          box.appendChild(hint);
        }
        row.appendChild(box);
        return row;
      },
      checkbox: function (checked) {
        return el("input", "yga-panel-check", { type: "checkbox" });
      },
      select: function (options, value) {
        const select = el("select", "yga-panel-select");
        for (const opt of options) {
          const option = el("option", null, { value: opt.value });
          option.textContent = yga.i18n(opt.labelKey);
          select.appendChild(option);
        }
        select.value = value;
        return select;
      },
      number: function (value, attrs) {
        const input = el("input", "yga-panel-input yga-panel-num", Object.assign({ type: "number" }, attrs || {}));
        input.value = String(value);
        return input;
      },
      text: function (value, attrs) {
        const input = el("input", "yga-panel-input", Object.assign({ type: "text" }, attrs || {}));
        input.value = value == null ? "" : String(value);
        return input;
      },
      button: function (labelKey, cls) {
        const btn = el("button", "yga-panel-btn" + (cls ? " " + cls : ""), { type: "button" });
        btn.textContent = yga.i18n(labelKey);
        return btn;
      },
      section: function (name, titleKey) {
        const node = el("section", "yga-panel-section", { "data-section": name });
        const heading = el("h3", "yga-panel-section-title");
        heading.textContent = yga.i18n(titleKey);
        node.appendChild(heading);
        return node;
      },
      placeholder: function (textKey) {
        const node = el("div", "yga-panel-placeholder");
        node.textContent = yga.i18n(textKey);
        return node;
      },
      // Settings write helper shared by all sections: one nested field,
      // immediate mirror, debounced storage write (PLAN.md §5).
      save: function (path, value) {
        return yga.profiles.saveSettingsPath(path, value);
      },
      // Worker must re-sync the scheduled alarm after refresh.* edits.
      notifyWorker: function () {
        try {
          chrome.runtime.sendMessage({ type: "counters:settings" });
        } catch (e) {
          console.debug("[yga] settings notify failed:", e);
        }
      },
      // Register a cleanup (event/listener unsubscribe) run on panel close.
      onCleanup: function (off) {
        if (typeof off === "function") cleanups.push(off);
      },
      activeSection: function () {
        return activeSection;
      }
    },

    isOpen() {
      return !!(panel && panel.isConnected);
    },

    open(section) {
      return openPanel(section);
    },

    close() {
      closePanel();
    },

    toggle(section) {
      if (this.isOpen()) this.close();
      else openPanel(section);
    },

    // Rebuild one section in place (used after CRUD that changes other sections).
    refresh(name) {
      if (!panel) return;
      const node = panel.querySelector('[data-section="' + name + '"]');
      if (node && yga.panelSections.rebuild) yga.panelSections.rebuild(node, name);
    },

    activate(name) {
      if (!panel) return;
      activeSection = name;
      const node = panel.querySelector('[data-section="' + name + '"]');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "start" });
    }
  };
})(window.yga);

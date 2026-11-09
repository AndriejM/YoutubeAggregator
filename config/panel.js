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
  let builtSection = null; // the one section currently in the body (§9.2.3)
  let staleSections = null; // sections edited while hidden — rebuild on show
  let modal = null; // §9.2.2 name dialog, Esc-closable before the panel

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

  // ---- single-field modal (§9.2.2: «+ Группа» is a modal with one name) ----

  function closeModal() {
    if (!modal) return;
    const node = modal;
    modal = null;
    node.remove();
  }

  function openModal(opts) {
    closeModal();
    if (!panel) return null;
    const box = el("div", "yga-panel-modal", {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": yga.i18n(opts.titleKey)
    });
    const title = el("h3", "yga-panel-modal-title");
    title.textContent = yga.i18n(opts.titleKey);
    const input = el("input", "yga-panel-input", { type: "text", "aria-label": yga.i18n(opts.titleKey) });
    input.value = opts.value || "";
    const bar = el("div", "yga-panel-bar");
    const ok = el("button", "yga-panel-btn yga-panel-primary", { type: "button" });
    ok.textContent = yga.i18n(opts.confirmKey || "modalOk");
    const cancel = el("button", "yga-panel-btn", { type: "button" });
    cancel.textContent = yga.i18n(opts.cancelKey || "modalCancel");
    bar.appendChild(ok);
    bar.appendChild(cancel);
    box.appendChild(title);
    box.appendChild(input);
    box.appendChild(bar);
    panel.appendChild(box);
    modal = box;

    let done = false;
    function submit() {
      if (done) return;
      done = true;
      const value = input.value;
      closeModal();
      if (opts.onConfirm) opts.onConfirm(value);
    }
    function abort() {
      if (done) return;
      done = true;
      closeModal();
      if (opts.onCancel) opts.onCancel();
    }
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", abort);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        abort();
      }
    });
    if (input.focus) input.focus();
    return box;
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

  // ---- tabs (§9.2.3): one section visible at a time, the rest not built ----
  // A long page of seven stacked sections overflowed the panel with no scroll
  // (§11 stage 4 known issue); a tab strip plus .yga-panel-body scroll fixes it.

  function tabButton(name) {
    const btn = el("button", "yga-panel-tab", {
      type: "button",
      role: "tab",
      "data-tab": name,
      "aria-selected": "false"
    });
    btn.textContent = yga.i18n(yga.panelSections.title(name));
    btn.addEventListener("click", () => yga.panel.activate(name));
    return btn;
  }

  function markTabs() {
    if (!panel) return;
    for (const btn of panel.querySelectorAll(".yga-panel-tab")) {
      const on = btn.getAttribute("data-tab") === activeSection;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.classList.toggle("yga-active", on);
    }
  }

  function showSection(name) {
    if (!panel) return;
    const body = panel.querySelector(".yga-panel-body");
    if (!body) return;
    body.textContent = "";
    builtSection = name;
    body.appendChild(yga.panelSections.buildSection(name));
  }

  function buildPanel() {
    const node = el("div", "yga-panel", {
      "data-yga": "panel",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": yga.i18n("configButton")
    });
    node.setAttribute(PANEL_ATTR, "");
    // Build marker: a stale content script (extension tile reloaded but the
    // YouTube tab not refreshed) shows the old panel — check this attribute
    // in DevTools or the console line logged on open.
    node.setAttribute("data-yga-build", "stage6b");

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

    const tabs = el("div", "yga-panel-tabs", { role: "tablist" });
    for (const name of yga.panelSections.names()) tabs.appendChild(tabButton(name));

    const body = el("div", "yga-panel-body", { role: "tabpanel" });
    node.appendChild(header);
    node.appendChild(tabs);
    node.appendChild(body);
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
    builtSection = null;
    staleSections = null;
    closeModal();
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
    console.info("[yga] panel build:", panel.getAttribute("data-yga-build"),
      "tabs:", panel.querySelectorAll(".yga-panel-tab").length);
    yga.panel.activate(section || yga.panelSections.names()[0]);
    const tabCount = panel.querySelectorAll(".yga-panel-tab").length;
    if (tabCount !== yga.panelSections.names().length) {
      console.warn("[yga] config panel tabs mismatch:", tabCount, yga.panelSections.names().length);
    }

    keydownHandler = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      // A modal (group name, §9.2.2) closes before the panel itself.
      if (modal) closeModal();
      else closePanel();
    };
    document.addEventListener("keydown", keydownHandler, true);

    // SPA navigation may replace #content: re-anchor instead of losing the panel.
    navHandler = () => {
      if (!panel) return;
      if (!panel.isConnected) {
        panel.remove();
        const keep = activeSection;
        panel = buildPanel();
        builtSection = null;
        if (insert()) showSection(keep);
        else {
          panel = null;
          runCleanups();
          return;
        }
      } else if (!insert()) {
        closePanel();
        return;
      }
      restoreYouTube(); // the old host may be gone, but never leave it hidden
    };
    window.addEventListener("yt-navigate-finish", navHandler);

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
          // opt.text carries a user string (a group name) that is not an i18n key.
          option.textContent = opt.text || yga.i18n(opt.labelKey);
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
      },
      // Single-field modal (§9.2.2). onConfirm receives the trimmed-or-empty
      // raw value; validation is the caller's job so it can show its own hint.
      modal: function (opts) {
        return openModal(opts);
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
    // Only the visible tab is rebuilt; a hidden one is marked stale and rebuilt
    // when it is next activated (§9.2.3).
    refresh(name) {
      if (!panel) return;
      if (name === activeSection && builtSection === name) {
        showSection(name);
        return;
      }
      if (!staleSections) staleSections = new Set();
      staleSections.add(name);
    },

    activate(name) {
      if (!panel || !yga.panelSections.names().includes(name)) return;
      activeSection = name;
      markTabs();
      if (builtSection !== name || (staleSections && staleSections.has(name))) showSection(name);
      if (staleSections) staleSections.delete(name);
    }
  };
})(window.yga);

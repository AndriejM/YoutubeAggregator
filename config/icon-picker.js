window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Stage 11: group avatar picker. It is a panel-local modal: theme tabs on
  // top, a scrollable icon grid below, and an optional HTTPS URL fallback.
  const u = yga.panel.util;
  const el = u.el;

  let openBox = null;
  let keyHandler = null;

  function close() {
    if (!openBox) return;
    const node = openBox;
    openBox = null;
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler, true);
      keyHandler = null;
    }
    node.remove();
  }

  function firstTheme() {
    const themes = (yga.groupIcons && yga.groupIcons.themes) || [];
    return themes.length ? themes[0].id : "";
  }

  function selectedFrom(current) {
    if (!current) return { type: "builtin", theme: firstTheme() };
    if (current.type === "url") return { type: "url" };
    return { type: "builtin", theme: current.theme || firstTheme() };
  }

  function previewNode(box, current) {
    const host = box.querySelector(".yga-icon-preview");
    if (!host) return;
    host.textContent = "";
    const node = yga.groupIcons ? yga.groupIcons.avatarNode(current, "yga-icon-preview-img", { alt: "" }) : null;
    if (node) {
      host.appendChild(node);
    } else {
      const empty = el("span", "yga-icon-preview-empty");
      empty.textContent = "—";
      host.appendChild(empty);
    }
  }

  function makeTab(label, tab, selected, onSelect) {
    const btn = el("button", "yga-panel-chip yga-icon-tab", { type: "button" });
    btn.textContent = label;
    btn._ygaTab = tab;
    if (selected) btn.classList.add("yga-active");
    btn.addEventListener("click", () => onSelect(tab));
    return btn;
  }

  function markTabs(box, selected) {
    const tabs = box.querySelectorAll(".yga-icon-tab");
    for (const tab of tabs) {
      const active =
        (selected.type === "none" && tab._ygaTab.type === "none") ||
        (selected.type === "url" && tab._ygaTab.type === "url") ||
        (selected.type === "builtin" &&
          tab._ygaTab.type === "builtin" &&
          tab._ygaTab.theme === selected.theme);
      tab.classList.toggle("yga-active", active);
    }
  }

  function renderTheme(box, themeId, onPick) {
    const content = box.querySelector(".yga-icon-content");
    if (!content) return;
    content.textContent = "";
    const theme = yga.groupIcons ? yga.groupIcons.theme(themeId) : null;
    if (!theme) {
      content.appendChild(u.placeholder("groupAvatarEmpty"));
      return;
    }
    const grid = el("div", "yga-icon-grid");
    for (let i = 1; i <= theme.count; i++) {
      const btn = el("button", "yga-icon-cell", {
        type: "button",
        "aria-label": theme.label + " " + i,
        title: theme.label + " " + i
      });
      btn.appendChild(el("img", "yga-icon-img", {
        alt: "",
        loading: "lazy",
        src: yga.groupIcons.url(theme.id, i)
      }));
      btn.addEventListener("click", () => onPick({ type: "builtin", theme: theme.id, index: i }));
      grid.appendChild(btn);
    }
    content.appendChild(grid);
  }

  function renderUrl(box, current, onPick) {
    const content = box.querySelector(".yga-icon-content");
    if (!content) return;
    content.textContent = "";
    const wrap = el("div", "yga-icon-url");
    const input = el("input", "yga-panel-input", {
      type: "url",
      "aria-label": yga.i18n("groupAvatarUrl"),
      placeholder: "https://..."
    });
    input.value = current && current.type === "url" ? current.url : "";
    const status = el("div", "yga-panel-meta");
    status.textContent = yga.i18n("groupAvatarUrlHint");
    const apply = u.button("groupAvatarApply", "yga-panel-primary");
    apply.addEventListener("click", () => {
      const raw = String(input.value || "").trim();
      if (!/^https:\/\//i.test(raw)) {
        status.textContent = yga.i18n("groupAvatarInvalidUrl");
        return;
      }
      onPick({ type: "url", url: raw });
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        apply.dispatchEvent({ type: "click" });
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(status);
    wrap.appendChild(apply);
    content.appendChild(wrap);
    if (input.focus) input.focus();
  }

  function renderNone(box) {
    const content = box.querySelector(".yga-icon-content");
    if (!content) return;
    content.textContent = "";
    content.appendChild(u.placeholder("groupAvatarNoneHint"));
  }

  // Tint row: built-in icons are recolored at runtime via CSS mask-image, so
  // the bundled files stay untouched. URL avatars are never tinted.
  function renderColorRow(box, opts) {
    const host = box.querySelector(".yga-icon-color-row");
    if (!host) return;
    host.textContent = "";
    const label = el("span", "yga-panel-meta");
    label.textContent = yga.i18n("groupAvatarColor");
    const color = opts.getColor();
    const input = el("input", "yga-panel-input yga-icon-color-input", {
      type: "color",
      "aria-label": yga.i18n("groupAvatarColor")
    });
    input.value = color || "#ffffff";
    // Chrome can deliver the colorpicker update only when its dialog closes,
    // so both events feed the same handler and the value is read from the input.
    const sync = () => opts.onInput(input.value);
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    const apply = u.button("groupAvatarColorApply", "yga-panel-primary yga-icon-color-apply");
    apply.disabled = !opts.canApply();
    apply.addEventListener("click", () => opts.onApply());
    const reset = u.button("groupAvatarColorReset", "yga-icon-color-reset");
    reset.disabled = !opts.canReset();
    reset.addEventListener("click", () => opts.onReset());
    host.appendChild(label);
    host.appendChild(input);
    host.appendChild(apply);
    host.appendChild(reset);
  }

  function render(box, selected, current, onPick) {
    markTabs(box, selected);
    previewNode(box, current);
    if (selected.type === "none") renderNone(box);
    else if (selected.type === "url") renderUrl(box, current, onPick);
    else renderTheme(box, selected.theme, onPick);
  }

  function open(opts) {
    close();
    const panel = document.querySelector('[data-yga="panel"]');
    if (!panel) return null;
    opts = opts || {};
    const current = yga.groupIcons ? yga.groupIcons.normalize(opts.current) : null;
    let selected = selectedFrom(current);
    let color = current && current.color ? current.color : "";

    const box = el("div", "yga-panel-modal yga-icon-modal", {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": yga.i18n("groupAvatarTitle")
    });
    const title = el("h3", "yga-panel-modal-title");
    title.textContent = yga.i18n("groupAvatarTitle");
    const preview = el("div", "yga-icon-preview");
    const tabs = el("div", "yga-panel-tabs yga-icon-tabs", { role: "tablist" });
    const colorRow = el("div", "yga-icon-color-row");
    const content = el("div", "yga-icon-content");
    const bar = el("div", "yga-panel-bar");
    const remove = u.button("groupAvatarRemove");
    remove.disabled = !current;
    const cancel = u.button("modalCancel");
    bar.appendChild(remove);
    bar.appendChild(cancel);

    // The colorpicker may have moved without an `input`/`change` event reaching
    // us (Chrome fires them only after the dialog closes), so an icon click
    // reads the live input value: anything the user moved away from what we
    // rendered wins, otherwise the pending tint (saved color or «Оригинал»).
    function pendingColor() {
      const input = box.querySelector(".yga-icon-color-input");
      const shown = input && yga.groupIcons ? yga.groupIcons.normalizeColor(input.value) : "";
      if (shown && shown !== (color || "#ffffff")) return shown;
      return color;
    }

    function pick(avatar) {
      if (avatar && avatar.type === "builtin") {
        const tint = pendingColor();
        if (tint) avatar.color = tint;
      }
      close();
      if (opts.onPick) opts.onPick(avatar);
    }

    function canApplyColor() {
      return !!(current && current.type === "builtin" && current.index);
    }

    function canResetColor() {
      return !!(current && current.type === "builtin" && current.color);
    }

    function inputColor() {
      const input = box.querySelector(".yga-icon-color-input");
      const raw = input ? input.value : color;
      return (yga.groupIcons && yga.groupIcons.normalizeColor(raw)) || "#ffffff";
    }

    function previewWithPendingColor() {
      if (!current || current.type !== "builtin") {
        previewNode(box, current);
        return;
      }
      const preview = Object.assign({}, current);
      if (color) preview.color = color;
      else delete preview.color;
      previewNode(box, preview);
    }

    function updateColorRow() {
      renderColorRow(box, {
        getColor: () => color,
        canApply: canApplyColor,
        canReset: canResetColor,
        onInput: (next) => {
          color = yga.groupIcons ? yga.groupIcons.normalizeColor(next) : "";
          previewWithPendingColor();
        },
        onApply: () => {
          if (!canApplyColor()) return;
          const applied = inputColor();
          color = applied;
          current.color = applied;
          remove.disabled = !current;
          previewNode(box, current);
          const reset = box.querySelector(".yga-icon-color-reset");
          if (reset) reset.disabled = false;
          if (opts.onApply) opts.onApply(current);
          else if (opts.onPick) opts.onPick(current);
        },
        onReset: () => {
          color = "";
          if (current && current.type === "builtin") delete current.color;
          remove.disabled = !current;
          previewNode(box, current);
          updateColorRow();
        }
      });
    }

    function select(tab) {
      selected = tab;
      render(box, selected, current, pick);
    }

    tabs.appendChild(makeTab(yga.i18n("groupAvatarNone"), { type: "none" }, selected.type === "none", select));
    for (const theme of (yga.groupIcons && yga.groupIcons.themes) || []) {
      tabs.appendChild(
        makeTab(
          theme.label,
          { type: "builtin", theme: theme.id },
          selected.type === "builtin" && selected.theme === theme.id,
          select
        )
      );
    }
    tabs.appendChild(makeTab(yga.i18n("groupAvatarUrl"), { type: "url" }, selected.type === "url", select));

    remove.addEventListener("click", () => pick(null));
    cancel.addEventListener("click", close);
    box.appendChild(title);
    box.appendChild(preview);
    box.appendChild(tabs);
    box.appendChild(colorRow);
    box.appendChild(content);
    box.appendChild(bar);
    panel.appendChild(box);
    openBox = box;
    updateColorRow();

    keyHandler = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    };
    document.addEventListener("keydown", keyHandler, true);
    render(box, selected, current, pick);
    return box;
  }

  yga.iconPicker = {
    open: open,
    close: close
  };
})(window.yga);

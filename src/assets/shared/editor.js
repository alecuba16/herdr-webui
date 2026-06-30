(function () {
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function languageFor(path) {
    if (window.HerdrGitSyntax && window.HerdrGitSyntax.languageFor) return window.HerdrGitSyntax.languageFor(path);
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ext || "text";
  }

  function highlight(content, path) {
    if (window.HerdrGitSyntax && window.HerdrGitSyntax.highlight) return window.HerdrGitSyntax.highlight(content, path);
    return esc(content);
  }

  let codeMirrorPromise = null;
  const EDITOR_SHORTCUT_PRESETS = {
    default: {},
    neovim: {
      save: "Ctrl+S",
      lineDown: "Alt+J",
      lineUp: "Alt+K",
      charLeft: "Alt+H",
      charRight: "Alt+L",
      wordLeft: "Alt+B",
      wordRight: "Alt+W",
      pageDown: "Ctrl+D",
      pageUp: "Ctrl+U",
      docStart: "Ctrl+G",
      docEnd: "Ctrl+Shift+G",
      deleteLine: "Ctrl+X",
      indentMore: "Ctrl+]",
      indentLess: "Ctrl+[",
    },
  };
  const EDITOR_SHORTCUT_LABELS = {
    save: "Save file",
    lineDown: "Move line down",
    lineUp: "Move line up",
    charLeft: "Move left",
    charRight: "Move right",
    wordLeft: "Move word left",
    wordRight: "Move word right",
    pageDown: "Page down",
    pageUp: "Page up",
    docStart: "Document start",
    docEnd: "Document end",
    deleteLine: "Delete line",
    indentMore: "Indent more",
    indentLess: "Indent less",
  };

  function normalizeShortcut(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.toLowerCase() === "off") return "off";
    const parts = raw.replace(/-/g, "+").split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop();
    if (!key) return "off";
    const mods = new Set(parts.map((part) => {
      const lower = part.toLowerCase();
      if (lower === "control") return "Ctrl";
      if (lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
      if (lower === "option") return "Alt";
      if (["ctrl", "alt", "shift"].includes(lower)) return lower[0].toUpperCase() + lower.slice(1);
      return "";
    }).filter(Boolean));
    const cleanKey = key.length === 1 ? key.toUpperCase() : key;
    return ["Ctrl", "Alt", "Shift", "Meta"].filter((mod) => mods.has(mod)).concat(cleanKey).join("+");
  }

  function normalizeShortcutMap(map, preset) {
    const defaults = EDITOR_SHORTCUT_PRESETS[preset] || EDITOR_SHORTCUT_PRESETS.default;
    const input = map && typeof map === "object" ? map : {};
    return Object.fromEntries(Object.keys(EDITOR_SHORTCUT_LABELS).map((key) => [
      key,
      normalizeShortcut(input[key] || defaults[key] || "off"),
    ]));
  }

  function ensureEditorSettingsModule() {
    const modules = window.HerdrSettingsModules || (window.HerdrSettingsModules = []);
    if (modules.some((module) => module.id === "editorShortcuts")) return;
    modules.push({
      id: "editorShortcuts",
      title: "Editor shortcuts",
      desc: "Code editor keyboard profile and custom key bindings.",
      defaults: {
        editorShortcutPreset: "default",
        editorShortcuts: normalizeShortcutMap({}, "default"),
      },
      ids: ["optEditorShortcutPreset"].concat(Object.keys(EDITOR_SHORTCUT_LABELS).map((key) => `optEditorShortcut-${key}`)),
      renderSettings() {
        const rows = Object.entries(EDITOR_SHORTCUT_LABELS).map(([key, label]) => `<label class="option"><span>${esc(label)}<small>Use Ctrl/Alt/Shift/Meta+Key, or off.</small></span><input id="optEditorShortcut-${esc(key)}" data-editor-shortcut="${esc(key)}" placeholder="off"></label>`).join("");
        return `<label class="option"><span>Shortcut preset<small>Default keeps CodeMirror keys. Neovim adds familiar movement/editing chords without full modal Vim.</small></span><select class="settings-select" id="optEditorShortcutPreset"><option value="default">Default</option><option value="neovim">Neovim-like</option></select></label>${rows}`;
      },
      normalize(options) {
        if (!EDITOR_SHORTCUT_PRESETS[options.editorShortcutPreset]) options.editorShortcutPreset = "default";
        options.editorShortcuts = normalizeShortcutMap(options.editorShortcuts, options.editorShortcutPreset);
      },
      apply(options) {
        const preset = document.getElementById("optEditorShortcutPreset");
        if (preset) preset.value = options.editorShortcutPreset || "default";
        for (const key of Object.keys(EDITOR_SHORTCUT_LABELS)) {
          const input = document.getElementById(`optEditorShortcut-${key}`);
          if (input) input.value = (options.editorShortcuts || {})[key] || "off";
        }
      },
      bind(ctx) {
        const preset = ctx.el("optEditorShortcutPreset");
        if (preset) preset.onchange = () => {
          ctx.setOption("editorShortcutPreset", preset.value);
          ctx.setOption("editorShortcuts", normalizeShortcutMap({}, preset.value));
          ctx.saveOptions();
          ctx.applyOptions();
        };
        for (const key of Object.keys(EDITOR_SHORTCUT_LABELS)) {
          const input = ctx.el(`optEditorShortcut-${key}`);
          if (!input) continue;
          input.onchange = () => {
            const shortcuts = Object.assign({}, ctx.getOption("editorShortcuts") || {});
            shortcuts[key] = normalizeShortcut(input.value);
            ctx.setOption("editorShortcuts", shortcuts);
            ctx.saveOptions();
            ctx.applyOptions();
          };
        }
      },
    });
  }

  ensureEditorSettingsModule();

  function loadCodeMirror() {
    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) return Promise.resolve(true);
    if (codeMirrorPromise) return codeMirrorPromise;
    codeMirrorPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = "/assets/vendor/codemirror.js";
      script.onload = () => resolve(!!(window.HerdrCodeMirror && window.HerdrCodeMirror.create));
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
    return codeMirrorPromise;
  }

  function create(options) {
    const opts = options || {};
    const parent = opts.parent;
    if (!parent) return null;
    let destroyed = false;
    let inner = null;
    let content = String(opts.content || "");

    function createCodeMirror() {
      const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
      parent.innerHTML = `<div class="herdr-editor cm">${head}<div class="herdr-editor-mount"></div></div>`;
      const mount = parent.querySelector(".herdr-editor-mount");
      const editor = window.HerdrCodeMirror.create(Object.assign({}, opts, { parent: mount, content }));
      return {
        getValue() { return editor.getValue(); },
        setValue(value) { content = String(value == null ? "" : value); editor.setValue(content); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
    }

    if (window.HerdrCodeMirror && window.HerdrCodeMirror.create) {
      inner = createCodeMirror();
      return editorHandle();
    }
    const readonly = opts.readonly !== false;
    parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
    const textarea = parent.querySelector("textarea");
    if (textarea && opts.onChange) textarea.addEventListener("input", () => {
      content = textarea.value;
      opts.onChange(textarea.value);
    });
    inner = {
      getValue() {
        const node = parent.querySelector("textarea");
        return node ? node.value : content;
      },
      setValue(value) {
        content = String(value == null ? "" : value);
        opts.content = content;
        parent.innerHTML = readonly ? previewHtml(opts) : editHtml(opts);
      },
      destroy() {
        parent.innerHTML = "";
      },
    };
    loadCodeMirror().then((available) => {
      if (!available || destroyed || !parent.isConnected) return;
      content = inner.getValue();
      inner.destroy();
      inner = createCodeMirror();
    });
    return editorHandle();

    function editorHandle() {
      return {
        getValue() { return inner && inner.getValue ? inner.getValue() : content; },
        setValue(value) {
          content = String(value == null ? "" : value);
          if (inner && inner.setValue) inner.setValue(content);
        },
        destroy() {
          destroyed = true;
          if (inner && inner.destroy) inner.destroy();
          parent.innerHTML = "";
        },
      };
    }
  }

  function createMerge(options) {
    const opts = options || {};
    const parent = opts.parent;
    if (!parent) return null;
    let destroyed = false;
    let inner = null;
    let content = String(opts.content || "");

    function createCodeMirrorMerge() {
      if (!window.HerdrCodeMirror || !window.HerdrCodeMirror.createMerge) return null;
      parent.innerHTML = `<div class="herdr-editor cm merge"><div class="herdr-editor-mount"></div></div>`;
      const mount = parent.querySelector(".herdr-editor-mount");
      const editor = window.HerdrCodeMirror.createMerge(Object.assign({}, opts, { parent: mount, content }));
      return {
        getValue() { return editor.getValue(); },
        setValue(value) { content = String(value == null ? "" : value); editor.setValue(content); },
        destroy() { editor.destroy(); parent.innerHTML = ""; },
      };
    }

    if (window.HerdrCodeMirror && window.HerdrCodeMirror.createMerge) {
      inner = createCodeMirrorMerge();
      return editorHandle();
    }
    parent.innerHTML = mergeFallbackHtml(opts);
    const textarea = parent.querySelector("textarea");
    if (textarea && opts.onChange) textarea.addEventListener("input", () => {
      content = textarea.value;
      opts.onChange(textarea.value);
    });
    inner = {
      getValue() {
        const node = parent.querySelector("textarea");
        return node ? node.value : content;
      },
      setValue(value) {
        content = String(value == null ? "" : value);
        opts.content = content;
        parent.innerHTML = mergeFallbackHtml(opts);
      },
      destroy() { parent.innerHTML = ""; },
    };
    loadCodeMirror().then((available) => {
      if (!available || destroyed || !parent.isConnected) return;
      content = inner.getValue();
      inner.destroy();
      inner = createCodeMirrorMerge() || inner;
    });
    return editorHandle();

    function editorHandle() {
      return {
        getValue() { return inner && inner.getValue ? inner.getValue() : content; },
        setValue(value) {
          content = String(value == null ? "" : value);
          if (inner && inner.setValue) inner.setValue(content);
        },
        destroy() {
          destroyed = true;
          if (inner && inner.destroy) inner.destroy();
          parent.innerHTML = "";
        },
      };
    }
  }

  function previewHtml(opts) {
    const content = String(opts.content || "");
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Preview")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor readonly">${head}<pre class="herdr-editor-code"><code>${highlight(content, opts.path)}</code></pre></div>`;
  }

  function editHtml(opts) {
    const head = opts.hideHeader ? "" : `<div class="herdr-editor-head"><strong>${esc(opts.path || "Editor")}</strong><span>${esc(languageFor(opts.path))}</span></div>`;
    return `<div class="herdr-editor">${head}<textarea spellcheck="false">${esc(opts.content || "")}</textarea></div>`;
  }

  function mergeFallbackHtml(opts) {
    const readonly = opts.readonly !== false ? " readonly" : "";
    return `<div class="herdr-editor merge fallback"><section><div class="herdr-editor-head"><strong>Previous</strong><span>${esc(languageFor(opts.path))}</span></div><pre class="herdr-editor-code"><code>${highlight(opts.previous || "", opts.path)}</code></pre></section><section><div class="herdr-editor-head"><strong>Current</strong><span>${esc(languageFor(opts.path))}</span></div><textarea spellcheck="false"${readonly}>${esc(opts.content || "")}</textarea></section></div>`;
  }

  window.HerdrEditor = { create, createMerge, highlight, languageFor };
})();

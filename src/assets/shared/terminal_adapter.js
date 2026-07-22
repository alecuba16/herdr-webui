(function (root) {
  const DEFAULT_GHOSTTY_WASM = "/assets/vendor/ghostty-vt.wasm";
  const COLOR_KEYS = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];

  function raf(callback) {
    const frame = root.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    return frame(callback);
  }

  function afterRender(callback) {
    setTimeout(() => raf(() => raf(callback)), 0);
  }

  function normalizeCore(value) {
    return value === "ghostty" ? "ghostty" : "wterm";
  }

  function terminalCoreLabel(value) {
    return normalizeCore(value) === "ghostty" ? "Ghostty" : "wterm";
  }

  function applyThemeVars(element, theme) {
    if (!element || !theme) return;
    const style = element.style;
    if (theme.foreground) style.setProperty("--term-fg", theme.foreground);
    if (theme.background) style.setProperty("--term-bg", theme.background);
    if (theme.cursor) style.setProperty("--term-cursor", theme.cursor);
    if (theme.selectionBackground)
      style.setProperty("--term-selection", theme.selectionBackground);
    COLOR_KEYS.forEach((key, index) => {
      if (theme[key]) style.setProperty(`--term-color-${index}`, theme[key]);
    });
  }

  function applyFontVar(element, family) {
    if (element && family) element.style.setProperty("--term-font-family", family);
  }

  function selectionInside(element) {
    const selection = root.getSelection && root.getSelection();
    if (!selection || !selection.toString()) return "";
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (
      (anchor && element.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode)) ||
      (focus && element.contains(focus.nodeType === 1 ? focus : focus.parentNode))
    ) return selection.toString();
    return "";
  }

  class HerdrWtermAdapter {
    constructor(container, wterm, options) {
      this.element = container;
      this.wterm = wterm;
      this.cols = options.cols || 80;
      this.rows = options.rows || 24;
      this.core = normalizeCore(options.core);
      this._destroyed = false;
      this._linkClick = null;
      this._wheelScroll = null;
      this.setTheme(options.theme || {});
      this.setFontFamily(options.fontFamily || "monospace");
      this.setLinksEnabled(options.links !== false);
      this.setWheelScrolling(true);
      container.__herdrTerminalAdapter = this;
    }

    static async create(container, options) {
      if (!root.HerdrWtermBundle || !root.HerdrWtermBundle.WTerm)
        throw new Error("wterm bundle is not loaded");
      const opts = options || {};
      const coreName = normalizeCore(opts.core);
      let core;
      if (coreName === "ghostty") {
        if (!root.HerdrWtermBundle.GhosttyCore)
          throw new Error("Ghostty terminal core is not available");
        core = await root.HerdrWtermBundle.GhosttyCore.load({
          wasmPath: opts.ghosttyWasmPath || DEFAULT_GHOSTTY_WASM,
          scrollbackLimit: opts.scrollback || 10000,
        });
      }
      container.innerHTML = "";
      const term = new root.HerdrWtermBundle.WTerm(container, {
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        core,
        autoResize: false,
        cursorBlink: true,
        onData: opts.onData,
      });
      const adapter = new HerdrWtermAdapter(container, term, opts);
      await term.init();
      adapter.setTheme(opts.theme || {});
      adapter.setFontFamily(opts.fontFamily || "monospace");
      return adapter;
    }

    write(data, callback) {
      if (this._destroyed || !this.wterm || data == null) {
        if (callback) callback();
        return;
      }
      this.wterm.write(data);
      if (callback) afterRender(callback);
    }

    resize(cols, rows) {
      if (this._destroyed || !this.wterm) return;
      this.cols = Math.max(1, Math.floor(cols || this.cols || 80));
      this.rows = Math.max(1, Math.floor(rows || this.rows || 24));
      this.wterm.resize(this.cols, this.rows);
    }

    focus() {
      if (!this._destroyed && this.wterm) this.wterm.focus();
    }

    dispose() { this.destroy(); }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.setLinksEnabled(false);
      this.setWheelScrolling(false);
      if (this.wterm && this.wterm.destroy) this.wterm.destroy();
      if (this.element && this.element.__herdrTerminalAdapter === this)
        delete this.element.__herdrTerminalAdapter;
      this.wterm = null;
    }

    clear() {
      if (!this.wterm || !this.wterm.bridge) return;
      try {
        this.wterm.bridge.init(this.cols, this.rows);
        this.wterm.write("");
      } catch (_) {}
    }

    setTheme(theme) {
      this.theme = theme || {};
      applyThemeVars(this.element, this.theme);
    }

    setFontFamily(family) {
      this.fontFamily = family || "monospace";
      applyFontVar(this.element, this.fontFamily);
    }

    setLinksEnabled(enabled) {
      if (this._linkClick) {
        this.element.removeEventListener("click", this._linkClick, true);
        this._linkClick = null;
      }
      if (!enabled) return;
      this._linkClick = (event) => {
        if (event.defaultPrevented) return;
        const range = textRangeFromPoint(event.clientX, event.clientY);
        const node = range && range.node;
        const text = node && node.textContent ? node.textContent : "";
        if (!text) return;
        const url = urlAtOffset(text, range.offset);
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        root.open(url, "_blank", "noopener,noreferrer");
      };
      this.element.addEventListener("click", this._linkClick, true);
    }

    setWheelScrolling(enabled) {
      if (this._wheelScroll) {
        this.element.removeEventListener("wheel", this._wheelScroll, { passive: false });
        this._wheelScroll = null;
      }
      if (!enabled) return;
      this._wheelScroll = (event) => {
        if (this._destroyed || event.defaultPrevented || !this.usesNormalBuffer()) return;
        const deltaY = Number(event.deltaY) || 0;
        if (!deltaY) return;
        const maxScroll = Math.max(0, (this.element.scrollHeight || 0) - (this.element.clientHeight || 0));
        if (maxScroll <= 0) return;
        event.preventDefault();
        event.stopPropagation();
        const lines = wheelLines(this, event, this.rows || 24);
        this.scrollLines(deltaY < 0 ? -lines : lines);
      };
      this.element.addEventListener("wheel", this._wheelScroll, { passive: false });
    }

    rowHeight() {
      const row = this.element.querySelector && this.element.querySelector(".term-row");
      const rect = row && row.getBoundingClientRect && row.getBoundingClientRect();
      if (rect && rect.height > 0) return rect.height;
      const css = root.getComputedStyle ? root.getComputedStyle(this.element) : null;
      const value = css && parseFloat(css.getPropertyValue("--term-row-height") || css.lineHeight || "0");
      return Number.isFinite(value) && value > 0 ? value : 17;
    }

    cellSize() {
      const row = this.element.querySelector && this.element.querySelector(".term-row");
      const span = row && row.querySelector && row.querySelector("span");
      const rect = span && span.getBoundingClientRect && span.getBoundingClientRect();
      const width = rect && rect.width > 0 ? rect.width / Math.max(1, span.textContent.length || 1) : 9;
      return { width, height: this.rowHeight() };
    }

    scrollLines(lines) {
      const count = Math.trunc(Number(lines) || 0);
      if (!count) return;
      this.element.scrollTop += count * this.rowHeight();
    }

    scrollToBottom() {
      this.element.scrollTop = this.element.scrollHeight || 0;
    }

    scrollToLine(line) {
      this.element.scrollTop = Math.max(0, Math.trunc(Number(line) || 0) * this.rowHeight());
    }

    atBottom() {
      return (this.element.scrollHeight || 0) - (this.element.scrollTop || 0) - (this.element.clientHeight || 0) <= 2;
    }

    usesNormalBuffer() {
      try {
        return !(this.wterm && this.wterm.bridge && this.wterm.bridge.usingAltScreen && this.wterm.bridge.usingAltScreen());
      } catch (_) {
        return true;
      }
    }

    getSelection() {
      return selectionInside(this.element);
    }
  }

  function urlAtOffset(text, offset) {
    const re = /https?:\/\/[^\s<>"]+/g;
    let match;
    while ((match = re.exec(text))) {
      const raw = match[0];
      const url = raw.replace(/[),.;]+$/g, "");
      const start = match.index;
      const end = start + url.length;
      if (offset >= start && offset <= end) return url;
    }
    return "";
  }

  function textRangeFromPoint(x, y) {
    const doc = root.document;
    if (!doc) return null;
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset || 0 };
    }
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset || 0 };
    }
    return null;
  }

  function wheelLines(term, event, pageRows) {
    const unit =
      event.deltaMode === 1
        ? 1
        : event.deltaMode === 2
          ? pageRows || 24
          : Math.max(1, term.rowHeight ? term.rowHeight() : 17);
    return Math.max(1, Math.round(Math.abs((Number(event.deltaY) || 0) / unit)));
  }

  root.HerdrTerminalRenderer = {
    create: HerdrWtermAdapter.create,
    normalizeCore,
    terminalCoreLabel,
    applyThemeVars,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalRenderer;
})(typeof globalThis !== "undefined" ? globalThis : window);

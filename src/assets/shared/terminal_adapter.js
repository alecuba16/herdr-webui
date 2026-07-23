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

  const INLINE_IMAGE_STARTS = ["\x1b]1337;File=", "\x1b_G", "\x1bP"];
  const INLINE_IMAGE_ST = "\x1b\\";

  function textDecoder() {
    try {
      const Decoder = root.TextDecoder;
      return Decoder ? new Decoder("utf-8", { fatal: false }) : null;
    } catch (_) {
      return null;
    }
  }

  function decodeTerminalBytes(data) {
    const decoder = textDecoder();
    if (decoder) return decoder.decode(data);
    let text = "";
    for (let i = 0; i < data.length; i += 8192) {
      text += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
    }
    return text;
  }

  function asciiBytes(value) {
    const bytes = [];
    for (let i = 0; i < value.length; i += 1) bytes.push(value.charCodeAt(i) & 0xff);
    return bytes;
  }

  const INLINE_IMAGE_START_BYTES = INLINE_IMAGE_STARTS.map(asciiBytes);

  function bytesContainNeedle(bytes, needle) {
    if (!bytes || bytes.length < needle.length) return false;
    outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function bytesEndWithInlineImagePrefix(bytes) {
    if (!bytes || !bytes.length) return false;
    return INLINE_IMAGE_START_BYTES.some((marker) => {
      const limit = Math.min(marker.length - 1, bytes.length);
      for (let length = limit; length > 0; length -= 1) {
        let matches = true;
        for (let i = 0; i < length; i += 1) {
          if (bytes[bytes.length - length + i] !== marker[i]) {
            matches = false;
            break;
          }
        }
        if (matches) return true;
      }
      return false;
    });
  }

  function dataMayContainInlineImage(data, state) {
    if (state && state.imageEscapeBuffer) return true;
    if (typeof data === "string")
      return INLINE_IMAGE_STARTS.some((start) => data.includes(start)) || pendingInlineImagePrefixLength(data) > 0;
    if (!data || typeof data.length !== "number") return false;
    return INLINE_IMAGE_START_BYTES.some((needle) => bytesContainNeedle(data, needle)) || bytesEndWithInlineImagePrefix(data);
  }

  function endOfOscSequence(text, start) {
    const bel = text.indexOf("\x07", start);
    const st = text.indexOf(INLINE_IMAGE_ST, start);
    if (bel < 0) return st < 0 ? null : { index: st, length: INLINE_IMAGE_ST.length };
    if (st < 0 || bel < st) return { index: bel, length: 1 };
    return { index: st, length: INLINE_IMAGE_ST.length };
  }

  function findNextInlineImageStart(text, from) {
    let best = null;
    for (const marker of INLINE_IMAGE_STARTS) {
      const index = text.indexOf(marker, from);
      if (index >= 0 && (!best || index < best.index)) best = { index, marker };
    }
    return best;
  }

  function pendingInlineImagePrefixLength(text) {
    const maxLength = INLINE_IMAGE_STARTS.reduce((max, marker) => Math.max(max, marker.length), 0);
    const limit = Math.min(maxLength - 1, text.length);
    for (let length = limit; length > 0; length -= 1) {
      const suffix = text.slice(text.length - length);
      if (INLINE_IMAGE_STARTS.some((marker) => marker.startsWith(suffix))) return length;
    }
    return 0;
  }

  function approxBase64Bytes(value) {
    const cleaned = String(value || "").replace(/\s+/g, "");
    if (!cleaned) return 0;
    const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
  }

  function formatByteSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  function terminalImageProtocolSummary(protocol, sequence) {
    let detail = "";
    if (protocol === "iTerm2") {
      const colon = sequence.indexOf(":");
      const payload = colon >= 0 ? sequence.slice(colon + 1).replace(/[\x07\x1b\\]+$/g, "") : "";
      detail = payload ? `, payload ${formatByteSize(approxBase64Bytes(payload))}` : "";
    } else if (protocol === "Kitty") {
      const payload = sequence.slice(3, -2).split(";").pop() || "";
      detail = payload ? `, payload ${formatByteSize(approxBase64Bytes(payload))}` : "";
    } else if (protocol === "SIXEL") {
      detail = `, ${formatByteSize(sequence.length)} escape data`;
    }
    return `\r\n[inline image omitted: ${protocol} graphics${detail}; wterm does not render raster image protocols yet. Use chafa --symbols=braille --colors=full for text previews.]\r\n`;
  }

  function isSixelSequence(sequence) {
    if (!sequence.startsWith("\x1bP") || !sequence.endsWith(INLINE_IMAGE_ST)) return false;
    const headerEnd = sequence.indexOf("q", 2);
    if (headerEnd < 0 || headerEnd > 40) return false;
    return /^[0-9;?]*q$/.test(sequence.slice(2, headerEnd + 1));
  }

  function filterTerminalImageSequences(data, state) {
    const imageState = state || {};
    if (!dataMayContainInlineImage(data, imageState)) return data;
    const text = (imageState.imageEscapeBuffer || "") + (typeof data === "string" ? data : decodeTerminalBytes(data));
    imageState.imageEscapeBuffer = "";
    let output = "";
    let cursor = 0;
    while (cursor < text.length) {
      const next = findNextInlineImageStart(text, cursor);
      if (!next) {
        const hold = pendingInlineImagePrefixLength(text.slice(cursor));
        if (hold > 0) {
          output += text.slice(cursor, text.length - hold);
          imageState.imageEscapeBuffer = text.slice(text.length - hold);
        } else {
          output += text.slice(cursor);
        }
        break;
      }
      output += text.slice(cursor, next.index);
      if (next.marker === "\x1b]1337;File=") {
        const end = endOfOscSequence(text, next.index);
        if (!end) {
          imageState.imageEscapeBuffer = text.slice(next.index);
          break;
        }
        const stop = end.index + end.length;
        output += terminalImageProtocolSummary("iTerm2", text.slice(next.index, stop));
        cursor = stop;
        continue;
      }
      if (next.marker === "\x1b_G") {
        const end = text.indexOf(INLINE_IMAGE_ST, next.index);
        if (end < 0) {
          imageState.imageEscapeBuffer = text.slice(next.index);
          break;
        }
        const stop = end + INLINE_IMAGE_ST.length;
        output += terminalImageProtocolSummary("Kitty", text.slice(next.index, stop));
        cursor = stop;
        continue;
      }
      const end = text.indexOf(INLINE_IMAGE_ST, next.index);
      if (end < 0) {
        imageState.imageEscapeBuffer = text.slice(next.index);
        break;
      }
      const stop = end + INLINE_IMAGE_ST.length;
      const sequence = text.slice(next.index, stop);
      output += isSixelSequence(sequence) ? terminalImageProtocolSummary("SIXEL", sequence) : sequence;
      cursor = stop;
    }
    return output;
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
      this._imageFallbackState = { imageEscapeBuffer: "" };
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
      this.wterm.write(filterTerminalImageSequences(data, this._imageFallbackState));
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
    const delta = Math.abs(Number(event.deltaY) || 0);
    if (event.deltaMode === 1) return Math.max(1, Math.round(delta));
    if (event.deltaMode === 2)
      return Math.max(1, Math.round(delta * (pageRows || 24)));
    const rowHeight = Math.max(1, term.rowHeight ? term.rowHeight() : 17);
    return Math.max(1, Math.round(delta / rowHeight));
  }

  /**
   * Attaches a pointerdown listener that calls `focus()` only when the mouse
   * stays within a 3px radius (a click, not a text-selection drag).  This
   * prevents textarea.focus() from collapsing native DOM text selection.
   *
   * @param {HTMLElement} element - Element to listen on.
   * @param {function} focus - Called when the gesture is a click, not a drag.
   * @param {function} [shouldIgnore] - Return true to skip focus for this event.
   */
  function attachClickFocus(element, focus, shouldIgnore) {
    element.addEventListener("pointerdown", function (event) {
      if (shouldIgnore && shouldIgnore(event)) return;
      if (event.button !== 0 || event.shiftKey) return;
      var startX = event.clientX, startY = event.clientY;
      var dragged = false;
      var onMove = function (ev) {
        if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)
          dragged = true;
      };
      var onUp = function () {
        root.document.removeEventListener("mousemove", onMove);
        root.document.removeEventListener("mouseup", onUp);
        if (!dragged) focus();
      };
      root.document.addEventListener("mousemove", onMove);
      root.document.addEventListener("mouseup", onUp);
    });
  }

  root.HerdrTerminalRenderer = {
    create: HerdrWtermAdapter.create,
    normalizeCore,
    terminalCoreLabel,
    applyThemeVars,
    filterTerminalImageSequences,
    terminalImageProtocolSummary,
    attachClickFocus,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalRenderer;
})(typeof globalThis !== "undefined" ? globalThis : window);

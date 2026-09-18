// External-backend graphics bridge: renders the herdr ClientShell graphics
// scene (Kitty images) on a canvas overlay above the attach terminal.
//
// The attach connection feeds wterm the pane text; this bridge opens a
// parallel ClientShell-mode connection pinned to the same tab and receives
// PaneSurface graphics scenes. Placements arrive in surface-relative cell
// coordinates; the pane's inner_rect from the same frame translates them
// into the pane-local grid wterm displays.
(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : window;

  function assetKeyString(key) {
    if (!key) return "";
    // serde externally-tagged enums: `Terminal`/`PaneLayer` variants arrive
    // as {Terminal:{...}} / {PaneLayer:{...}} with the target nested as
    // {Pane:{pane_id}} / {Popup:{terminal_id}}.
    const source = key.source || {};
    const terminal = source.Terminal || {};
    const paneLayer = source.PaneLayer || {};
    const target = terminal.target || {};
    return [
      terminal ? "Terminal" : paneLayer ? "PaneLayer" : "",
      target.Pane ? "Pane" : target.Popup ? "Popup" : "",
      (target.Pane && target.Pane.pane_id) ||
        (target.Popup && target.Popup.terminal_id) ||
        "",
      String(terminal.image_id || ""),
      paneLayer.pane_id || "",
      paneLayer.layer_id || "",
      key.image_width,
      key.image_height,
      key.format,
      key.data_len,
      key.data_fingerprint,
    ].join("|");
  }

  function base64ToBytes(text) {
    const clean = String(text || "").replace(/[^A-Za-z0-9+/]/g, "");
    const withPadding = clean + "=".repeat((4 - (clean.length % 4)) % 4);
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  class GraphicsBridge {
    constructor(options) {
      this.options = options || {};
      this.terminal = options.terminal;
      this.ws = null;
      this.connecting = false;
      this.connectedKey = "";
      this.assets = new Map(); // key string -> ImageBitmap
      this.pendingAssets = new Map(); // key string -> {data, width, height, format}
      this.pendingDecodeKeys = new Set(); // keys with a decode promise in flight
      this.latestScene = null;
      this.canvas = null;
      this.ctx = null;
      this.raf = null;
      this.enabled = false;
      this.reconnectTimer = null;
      this.reconnectDelay = 500;
      this.scrollBound = false;
      this._onHostScroll = null;
    }

    setTerminal(terminal) {
      if (this.terminal === terminal) return;
      // Detach listeners from the OLD element before switching: the
      // teardown below reads this.terminal to unbind.
      this.detachHostListeners();
      this.terminal = terminal;
      this.teardownCanvas();
    }

    // Removes the scroll listener from whichever element currently owns
    // it, independent of the canvas teardown order.
    detachHostListeners() {
      if (this.scrollBound && this.terminal && this.terminal.element && this._onHostScroll) {
        this.terminal.element.removeEventListener("scroll", this._onHostScroll);
      }
      this.scrollBound = false;
      this._onHostScroll = null;
    }

    cellMetrics() {
      if (!this.terminal) return { width: 9, height: 17 };
      try {
        const size = this.terminal.cellSize
          ? this.terminal.cellSize()
          : { width: 9, height: 17 };
        return {
          width: Math.max(1, Math.round(size.width)),
          height: Math.max(1, Math.round(size.height)),
        };
      } catch (_) {
        return { width: 9, height: 17 };
      }
    }

    gridMetrics() {
      let cols = 100;
      let rows = 30;
      try {
        if (this.terminal && this.terminal.cols) cols = this.terminal.cols;
        if (this.terminal && this.terminal.rows) rows = this.terminal.rows;
      } catch (_) {}
      return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
    }

    // Connects (or reconnects) the bridge for the given target. The target
    // key includes session, workspace, tab, and pane id: any navigation
    // drops the bridge so a fresh one opens for the new tab.
    connect(state) {
      if (!state || !state.tab || !state.terminalId) return this.disconnect();
      if (isBuiltinMode(state)) return this.disconnect();
      const key = [
        state.session || "default",
        state.ws || "",
        state.tab || "",
        state.pane || "",
        state.terminalId || "",
      ].join("|");
      if (this.connectedKey === key && this.ws && this.ws.readyState <= 1) return;
      this.disconnect();
      this.connectedKey = key;
      this.paneId = state.pane || "";
      this.enabled = true;
      this.open(key, state);
    }

    open(key, state) {
      const urlBuilder =
        this.wsUrlBuilder ||
        (typeof root.wsUrl === "function" ? root.wsUrl : null) ||
        (typeof globalThis.wsUrl === "function" ? globalThis.wsUrl : null) ||
        null;
      if (!urlBuilder) return;
      const cell = this.cellMetrics();
      const grid = this.gridMetrics();
      const path =
        "/ws/terminal-graphics?tab_id=" +
        encodeURIComponent(state.tab) +
        "&cols=" +
        grid.cols +
        "&rows=" +
        grid.rows +
        "&cell_width_px=" +
        cell.width +
        "&cell_height_px=" +
        cell.height;
      let ws;
      try {
        ws = new WebSocket(urlBuilder(path));
      } catch (_) {
        this.scheduleReconnect(key, state);
        return;
      }
      this.ws = ws;
      this.connecting = true;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.connecting = false;
        this.reconnectDelay = 500;
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws || typeof event.data !== "string") return;
        this.handleMessage(event.data);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.connecting = false;
        this.scheduleReconnect(key, state);
      };
      ws.onerror = () => {};
    }

    scheduleReconnect(key, state) {
      if (this.connectedKey !== key) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.connectedKey === key) this.open(key, state);
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(8000, this.reconnectDelay * 2);
    }

    disconnect() {
      this.connectedKey = "";
      this.enabled = false;
      // A full disconnect (tab close, backend switch, builtin mode) ends
      // this connection's delivery cache: the server re-sends any bytes a
      // future connection needs, so all cached bitmaps can be freed now.
      this.clearAssets();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        try {
          ws.onclose = null;
          ws.close();
        } catch (_) {}
      }
      this.teardownCanvas();
    }

    teardownCanvas() {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      this.detachHostListeners();
      this.canvas = null;
      this.ctx = null;
      this.latestScene = null;
    }

    // Frees every decoded bitmap and invalidates in-flight decodes; safe to
    // call on tab switches (the server re-delivers bytes a new connection
    // needs).
    clearAssets() {
      for (const bitmap of this.assets.values()) {
        if (bitmap && typeof bitmap.close === "function") {
          try {
            bitmap.close();
          } catch (_) {}
        }
      }
      this.assets.clear();
      this.pendingAssets.clear();
      this.pendingDecodeKeys.clear();
    }

    handleMessage(text) {
      let message;
      try {
        message = JSON.parse(text);
      } catch (_) {
        return;
      }
      if (!message || typeof message !== "object") return;
      if (message.type === "graphics_bridge_error") {
        this.disconnect();
        return;
      }
      if (message.type !== "graphics_scene") return;
      this.ingestScene(message);
    }

    ingestScene(scene) {
      // Track which asset keys stay live (explicitly retained or still
      // placed). Anything else can be evicted: the server only re-sends
      // bytes it has not already delivered on this connection. Evicted
      // bitmaps are closed so their GPU memory is released.
      const liveKeys = new Set();
      (scene.retained_assets || []).forEach((key) =>
        liveKeys.add(assetKeyString(key)),
      );
      (scene.placements || []).forEach((placement) =>
        liveKeys.add(assetKeyString(placement.asset)),
      );
      for (const [key, bitmap] of this.assets) {
        if (!liveKeys.has(key)) {
          this.assets.delete(key);
          if (bitmap && typeof bitmap.close === "function") {
            try {
              bitmap.close();
            } catch (_) {}
          }
        }
      }

      let decoding = false;
      (scene.assets || []).forEach((asset) => {
        const key = assetKeyString(asset.key);
        if (!key || this.assets.has(key) || this.pendingAssets.has(key)) return;
        const meta = asset.key || {};
        this.pendingAssets.set(key, {
          data: base64ToBytes(asset.data),
          width: meta.image_width || 1,
          height: meta.image_height || 1,
          format: meta.format,
        });
        decoding = true;
      });
      this.latestScene = scene;
      if (decoding) this.decodePendingAssets();
      this.scheduleRedraw();
    }

    decodePendingAssets() {
      const entries = Array.from(this.pendingAssets.entries());
      if (!entries.length) return;
      this.pendingAssets.clear();
      if (!this.pendingDecodeKeys) this.pendingDecodeKeys = new Set();
      entries.forEach(([key, meta]) => {
        let blob;
        try {
          if (meta.format === "Png") {
            blob = new Blob([meta.data], { type: "image/png" });
          } else {
            // Raw RGB/RGBA rows: wrap into an ImageData for createImageBitmap.
            blob = rawToImageData(meta);
          }
        } catch (_) {
          this.pendingDecodeKeys.delete(key);
          return;
        }
        if (!blob) {
          this.pendingDecodeKeys.delete(key);
          return;
        }
        this.pendingDecodeKeys.add(key);
        Promise.resolve(
          root.createImageBitmap ? createImageBitmap(blob) : Promise.reject(),
        )
          .then((bitmap) => {
            // A disconnect (or asset flush) while this decode was in flight
            // invalidated the key: close the orphan instead of caching it.
            if (!this.enabled || !this.pendingDecodeKeys || !this.pendingDecodeKeys.has(key)) {
              if (bitmap && typeof bitmap.close === "function") {
                try { bitmap.close(); } catch (_) {}
              }
              return;
            }
            this.pendingDecodeKeys.delete(key);
            this.assets.set(key, bitmap);
            this.scheduleRedraw();
          })
          .catch(() => {
            if (this.pendingDecodeKeys) this.pendingDecodeKeys.delete(key);
          });
      });
    }

    scheduleRedraw() {
      if (!this.latestScene || this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.redraw();
      });
    }

    ensureCanvas() {
      if (!this.terminal || !this.terminal.element) return null;
      const host = this.terminal.element;
      if (this.canvas && this.canvas.parentNode === host) return this.canvas;
      if (this.canvas) this.teardownCanvas();
      const canvas = document.createElement("canvas");
      canvas.className = "term-graphics-overlay";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "2";
      // Insert as the first child so text stays visually below the overlay
      // but selection/copy still hits the text layer.
      host.insertBefore(canvas, host.firstChild);
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      if (!this.scrollBound) {
        // The wterm host element is the scroll container; keep the
        // overlay glued to the live viewport while scrollback scrolls.
        this._onHostScroll = () => this.scheduleRedraw();
        host.addEventListener("scroll", this._onHostScroll, { passive: true });
        this.scrollBound = true;
      }
      return canvas;
    }

    // Geometry of the live viewport inside the wterm container: the
    // `.term-grid` box (which sits inside the container's padding) plus
    // the scroll state, so placements can be drawn in viewport
    // coordinates even while scrollback is scrolled.
    viewportGeometry() {
      const host = this.terminal.element;
      const grid = host.querySelector && host.querySelector(".term-grid");
      if (!grid) return null;
      const hostRect = host.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      return {
        hostRect,
        gridLeft: gridRect.left - hostRect.left,
        gridTop: gridRect.top - hostRect.top,
        gridWidth: gridRect.width,
        gridHeight: gridRect.height,
        scrollTop: host.scrollTop || 0,
        clientHeight: host.clientHeight || 0,
      };
    }

    redraw() {
      const scene = this.latestScene;
      if (!scene || !this.enabled) return;
      if (!this.terminal || !this.terminal.element) return;
      const canvas = this.ensureCanvas();
      if (!canvas || !this.ctx) return;
      const geo = this.viewportGeometry();
      if (!geo) return;
      const cell = this.cellMetrics();
      const dpr = root.devicePixelRatio || 1;
      const cssWidth = geo.hostRect.width || cell.width * (scene.cols || 1);
      const cssHeight = geo.hostRect.height || cell.height * (scene.rows || 1);
      if (
        canvas.width !== Math.round(cssWidth * dpr) ||
        canvas.height !== Math.round(cssHeight * dpr)
      ) {
        canvas.width = Math.max(1, Math.round(cssWidth * dpr));
        canvas.height = Math.max(1, Math.round(cssHeight * dpr));
        canvas.style.width = "100%";
        canvas.style.height = "100%";
      }
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);

      // The attach connection shows ONE pane (this.paneId); the shell
      // surface covers the whole tab. Draw only that pane's placements,
      // translated by its inner_rect (placements are inner-rect-relative:
      // x = area.x + viewport_col where area = info.inner_rect).
      const panes = scene.panes || [];
      const placements = scene.placements || [];
      let targetPane = null;
      if (this.paneId) {
        targetPane = panes.find((pane) => pane.pane_id === this.paneId) || null;
      }
      if (!targetPane) {
        // No pane id (or the pane vanished): fall back to the focused
        // pane from the scene rather than drawing neighbor panes at
        // wrong coordinates.
        targetPane = panes.find((pane) => pane.focused) || panes[0] || null;
      }
      if (!targetPane) return;

      // Live-viewport origin: the grid's visible top in viewport
      // coordinates. When scrollback exists, wterm keeps the live area
      // at the bottom of the grid content, so the live top is
      // gridHeight - rows*rowHeight - scrollTop (all CSS px).
      const liveRows = Math.max(1, this.terminal.rows || scene.rows || 1);
      const liveTop =
        geo.gridTop + geo.gridHeight - liveRows * cell.height - geo.scrollTop;
      const liveLeft = geo.gridLeft;

      // Sort by z for stable stacking (lower z first).
      const ordered = placements
        .slice()
        .sort((a, b) => (a.z || 0) - (b.z || 0));
      ordered.forEach((placement) => {
        const key = assetKeyString(placement.asset);
        const bitmap = this.assets.get(key);
        if (!bitmap) return;
        if (!placementTargetsPane(placement, targetPane, panes)) return;
        // Pane-surface coords -> pane-local coords.
        const localX = placement.x - targetPane.inner_x;
        const localY = placement.y - targetPane.inner_y;
        // Fully outside this pane's viewport: nothing to draw.
        if (
          localX + placement.cols <= 0 ||
          localY + placement.rows <= 0 ||
          localX >= targetPane.inner_width ||
          localY >= targetPane.inner_height
        ) {
          return;
        }
        const xPx = liveLeft + localX * cell.width + (placement.x_offset || 0);
        const yPx = liveTop + localY * cell.height + (placement.y_offset || 0);
        const wPx = placement.cols * cell.width;
        const hPx = placement.rows * cell.height;
        ctx.drawImage(
          bitmap,
          placement.source_x || 0,
          placement.source_y || 0,
          placement.source_width || bitmap.width,
          placement.source_height || bitmap.height,
          xPx,
          yPx,
          wPx,
          hPx,
        );
      });
    }

    resize(grid) {
      if (!this.ws || this.ws.readyState !== 1) return;
      const cell = this.cellMetrics();
      try {
        this.ws.send(
          JSON.stringify({
            type: "resize",
            cols: grid.cols,
            rows: grid.rows,
            cell_width_px: cell.width,
            cell_height_px: cell.height,
          }),
        );
      } catch (_) {}
    }

    focus(focused) {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ type: "focus", focused: !!focused }));
      } catch (_) {}
    }
  }

  // True when the current session runs the builtin backend, which has no
  // ClientShell protocol to bridge.
  function isBuiltinMode(state) {
    if (!state) return true;
    const backend = state.sessionBackend || state.backendMode || "builtin";
    return backend === "builtin";
  }

  // True when the placement belongs to the given pane. Terminal sources
  // carry the pane target; PaneLayer sources carry the pane_id directly.
  // Containment inside the pane's inner rect is the last-resort fallback.
  function placementTargetsPane(placement, pane, panes) {
    const source = (placement.asset && placement.asset.source) || null;
    if (source && source.Terminal && source.Terminal.target) {
      const target = source.Terminal.target;
      const id =
        (target.Pane && target.Pane.pane_id) ||
        (target.Popup && target.Popup.terminal_id);
      return id ? pane.pane_id === id : false;
    }
    if (source && source.PaneLayer && source.PaneLayer.pane_id) {
      return pane.pane_id === source.PaneLayer.pane_id;
    }
    return (
      placement.x >= pane.inner_x &&
      placement.x < pane.inner_x + pane.inner_width &&
      placement.y >= pane.inner_y &&
      placement.y < pane.inner_y + pane.inner_height
    );
  }

  function rawToImageData(meta) {
    const bytes = meta.data;
    const width = meta.width || 1;
    const height = meta.height || 1;
    if (meta.format === "Rgb") {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
        rgba[i * 4] = bytes[j];
        rgba[i * 4 + 1] = bytes[j + 1];
        rgba[i * 4 + 2] = bytes[j + 2];
        rgba[i * 4 + 3] = 255;
      }
      return new ImageData(rgba, width, height);
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height * 4; i += 1) rgba[i] = bytes[i];
    return new ImageData(rgba, width, height);
  }

  let bridge = null;

  function sharedBridge() {
    if (!bridge) bridge = new GraphicsBridge({});
    return bridge;
  }

  // Public API used by desktop and mobile terminal controllers.
  root.HerdrGraphicsBridge = {
    // (Re)connect the bridge for the current app state. `opts.wsUrl`
    // builds absolute WS URLs from paths (each app has its own scoped
    // wsUrl with session/backend query params); `opts.terminal` is the
    // adapter instance.
    connect(state, terminalOrOpts) {
      const b = sharedBridge();
      const opts = terminalOrOpts || {};
      if (typeof opts === "object" && opts !== null && typeof opts.wsUrl === "function") {
        b.wsUrlBuilder = opts.wsUrl;
      }
      const terminal =
        opts && typeof opts === "object" && typeof opts.wsUrl === "function"
          ? opts.terminal || null
          : terminalOrOpts;
      if (terminal) b.setTerminal(terminal);
      b.connect(state);
    },
    // Drop the bridge (tab closed, backend switch, builtin mode).
    disconnect() {
      if (bridge) bridge.disconnect();
    },
    // Forward grid resizes so the shell surface stays in sync.
    resize(grid) {
      if (bridge) bridge.resize(grid);
    },
    // Forward outer-terminal focus so herdr can route focus events.
    focus(focused) {
      if (bridge) bridge.focus(focused);
    },
  };
})();
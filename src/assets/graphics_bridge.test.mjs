import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Loads graphics_bridge.js into a sandbox and returns the shared API plus
// the sandbox context. The bridge is an IIFE that publishes
// `HerdrGraphicsBridge` on the global object.
function loadBridge() {
  const source = readFileSync(
    new URL("./shared/graphics_bridge.js", import.meta.url),
    "utf8",
  );
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Blob,
    requestAnimationFrame: (fn) => {
      sandbox.__raf = fn;
      return 1;
    },
    cancelAnimationFrame: () => {},
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        sandbox.sockets.push(this);
      }
      close() {
        this.readyState = 3;
      }
      send(data) {
        this.sent.push(data);
      }
    },
    createImageBitmap: undefined,
    ImageData: class ImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
    devicePixelRatio: 1,
    atob: (text) => Buffer.from(text, "base64").toString("binary"),
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    document: undefined,
    sockets: [],
    __raf: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "graphics_bridge.js" });
  return { bridge: sandbox.HerdrGraphicsBridge, sandbox };
}

const TERMINAL_KEY = {
  source: {
    Terminal: {
      target: { Pane: { pane_id: "ws-1:p1" } },
      image_id: 42,
    },
  },
  image_width: 4,
  image_height: 2,
  format: "Rgba",
  data_len: 32,
  data_fingerprint: 99,
};

const LAYER_KEY = {
  source: { PaneLayer: { pane_id: "ws-1:p2", layer_id: "chat" } },
  image_width: 8,
  image_height: 4,
  format: "Png",
  data_len: 64,
  data_fingerprint: 7,
};

describe("graphics bridge", () => {
  it("connects to the graphics WS with tab id and metrics", () => {
    const { bridge, sandbox } = loadBridge();
    const state = {
      session: "default",
      ws: "ws-1",
      tab: "ws-1:t1",
      pane: "ws-1:p1",
      terminalId: "term-9",
      sessionBackend: "external-herdr",
    };
    const terminal = {
      element: null,
      cols: 100,
      rows: 30,
      cellSize: () => ({ width: 9, height: 17 }),
    };
    bridge.connect(state, {
      terminal,
      wsUrl: (path) => "ws://test" + path,
    });
    equal(sandbox.sockets.length, 1);
    const url = sandbox.sockets[0].url;
    ok(url.includes("/ws/terminal-graphics?tab_id=ws-1%3At1"), "tab id in URL");
    ok(url.includes("cols=100"), "cols in URL");
    ok(url.includes("rows=30"), "rows in URL");
    ok(url.includes("cell_width_px=9"), "cell width in URL");
    ok(url.includes("cell_height_px=17"), "cell height in URL");
    bridge.disconnect();
  });

  it("stays disconnected for builtin sessions", () => {
    const { bridge, sandbox } = loadBridge();
    const state = {
      session: "default",
      ws: "ws-1",
      tab: "ws-1:t1",
      pane: "ws-1:p1",
      terminalId: "term-9",
      sessionBackend: "builtin",
    };
    bridge.connect(state, { wsUrl: (p) => "ws://test" + p });
    equal(sandbox.sockets.length, 0);
  });

  it("reconnects when the tab changes but not on repeat connects", () => {
    const { bridge, sandbox } = loadBridge();
    const terminal = {
      element: null,
      cols: 80,
      rows: 24,
      cellSize: () => ({ width: 9, height: 17 }),
    };
    const opts = { terminal, wsUrl: (p) => "ws://test" + p };
    const base = {
      session: "default",
      ws: "ws-1",
      pane: "ws-1:p1",
      terminalId: "term-9",
      sessionBackend: "external-herdr",
    };
    bridge.connect({ ...base, tab: "ws-1:t1" }, opts);
    bridge.connect({ ...base, tab: "ws-1:t1" }, opts);
    equal(sandbox.sockets.length, 1, "same target does not reopen");
    bridge.connect({ ...base, tab: "ws-1:t2" }, opts);
    equal(sandbox.sockets.length, 2, "new tab reopens");
    bridge.disconnect();
  });

  it("ingests scenes, decodes assets, and evicts dropped keys", async () => {
    const { bridge, sandbox } = loadBridge();
    const decoded = [];
    sandbox.createImageBitmap = async (blob) => {
      decoded.push(blob);
      return { width: 4, height: 2 };
    };
    const fakeCtx = {
      setTransform() {},
      clearRect() {},
      scale() {},
      drawImage() {},
    };
    sandbox.document = {
      createElement: () => ({
        style: {},
        setAttribute() {},
        classList: { add() {} },
        getContext: () => fakeCtx,
      }),
    };
    const state = {
      session: "default",
      ws: "ws-1",
      tab: "ws-1:t1",
      pane: "ws-1:p1",
      terminalId: "term-9",
      sessionBackend: "external-herdr",
    };
    const element = {
      style: {},
      firstChild: null,
      insertBefore() {},
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 408 }),
      }),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 408 }),
      clientWidth: 720,
      clientHeight: 408,
      scrollTop: 0,
      addEventListener() {},
      removeEventListener() {},
    };
    const terminal = {
      element,
      cols: 80,
      rows: 24,
      cellSize: () => ({ width: 9, height: 17 }),
    };
    bridge.connect(state, { terminal, wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    const pngBase64 = Buffer.from([1, 2, 3]).toString("base64");

    // Scene 1: one PNG asset, retained.
    ws.onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: TERMINAL_KEY, data: pngBase64 }],
        placements: [],
        retained_assets: [TERMINAL_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(decoded.length, 1, "PNG asset decoded");

    // Scene 2: same key retained, no new data delivered.
    ws.onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 2,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [],
        placements: [],
        retained_assets: [TERMINAL_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(decoded.length, 1, "retained asset not re-delivered");

    // Scene 3: key dropped from retained -> evicted; re-delivered bytes
    // decode again.
    ws.onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 3,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: TERMINAL_KEY, data: pngBase64 }],
        placements: [],
        retained_assets: [LAYER_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(decoded.length, 2, "evicted asset re-decoded on re-delivery");
    bridge.disconnect();
  });
});
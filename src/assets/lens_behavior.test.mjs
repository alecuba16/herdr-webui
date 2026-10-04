// Unit tests for the chat lens module (src/assets/desktop/app_js/lens.js).
// The module runs in the DESKTOP_JS bundle scope where `term` and
// `escapeHtml` exist; the vm context mirrors that.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const LENS_SOURCE = readFileSync(
  new URL("./desktop/app_js/lens.js", import.meta.url),
  "utf8",
);
const SHARED_CORE_SOURCE = readFileSync(
  new URL("./shared/core.js", import.meta.url),
  "utf8",
);

function element(id, registry) {
  const node = {
    id,
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    textContent: "",
    _innerHTML: "",
    // Parse the lens overlay's innerHTML when assigned (like the real
    // DOM): the interactive children (scroller/content/alt hint/pill) must
    // keep identity across querySelector calls.
    _parsed: new Map(),
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(html) {
      this._innerHTML = html;
      this._parsed = new Map();
      if (/id="terminalLensScroller"/.test(html)) {
        const scroller = element("terminalLensScroller");
        scroller.scrollTop = 0;
        scroller.scrollHeight = 100;
        scroller.clientHeight = 100;
        this._parsed.set(".terminal-lens-scroller", scroller);
        this._parsed.set("#terminalLensScroller", scroller);
        const content = element("terminalLensContent");
        this._parsed.set(".terminal-lens-content", content);
        scroller.children.push(content);
      }
      if (/id="terminalLensAlt"/.test(html)) {
        const alt = element("terminalLensAlt");
        alt.hidden = true; // it ships hidden in the markup
        this._parsed.set("#terminalLensAlt", alt);
      }
      if (/id="terminalLensNew"/.test(html)) {
        const pill = element("terminalLensNew");
        pill.hidden = true;
        this._parsed.set("#terminalLensNew", pill);
      }
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector(sel) {
      return this._parsed.get(sel) || null;
    },
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    classList: {
      _set: new Set(),
      toggle(name, value) {
        if (value === undefined) value = !this._set.has(name);
        if (value) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    focus() {},
  };
  // The lens assigns node.id AFTER createElement (overlay(), switch): a
  // setter keeps the context's id -> node registry in sync so later
  // getElementById calls find the real element, not a fresh blank one.
  let currentId = id;
  Object.defineProperty(node, "id", {
    get: () => currentId,
    set(value) {
      currentId = value;
      if (registry && value) registry(value, node);
    },
    configurable: true,
  });
  return node;
}

function makeBridge(overrides = {}) {
  return {
    getCols: () => 20,
    getRows: () => 2,
    getScrollbackCount: () => 0,
    getScrollbackLineLen: () => 0,
    getScrollbackCell: () => null,
    getCell: (row, col) => ({ chars: " ", width: 1, spacerHead: false }),
    usingAltScreen: () => false,
    ...overrides,
  };
}

function context(overrides = {}) {
  const elements = new Map();
  // The lens mounts inside the terminal shell: pre-register it so
  // overlay() can build the real node tree.
  elements.set("terminalShell", element("terminalShell"));
  const getElement = (id) => elements.get(id) || null;
  const register = (id, node) => elements.set(id, node);
  const ctx = {
    console,
    setTimeout(fn) {
      if (typeof fn === "function") fn();
      return 1;
    },
    clearTimeout() {},
    requestAnimationFrame(fn) {
      if (typeof fn === "function") fn();
      return 1;
    },
    document: {
      getElementById: getElement,
      createElement: () => element("", register),
      addEventListener() {},
    },
    // The lens reads `term` from the bundle scope; tests inject it through
    // globalThis before loading the module.
    term: null,
    escapeHtml: (value) =>
      String(value).replace(/[&<>"']/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    ...overrides,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SHARED_CORE_SOURCE, contextObject);
  // Redefine term/escapeHtml for the module's closure lookups after core.js
  // ran (core.js declares its own term).
  vm.runInContext("var term = globalThis.__term;", contextObject);
  const injected = vm.createContext(ctx);
  return { ctx: injected, contextObject };
}

function loadLens(ctx, bridge) {
  ctx.__term = bridge ? { wterm: { bridge } } : null;
  vm.runInContext("term = globalThis.__term;", ctx);
  vm.runInContext(LENS_SOURCE, ctx);
}

describe("chat lens module", () => {
  beforeEach(() => {});

  it("module defines the HerdrLens API", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    ok(ctx.HerdrLens, "globalThis.HerdrLens must exist");
    for (const name of [
      "insertLensSwitch", "toggle", "setLens", "render", "readTranscript",
      "isActive", "lensState", "onTerminalFrame", "transcriptHtml",
    ]) {
      equal(typeof ctx.HerdrLens[name], "function", `${name} must be a function`);
    }
  });

  it("reads the transcript from the live bridge (scrollback + grid)", () => {
    const lines = ["❯ echo hi", "hi", "done"];
    const bridge = makeBridge({
      getScrollbackCount: () => 1,
      getRows: () => 2,
      getScrollbackLineLen: (row) => (row === 0 ? 9 : 0),
      getScrollbackCell: (row, col) => ({ chars: lines[0][col], width: 1, spacerHead: false }),
      getCell: (row, col) => ({
        chars: lines[1 + row][col] || " ",
        width: 1,
        spacerHead: false,
      }),
    });
    const { ctx } = context();
    loadLens(ctx, bridge);
    const transcript = ctx.HerdrLens.readTranscript();
    equal(JSON.stringify(transcript), JSON.stringify(["❯ echo hi", "hi", "done"]));
  });

  it("returns empty transcript without a bridge or on alt screen", () => {
    const { ctx } = context();
    loadLens(ctx, null);
    equal(ctx.HerdrLens.readTranscript().length, 0);
    const altBridge = makeBridge({ usingAltScreen: () => true });
    loadLens(altBridge ? ctx : ctx, altBridge);
    // reloading overwrites the module; readTranscript must now return []
    equal(ctx.HerdrLens.readTranscript().length, 0);
  });

  it("bounds the read to the last 400 lines", () => {
    const total = 500;
    let reads = 0;
    const bridge = makeBridge({
      getCols: () => 4,
      getScrollbackCount: () => total - 5,
      getRows: () => 5,
      getScrollbackLineLen: () => 4,
      getScrollbackCell: () => {
        reads++;
        return { chars: "aaaa", width: 4, spacerHead: false };
      },
      getCell: () => {
        reads++;
        return { chars: "bbbb", width: 4, spacerHead: false };
      },
    });
    const { ctx } = context();
    loadLens(ctx, bridge);
    const transcript = ctx.HerdrLens.readTranscript();
    equal(transcript.length, 400, "transcript must cap at 400 lines");
    equal(reads, 400 * 4, "cell reads must match the bounded window");
  });

  it("shapes user turns as right cards and output as plain lines", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    const html = ctx.HerdrLens.transcriptHtml([
      "❯ run the deploy",
      "deploying...",
      "",
      "❯ second command",
      "wrapped tail",
    ]);
    match(html, /lens-turn lens-turn-user/);
    match(html, />❯ run the deploy</);
    match(html, />deploying\.\.\.</);
    match(html, />wrapped tail</);
    // Output after a prompt stays output: never swallowed into the card.
    ok(!/>[^<]*deploying[^<]*run the deploy</.test(html));
    match(html, /lens-gap/);
  });

  it("escapes transcript content", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    const html = ctx.HerdrLens.transcriptHtml(["<script>alert(1)</script>"]);
    ok(!html.includes("<script>"), "raw html must not survive");
    match(html, /&lt;script&gt;/);
  });

  it("prompt heuristics match shell prompt markers", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    // A prompt marker anywhere in the line matches: real prompts carry a
    // cwd prefix (`~/repo ❯ cmd`) and the user card shows the full line.
    const re = ctx.HerdrLens.PROMPT_LINE;
    ok(re.test("❯ cmd"));
    ok(re.test("  › cmd"));
    ok(re.test("$ cmd"));
    ok(re.test("➜ cmd"));
    ok(re.test("~/some/repo ❯ git status"));
    ok(re.test("~/repo $ ls -la"));
    ok(!re.test("output line"));
    ok(!re.test("price: $5"));
    ok(!re.test("no marker here"));
  });

  it("drops trailing blank grid padding from the transcript", () => {
    const lines = ["real output", "", "", ""];
    const grid = lines.map((l) => ({ chars: l, width: 1, spacerHead: false }));
    const bridge = makeBridge({
      getRows: () => 4,
      getCols: () => lines[0].length,
      getScrollbackCount: () => 0,
      getCell: (row, col) => ({
        chars: (lines[row][col] || " "),
        width: 1,
        spacerHead: false,
      }),
    });
    const { ctx } = context();
    loadLens(ctx, bridge);
    const transcript = ctx.HerdrLens.readTranscript();
    equal(JSON.stringify(transcript), JSON.stringify(["real output"]));
  });

  it("lens state toggles and stays consistent", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    equal(ctx.HerdrLens.isActive(), false);
    equal(JSON.stringify(ctx.HerdrLens.lensState()), JSON.stringify({ active: false, follow: true, unread: false }));
    ctx.HerdrLens.setLens(true);
    equal(ctx.HerdrLens.isActive(), true);
    equal(JSON.stringify(ctx.HerdrLens.lensState()), JSON.stringify({ active: true, follow: true, unread: false }));
    ctx.HerdrLens.toggle();
    equal(ctx.HerdrLens.isActive(), false);
  });

  it("onPaneChanged resets reading state and re-renders", () => {
    const lines = ["one", "two"];
    const bridge = makeBridge({
      getCols: () => 5,
      getRows: () => 2,
      getScrollbackCount: () => 0,
      getCell: (row, col) => ({
        chars: (lines[row] && lines[row][col]) || " ",
        width: 1,
        spacerHead: false,
      }),
    });
    const { ctx } = context();
    loadLens(ctx, bridge);
    ctx.HerdrLens.setLens(true);
    const overlayNode = ctx.document.getElementById("terminalLens");
    const content = overlayNode.querySelector(".terminal-lens-content");
    // Simulate the reader scrolled up: follow=false.
    const scroller = overlayNode.querySelector("#terminalLensScroller");
    scroller.scrollTop = 0;
    scroller.scrollHeight = 200;
    scroller.clientHeight = 100;
    for (const fn of scroller.listeners.scroll || []) fn();
    equal(ctx.HerdrLens.lensState().follow, false, "scrolled up stops follow");
    // New frame with the SAME line count: dirty forces the re-read and
    // lines.length > lastRenderedLineCount is false, so no unread yet.
    ctx.HerdrLens.onTerminalFrame();
    equal(ctx.HerdrLens.lensState().unread, false,
      "same-length rewrite does not fake unread");
    // Now the pane switches: follow/unread and the baseline must reset.
    // follow=true + the re-render snaps the scroller back to the tail.
    scroller.scrollTop = 0;
    ctx.HerdrLens.onPaneChanged();
    const after = ctx.HerdrLens.lensState();
    equal(after.follow, true, "pane switch resumes following");
    equal(after.unread, false, "pane switch clears unread");
    equal(content.dataset.dirty, "0",
      "the forced re-render already consumed the dirty flag");
    equal(scroller.scrollTop, scroller.scrollHeight, "re-render scrolls to the tail");
  });

  it("onPaneChanged is a no-op while the lens is closed", () => {
    const { ctx } = context();
    loadLens(ctx, makeBridge());
    // Lens closed: onPaneChanged must not build the overlay.
    ctx.HerdrLens.onPaneChanged();
    equal(!!ctx.document.getElementById("terminalLens"), false,
      "closed lens stays unrendered on pane change");
  });

  it("render skips the DOM write and the scroll when nothing changed", () => {
    const lines = ["hello"];
    const bridge = makeBridge({
      getCols: () => 5,
      getRows: () => 1,
      getScrollbackCount: () => 0,
      getCell: (row, col) => ({
        chars: (lines[row] && lines[row][col]) || " ",
        width: 1,
        spacerHead: false,
      }),
    });
    const { ctx } = context();
    loadLens(ctx, bridge);
    ctx.HerdrLens.setLens(true);
    const overlayNode = ctx.document.getElementById("terminalLens");
    const content = overlayNode.querySelector(".terminal-lens-content");
    const scroller = overlayNode.querySelector("#terminalLensScroller");
    const html = content.innerHTML;
    scroller.scrollTop = 42; // reader parked mid-transcript
    ctx.HerdrLens.render();
    equal(content.innerHTML, html, "unchanged transcript does not rewrite the DOM");
    equal(scroller.scrollTop, 42, "unchanged transcript does not force a scroll");
    // New bytes landed (onTerminalFrame): the write happens, and with
    // follow on, the scroller snaps to the tail.
    ctx.HerdrLens.onTerminalFrame();
    ok(content.innerHTML !== html || scroller.scrollTop === scroller.scrollHeight,
      "frame notify refreshes the lens");
  });

  it("shows the alt-screen hint only while an alt-screen app runs", () => {
    let alt = false;
    const bridge = makeBridge({ usingAltScreen: () => alt });
    const { ctx } = context();
    loadLens(ctx, bridge);
    ctx.HerdrLens.setLens(true);
    const overlayNode = ctx.document.getElementById("terminalLens");
    const hint = overlayNode.querySelector("#terminalLensAlt");
    ok(hint, "alt hint element must exist in the overlay");
    equal(hint.hidden, true, "hint hidden on the normal screen");
    alt = true;
    ctx.HerdrLens.render();
    equal(hint.hidden, false, "hint shown when the bridge reports alt screen");
    alt = false;
    ctx.HerdrLens.render();
    equal(hint.hidden, true, "hint hidden again once the app exits");
  });

  it("opening the lens pauses covered wterm paints, closing restores them", () => {
    const paused = [];
    const renderer = { setRenderingPaused: (v) => paused.push(v) };
    const { ctx, contextObject } = context();
    ctx.__term = { wterm: renderer };
    vm.runInContext("var term = globalThis.__term;", contextObject);
    vm.runInContext(LENS_SOURCE, contextObject);
    ctx.HerdrLens.setLens(true);
    equal(paused[paused.length - 1], true, "lens open pauses the covered renderer");
    ctx.HerdrLens.setLens(false);
    equal(paused[paused.length - 1], false, "lens close resumes paints");
  });
});

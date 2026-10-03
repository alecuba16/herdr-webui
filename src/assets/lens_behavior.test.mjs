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

function element(id) {
  return {
    id,
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    innerHTML: "",
    textContent: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
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
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
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
      createElement: () => element(),
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
});

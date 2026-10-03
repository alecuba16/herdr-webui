// Unit tests for the prompt cards module (src/assets/desktop/app_js/prompt_cards.js).
// Same vm harness as lens_behavior.test.mjs: the module runs in the
// DESKTOP_JS bundle scope where `term`, `state`, `statusClass`, `escapeHtml`,
// and `sendInputData` exist.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./desktop/app_js/prompt_cards.js", import.meta.url),
  "utf8",
);

function element(id) {
  const el = {
    id,
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    textContent: "",
    _innerHTML: "",
    // Buttons parsed from innerHTML are CACHED per render so onclick
    // bindings survive across querySelector/querySelectorAll calls,
    // like real DOM nodes.
    _buttons: null,
    set innerHTML(v) {
      this._innerHTML = v;
      this._buttons = null;
      this._form = null;
      this._dismiss = null;
      this._show = null;
    },
    get innerHTML() {
      return this._innerHTML;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector(sel) {
      if (sel === ".prompt-card-option") return this.querySelectorAll(".prompt-card-option")[0] || null;
      if (sel === ".prompt-card-dismiss") {
        if (!/class="prompt-card-dismiss"/.test(this._innerHTML)) return null;
        if (!this._dismiss) this._dismiss = { onclick: null };
        return this._dismiss;
      }
      if (sel === ".prompt-card-show") {
        if (!/class="prompt-card-show"/.test(this._innerHTML)) return null;
        if (!this._show) this._show = { onclick: null };
        return this._show;
      }
      if (sel === "#promptCardForm") {
        const formMatch = /<form id="promptCardForm">([\s\S]*?)<\/form>/.exec(this._innerHTML);
        if (!formMatch) return null;
        if (!this._form) {
          this._form = { onsubmit: null, __input: { value: "", focus() {} } };
        }
        return this._form;
      }
      if (sel === "#promptCardInput") {
        const f = this.querySelector("#promptCardForm");
        return f ? f.__input : null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === ".prompt-card-option") {
        if (!this._buttons) {
          this._buttons = [];
          const re = /<button type="button" class="prompt-card-option" data-option-key="([^"]*)">([^<]*)<\/button>/g;
          let m;
          while ((m = re.exec(this._innerHTML))) {
            this._buttons.push({
              __key: m[1],
              __label: m[2],
              onclick: null,
              getAttribute() {
                return this.__key;
              },
            });
          }
        }
        return this._buttons;
      }
      return [];
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
    onclick: null,
    onsubmit: null,
  };
  return el;
}

function makeBridge(gridLines) {
  return {
    getCols: () => 40,
    getRows: () => gridLines.length,
    getScrollbackCount: () => 0,
    getScrollbackLineLen: () => 0,
    getScrollbackCell: () => null,
    getCell: (row, col) => ({
      chars: (gridLines[row] || "")[col] || " ",
      width: 1,
      spacerHead: false,
    }),
    usingAltScreen: () => false,
  };
}

function loadModule(overrides = {}) {
  const elements = new Map();
  const shell = element("terminalShell");
  const card = element("terminalPromptCard");
  const sent = [];
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
      getElementById: (id) => {
        if (id === "terminalShell") return shell;
        if (id === "terminalPromptCard") return card;
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      createElement: () => element(),
      addEventListener() {},
    },
    term: { wterm: { bridge: overrides.bridge || makeBridge([]) } },
    state: overrides.state || { ws: "ws_1", workspaces: [] },
    statusClass: overrides.statusClass || ((s) => s),
    escapeHtml: (value) =>
      String(value).replace(/[&<>"']/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    sendInputData: (data) => sent.push(data),
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SOURCE, contextObject);
  return { ctx, card, shell, sent };
}

const QUESTION_GRID = [
  "some earlier output line",
  "? Allow the tool to run now?",
  "> 1. Allow once",
  "> 2. Always allow",
  "> 3. Deny",
  "↑↓ select · esc cancel",
];

describe("prompt cards module", () => {
  it("defines the HerdrPromptCards API", () => {
    const { ctx } = loadModule();
    ok(ctx.HerdrPromptCards, "globalThis.HerdrPromptCards must exist");
    for (const name of ["evaluate", "parsePrompt", "tailLines", "paneBlocked"]) {
      equal(typeof ctx.HerdrPromptCards[name], "function", `${name} must be a function`);
    }
  });

  it("parses numbered question dialogs into options", () => {
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt(QUESTION_GRID);
    ok(prompt, "dialog must parse");
    equal(prompt.kind, "options");
    equal(prompt.title, "Allow the tool to run now");
    equal(prompt.options.length, 3);
    equal(prompt.options[0].key, "1");
    equal(prompt.options[0].label, "Allow once");
    equal(prompt.options[2].label, "Deny");
  });

  it("parses free-text response prompts", () => {
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      "❯ How should we proceed with the migration?",
      "enter your response · esc cancel",
    ]);
    ok(prompt);
    equal(prompt.kind, "text");
    equal(prompt.title, "How should we proceed with the migration");
  });

  it("returns null for non-dialog tails", () => {
    const { ctx } = loadModule();
    equal(ctx.HerdrPromptCards.parsePrompt(["plain output", "another line"]), null);
    equal(ctx.HerdrPromptCards.parsePrompt([]), null);
    // single numbered line without confirmation words: not a dialog
    equal(ctx.HerdrPromptCards.parsePrompt(["1. first item", "2. second item"]), null);
  });

  it("reads the tail from the bridge", () => {
    const { ctx } = loadModule({ bridge: makeBridge(QUESTION_GRID) });
    const lines = ctx.HerdrPromptCards.tailLines();
    ok(lines.includes("↑↓ select · esc cancel"));
    ok(!lines.some((l) => l.trim() === ""), "no blank tail rows");
  });

  it("paneBlocked reflects the selected workspace status", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const { ctx } = loadModule({ state });
    equal(ctx.HerdrPromptCards.paneBlocked(), true);
    const state2 = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "working" }],
    };
    const mod2 = loadModule({ state: state2 });
    equal(mod2.ctx.HerdrPromptCards.paneBlocked(), false);
  });

  it("evaluate renders the card only when blocked + dialog present", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const { ctx, card } = loadModule({ state, bridge: makeBridge(QUESTION_GRID) });
    const prompt = ctx.HerdrPromptCards.evaluate();
    ok(prompt, "card evaluates to a prompt");
    equal(card.hidden, false);
    match(card.innerHTML, /prompt-card-option/);
    match(card.innerHTML, /Allow once/);
    match(card.innerHTML, /prompt-card-show/);

    // Not blocked: card hides.
    const mod2 = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "working" }] },
      bridge: makeBridge(QUESTION_GRID),
    });
    equal(mod2.ctx.HerdrPromptCards.evaluate(), null);
    equal(mod2.card.hidden, true);
  });

  it("answering an option synthesizes the right keypress payload", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const { ctx, card, sent } = loadModule({ state, bridge: makeBridge(QUESTION_GRID) });
    ctx.HerdrPromptCards.evaluate();
    // Simulate the option button click path: the module binds onclick on
    // each option button; the mock exposes them via querySelectorAll.
    const buttons = card.querySelectorAll(".prompt-card-option");
    equal(buttons.length, 3, "three option buttons rendered");
    // Click option 2 via its bound handler.
    buttons[1].onclick();
    equal(sent.length, 1, "one payload sent");
    equal(sent[0], "2\r", "option N sends N + Enter");
    equal(card.hidden, true, "card hides after answering");
  });

  it("free-text answering sends typed text + Enter", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const grid = ["❯ Describe the fix", "enter your response"];
    const { ctx, card, sent } = loadModule({ state, bridge: makeBridge(grid) });
    ctx.HerdrPromptCards.evaluate();
    const form = card.querySelector("#promptCardForm");
    ok(form, "text prompt renders the form");
    const input = card.querySelector("#promptCardInput");
    ok(input, "input present");
    input.value = "refactor the parser";
    form.onsubmit({ preventDefault() {} });
    equal(sent.length, 1);
    equal(sent[0], "refactor the parser\r");
  });

  it("dismissal collapses the card until the question changes", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const { ctx, card } = loadModule({ state, bridge: makeBridge(QUESTION_GRID) });
    ctx.HerdrPromptCards.evaluate();
    card.querySelector(".prompt-card-dismiss").onclick();
    equal(card.hidden, true);
    ok(ctx.HerdrPromptCards._dismissed(), "dismissal recorded");
    // Re-evaluating the SAME dialog stays collapsed.
    ctx.HerdrPromptCards.evaluate();
    equal(card.hidden, true, "same question stays dismissed");
    // A different question re-opens.
    const other = [
      "? Approve the deploy?",
      "1. Approve",
      "2. Reject",
      "esc cancel",
    ];
    const mod2 = loadModule({ state, bridge: makeBridge(other) });
    mod2.ctx.HerdrPromptCards.evaluate();
    equal(mod2.card.hidden, false, "different question re-opens");
  });

  it("parses only the newest dialog when two are on screen", () => {
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      "? Older question?",
      "1. Yes",
      "2. No",
      "esc cancel",
      "intermediate output",
      "? Newer question?",
      "1. Approve",
      "2. Reject",
      "esc cancel",
    ]);
    ok(prompt, "dialog must parse");
    equal(prompt.options.length, 2, "only the last block's options");
    equal(prompt.options[0].label, "Approve");
    equal(prompt.title, "Newer question");
  });

  it("stale card cannot send: title must still match the tail", () => {
    const state = {
      ws: "ws_1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
    };
    const { ctx, card, sent } = loadModule({ state, bridge: makeBridge(QUESTION_GRID) });
    ctx.HerdrPromptCards.evaluate();
    // The dialog moved on between render and click: the grid now shows a
    // DIFFERENT question. The click must not send.
    const movedOn = makeBridge([
      "? A different question?",
      "1. Yes",
      "2. No",
      "esc cancel",
    ]);
    ctx.term.wterm.bridge = movedOn;
    const buttons = card.querySelectorAll(".prompt-card-option");
    buttons[0].onclick();
    equal(sent.length, 0, "stale click must not send");
  });

  it("escapes hostile terminal text in every rendered slot", () => {
    // Terminal output is attacker-influenceable: a malicious agent or
    // program can print a dialog whose title/labels carry markup. Every
    // dynamic slot in the card HTML must route through escapeHtml.
    const { ctx, card } = loadModule({
      state: {
        ws: "ws_1",
        workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }],
      },
    });
    const hostileGrid = [
      "old output",
      '? <img src=x onerror="steal()"> allow <b>evil</b> now?',
      '> 1. <script>alert(1)</script>',
      '> 2. " onclick="steal()',
      "↑↓ select · esc cancel",
    ];
    ctx.term.wterm.bridge = makeBridge(hostileGrid);
    const prompt = ctx.HerdrPromptCards.parsePrompt(hostileGrid);
    ok(prompt, "hostile dialog still parses");
    ctx.HerdrPromptCards.evaluate();
    const html = card._innerHTML;
    // No raw markup can survive into any attribute or body slot.
    ok(!html.includes("<img"), "img tag must be escaped");
    ok(!html.includes("<script"), "script tag must be escaped");
    ok(!html.includes("<b>evil"), "b tag must be escaped");
    ok(!html.includes('" onclick="'), "attribute breakout must be escaped");
    ok(html.includes("&lt;img"), "escaped entities present");
    ok(html.includes("&lt;script&gt;"), "script escaped to entities");
  });
});

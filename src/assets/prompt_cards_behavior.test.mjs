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

// The real inputAttrs guard helper from shared/core.js (module.exports),
// injected into the vm sandbox exactly like DESKTOP_JS scope provides it.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { inputAttrs } = require("./shared/core.js");

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
    getCols: () => Math.max(40, ...gridLines.map((line) => line.length)),
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
    options: overrides.options !== undefined ? overrides.options : {},
    statusClass: overrides.statusClass || ((s) => s),
    escapeHtml: (value) =>
      String(value).replace(/[&<>"']/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    sendInputData: (data) => sent.push(data),
    inputAttrs,
    // Chat lens defaults to OPEN: the card is a chat-mode surface, so
    // rendering tests run in chat mode. Tests can override with
    // extra: { HerdrLens: { isActive: () => false } }.
    HerdrLens: { isActive: () => true },
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
    // The free-text input must carry the full Android keyboard guard set.
    ok(
      /<input id="promptCardInput"[^>]*autocomplete="off"[^>]*autocorrect="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"[^>]*writingsuggestions="false"[^>]*translate="no"[^>]*enterkeyhint="send"/.test(card.innerHTML),
      "prompt card input carries the full keyboard guard set with enterkeyhint=send",
    );
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

  it("prefers the server prompt endpoint and sticks local-only after a failure", async () => {
    // GET /api/panes/{pane_id}/prompt returns the backend parse of the pane
    // tail: {blocked, kind, title, options}. While it answers, the card
    // renders from it even when the local grid is blank (alt screen), and
    // the first failure disables the endpoint for the session (sticky-off
    // like snapshotBootstrap) so evaluate falls back to the local parse.
    const state = {
      ws: "ws_1",
      pane: "p1",
      workspaces: [{ workspace_id: "ws_1", agent_status: "working" }],
    };
    const calls = [];
    let failNext = false;
    const { ctx, card } = loadModule({
      state,
      bridge: makeBridge([]),
      extra: {
        api: async (url) => {
          calls.push(String(url));
          if (failNext) throw new Error("route missing");
          return {
            blocked: true,
            kind: "options",
            title: "Server-side question?",
            options: [
              { key: "1", label: "Approve" },
              { key: "2", label: "Deny" },
            ],
          };
        },
      },
    });
    // The workspace status is not blocked, but the server payload says the
    // pane is: the server flag is the sharper source.
    ctx.HerdrPromptCards.evaluate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.HerdrPromptCards.evaluate();
    equal(card.hidden, false);
    match(card.innerHTML, /Server-side question\?/);
    match(card.innerHTML, /Approve/);
    ok(calls.some((url) => url === "/api/panes/p1/prompt"), "prompt endpoint hit");

    // Failure sticks: the endpoint is off for the session and the local
    // grid (blank) yields no card.
    failNext = true;
    ctx.HerdrPromptCards._resetServer();
    ctx.HerdrPromptCards.evaluate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.HerdrPromptCards.evaluate();
    equal(ctx.HerdrPromptCards._serverUsable(), false);
    equal(card.hidden, true, "local fallback finds no dialog in a blank grid");
  });

  it("parses the jcode Permissions viewer into letter options", () => {
    // The real jcode viewer tail (jcode-tui-permissions): fullscreen
    // alt screen, letter shortcuts, waiting line, pending count.
    const { ctx } = loadModule();
    const grid = [
      "│ Permissions (2 pending)                             │",
      "│ a approve · d deny · A approve all · D deny all     │",
      "│ ⏳ Agent is waiting for this decision               │",
      "│ Tool: Bash (rm -rf work)                            │",
    ];
    const prompt = ctx.HerdrPromptCards.parsePrompt(grid);
    ok(prompt, "jcode viewer must parse");
    equal(prompt.kind, "options");
    ok(prompt.title.includes("jcode permissions"), "viewer title");
    ok(prompt.title.includes("2"), "pending count in title");
    equal(prompt.options.map((o) => o.key).join(","), "a,d,A,D");
    equal(prompt.options[0].label, "Approve");
    equal(prompt.options[3].label, "Deny all");
  });

  it("jcode viewer markers above newer output still parse (pinned asymmetry)", () => {
    // Pins CURRENT behavior: the round-2 tail-end tightening applies to
    // the numbered branch only. The viewer branch parses both markers
    // wherever they sit in the window, because real viewer layouts can
    // carry content below the waiting line (tool rows, the deny-reason
    // input state) and the live viewer holds the alt screen so its
    // markers never sit above newer output while it is active. If this
    // ever gets tightened, change all three parser copies and the
    // parity corpus together.
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      "│ Permissions (1 pending) │",
      "│ a approve · d deny · A approve all · D deny all │",
      "│ ⏳ Agent is waiting for this decision │",
      "build log line 1",
      "build log line 2",
    ]);
    ok(prompt, "viewer card floats even with newer output below (pinned)");
    equal(prompt.title, "jcode permissions (1 pending)");
  });

  it("jcode viewer needs both markers; transcript quotes do not parse", () => {
    const { ctx } = loadModule();
    equal(
      ctx.HerdrPromptCards.parsePrompt([
        "a approve · d deny · A approve all · D deny all",
        "Release notes mention the shortcuts above.",
      ]),
      null,
      "help row without the waiting line is not a viewer",
    );
    equal(
      ctx.HerdrPromptCards.parsePrompt([
        "earlier: ⏳ Agent is waiting for this decision",
        "1. do not parse this",
        "2. yes",
        "task finished, exit 0",
      ]),
      null,
      "waiting line alone is not a viewer",
    );
  });

  it("answering a jcode viewer option sends the letter + Enter", () => {
    const JCODE_GRID = [
      "│ Permissions (2 pending)                             │",
      "│ a approve · d deny · A approve all · D deny all     │",
      "│ ⏳ Agent is waiting for this decision               │",
    ];
    const { ctx, card, sent } = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }] },
      bridge: makeBridge(JCODE_GRID),
    });
    const prompt = ctx.HerdrPromptCards.evaluate();
    ok(prompt, "viewer card renders");
    const buttons = card.querySelectorAll(".prompt-card-option");
    equal(buttons.length, 4, "four letter buttons rendered");
    // Click "Approve all" (A) via its bound handler.
    buttons[2].onclick();
    equal(sent.length, 1, "one payload sent");
    equal(sent[0], "A\r", "letter + Enter, exactly what the viewer expects");
    equal(card.hidden, true, "card hides after answering");
  });

  it("jcode ask_user chooser never parses as a prompt card", () => {
    // The chooser renders its own answer rows ("N. option", plus an
    // "N. Your answer" free-text row) followed by hint lines whose
    // "Enter sends ..." text matches FREE_TEXT. Without the guard the
    // hint tail parses as a free-text card with a scraped title. The
    // chooser already has its own surface: the chat lens decision
    // parts.
    const { ctx } = loadModule();
    const chooserGrid = [
      "Where should the new workspace live?",
      "❯ 1. ~/Documents/projects/new-space",
      "  2. /tmp/scratch",
      "  3. Your answer",
      "1-9 or ↑↓ + Enter to choose · type on Your answer · Esc dismisses",
      "Enter sends · Shift/Alt+Enter newline · Esc dismisses",
    ];
    equal(ctx.HerdrPromptCards.parsePrompt(chooserGrid), null, "chooser tail is not a card");
  });

  it("numbered list above newer output does not parse (stale-window FP)", () => {
    const { ctx } = loadModule();
    equal(
      ctx.HerdrPromptCards.parsePrompt([
        "plan:",
        "1. allow port",
        "2. deny stale entry",
        "done, task finished",
      ]),
      null,
      "block must sit at the tail end or carry a confirm hint",
    );
  });

  it("numbered block at the tail end still parses", () => {
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      "❯ Run it?",
      "1. Yes, allow once",
      "2. No, deny",
      "",
      "",
    ]);
    ok(prompt, "tail-end options parse");
    equal(prompt.title, "Run it");
  });

  it("numbered block with a confirm hint below parses", () => {
    const { ctx } = loadModule();
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      "❯ Apply migration?",
      "1. yes, allow",
      "2. no, cancel",
      "press enter to confirm",
      "(applying soon)",
    ]);
    ok(prompt, "confirm hint keeps the dialog parseable");
    equal(prompt.title, "Apply migration");
    equal(prompt.options.length, 2);
  });

  it("promptCardsEnabled=false hides the card even when blocked", () => {
    const { ctx, card } = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }] },
      bridge: makeBridge(QUESTION_GRID),
      options: { promptCardsEnabled: false },
    });
    const result = ctx.HerdrPromptCards.evaluate();
    equal(result, null, "toggle off means no card");
    ok(card.hidden, "overlay stays hidden");
  });

  it("promptCardsEnabled default (missing) keeps cards working", () => {
    const { ctx, card } = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }] },
      bridge: makeBridge(QUESTION_GRID),
      // Chat lens open: the card is a chat-mode surface, so the default
      // harness must simulate the lens being open for rendering paths.
      extra: { HerdrLens: { isActive: () => true } },
    });
    const result = ctx.HerdrPromptCards.evaluate();
    ok(result, "no stored option defaults to enabled");
    ok(!card.hidden, "overlay visible");
  });

  it("card stays hidden on the terminal view (chat lens closed)", () => {
    // Chat-mode gate: the card is a chat-mode surface. With the lens
    // closed (terminal view), a blocked pane with a live dialog must not
    // open the card — the pane's own dialog owns the keyboard there.
    const { ctx, card } = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }] },
      bridge: makeBridge(QUESTION_GRID),
      extra: { HerdrLens: { isActive: () => false } },
    });
    equal(ctx.HerdrPromptCards.evaluate(), null, "lens closed means no card");
    ok(card.hidden, "overlay stays hidden on the terminal view");
  });

  it("card hides when the chat lens closes mid-episode", () => {
    // The lens can close while the card is up (user clicks Terminal).
    // evaluate after the close must collapse it, not leave it floating
    // over the terminal view.
    let lensActive = true;
    const { ctx, card } = loadModule({
      state: { ws: "ws_1", workspaces: [{ workspace_id: "ws_1", agent_status: "blocked" }] },
      bridge: makeBridge(QUESTION_GRID),
      extra: { HerdrLens: { isActive: () => lensActive } },
    });
    ok(ctx.HerdrPromptCards.evaluate(), "card open while lens open");
    ok(!card.hidden, "overlay visible in chat mode");
    lensActive = false;
    equal(ctx.HerdrPromptCards.evaluate(), null, "lens close collapses the card");
    ok(card.hidden, "overlay hidden after lens close");
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

  it("exotic unicode whitespace parses like plain spaces", () => {
    // JS `\s` and Rust regex `\s` disagree on BOM and NEL (and the two
    // `trim()` sets differ too). All exotic spaces normalize to plain
    // space before matching, so the JS parser reads NBSP/NEL/U+3000/
    // BOM/LS/PS dialogs exactly like the Rust one.
    const { ctx } = loadModule();
    const nbsp = "\u00a0pick\u00a0one\u00a0";
    const prompt = ctx.HerdrPromptCards.parsePrompt([
      nbsp,
      "1.\u0085allow",
      "2.\u3000deny",
    ]);
    ok(prompt, "NBSP/NEL/U+3000 dialog parses");
    equal(prompt.title, "pick one");
    equal(prompt.options[0].label, "allow");
    equal(prompt.options[1].label, "deny");

    const bomPrompt = ctx.HerdrPromptCards.parsePrompt([
      "\ufeffALLOW now?",
      "enter your response",
    ]);
    ok(bomPrompt, "BOM-led free-text parses");
    equal(bomPrompt.title, "ALLOW now", "BOM does not survive into the title");

    const lsPrompt = ctx.HerdrPromptCards.parsePrompt([
      "allow\u2028it?",
      "enter your response",
    ]);
    ok(lsPrompt, "LS title parses");
    equal(lsPrompt.title, "allow it");
  });
});

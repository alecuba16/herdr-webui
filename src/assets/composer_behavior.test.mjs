// Unit tests for the desktop composer (src/assets/desktop/app_js/composer.js).
//
// Same vm harness as prompt_cards_behavior.test.mjs: the module runs in the
// DESKTOP_JS bundle scope where `state` and `api` exist. The DOM stub is
// small but faithful to the paths composer.js actually uses: getElementById
// for the shell, createElement + appendChild, querySelector for the note /
// input / send trio parsed out of the overlay's innerHTML, addEventListener
// for keydown/input, and `hidden` as a plain boolean.
//
// The server owns refusal copy: api() throws with error.details carrying
// {error, code, note} and the composer displays details.note (falling back
// to the error string). These tests throw server-shaped errors.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./desktop/app_js/composer.js", import.meta.url),
  "utf8",
);

function stubNode(id) {
  const node = {
    id,
    className: "",
    hidden: false,
    textContent: "",
    children: [],
    listeners: {},
    value: "",
    // The overlay's innerHTML is parsed when assigned (like the real
    // DOM); its interactive children are cached so identity survives
    // across querySelector calls.
    _innerHTML: "",
    _note: null,
    _input: null,
    _send: null,
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(html) {
      this._innerHTML = html;
      if (!/id="terminalComposerNote"/.test(html)) return;
      this._note = stubNode("terminalComposerNote");
      this._input = stubNode("terminalComposerInput");
      this._input.value = "";
      this._send = stubNode("terminalComposerSend");
      this._send.onclick = null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector(sel) {
      if (!this._note) return null;
      if (sel === "#terminalComposerNote") return this._note;
      if (sel === "#terminalComposerInput") return this._input;
      if (sel === "#terminalComposerSend") return this._send;
      return null;
    },
  };
  return node;
}

function loadComposer(overrides = {}) {
  const shell = stubNode("terminalShell");
  const created = [];
  const apiCalls = [];
  const document = {
    // getElementById must find the overlay by id on later calls (the
    // real DOM would); otherwise overlay() would build a new node per
    // sync/submit instead of reusing the one it appended.
    getElementById: (id) => {
      if (id === "terminalShell") return shell;
      return created.find((node) => node.id === id) || null;
    },
    createElement: () => {
      const node = stubNode("");
      created.push(node);
      return node;
    },
  };
  const state = overrides.state || { pane: "pane_a" };
  const api = overrides.api || (async () => ({}));
  const ctx = {
    console,
    document,
    state,
    api: async (url, opt) => {
      apiCalls.push({ url, opt });
      return api(url, opt);
    },
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SOURCE, contextObject);
  return { ctx, shell, created, apiCalls };
}

// Server-shaped refusal error, like http.js throws for !ok bodies.
function refusalError(code, message, note) {
  const error = Error(message);
  error.details = { error: message, code, note };
  return error;
}

// The overlay element is the one node created and appended to the shell.
function overlayOf(result) {
  return result.shell.children[0];
}

function inputOf(result) {
  const node = overlayOf(result);
  return node.querySelector("#terminalComposerInput");
}

function sendOf(result) {
  return overlayOf(result).querySelector("#terminalComposerSend");
}

function noteOf(result) {
  return overlayOf(result).querySelector("#terminalComposerNote");
}

function typeDraft(result, text) {
  // The composer is lazy: build the overlay first like sync()/submit()
  // do, then type.
  result.ctx.HerdrComposer.overlay();
  const input = inputOf(result);
  input.value = text;
  for (const fn of input.listeners.input || []) fn();
}

describe("composer module", () => {
  it("exposes the HerdrComposer API", () => {
    const result = loadComposer();
    ok(result.ctx.HerdrComposer, "globalThis.HerdrComposer must exist");
    for (const name of ["sync", "submit", "note", "overlay"]) {
      equal(
        typeof result.ctx.HerdrComposer[name],
        "function",
        `${name} must be a function`,
      );
    }
  });

  it("creates the overlay lazily, hidden, inside the shell", () => {
    const result = loadComposer();
    const overlay = result.ctx.HerdrComposer.overlay();
    ok(overlay, "overlay() builds the node");
    equal(result.shell.children[0], overlay, "appended to #terminalShell");
    ok(overlay.hidden, "starts hidden until the lens opens");
    ok(
      /role="status"/.test(overlay.innerHTML),
      "the note row is a live region",
    );
  });

  it("returns null overlay when no shell exists", () => {
    const result = loadComposer({ extra: { document: { getElementById: () => null, createElement: () => stubNode("") } } });
    equal(result.ctx.HerdrComposer.overlay(), null);
  });

  it("keeps per-pane drafts and restores them on sync", async () => {
    const result = loadComposer({ state: { pane: "pane_a" } });
    result.ctx.HerdrLens = { isActive: () => true };
    typeDraft(result, "thought for pane a");
    result.ctx.state.pane = "pane_b";
    typeDraft(result, "different thought");
    // Lens on: the box shows the draft of the pane now in view.
    result.ctx.HerdrComposer.sync();
    const input = inputOf(result);
    equal(input.value, "different thought");
    result.ctx.state.pane = "pane_a";
    result.ctx.HerdrComposer.sync();
    equal(input.value, "thought for pane a", "pane_a draft survived the switch");
  });

  it("sync toggles visibility with the lens", async () => {
    const result = loadComposer();
    result.ctx.HerdrLens = { isActive: () => false };
    result.ctx.HerdrComposer.sync();
    ok(overlayOf(result).hidden, "hidden when lens is off");
    result.ctx.HerdrLens = { isActive: () => true };
    result.ctx.HerdrComposer.sync();
    equal(overlayOf(result).hidden, false, "visible when lens is on");
  });

  it("submit sends the shaped message to the pane's submit route", async () => {
    let seen;
    const result = loadComposer({
      api: async (url, opt) => {
        seen = { url, opt, body: JSON.parse(opt.body) };
        return { ok: true };
      },
    });
    typeDraft(result, "hello from test\r\nsecond line\n\n");
    await result.ctx.HerdrComposer.submit();
    equal(seen.url, "/api/panes/pane_a/submit");
    equal(seen.opt.method, "POST");
    equal(seen.opt.headers["content-type"], "application/json");
    // Server-side shaping happens too, but the browser must not send the
    // composer's trailing Enter-shaped bytes as part of the text.
    equal(seen.body.text, "hello from test\nsecond line");
    equal(inputOf(result).value, "", "box clears after a successful send");
    equal(result.ctx.HerdrComposer.drafts.size, 0, "draft deleted on success");
    equal(noteOf(result).hidden, true, "note cleared on success");
  });

  it("submit refuses empty and whitespace-only drafts", async () => {
    let calls = 0;
    const result = loadComposer({ api: async () => { calls++; return {}; } });
    typeDraft(result, "   \n\t ");
    await result.ctx.HerdrComposer.submit();
    equal(calls, 0, "whitespace never reaches the server");
    typeDraft(result, "");
    await result.ctx.HerdrComposer.submit();
    equal(calls, 0);
  });

  it("submit shows a refusal note and keeps the draft on error", async () => {
    const result = loadComposer({
      api: async () => {
        throw refusalError(
          "agent_blocked",
          "agent_blocked: the agent is waiting for an answer in the terminal",
          "Not sent: the agent is waiting for an answer in the terminal. Answer it first.",
        );
      },
    });
    typeDraft(result, "answer me this");
    await result.ctx.HerdrComposer.submit();
    const note = noteOf(result);
    equal(note.hidden, false, "refusal is visible");
    match(note.textContent, /waiting for an answer/i);
    equal(inputOf(result).value, "answer me this", "draft kept on refusal");
    ok(
      result.ctx.HerdrComposer.drafts.has("pane_a"),
      "draft map still holds the pane's text",
    );
  });

  it("submit falls back to the raw error string without a server note", async () => {
    const result = loadComposer({
      api: async () => {
        const error = Error("io_error: write failed");
        error.details = { error: "io_error: write failed", code: "io_error" };
        throw error;
      },
    });
    typeDraft(result, "x");
    await result.ctx.HerdrComposer.submit();
    // details.note is absent (non-JSON body or older server): the browser
    // shows the server's own error string, verbatim, no client-side copy.
    equal(noteOf(result).textContent, "io_error: write failed");
  });

  it("submit shows the server note verbatim", async () => {
    const result = loadComposer({
      api: async () => {
        throw refusalError("message_too_long", "message_too_long: too big",
          "Not sent: message is too long (20000 characters max).");
      },
    });
    typeDraft(result, "x");
    await result.ctx.HerdrComposer.submit();
    equal(noteOf(result).textContent,
      "Not sent: message is too long (20000 characters max).");
  });

  it("submit refuses drafts over MAX_COMPOSER_CHARS without calling api", async () => {
    let calls = 0;
    const result = loadComposer({ api: async () => { calls++; return {}; } });
    typeDraft(result, "a".repeat(20001));
    await result.ctx.HerdrComposer.submit();
    equal(calls, 0, "over-cap draft never reaches the server");
    match(noteOf(result).textContent, /too long/i);
  });

  it("Enter key submits, Shift+Enter does not", async () => {
    let calls = 0;
    const result = loadComposer({ api: async () => { calls++; return {}; } });
    result.ctx.HerdrComposer.overlay();
    const input = inputOf(result);
    const press = (key, shiftKey) => {
      let prevented = false;
      const event = { key, shiftKey, preventDefault: () => { prevented = true; } };
      for (const fn of input.listeners.keydown || []) fn(event);
      return prevented;
    };
    typeDraft(result, "hello");
    equal(press("Enter", true), false, "Shift+Enter is left to the browser (newline)");
    equal(calls, 0, "Shift+Enter is a newline, not a submit");
    ok(press("Enter", false), "Enter preventDefaults");
    // submit() is async: let microtasks run before counting.
    await Promise.resolve();
    await Promise.resolve();
    equal(calls, 1, "Enter sent once");
  });

  it("Send button click submits the draft", async () => {
    let calls = 0;
    const result = loadComposer({ api: async () => { calls++; return {}; } });
    typeDraft(result, "via button");
    sendOf(result).onclick();
    await Promise.resolve();
    await Promise.resolve();
    equal(calls, 1);
  });

  it("note() writes and clears the live region", () => {
    const result = loadComposer();
    result.ctx.HerdrComposer.note("hello note");
    const note = noteOf(result);
    equal(note.textContent, "hello note");
    equal(note.hidden, false);
    result.ctx.HerdrComposer.note("");
    equal(note.hidden, true, "empty note hides the row");
  });

  it("guards against a missing active pane", async () => {
    let calls = 0;
    const result = loadComposer({
      api: async () => { calls++; return {}; },
    });
    // No active pane: submit is a no-op, not a crash.
    result.ctx.state.pane = null;
    typeDraft(result, "hello again");
    await result.ctx.HerdrComposer.submit();
    equal(calls, 0);
  });
});

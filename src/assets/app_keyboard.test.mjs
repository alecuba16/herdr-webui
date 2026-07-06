import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeElement(id = "") {
  return {
    id,
    children: [],
    dataset: {},
    disabled: false,
    focused: false,
    offsetParent: {},
    style: { display: "none", setProperty() {} },
    textContent: "",
    appendChild(child) { this.children.push(child); },
    contains(node) { return node === this || this.children.includes(node); },
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    querySelectorAll() { return this.children; },
    setAttribute(name, value) { this.attributes = { ...(this.attributes || {}), [name]: value }; },
    removeAttribute(name) { if (this.attributes) delete this.attributes[name]; },
  };
}

function context() {
  const elements = new Map();
  let document;
  const getElement = (id) => {
    if (!elements.has(id)) {
      const element = makeElement(id);
      element.ownerDocument = document;
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document = {
    activeElement: null,
    body: makeElement("body"),
    createElement: () => makeElement(),
    getElementById: getElement,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  document.body.ownerDocument = document;
  const localStorage = new Map();
  const ctx = {
    console,
    TextEncoder,
    clearTimeout() {},
    setTimeout() { return 1; },
    document,
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    location: { pathname: "/", href: "" },
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    addEventListener() {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    prompt: () => null,
    confirm: () => true,
    Terminal: class {},
    WebSocket: class {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadKeyboardContext() {
  const ctx = context();
  const coreSource = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
  const helperStart = coreSource.indexOf("function setActionButtonLoading");
  const helperEnd = coreSource.indexOf("function setTerminalLoading", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const source = [
    "function el(id) { return document.getElementById(id); }",
    coreSource.slice(helperStart, helperEnd),
    readFileSync(new URL("./desktop/app_js/keyboard.js", import.meta.url), "utf8"),
  ].join("\n");
  vm.runInContext(source, ctx);
  return ctx;
}

function keyEvent(key, target) {
  return {
    key,
    target,
    shiftKey: false,
    preventDefaultCalled: false,
    preventDefault() { this.preventDefaultCalled = true; },
  };
}

describe("desktop keyboard routing", () => {
  it("traps Tab inside normal modals", () => {
    const ctx = loadKeyboardContext();
    const modal = ctx.document.getElementById("settingsModal");
    const first = makeElement("first");
    const last = makeElement("last");
    first.ownerDocument = ctx.document;
    last.ownerDocument = ctx.document;
    modal.children = [first, last];
    modal.style.display = "grid";
    ctx.document.activeElement = last;

    const event = keyEvent("Tab", last);
    ctx.handleModalFocusTrapKeydown(event);

    assert.equal(event.preventDefaultCalled, true);
    assert.equal(ctx.document.activeElement, first);
  });

  it("lets temp terminal own Tab instead of focus trapping it", () => {
    const ctx = loadKeyboardContext();
    const modal = ctx.document.getElementById("tempTerminalModal");
    const terminal = makeElement("tempTerminal");
    terminal.ownerDocument = ctx.document;
    modal.children = [terminal];
    modal.style.display = "grid";

    const event = keyEvent("Tab", terminal);
    ctx.handleModalFocusTrapKeydown(event);

    assert.equal(event.preventDefaultCalled, false);
  });
});

describe("action button loading helper", () => {
  it("disables, labels, then restores button state", () => {
    const ctx = loadKeyboardContext();
    const button = makeElement("submit");
    button.textContent = "Create workspace";

    ctx.setActionButtonLoading(button, true, "Creating...");
    assert.equal(ctx.actionButtonLoading(button), true);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Creating...");
    assert.equal(button.attributes["aria-busy"], "true");

    ctx.setActionButtonLoading(button, false);
    assert.equal(ctx.actionButtonLoading(button), false);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Create workspace");
    assert.equal(button.attributes["aria-busy"], undefined);
  });
});

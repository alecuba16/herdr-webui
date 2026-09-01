import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Test the blocking overlay depth-counting logic from core.js.
// The showBlocking/hideBlocking/resetBlocking functions manage a ref-counted
// overlay so that nested async operations work correctly.

function context() {
  const elements = new Map();

  function makeElement(id) {
    const el = {
      id: id || "",
      _classes: new Set(),
      _aria: "true",
      _textContent: "",
      classList: {
        add(token) { el._classes.add(token); },
        remove(token) { el._classes.delete(token); },
        contains(token) { return el._classes.has(token); },
      },
      set textContent(v) { el._textContent = String(v); },
      get textContent() { return el._textContent; },
      setAttribute(name, value) {
        if (name === "aria-hidden") el._aria = String(value);
      },
      getAttribute(name) {
        if (name === "aria-hidden") return el._aria;
        return null;
      },
      style: {},
    };
    return el;
  }

  function getElement(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  }

  // Pre-create the blocking overlay elements so tests can access them
  getElement("blockingOverlay");
  getElement("blockingOverlayLabel");

  const ctx = {
    console,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) { return 1; },
    requestAnimationFrame(fn) { fn(); },
    document: {
      body: getElement("body"),
      createElement: () => makeElement(""),
      getElementById: getElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    localStorage: {
      _store: new Map(),
      getItem(key) { return this._store.get(key) || null; },
      setItem(key, value) { this._store.set(key, String(value)); },
      removeItem(key) { this._store.delete(key); },
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    WebSocket: class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    addEventListener() {},
    encodeURIComponent,
    decodeURIComponent,
    JSON,
    Error,
    Math,
    String,
    Object,
    Array,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
    RegExp,
    Number,
    Boolean,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return { ctx: vm.createContext(ctx), elements };
}

function loadCore(ctx) {
  const source = readFileSync(
    new URL("./desktop/app_js/core.js", import.meta.url),
    "utf8",
  );
  try {
    vm.runInContext(source, ctx);
  } catch (e) {
    // Some init code may fail without full DOM; the functions we test
    // are declared at top level and should be available.
  }
}

function getOverlay(elements) {
  return elements.get("blockingOverlay");
}
function getLabel(elements) {
  return elements.get("blockingOverlayLabel");
}

describe("blocking overlay", () => {
  it("showBlocking adds 'show' class and sets aria-hidden to false", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    ctx.showBlocking("Loading...");
    const overlay = getOverlay(elements);
    assert.ok(overlay, "blockingOverlay element should exist");
    assert.ok(overlay.classList.contains("show"), "should have 'show' class");
    assert.equal(overlay.getAttribute("aria-hidden"), "false");
    assert.equal(getLabel(elements).textContent, "Loading...");
  });

  it("hideBlocking removes 'show' class and sets aria-hidden to true when depth reaches 0", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    ctx.showBlocking("Working...");
    ctx.hideBlocking();
    const overlay = getOverlay(elements);
    assert.ok(!overlay.classList.contains("show"), "should not have 'show' class");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");
  });

  it("nested showBlocking calls require matching hideBlocking calls", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    const overlay = getOverlay(elements);

    // First level
    ctx.showBlocking("Outer...");
    assert.ok(overlay.classList.contains("show"));
    assert.equal(getLabel(elements).textContent, "Outer...");

    // Second level (nested) - should update the message
    ctx.showBlocking("Inner...");
    assert.ok(overlay.classList.contains("show"), "overlay still visible after nested show");
    assert.equal(getLabel(elements).textContent, "Inner...");

    // First hide - depth goes 2 -> 1, overlay should stay visible
    ctx.hideBlocking();
    assert.ok(overlay.classList.contains("show"), "overlay stays visible when depth > 0");

    // Second hide - depth goes 1 -> 0, overlay should be hidden
    ctx.hideBlocking();
    assert.ok(!overlay.classList.contains("show"), "overlay hidden when depth reaches 0");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");
  });

  it("hideBlocking does nothing when depth is already 0", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    const overlay = getOverlay(elements);

    // Call hideBlocking without any prior showBlocking
    ctx.hideBlocking();
    assert.ok(!overlay.classList.contains("show"), "overlay should remain hidden");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");
  });

  it("showBlocking uses default message when none provided", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    ctx.showBlocking();
    assert.equal(getLabel(elements).textContent, "Working...");
  });

  it("resetBlocking clears the overlay regardless of depth", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    const overlay = getOverlay(elements);

    // Build up depth to 3
    ctx.showBlocking("A");
    ctx.showBlocking("B");
    ctx.showBlocking("C");
    assert.ok(overlay.classList.contains("show"));

    // Reset should clear everything
    ctx.resetBlocking();
    assert.ok(!overlay.classList.contains("show"), "reset clears 'show' class");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");

    // Subsequent hideBlocking should be a no-op
    ctx.hideBlocking();
    assert.ok(!overlay.classList.contains("show"));
  });

  it("resetBlocking is exposed globally on window", () => {
    const { ctx } = context();
    loadCore(ctx);

    assert.equal(typeof ctx.window.resetBlocking, "function");
    assert.equal(typeof ctx.window.showBlocking, "function");
    assert.equal(typeof ctx.window.hideBlocking, "function");
  });

  it("resetBlocking recovers from stuck overlay (simulating unhandledrejection)", () => {
    const { ctx, elements } = context();
    loadCore(ctx);

    const overlay = getOverlay(elements);

    // Simulate an active overlay
    ctx.showBlocking("Working...");
    assert.ok(overlay.classList.contains("show"));

    // Simulate what the unhandledrejection handler does: call resetBlocking
    ctx.window.resetBlocking();
    assert.ok(!overlay.classList.contains("show"), "reset clears stuck overlay");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");

    // Depth should be 0 now, so hideBlocking is a no-op
    ctx.hideBlocking();
    assert.ok(!overlay.classList.contains("show"));
  });
});
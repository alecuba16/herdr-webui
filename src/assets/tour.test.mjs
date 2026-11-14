// Onboarding tour unit tests: the real tour.js + tour_steps.js in a
// fake-DOM vm harness (same pattern as the file-browser suites in
// app_core.test.mjs). Covers start, step navigation, chord resolution,
// demo actions, skip/finish persistence, and the first-run helper.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = (rel) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

class FakeElement {
  constructor(document, tag = "div") {
    this.ownerDocument = document;
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.textContent = "";
    this._id = "";
    this._innerHTML = "";
    this._attributes = {};
    this._listeners = [];
    this.classList = {
      _classes: new Set(),
      add(...tokens) { for (const t of tokens) this._classes.add(t); },
      remove(...tokens) { for (const t of tokens) this._classes.delete(t); },
      contains(token) { return this._classes.has(token); },
    };
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null;
  }
  setAttribute(name, value) { this._attributes[name] = String(value); }
  set id(value) {
    this._id = String(value || "");
    if (this._id) this.ownerDocument.nodes.set(this._id, this);
  }
  get id() { return this._id; }
  set innerHTML(value) {
    this._innerHTML = String(value || "");
    // Parse id="..." and class="..." so querySelector finds the tour
    // card/hole nodes the driver builds via root.innerHTML.
    const idRe = /id="([^"]+)"/g;
    const classRe = /class="([^"]+)"/g;
    const ids = [...this._innerHTML.matchAll(idRe)].map((m) => m[1]);
    const classes = [...this._innerHTML.matchAll(classRe)].map((m) => m[1].split(/\s+/));
    const count = Math.max(ids.length, classes.length);
    for (let i = 0; i < count; i++) {
      const key = ids[i] || classes[i].join(".");
      if (this.ownerDocument.nodes.has(key)) continue;
      const node = new FakeElement(this.ownerDocument);
      if (ids[i]) node.id = ids[i];
      if (classes[i]) node.className = classes[i].join(" ");
      node.parentNode = this;
      this.children.push(node);
    }
  }
  get innerHTML() { return this._innerHTML; }
  querySelector(selector) {
    // The tour only queries classes inside the card and id selectors in
    // the step list; support both.
    if (selector.startsWith("#")) return this.ownerDocument.getElementById(selector.slice(1));
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const rest = selector.replace(/^[.#]/, "");
    const byClass = selector.startsWith(".");
    return this.children.filter((child) =>
      byClass
        ? String(child.className || "").split(/\s+/).includes(rest)
        : String(child.tag || "") === selector,
    );
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) this.ownerDocument.nodes.set(child.id, child);
    return child;
  }
  addEventListener(type, listener) { this._listeners.push([type, listener]); }
  click() {
    for (const [type, listener] of this._listeners) if (type === "click") listener({ target: this });
  }
  focus() {}
  getBoundingClientRect() { return { x: 10, y: 10, width: 200, height: 40, left: 10, top: 10, right: 210, bottom: 50 }; }
  get isConnected() { return true; }
}

function createFakeDocument() {
  const doc = {
    nodes: new Map(),
    keydownHandlers: [],
    createElement(tag) { return new FakeElement(doc, tag); },
    getElementById(id) { return doc.nodes.get(id) || null; },
    querySelector(selector) {
      if (selector === "body") return doc.body;
      if (selector.startsWith("#")) return doc.getElementById(selector.slice(1));
      return doc.body.querySelectorAll(selector)[0] || null;
    },
    addEventListener(type, listener) { if (type === "keydown") doc.keydownHandlers.push(listener); },
  };
  doc.body = new FakeElement(doc, "body");
  return doc;
}

function makeHarness() {
  const document = createFakeDocument();
  const ids = ["headerActionsButton", "workspaces", "agents", "tabs", "terminal",
    "rightSidebarRail", "rightSidebarToggle", "shortcutsToggle", "sidebarToggle",
    "searchPalette", "settingsModal"];
  for (const id of ids) {
    const node = new FakeElement(document);
    node.id = id;
    document.body.appendChild(node);
  }
  document.getElementById("searchPalette").style.display = "none";
  document.getElementById("settingsModal").style.display = "none";

  const storage = new Map();
  const flags = { paletteOpened: 0, workspaceJumps: 0, tabCreated: 0, terminalFocused: 0, helpOpened: 0 };
  const ctx = {
    window: {
      document,
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
      },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      innerWidth: 1280,
      innerHeight: 800,
      HerdrRightSidebar: { collapsed: () => true },
    },
    el: (id) => document.getElementById(id),
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]),
    state: { ws: "ws", tab: "t", workspaces: [{ workspace_id: "ws" }, { workspace_id: "ws2" }], agents: [{}, {}] },
    options: {},
    globalShortcutPrefixLabel: () => "Ctrl+B",
    shortcutMapFor: () => ({
      search: "Slash", help: "Shift+Slash", nextWorkspace: "KeyJ", nextAgent: "KeyA",
      newPanel: "KeyP", focusTerminal: "KeyF", rightRail: "Shift+KeyV",
    }),
    shortcutDisplay: (v) => String(v || ""),
    openSearchPalette: () => { flags.paletteOpened += 1; },
    searchPaletteOpen: () => false,
    closeSearchPalette: () => {},
    selectRelativeWorkspace: () => { flags.workspaceJumps += 1; return true; },
    selectRelativeAgent: () => true,
    newTab: () => { flags.tabCreated += 1; },
    focusTerminal: () => { flags.terminalFocused += 1; return true; },
    showShortcutsModal: () => { flags.helpOpened += 1; },
    closeSettingsModal: () => {},
  };
  ctx.window.window = ctx.window;
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);
  context.document = document;
  context.window.document = document;
  context.window.localStorage = ctx.window.localStorage;
  context.localStorage = ctx.window.localStorage;
  // Modules read bare globals (el, escapeHtml, state...) and window.*; the
  // vm context provides both views over the same object.
  for (const key of ["el", "escapeHtml", "state", "options", "globalShortcutPrefixLabel",
    "shortcutMapFor", "shortcutDisplay", "openSearchPalette", "searchPaletteOpen",
    "closeSearchPalette", "selectRelativeWorkspace", "selectRelativeAgent", "newTab",
    "focusTerminal", "showShortcutsModal", "closeSettingsModal"]) {
    context[key] = ctx[key];
  }
  const stepsScript = new vm.Script(source("desktop/app_js/tour_steps.js"), { filename: "tour_steps.js" });
  const driverScript = new vm.Script(source("desktop/app_js/tour.js"), { filename: "tour.js" });
  stepsScript.runInContext(context);
  driverScript.runInContext(context);
  return {
    context,
    document,
    flags,
    storage,
    tour: context.window.HerdrOnboardingTour,
    stepsApi: context.window.HerdrTourSteps,
    press(key) {
      for (const handler of document.keydownHandlers) handler({ key, preventDefault() {}, stopPropagation() {}, defaultPrevented: false });
    },
  };
}

describe("onboarding tour (webui)", () => {
  it("starts, renders the first step, runs its demo, and moves with Enter", () => {
    const h = makeHarness();
    assert.equal(h.tour.isDone(), false);
    h.tour.start();
    assert.equal(h.tour.isActive(), true);
    assert.ok(h.document.querySelector(".tour-root"), "tour root mounted");
    assert.equal(h.document.getElementById("tourTitle").textContent, "Search and actions");
    assert.equal(h.flags.paletteOpened, 1, "step 1 demo opened the palette");
    h.press("Enter");
    assert.equal(h.document.getElementById("tourTitle").textContent, "Workspaces");
  });

  it("arrow keys walk back and forward, Esc stops and persists the skip", () => {
    const h = makeHarness();
    h.tour.start();
    h.press("ArrowRight");
    assert.equal(h.document.getElementById("tourTitle").textContent, "Workspaces");
    h.press("ArrowLeft");
    assert.equal(h.document.getElementById("tourTitle").textContent, "Search and actions");
    h.press("Escape");
    assert.equal(h.tour.isActive(), false);
    assert.equal(h.storage.get("herdr-web-tour-done"), "skipped");
    assert.equal(h.tour.isDone(), true);
  });

  it("finishing walks every visible step and persists done", () => {
    const h = makeHarness();
    h.tour.start();
    const next = h.document.getElementById("tourNext");
    for (let i = 0; i < 20 && h.tour.isActive(); i++) next.click();
    assert.equal(h.tour.isActive(), false);
    assert.equal(h.storage.get("herdr-web-tour-done"), "done");
  });

  it("chords resolve through the configured shortcut maps", () => {
    const h = makeHarness();
    assert.equal(h.stepsApi.chordLabel("webuiShortcuts", "search"), "Ctrl+B then Slash");
    const steps = h.stepsApi.steps();
    assert.ok(steps.length >= 5, "tour covers the main areas");
    for (const step of steps) {
      assert.ok(step.target, `target on "${step.title}"`);
      assert.ok(step.title, "title present");
      assert.ok(typeof step.body === "string" || typeof step.body === "function", "body present");
    }
  });

  it("reset clears the persisted flag so the tour can replay", () => {
    const h = makeHarness();
    h.tour.start();
    h.press("Escape");
    h.tour.reset();
    assert.equal(h.tour.isDone(), false);
  });

  it("steps skip their demos when showWhen is false", () => {
    const h = makeHarness();
    // Single workspace and single agent: both list steps drop out.
    h.context.state.workspaces = [{ workspace_id: "ws" }];
    h.context.state.agents = [{}];
    h.tour.start();
    const seen = [];
    for (let i = 0; i < 20 && h.tour.isActive(); i++) {
      seen.push(h.document.getElementById("tourTitle").textContent);
      h.document.getElementById("tourNext").click();
    }
    assert.ok(!seen.includes("Workspaces"), "workspaces step skipped without data");
    assert.ok(!seen.includes("Agents"), "agents step skipped without data");
  });
});
// Onboarding tour unit tests for the mobile layout: real tour.js +
// tour_steps.js in a fake-DOM vm harness (same pattern as the desktop
// tour.test.mjs). Covers start, step navigation, demo dispatch through
// HerdrMobile, skip/finish persistence, and the boot auto-start guard.
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
    this._listeners = {};
    this.rect = { x: 0, y: 0, width: 100, height: 44 };
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
    const classRe = /class="([^"]+)"/g;
    const idRe = /id="([^"]+)"/g;
    const classes = [...this._innerHTML.matchAll(classRe)].map((m) => m[1].split(/\s+/));
    const ids = [...this._innerHTML.matchAll(idRe)].map((m) => m[1]);
    const count = Math.max(ids.length, classes.length);
    for (let i = 0; i < count; i++) {
      const key = ids[i] || classes[i].join(".");
      if (this.ownerDocument.nodes.has(key)) continue;
      const node = new FakeElement(this.ownerDocument);
      if (ids[i]) node.id = ids[i];
      if (classes[i]) node.className = classes[i].join(" ");
      node.rect = { x: 10, y: 10 + i * 44, width: 320, height: 44 };
      this.children.push(node);
      this.ownerDocument.nodes.set(key, node);
    }
  }
  get innerHTML() { return this._innerHTML; }
  get isConnected() { return !!this.parentNode; }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  addEventListener(event, listener) {
    (this._listeners[event] || (this._listeners[event] = [])).push(listener);
  }
  removeEventListener() {}
  querySelector(selector) {
    const wanted = selector.startsWith(".") ? selector.slice(1) : null;
    for (const child of this.children) {
      if (wanted && String(child.className).split(/\s+/).includes(wanted)) return child;
    }
    return this.children[0] || null;
  }
  click() {
    for (const listener of this._listeners.click || []) listener({ target: this });
  }
  focus() {}
  getBoundingClientRect() { return this.rect; }
}

function createFakeDocument() {
  const doc = {
    nodes: new Map(),
    keydownHandlers: [],
    createElement: (tag) => new FakeElement(doc, tag),
    getElementById: (id) => doc.nodes.get(id) || null,
    querySelector: (selector) => doc.queryResults.get(selector) || null,
    queryResults: new Map(),
    addEventListener(event, listener) {
      if (event === "keydown") doc.keydownHandlers.push(listener);
    },
    removeEventListener() {},
    body: null,
  };
  doc.body = new FakeElement(doc, "body");
  return doc;
}

function makeHarness() {
  const document = createFakeDocument();
  const navButtons = {};
  for (const screen of ["home", "search", "terminal", "git", "files", "more"]) {
    const node = new FakeElement(document, "button");
    node.dataset.screen = screen;
    node.rect = { x: 10, y: 800, width: 60, height: 44 };
    document.queryResults.set(`.mobile-nav button[data-screen="${screen}"]`, node);
    navButtons[screen] = node;
  }
  const nav = new FakeElement(document, "nav");
  nav.className = "mobile-nav";
  nav.rect = { x: 0, y: 790, width: 390, height: 50 };
  document.queryResults.set(".mobile-nav", nav);
  const drawerItems = {};
  for (const screen of ["agents", "panels", "worktrees", "sessions", "notes", "settings"]) {
    const node = new FakeElement(document, "button");
    node.dataset.screen = screen;
    node.rect = { x: 12, y: 140 + drawerItemsCount() * 56, width: 280, height: 52 };
    document.queryResults.set(`.mobile-drawer-item[data-screen="${screen}"]`, node);
    drawerItems[screen] = node;
  }
  function drawerItemsCount() { return Object.keys(drawerItems).length; }
  const title = new FakeElement(document);
  title.id = "mobileTitle";
  title.rect = { x: 10, y: 20, width: 200, height: 40 };
  document.body.appendChild(title);
  document.queryResults.set("#mobileTitle", title);

  const storage = new Map();
  const flags = { screenShown: [], workspacesSheetOpened: 0, drawerOpened: 0, drawerClosed: 0, searchClosed: 0, timeouts: [] };
  const ctx = {
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    setTimeout: (fn) => { flags.timeouts.push(fn); return flags.timeouts.length; },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    innerWidth: 390,
    innerHeight: 844,
    HerdrOptions: { read: () => ({}) },
    HerdrMobile: {
      showScreen: (screen) => { flags.screenShown.push(screen); },
      openWorkspacesSheet: () => { flags.workspacesSheetOpened += 1; },
      closeWorkspacesSheet: () => {},
      closeSearch: () => { flags.searchClosed += 1; },
      openDrawer: () => { flags.drawerOpened += 1; },
      closeDrawer: () => { flags.drawerClosed += 1; },
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);

  const stepsScript = new vm.Script(source("mobile/tour_steps.js"), { filename: "tour_steps.js" });
  const driverScript = new vm.Script(source("mobile/tour.js"), { filename: "tour.js" });
  stepsScript.runInContext(context);
  driverScript.runInContext(context);
  return {
    context,
    document,
    flags,
    storage,
    navButtons,
    drawerItems,
    tour: context.HerdrMobileTour,
    stepsApi: context.HerdrMobileTourSteps,
    press(key) {
      for (const handler of document.keydownHandlers) handler({ key, preventDefault() {}, stopPropagation() {}, defaultPrevented: false });
    },
    flushTimeouts() {
      const pending = flags.timeouts.splice(0);
      for (const fn of pending) fn();
    },
  };
}

describe("onboarding tour (mobile)", () => {
  it("starts, renders the first step, and runs its demo through HerdrMobile", () => {
    const h = makeHarness();
    assert.equal(h.tour.isDone(), false);
    h.tour.start();
    assert.equal(h.tour.isActive(), true);
    assert.ok(h.document.body.children.some((node) => String(node.className).includes("tour-root")), "tour root mounted");
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Search");
    assert.equal(h.flags.screenShown[0], "search", "step 1 demo opened the search screen");
    h.press("ArrowRight");
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Workspaces");
  });

  it("Back and Next buttons walk the steps; the first step disables Back", () => {
    const h = makeHarness();
    h.tour.start();
    assert.equal(h.document.getElementById("mobileTourPrev").disabled, true);
    h.document.getElementById("mobileTourNext").click();
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Workspaces");
    assert.equal(h.document.getElementById("mobileTourPrev").disabled, false);
    h.document.getElementById("mobileTourPrev").click();
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Search");
  });

  it("Esc stops and persists the skip; the flag suppresses nothing until reset", () => {
    const h = makeHarness();
    h.tour.start();
    h.press("Escape");
    assert.equal(h.tour.isActive(), false);
    assert.equal(h.storage.get("herdr-mobile-tour-done"), "skipped");
    assert.equal(h.tour.isDone(), true);
  });

  it("finishing walks every step and persists done", () => {
    const h = makeHarness();
    h.tour.start();
    const next = h.document.getElementById("mobileTourNext");
    for (let i = 0; i < 20 && h.tour.isActive(); i++) next.click();
    assert.equal(h.tour.isActive(), false);
    assert.equal(h.storage.get("herdr-mobile-tour-done"), "done");
  });

  it("the last step button reads Finish", () => {
    const h = makeHarness();
    h.tour.start();
    const next = h.document.getElementById("mobileTourNext");
    for (let i = 0; i < 20 && h.tour.isActive(); i++) {
      if (next.textContent === "Finish") break;
      next.click();
    }
    assert.equal(next.textContent, "Finish");
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
    h.context.HerdrOptions.read = () => ({ headerSearchEnabled: false });
    h.tour.start();
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Workspaces", "search step skipped when header search is off");
    assert.equal(h.flags.screenShown.length, 0);
  });

  it("demos run the real HerdrMobile actions, one dispatch per step entry", () => {
    const h = makeHarness();
    h.tour.start();
    assert.equal(h.flags.screenShown.length, 1);
    h.flushTimeouts();
    assert.equal(h.flags.screenShown.length, 1, "demo repaint never re-runs the demo");
    h.document.getElementById("mobileTourNext").click();
    assert.equal(h.flags.workspacesSheetOpened, 1, "workspaces step opened the sheet");
  });

  it("stop closes the sheets and drawer the demos opened", () => {
    const h = makeHarness();
    const closed = { workspaces: 0, drawer: 0, search: 0 };
    h.context.HerdrMobile.closeWorkspacesSheet = () => { closed.workspaces += 1; };
    h.context.HerdrMobile.closeDrawer = () => { closed.drawer += 1; };
    h.context.HerdrMobile.closeSearch = () => { closed.search += 1; };
    h.tour.start();
    // Step 1 (Search) opens the search sheet via showScreen("search").
    h.tour.stop(false);
    assert.equal(closed.search, 1, "stop closed the search sheet");
    assert.equal(closed.workspaces, 1, "stop closed the workspaces sheet");
    assert.ok(closed.drawer >= 1, "stop closed the drawer");
  });

  it("double start() is a no-op", () => {
    const h = makeHarness();
    h.tour.start();
    h.tour.start();
    assert.equal(h.flags.screenShown.length, 1, "second start ran nothing");
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Search");
  });

  it("step order keeps the shared story: nav screens, then every drawer screen, then the replay hint", () => {
    const h = makeHarness();
    const titles = h.stepsApi.steps().map((step) => step.title);
    assert.deepEqual([...titles], [
      "Search",
      "Workspaces",
      "Home",
      "Terminal",
      "Git",
      "Files",
      "More",
      "Agents",
      "Panels",
      "Worktrees",
      "Sessions",
      "Notes",
      "Settings",
      "Replay any time",
    ]);
  });

  it("the six drawer steps walk the same order as the drawer item list", () => {
    const h = makeHarness();
    const drawerScreens = ["agents", "panels", "worktrees", "sessions", "notes", "settings"];
    const drawerSteps = h.stepsApi.steps().filter((step) => step.target.startsWith(".mobile-drawer-item"));
    assert.equal(drawerSteps.length, 6, "one step per drawer screen");
    assert.deepEqual(
      [...drawerSteps.map((step) => step.title.toLowerCase())],
      drawerScreens,
      "drawer steps match the renderDrawerItems order"
    );
  });

  it("drawer steps keep the drawer open and the replay hint closes it", () => {
    const h = makeHarness();
    h.tour.start();
    // Walk to the first drawer step (More is step 7): the drawer opens
    // once per entry into More and every drawer step keeps re-asserting it.
    for (let i = 0; i < 6; i++) h.document.getElementById("mobileTourNext").click();
    const drawerOpenedAtMore = h.flags.drawerOpened;
    assert.ok(drawerOpenedAtMore >= 1, "More opened the drawer");
    h.document.getElementById("mobileTourNext").click();
    assert.ok(h.flags.drawerOpened > drawerOpenedAtMore, "the Agents drawer step re-opened the drawer");
    // Walk the remaining drawer steps to the replay hint.
    for (let i = 0; i < 6; i++) h.document.getElementById("mobileTourNext").click();
    assert.equal(h.flags.drawerClosed, 1, "the replay hint demo closed the drawer once");
    assert.equal(h.document.getElementById("mobileTourTitle").textContent, "Replay any time");
  });

  it("each drawer step spotlights a real drawer item", () => {
    const h = makeHarness();
    h.tour.start();
    for (let i = 0; i < 7; i++) h.document.getElementById("mobileTourNext").click();
    for (const screen of ["agents", "panels", "worktrees", "sessions", "notes", "settings"]) {
      assert.equal(h.document.getElementById("mobileTourTitle").textContent.toLowerCase(), screen);
      h.document.getElementById("mobileTourNext").click();
    }
  });

  it("every step has a target, title, and body", () => {
    const h = makeHarness();
    for (const step of h.stepsApi.steps()) {
      assert.ok(step.target, `target on "${step.title}"`);
      assert.ok(step.title, "title present");
      assert.ok(typeof step.body === "string" || typeof step.body === "function", "body present");
    }
  });

  it("step selectors match the real shell markup in mobile/app.js and screens.js", () => {
    // The harness used to fake-verify selectors the real DOM could not
    // match ("nav .mobile-nav ..." against <nav class="mobile-nav">), so
    // every nav step silently auto-skipped in the real app. Tie each
    // non-body target to a literal string in the shipped markup instead.
    const appSource = source("mobile/app.js");
    const screensSource = source("mobile/screens.js");
    const ids = [
      "#mobileTitle",
    ];
    for (const id of ids) {
      assert.ok(appSource.includes(`id="${id.slice(1)}"`), `${id} exists in the shell markup`);
    }
    for (const screen of ["home", "search", "terminal", "git", "files", "more"]) {
      assert.ok(
        appSource.includes(`data-screen="${screen}"`),
        `.mobile-nav button[data-screen="${screen}"] exists in the shell markup`
      );
    }
    // The drawer markup renders data-screen from the items array, so the
    // literal "data-screen=\"agents\"" never appears in source; tie the
    // guard to the screen list the map call iterates instead.
    for (const screen of ["agents", "panels", "worktrees", "sessions", "notes", "settings"]) {
      assert.ok(
        screensSource.includes(`screen: "${screen}"`),
        `drawer item screen "${screen}" exists in the screens.js item list`
      );
      assert.ok(
        screensSource.includes("data-screen=\"${item.screen}\""),
        "drawer markup still renders data-screen for tour targets"
      );
    }
    for (const step of makeHarness().stepsApi.steps()) {
      if (step.target === "body") continue;
      assert.ok(
        step.target.startsWith("#mobile") ||
          step.target.startsWith(".mobile-nav button[data-screen=") ||
          step.target.startsWith(".mobile-drawer-item[data-screen="),
        `target "${step.target}" uses a selector covered by the shell markup check`
      );
    }
  });
});

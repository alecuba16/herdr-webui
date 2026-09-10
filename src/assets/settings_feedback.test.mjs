import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("./shared/settings_feedback.js", import.meta.url),
  "utf8",
);

function loadFeedback() {
  const ctx = { console, Map, Object, String, setTimeout, clearTimeout };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.window.HerdrSettingsFeedback;
}

// Minimal DOM stub: nodes carry className/dataset/attributes plus the child
// ops the module uses (appendChild, querySelector, remove, closest).
function createNodeStub({ id = "", className = "" } = {}) {
  const node = {
    id,
    className,
    children: [],
    parentNode: null,
    dataset: {},
    _attributes: {},
    setAttribute(name, value) {
      this._attributes[name] = String(value);
    },
    getAttribute(name) {
      return this._attributes[name];
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode !== this)
        child.parentNode.children = child.parentNode.children.filter(
          (existing) => existing !== child,
        );
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(
        (child) => child !== this,
      );
      this.parentNode = null;
    },
    querySelector(selector) {
      const wanted = selector
        .split(",")
        .map((part) => part.trim())
        .map((part) => (part.startsWith(".") ? part.slice(1) : part));
      for (const child of this.children) {
        if (wanted.includes(String(child.className))) return child;
        const nested = child.querySelector && child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    closest(selector) {
      const wanted = selector.startsWith(".") ? selector.slice(1) : selector;
      let current = this;
      while (current) {
        if (String(current.className) === wanted) return current;
        if (current.tagName === wanted.toUpperCase()) return current;
        current = current.parentNode;
      }
      return null;
    },
  };
  return node;
}

function createContext() {
  const timers = [];
  let seq = 0;
  const fakeSetTimeout = (callback, delay) => {
    const id = ++seq;
    timers.push({ id, callback, delay, cleared: false });
    return id;
  };
  const fakeClearTimeout = (id) => {
    const timer = timers.find((item) => item.id === id);
    if (timer) timer.cleared = true;
  };
  const document = { createElement: () => createNodeStub() };
  const api = loadFeedback().create({
    document,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  return { api, timers };
}

describe("HerdrSettingsFeedback", () => {
  it("exposes the applied duration for callers and tests", () => {
    const { api } = createContext();
    ok(api.APPLIED_MS >= 1000, "badge should stay long enough to be seen");
  });

  it("flashes an applied badge on the closest .option row", () => {
    const { api } = createContext();
    const row = createNodeStub({ className: "option", id: "optRow" });
    const control = createNodeStub();
    row.appendChild(control);

    const badge = api.flashApplied(control);
    ok(badge, "returns the badge node");
    equal(badge.parentNode, row, "badge is appended to the row");
    equal(badge.className, "settings-applied");
    equal(badge.textContent, "✓ Applied");
    equal(badge.getAttribute("aria-live"), "polite");
    equal(badge.dataset.state, "settings-applied-ok");
  });

  it("reuses the same badge on repeated flashes and coalesces timers per row", () => {
    const { api, timers } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub();
    row.appendChild(control);

    api.flashApplied(control);
    equal(row.children.length, 2, "one control + one badge");

    api.flashApplied(control, "Saved");
    equal(row.children.length, 2, "badge reused, not duplicated");
    equal(row.children[1].textContent, "✓ Saved");
    const cleared = timers.filter((timer) => timer.cleared);
    equal(cleared.length, 1, "first timer is replaced by the second");
  });

  it("removes the badge after the applied timeout", () => {
    const { api, timers } = createContext();
    const row = createNodeStub({ className: "option" });
    api.flashAppliedRow(row);

    const due = timers.filter((timer) => !timer.cleared);
    equal(due.length, 1);
    due[0].callback();
    ok(!row.children.some((child) => String(child.className).startsWith("settings-")), "badge removed after timeout");
  });

  it("flashes error badges with a distinct class and state", () => {
    const { api, timers } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub();
    row.appendChild(control);

    api.flashError(control, "Could not save");
    const badge = row.children[1];
    equal(badge.className, "settings-error-flash");
    equal(badge.textContent, "Could not save");
    equal(badge.dataset.state, "settings-applied-error");

    // Switching the same row to applied replaces the error badge state.
    api.flashApplied(control);
    equal(badge.className, "settings-applied");
    equal(badge.dataset.state, "settings-applied-ok");
    equal(row.children.length, 2, "still a single badge per row");

    timers.filter((timer) => !timer.cleared)[0].callback();
    equal(row.children.length, 1, "only the control remains after removal");
  });

  it("falls back to the control itself when no row ancestor matches", () => {
    const { api } = createContext();
    const orphan = createNodeStub();
    const badge = api.flashApplied(orphan, "Done");
    equal(badge.parentNode, orphan, "badge lands on the control itself");
  });

  it("prefers the theme customizer container for apply/reset buttons", () => {
    const { api } = createContext();
    const customizer = createNodeStub({ className: "theme-customizer" });
    const button = createNodeStub();
    customizer.appendChild(button);

    const badge = api.flashApplied(button);
    equal(badge.parentNode, customizer);
  });

  it("clear removes badge and pending timer", () => {
    const { api, timers } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub();
    row.appendChild(control);
    api.flashApplied(control);
    ok(timers.some((timer) => !timer.cleared), "timer pending");

    api.clear(control);
    ok(!row.children.some((child) => String(child.className).startsWith("settings-")), "badge removed");
    ok(timers.every((timer) => timer.cleared), "timer cleared");
  });

  it("does nothing without a control", () => {
    const { api } = createContext();
    equal(api.flashApplied(null), null);
    equal(api.flashError(null, "x"), null);
    equal(api.clear(null), undefined);
  });
});
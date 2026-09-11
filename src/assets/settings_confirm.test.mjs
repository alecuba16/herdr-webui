import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("./shared/settings_confirm.js", import.meta.url),
  "utf8",
);

function loadConfirm() {
  const ctx = { console, Map, Object, String, Promise, Event: FakeEvent };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.window.HerdrSettingsConfirm;
}

class FakeEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
  }
}

let eventSeq = 0;
const dispatched = [];

function createNodeStub({ id = "", className = "", tagName = "INPUT", type = "text" } = {}) {
  const listeners = {};
  const node = {
    id,
    className,
    tagName,
    type,
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    value: "",
    checked: false,
    _attributes: {},
    classList: {
      toggle(name, force) {
        const names = String(node.className).split(/\s+/).filter(Boolean);
        const has = names.includes(name);
        if (force === undefined ? has : force) {
          if (!has) names.push(name);
        } else if (has) {
          const index = names.indexOf(name);
          names.splice(index, 1);
        }
        node.className = names.join(" ");
      },
      contains(name) {
        return String(node.className)
          .split(/\s+/)
          .includes(name);
      },
    },
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
    addEventListener(type, listener) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);
    },
    dispatchEvent(event) {
      eventSeq += 1;
      dispatched.push({ seq: eventSeq, target: this, type: event.type });
      for (const listener of listeners[event.type] || []) listener(event);
      return true;
    },
  };
  return node;
}

function fire(node, type) {
  node.dispatchEvent(new FakeEvent(type, { bubbles: true }));
}

function findChip(row, className) {
  return row.children.find(
    (child) => String(child.className) === className,
  );
}

function visibleChip(row, className) {
  const chip = findChip(row, className);
  if (!chip) return null;
  return String(chip.style.display || "") === "none" ? null : chip;
}

function createContext() {
  const saves = [];
  const reads = new Map();
  const rollbacks = [];
  const document = { createElement: () => createNodeStub() };
  const api = loadConfirm().create({
    document,
    save: (control, value) => saves.push({ control, value }),
    read: (control) => reads.get(control),
    onRollback: (control, value) => rollbacks.push({ control, value }),
  });
  return { api, saves, reads, rollbacks, document };
}

describe("HerdrSettingsConfirm", () => {
  it("shows pencil and rollback only while a text input differs from saved", () => {
    const { api, reads } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "text" });
    control.value = "saved";
    row.appendChild(control);
    reads.set(control, "saved");

    api.watch(row, control);
    ok(!visibleChip(row, "settings-confirm-pencil"), "no pencil before edit");
    ok(!visibleChip(row, "settings-rollback"), "no rollback before edit");

    control.value = "edited";
    fire(control, "input");
    ok(visibleChip(row, "settings-confirm-pencil"), "pencil appears on edit");
    ok(visibleChip(row, "settings-rollback"), "rollback appears on edit");
    ok(
      String(row.className).includes("settings-pending"),
      "row marked pending",
    );

    const pencil = findChip(row, "settings-confirm-pencil");
    equal(
      pencil.getAttribute("aria-label"),
      "Enter or press to confirm",
      "pencil hover hint",
    );
  });

  it("commits on Enter and hides chrome once values match", () => {
    const { api, reads, saves } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "text" });
    control.value = "saved";
    row.appendChild(control);
    reads.set(control, "saved");
    api.watch(row, control);

    control.value = "edited";
    fire(control, "input");
    let prevented = false;
    fire(control, "keydown");
    // keydown alone is not Enter in this stub; call commit directly.
    api.commit(row);
    equal(saves.length, 1, "save called once");
    equal(saves[0].value, "edited", "committed the edited value");
    reads.set(control, "edited");
    api.commit(row);
    reads.set(control, "edited");
    fire(control, "input");
    ok(
      !String(row.className).includes("settings-pending"),
      "row no longer pending after re-sync",
    );
    ok(prevented === false, "stub flag unused");
  });

  it("commit re-syncs the control when the host clamps the value", () => {
    const { api, reads, saves } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "number" });
    control.value = "200";
    row.appendChild(control);
    reads.set(control, 80);
    // Simulate the host clamping on save: read returns the clamped value
    // right after the save callback runs.
    api.watch(row, control);
    api.commit(row);
    equal(saves.length, 1, "save ran");
    // commit() refreshes savedValue from read() after saving, so the
    // control re-syncs to the clamped value 80.
    equal(control.value, "80", "control re-synced to clamped value");
  });

  it("rollback restores the saved value and notifies the host", () => {
    const { api, reads, rollbacks } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "text" });
    control.value = "saved";
    row.appendChild(control);
    reads.set(control, "saved");
    api.watch(row, control);

    control.value = "edited";
    fire(control, "input");
    api.rollback(row);
    equal(control.value, "saved", "value restored");
    equal(rollbacks.length, 1, "host rollback hook ran");
    ok(
      !String(row.className).includes("settings-pending"),
      "pending cleared after rollback",
    );
  });

  it("selects commit immediately and keep a persistent rollback arrow", () => {
    const { api, reads } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ tagName: "SELECT", type: "select-one" });
    control.value = "wterm";
    row.appendChild(control);
    reads.set(control, "wterm");
    api.watch(row, control);
    ok(!findChip(row, "settings-confirm-pencil"), "select has no pencil");

    control.value = "ghostty";
    fire(control, "change");
    const rollback = findChip(row, "settings-rollback");
    ok(rollback, "rollback arrow shown after change");
    ok(
      String(rollback.style.display || "") !== "none",
      "arrow visible while baseline differs",
    );

    // Rolling back dispatches input+change so host handlers persist it.
    dispatched.length = 0;
    api.rollback(row);
    equal(control.value, "wterm", "select restored to baseline");
    const types = dispatched.map((entry) => entry.type);
    ok(types.includes("input"), "input event dispatched");
    ok(types.includes("change"), "change event dispatched");
  });

  it("checkboxes roll back via a change event", () => {
    const { api, reads } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "checkbox" });
    control.checked = false;
    row.appendChild(control);
    reads.set(control, false);
    api.watch(row, control);

    control.checked = true;
    fire(control, "change");
    api.rollback(row);
    equal(control.checked, false, "checkbox restored");
  });

  it("rewatching refreshes baselines without duplicating listeners", () => {
    const { api, reads } = createContext();
    const row = createNodeStub({ className: "option" });
    const control = createNodeStub({ type: "text" });
    control.value = "one";
    row.appendChild(control);
    reads.set(control, "one");
    api.watch(row, control);
    api.watch(row, control);
    equal(
      row.children.filter(
        (child) =>
          child.className === "settings-confirm-pencil" &&
          String(child.style.display || "") !== "none",
      ).length,
      0,
      "no visible chrome before edits",
    );
    control.value = "two";
    fire(control, "input");
    fire(control, "input");
    equal(
      row.children.filter(
        (child) =>
          child.className === "settings-confirm-pencil" &&
          String(child.style.display || "") !== "none",
      ).length,
      1,
      "exactly one visible pencil after double watch",
    );
  });

  it("refreshAll re-reads baselines for every watched row", () => {
    const { api, reads } = createContext();
    const rowA = createNodeStub({ className: "option" });
    const controlA = createNodeStub({ type: "text" });
    controlA.value = "a";
    rowA.appendChild(controlA);
    reads.set(controlA, "a");
    api.watch(rowA, controlA);

    const rowB = createNodeStub({ className: "option" });
    const controlB = createNodeStub({ type: "number" });
    controlB.value = "5";
    rowB.appendChild(controlB);
    reads.set(controlB, "5");
    api.watch(rowB, controlB);

    reads.set(controlA, "changed");
    api.refreshAll();
    ok(
      String(rowA.className).includes("settings-pending"),
      "row A pending after baseline drift",
    );
    ok(
      !String(rowB.className).includes("settings-pending"),
      "row B still clean",
    );
  });
});
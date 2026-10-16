import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");

// The find toolbar owns the keyboard while it is open: every keystroke in
// the query repaints the selection, and selectRange must not move focus
// into the editor or the next keystroke lands in the document instead of
// the query (the per-keystroke focus-loss defect). These tests drive the
// real wireFindToolbar through the real create() path with a stub
// CodeMirror and a tiny HTML parser for the innerHTML calls.

function makeNode(document, tag, className) {
  const node = {
    tagName: tag.toUpperCase(),
    className: className || "",
    dataset: {},
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    children: [],
    handlers: {},
    ownerDocument: document,
    __attrs: {},
    __listeners: {},
    setAttribute(name, value) { this.__attrs[String(name)] = String(value); },
    getAttribute(name) { return this.__attrs[String(name)]; },
    // Real-DOM semantics: multiple handlers per type, removeEventListener
    // actually removes. The single-slot version let editor.js's rebind cycle
    // (create + mountCodeMirror) drop or double-fire handlers.
    addEventListener(type, handler) {
      const list = this.__listeners[type] || (this.__listeners[type] = []);
      if (!list.includes(handler)) list.push(handler);
      this.handlers[type] = (event) => { for (let i = list.length - 1; i >= 0; i--) list[i](event); };
    },
    removeEventListener(type, handler) {
      const list = this.__listeners[type];
      if (!list) return;
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
      this.handlers[type] = list.length
        ? (event) => { for (let i = list.length - 1; i >= 0; i--) list[i](event); }
        : null;
    },
    focus() { document.activeElement = node; },
    select() {},
    closest(selector) {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      for (let at = node; at; at = at.parentNode) {
        if (wantClass && String(at.className).split(/\s+/).includes(wantClass)) return at;
      }
      return null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const wanted = selector.split(",").map((s) => s.trim().replace(/^\./, ""));
      const out = [];
      for (const child of node.children) {
        const classes = String(child.className).split(/\s+/);
        if (wanted.some((w) => classes.includes(w))) out.push(child);
        for (const deep of child.querySelectorAll(selector)) out.push(deep);
      }
      return out;
    },
  };
  Object.defineProperty(node, "innerHTML", {
    get() { return node.__innerHTML || ""; },
    set(value) { node.__innerHTML = String(value); node.children = parseHtml(document, node.__innerHTML); for (const child of node.children) child.parentNode = node; },
  });
  return node;
}

// Minimal parser: builds a node tree for the tags the editor templates
// emit, carrying class attributes over. Text and attributes beyond class
// are ignored; the toolbar code only queries by class.
function parseHtml(document, html) {
  const roots = [];
  const stack = [{ tag: "#root", node: { children: roots } }];
  const re = /<(\/?)([a-z]+)([^>]*)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const [, closing, tag, attrs] = match;
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch) continue;
    const node = makeNode(document, tag, classMatch[1]);
    const pressed = /aria-pressed="([^"]*)"/.exec(attrs);
    if (pressed) node.setAttribute("aria-pressed", pressed[1]);
    if (/\shidden(\s|$)/.test(attrs)) node.hidden = true;
    const disabledMatch = /\sdisabled(\s|$)/.test(attrs);
    if (disabledMatch) node.disabled = true;
    const parent = stack[stack.length - 1].node;
    parent.children.push(node);
    node.parentNode = parent;
    if (!match[0].endsWith("/>")) stack.push({ tag, node });
  }
  return roots;
}

function loadEditor(overrides = {}) {
  const document = {
    activeElement: null,
    createElement() { return { setAttribute() {}, appendChild() {} }; },
    querySelector() { return null; },
    body: { appendChild() {} },
  };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    HerdrAppHelpers: null,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  Object.assign(ctx, overrides);
  vm.runInContext(source, ctx);
  return { ctx, HerdrEditor: ctx.window.HerdrEditor, document };
}

function editorWithStub(document, content = "alpha beta gamma\nbeta beta") {
  const selectCalls = [];
  const replaceCalls = [];
  const stub = {
    getValue: () => content,
    setValue() {},
    selectRange(from, to, opts) {
      selectCalls.push({ from, to, opts });
      if (!opts || !opts.keepFocus) document.activeElement = { tagName: "DIV", className: "cm-content" };
    },
    replaceRange(from, to, value, opts) {
      content = content.slice(0, from) + value + content.slice(to);
      replaceCalls.push({ from, to, value, opts });
      if (!opts || !opts.keepFocus) document.activeElement = { tagName: "DIV", className: "cm-content" };
    },
  };
  const parent = makeNode(document, "div", "pane-editor-container");
  return { stub, parent, selectCalls, replaceCalls };
}

describe("editor find toolbar focus", () => {
  it("keeps focus in the query while typing repaints the selection", () => {
    const { ctx, HerdrEditor, document } = loadEditor();
    const { stub, parent, selectCalls } = editorWithStub(document);
    ctx.HerdrCodeMirror = { create: () => stub };
    const api = HerdrEditor.create({ parent, readonly: false, content: "alpha beta gamma\nbeta beta" });
    ok(api, "create returned an api");

    const query = parent.querySelector(".herdr-editor-find-query");
    ok(query, "find query input rendered");

    // Type "be": each input event repaints the selection. Focus must stay
    // on the query between keystrokes.
    for (const ch of ["b", "e"]) {
      query.value += ch;
      document.activeElement = query;
      query.handlers.input();
      equal(document.activeElement, query, `focus stayed in the query after typing "${query.value}"`);
    }
    equal(query.value, "be");
    ok(selectCalls.length >= 2, "each keystroke repainted the match selection");
    ok(selectCalls.every((call) => call.opts && call.opts.keepFocus === true), "every selectRange passed keepFocus");
  });

  it("refocuses the query after prev/next button clicks", () => {
    const { ctx, HerdrEditor, document } = loadEditor();
    const { stub, parent, selectCalls } = editorWithStub(document);
    ctx.HerdrCodeMirror = { create: () => stub };
    HerdrEditor.create({ parent, readonly: false, content: "alpha beta gamma\nbeta beta" });

    const query = parent.querySelector(".herdr-editor-find-query");
    const next = parent.querySelector(".herdr-editor-find-next");
    const prev = parent.querySelector(".herdr-editor-find-prev");
    ok(query && next && prev, "toolbar buttons rendered");

    query.value = "beta";
    document.activeElement = query;
    query.handlers.input();
    equal(selectCalls.length, 1, "keystroke picked a match");

    // A click lands focus on the button; the handler must hand it back.
    document.activeElement = next;
    next.handlers.click();
    equal(document.activeElement, query, "next click refocused the query");
    ok(selectCalls.every((call) => call.opts && call.opts.keepFocus === true), "button click kept focus");

    document.activeElement = prev;
    prev.handlers.click();
    equal(document.activeElement, query, "prev click refocused the query");
  });

  it("replace-one keeps focus out of the editor and refocuses the query", () => {
    const { ctx, HerdrEditor, document } = loadEditor();
    const { stub, parent, replaceCalls } = editorWithStub(document);
    ctx.HerdrCodeMirror = { create: () => stub };
    HerdrEditor.create({ parent, readonly: false, content: "alpha beta gamma\nbeta beta" });

    const query = parent.querySelector(".herdr-editor-find-query");
    const replacement = parent.querySelector(".herdr-editor-replace-query");
    const one = parent.querySelector(".herdr-editor-replace-one");
    ok(query && replacement && one, "replace controls rendered");

    query.value = "beta";
    replacement.value = "zeta";
    query.handlers.input();
    document.activeElement = one;
    one.handlers.click();
    equal(document.activeElement, query, "replace-one refocused the query");
    equal(replaceCalls.length, 1, "one replaceRange call");
    ok(replaceCalls[0].opts && replaceCalls[0].opts.keepFocus === true, "replaceRange passed keepFocus");
    equal(replaceCalls[0].value, "zeta");
  });
});

describe("editor find toggle behavior", () => {
  // Header/float buttons are real toggles now. They resolve their editor
  // wrapper via closest(), but create() pins the api on the mount container
  // above the wrapper, so the static toggle must walk parentNode to find it.
  function makeFloatEditor() {
    const { ctx, HerdrEditor, document } = loadEditor();
    const stub = { getValue: () => "alpha beta", setValue() {}, selectRange() {}, replaceRange() {} };
    ctx.HerdrCodeMirror = { create: () => stub };
    const parent = makeNode(document, "div", "notes-editor");
    HerdrEditor.create({ parent, readonly: false, content: "alpha beta", hideHeader: true });
    const wrapper = parent.querySelector(".herdr-editor");
    const toggle = parent.querySelector(".herdr-editor-find-toggle");
    const toolbar = parent.querySelector(".herdr-editor-find");
    const query = parent.querySelector(".herdr-editor-find-query");
    return { ctx, HerdrEditor, document, parent, wrapper, toggle, toolbar, query };
  }

  it("renders the floating toggle on headerless mounts with aria-pressed off", () => {
    const { wrapper, toggle, toolbar } = makeFloatEditor();
    ok(wrapper, "herdr-editor wrapper rendered");
    ok(toggle, "floating find toggle rendered");
    ok(toggle.className.includes("herdr-editor-find-float"), "toggle carries the float class");
    equal(toggle.getAttribute("aria-pressed"), "false", "aria-pressed starts false");
    ok(toolbar, "find toolbar rendered");
    equal(toolbar.hidden, true, "toolbar starts hidden");
  });

  it("static toggleFind toggles through the mount api and syncs aria", () => {
    const { HerdrEditor, wrapper, toggle, toolbar } = makeFloatEditor();
    // The button's inline handler resolves closest('.herdr-editor').
    ok(HerdrEditor.toggleFind(wrapper), "first toggle showed the toolbar");
    equal(toolbar.hidden, false, "toolbar visible after first toggle");
    equal(toggle.getAttribute("aria-pressed"), "true", "aria-pressed synced on show");
    ok(HerdrEditor.toggleFind(wrapper), "second toggle hid the toolbar");
    equal(toolbar.hidden, true, "toolbar hidden after second toggle");
    equal(toggle.getAttribute("aria-pressed"), "false", "aria-pressed synced on hide");
  });

  it("static openFind stays show-only", () => {
    const { HerdrEditor, wrapper, toolbar } = makeFloatEditor();
    ok(HerdrEditor.openFind(wrapper));
    equal(toolbar.hidden, false, "openFind showed the toolbar");
    ok(HerdrEditor.openFind(wrapper));
    equal(toolbar.hidden, false, "openFind never hides the toolbar");
  });

  it("Ctrl+F toggles the toolbar; query focus re-selects instead of hiding", () => {
    const { document, parent, toggle, toolbar, query } = makeFloatEditor();
    // The shortcut handler is bound on the mount container (create's parent).
    const fire = (opts) => {
      const event = Object.assign({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }, opts);
      parent.handlers.keydown(event);
    };
    // First press shows.
    fire({ key: "f", ctrlKey: true, metaKey: false, altKey: false });
    equal(toolbar.hidden, false, "first Ctrl+F shows the toolbar");
    equal(toggle.getAttribute("aria-pressed"), "true", "aria synced after shortcut show");
    // Query focused: second press re-selects, does not hide.
    query.value = "al";
    query.focus();
    fire({ key: "f", ctrlKey: true, metaKey: false, altKey: false });
    equal(toolbar.hidden, false, "Ctrl+F with query focused keeps the toolbar open");
    equal(document.activeElement, query, "focus stayed in the query");
    // Focus outside the query: third press hides.
    document.activeElement = null;
    fire({ key: "f", ctrlKey: true, metaKey: false, altKey: false });
    equal(toolbar.hidden, true, "Ctrl+F with focus elsewhere hides the toolbar");
    equal(toggle.getAttribute("aria-pressed"), "false", "aria synced after shortcut hide");
  });
});
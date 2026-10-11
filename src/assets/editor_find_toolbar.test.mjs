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
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeEventListener() {},
    focus() { document.activeElement = node; },
    select() {},
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
    set(value) { node.__innerHTML = String(value); node.children = parseHtml(document, node.__innerHTML); },
  });
  return node;
}

// Minimal parser: builds a node tree for the tags the editor templates
// emit, carrying class attributes over. Text and attributes beyond class
// are ignored; the toolbar code only queries by class.
function parseHtml(document, html) {
  const roots = [];
  const stack = [{ tag: "#root", children: roots }];
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
    stack[stack.length - 1].children.push(node);
    if (!match[0].endsWith("/>")) stack.push({ tag, children: node.children });
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
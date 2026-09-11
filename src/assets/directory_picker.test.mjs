// Functional tests for the desktop directory picker modal: incremental
// search paging (infinite scroll) and the Default dir action.
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { equal, match } from "node:assert/strict";

const pickerSource = readFileSync(new URL("./desktop/directory_picker.js", import.meta.url), "utf8");
const treeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");

// Minimal DOM good enough for the picker: createElement/getElementById,
// innerHTML assignment (captured for assertions), appendChild, remove,
// querySelector for the tree, activeElement, focus and selection.
function makeElement(id = "") {
  const el = {
    id,
    innerHTML: "",
    className: "",
    textContent: "",
    value: "",
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 500,
    selectionStart: null,
    selectionEnd: null,
    dataset: {},
    children: [],
    style: {},
    parentNode: { appendChild() {} },
    appendChild(child) { this.children.push(child); },
    insertAdjacentElement() {},
    remove() { this.removed = true; },
    focus() {},
    setSelectionRange() {},
    dispatchEvent() {},
    addEventListener() {},
    querySelector() { return makeElement("tree"); },
  };
  return el;
}

function context({ fetchImpl } = {}) {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout() {},
    setTimeout(fn) { if (typeof fn === "function") fn(); return 1; },
    document: {
      body: makeElement("body"),
      title: "",
      createElement: (tag) => makeElement(tag),
      querySelector: () => makeElement("queried"),
      querySelectorAll: () => [],
      getElementById,
      addEventListener() {},
    },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.get(key) ?? null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
    fetch: fetchImpl || (async () => ({ status: 200, json: async () => ({}) })),
    addEventListener() {},
    WebSocket: class {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return { ctx: vm.createContext(ctx), elements, getElementById };
}

// The picker keeps `state` and `render` inside its closure. Tests inject a
// debug hook that exposes both so assertions can read module state.
const debugPickerSource = pickerSource.replace(
  "window.HerdrDirectoryPicker = {",
  "window.__pickerDebug = { state, render };\n  window.HerdrDirectoryPicker = {",
);

function loadPicker({ fetchImpl, defaultFolder, explorationDefault } = {}) {
  const harness = context({ fetchImpl });
  const { ctx } = harness;
  if (defaultFolder != null) ctx.defaultFolderPath = () => defaultFolder;
  if (explorationDefault != null) {
    ctx.HerdrOptions = {
      read() {
        return { explorationDefaultDirectory: explorationDefault };
      },
    };
  }
  vm.runInContext(treeSource, ctx);
  vm.runInContext(debugPickerSource, ctx);
  return harness;
}

function treeUrlCalls(ctx) {
  return ctx.fetch.urls || [];
}

test("directory picker search appends pages on scroll and stops at the end", async () => {
  const searchCalls = [];
  let page = 0;
  const pages = [
    { entries: [{ name: "a1", path: "a/1", kind: "dir", level: 0 }], truncated: true },
    { entries: [{ name: "a2", path: "a/2", kind: "dir", level: 0 }], truncated: true },
    { entries: [{ name: "a3", path: "a/3", kind: "dir", level: 0 }], truncated: false },
  ];
  const { ctx, getElementById } = loadPicker({
    fetchImpl: async (url) => {
      const text = String(url);
      if (!text.includes("q=")) {
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      }
      searchCalls.push(text);
      const pageData = pages[Math.min(searchCalls.length - 1, pages.length - 1)];
      // The server's offset counts matches, so page N starts at the number
      // of matched entries served so far.
      pageData.path = "";
      return { ok: true, status: 200, json: async () => pageData };
    },
  });

  // Open the picker, then filter.
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vm.runInContext("HerdrDirectoryPicker.filter('a')", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  equal(searchCalls.length, 1, "first search issues one request");
  match(searchCalls[0], /offset=0/);
  equal(vm.runInContext("__pickerDebug.state.entries.length", ctx), 1);
  equal(vm.runInContext("__pickerDebug.state.filterDone", ctx), false);

  // Simulate the user scrolling near the bottom of the tree.
  const tree = getElementById("directoryPickerModal").querySelector(".directory-picker-tree");
  tree.scrollTop = 1500;
  ctx.__tree = tree;
  await vm.runInContext("HerdrDirectoryPicker.treeScroll(__tree)", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(searchCalls.length, 2, "scroll near bottom fetches the next page");
  match(searchCalls[1], /offset=1&/, "offset counts matched entries served so far");
  equal(vm.runInContext("__pickerDebug.state.entries.length", ctx), 2, "appended page grows entries");

  // Scroll again: third page arrives and marks the search done.
  tree.scrollTop = 1500;
  ctx.__tree = tree;
  await vm.runInContext("HerdrDirectoryPicker.treeScroll(__tree)", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(searchCalls.length, 3);
  equal(vm.runInContext("__pickerDebug.state.entries.length", ctx), 3);
  equal(vm.runInContext("__pickerDebug.state.filterDone", ctx), true, "truncated=false ends paging");

  // No further fetches once done.
  tree.scrollTop = 1500;
  ctx.__tree = tree;
  await vm.runInContext("HerdrDirectoryPicker.treeScroll(__tree)", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(searchCalls.length, 3, "no fetch after the last page");
});

test("directory picker shows a Load more button while more results exist", async () => {
  const { ctx } = loadPicker({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ entries: [{ name: "b1", path: "b/1", kind: "dir", level: 0 }], truncated: true }),
    }),
  });
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  await ctx.HerdrDirectoryPicker.filter("b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  vm.runInContext("__pickerDebug.render()", ctx);
  const modal = ctx.document.getElementById("directoryPickerModal");
  match(modal.innerHTML, /Load more/);
  match(modal.innerHTML, /HerdrDirectoryPicker\.loadMore\(\)/);
  match(modal.innerHTML, /HerdrDirectoryPicker\.treeScroll\(this\)/);
});

test("directory picker Default dir button loads the configured default folder", async () => {
  const calls = [];
  const { ctx } = loadPicker({
    defaultFolder: "/Users/tester/projects",
    fetchImpl: async (url) => {
      calls.push(String(url));
      const pathMatch = /path=([^&]*)/.exec(String(url));
      const path = pathMatch ? decodeURIComponent(pathMatch[1].replace(/\+/g, " ")) : "";
      return { ok: true, status: 200, json: async () => ({ path, entries: [], truncated: false }) };
    },
  });
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  vm.runInContext("HerdrDirectoryPicker.defaultFolder()", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(vm.runInContext("__pickerDebug.state.root", ctx), "/");
  equal(vm.runInContext("__pickerDebug.state.path", ctx), "Users/tester/projects");
  match(calls[calls.length - 1], /cwd=%2F/);
  match(calls[calls.length - 1], /path=Users%2Ftester%2Fprojects/);

  // The action row renders the button next to Home and Select this folder.
  vm.runInContext("__pickerDebug.render()", ctx);
  const modal = ctx.document.getElementById("directoryPickerModal");
  match(modal.innerHTML, /Home<\/button><button class="git-ui-btn" onclick="HerdrDirectoryPicker\.defaultFolder\(\)">Default dir<\/button>/);
  // The tree scrolls are wired for incremental search results.
  match(modal.innerHTML, /onscroll="HerdrDirectoryPicker\.treeScroll\(this\)"/);
});

test("directory picker falls back to exploration default directory without the app bundle", async () => {
  const calls = [];
  const { ctx } = loadPicker({
    explorationDefault: "/home/tester/src",
    fetchImpl: async (url) => {
      calls.push(String(url));
      const pathMatch = /path=([^&]*)/.exec(String(url));
      const path = pathMatch ? decodeURIComponent(pathMatch[1].replace(/\+/g, " ")) : "";
      return { ok: true, status: 200, json: async () => ({ path, entries: [], truncated: false }) };
    },
  });
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  vm.runInContext("HerdrDirectoryPicker.defaultFolder()", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(vm.runInContext("__pickerDebug.state.root", ctx), "/");
  equal(vm.runInContext("__pickerDebug.state.path", ctx), "home/tester/src");
});

test("directory picker rejects filesystem root as a configured default", async () => {
  const calls = [];
  const { ctx } = loadPicker({
    defaultFolder: "/",
    fetchImpl: async (url) => {
      calls.push(String(url));
      const pathMatch = /path=([^&]*)/.exec(String(url));
      const path = pathMatch ? decodeURIComponent(pathMatch[1].replace(/\+/g, " ")) : "";
      return { ok: true, status: 200, json: async () => ({ path, entries: [], truncated: false }) };
    },
  });
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  vm.runInContext("HerdrDirectoryPicker.defaultFolder()", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(vm.runInContext("__pickerDebug.state.root", ctx), "~");
  equal(vm.runInContext("__pickerDebug.state.path", ctx), "");
  match(calls[calls.length - 1], /cwd=~/);
});

test("directory picker search paging resets when the filter changes", async () => {
  const calls = [];
  const { ctx } = loadPicker({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ entries: [{ name: "x", path: "x", kind: "dir", level: 0 }], truncated: true }),
      };
    },
  });
  await vm.runInContext("HerdrDirectoryPicker.openInput('someInput')", ctx);
  await vm.runInContext("HerdrDirectoryPicker.filter('first')", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vm.runInContext("HerdrDirectoryPicker.loadMore()", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Each page served one match, so the offset advanced by two matches.
  equal(vm.runInContext("__pickerDebug.state.filterOffset", ctx), 2);

  await vm.runInContext("HerdrDirectoryPicker.filter('second')", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lastCall = calls[calls.length - 1];
  match(lastCall, /q=second/);
  match(lastCall, /offset=0/);
  equal(vm.runInContext("__pickerDebug.state.entries.length", ctx), 1, "entries reset for the new term");
});
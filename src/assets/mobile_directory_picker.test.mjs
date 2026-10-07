// Behavior tests for the mobile directory picker (vm-loaded with stubs):
// field mode writes the target input, workspace mode opens the folder as a
// workspace, navigation/filter helpers, and the permission-error grant flow.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pickerSource = read("./mobile/directory_picker.js");

// Minimal DOM: enough nodes for the picker to create/look up its backdrop,
// sheet, and rows, and for tests to read the rendered innerHTML. Focus
// tracking mirrors the real DOM closely enough to pin the keyboard-keep
// behavior: document.activeElement is whatever the last focus() targeted.
function makeNode(id) {
  const node = {
    id,
    innerHTML: "",
    className: "",
    children: [],
    attrs: {},
    selectionStart: 0,
    focused: false,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    focus() {
      node.focused = true;
      activeElementRef.current = node;
    },
    setSelectionRange(start) {
      node.selectionStart = start;
    },
    onclick: null,
  };
  return node;
}

// Shared mutable ref so makeNode.focus() can update document.activeElement;
// the vm sandbox sees the same object the tests assert against.
const activeElementRef = { current: null };

function pickerContext({
  entries = [
    { name: "alpha", path: "Projects/alpha", is_dir: true },
    { name: "beta", path: "Projects/beta", is_dir: true },
    { name: "gamma", path: "Projects/gamma", is_dir: true },
  ],
  failTreeWith = null,
  failTreeOnceWith = null,
  failWorkspaceWith = null,
  accessResponse = {},
  openWorkspaceFn = undefined,
  onFieldPickFn = undefined,
  defaultFolder = "",
  fieldPath = "",
  treeGate = null,
} = {}) {
  const calls = { api: [], opens: [], renders: 0 };
  let treeFailedOnce = false;
  let filterNode = null;
  const allNodes = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    Math,
    Number,
    String,
    Error,
    Set,
    Map,
    Promise,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    history: { pushState: () => {} },
    document: {
      // Nodes get their id assigned after creation (like the real DOM), so
      // lookups must read the current .id instead of a creation-time map key.
      // innerHTML children are not real nodes in this stub; the picker's
      // focus-restore only ever targets the filter input, so synthesize a
      // node for it when the rendered markup contains it.
      getElementById: (id) => {
        const node = allNodes.find((n) => n.id === id);
        if (node) return node;
        const sheet = allNodes.find((n) => n.id === "mobileDirectoryPickerSheet");
        if (sheet && id === "mobileDirectoryPickerFilter" && sheet.innerHTML.includes('id="mobileDirectoryPickerFilter"')) {
          if (!filterNode) filterNode = makeNode(id);
          return filterNode;
        }
        return null;
      },
      createElement: (tag) => {
        const node = makeNode();
        node.tag = tag;
        allNodes.push(node);
        return node;
      },
      body: {
        // Track body children so tests can assert the picker sheet mounts as a
        // backdrop SIBLING (never inside the backdrop, where tap events would
        // bubble into backdrop.onclick = close).
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      },
      get activeElement() {
        return activeElementRef.current;
      },
    },
    _allNodes: allNodes,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(pickerSource, ctx);

  const state = {
    worktreeDiscoverPath: fieldPath,
    worktreePath: "",
    screen: "worktrees",
    session: "default",
  };
  const module = ctx.HerdrMobileDirectoryPickerModule.create({
    state,
    api: async (url, opts) => {
      calls.api.push({ url, opts });
      if (url.includes("/api/file-browser/tree")) {
        if (treeGate && url.includes(treeGate.match)) {
          // Hold this reply at the gate so the test controls landing order.
          return new Promise((resolve) => {
            treeGate.gate.pending.push({
              resolve: (data) => resolve(data || { entries: [] }),
            });
          });
        }
        if (failTreeWith) throw failTreeWith;
        if (failTreeOnceWith && !treeFailedOnce) {
          treeFailedOnce = true;
          throw failTreeOnceWith;
        }
        return { entries };
      }
      if (url.includes("/api/file-browser/request-access")) return accessResponse;
      if (url.includes("/api/recent-workspaces")) {
        if (failWorkspaceWith) throw failWorkspaceWith;
        return {
          result: {
            workspace: { workspace_id: "w-pick" },
            tab: { tab_id: "t-pick" },
            root_pane: { pane_id: "p-pick" },
          },
        };
      }
      return {};
    },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, "c"),
    inputAttrs: (hint) => ` autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no"${hint ? ` enterkeyhint="${hint}"` : ""}`,
    jsArg: (value) => JSON.stringify(value),
    render: () => {
      calls.renders++;
    },
    defaultFolderFn: () => defaultFolder,
    openWorkspaceFn,
    onFieldPickFn,
  });
  const findNode = (id) => allNodes.find((n) => n.id === id) || null;
  const getFilterNode = () => (allNodes.find((n) => n.id === "mobileDirectoryPickerSheet") || { innerHTML: "" }).innerHTML.includes('id="mobileDirectoryPickerFilter"') ? filterNode : null;
  const sheetHTML = () => (allNodes.find((n) => n.id === "mobileDirectoryPickerSheet") || { innerHTML: "" }).innerHTML;
  const bodyChildren = () => sandbox.document.body.children;
  return { module, state, calls, allNodes, findNode, getFilterNode, sheetHTML, bodyChildren };
}

describe("mobile directory picker module", () => {
  it("loads and exposes its API", () => {
    const { module } = pickerContext();
    assert.equal(typeof module.openForField, "function");
    assert.equal(typeof module.openForWorkspace, "function");
    assert.equal(typeof module.close, "function");
    assert.equal(typeof module.enter, "function");
    assert.equal(typeof module.up, "function");
    assert.equal(typeof module.home, "function");
    assert.equal(typeof module.defaultFolder, "function");
    assert.equal(typeof module.filter, "function");
    assert.equal(typeof module.selectCurrent, "function");
    assert.equal(typeof module.requestAccess, "function");
  });

  it("splitPath/joinPath mirror the desktop rules", () => {
    const { module } = pickerContext();
    const same = (actual, expected) => assert.deepEqual({ ...actual }, expected);
    same(module.splitPath(""), { root: "~", path: "" });
    same(module.splitPath("~"), { root: "~", path: "" });
    same(module.splitPath("~/Documents/code"), { root: "~", path: "Documents/code" });
    same(module.splitPath("/tmp/build"), { root: "/", path: "tmp/build" });
    same(module.splitPath("relative/thing"), { root: "~", path: "relative/thing" });
    assert.equal(module.joinPath("~", ""), "~");
    assert.equal(module.joinPath("~", "Projects/alpha"), "~/Projects/alpha");
    assert.equal(module.joinPath("/", ""), "/");
    assert.equal(module.joinPath("/", "tmp"), "/tmp");
    assert.equal(module.joinPath("/", "/tmp"), "/tmp");
  });

  it("field mode browses dirs_only, renders rows, and writes the chosen folder", async () => {
    const { module, state, calls, sheetHTML } = pickerContext({ fieldPath: "~/Documents" });
    module.openForField("worktreeDiscoverPath");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.api.length, 1);
    assert.match(calls.api[0].url, /\/api\/file-browser\/tree\?cwd=~&path=Documents&dirs_only=true/);
    const html = sheetHTML();
    assert.match(html, /mobile-directory-picker/);
    assert.match(html, /Choose folder for worktreeDiscoverPath/);
    assert.match(html, /Projects\/alpha/);
    assert.match(html, /Use this folder/);
    assert.match(html, /mobileDirectoryPickerFilter/);
    assert.ok(!/Grant folder access/.test(html), "no grant button without a permission error");

    await module.selectCurrent();
    assert.equal(state.worktreeDiscoverPath, "~/Documents");
    assert.equal(module._picker.active, false);
    assert.ok(calls.renders > 0, "confirm triggers a render so the input shows the new value");
  });

  it("mounts the sheet as a backdrop sibling so taps cannot bubble to close", async () => {
    // Regression: the sheet used to append INTO the backdrop, whose onclick
    // closes the picker. Every real tap inside the sheet (folder rows, Up,
    // Use this folder) bubbled up and dismissed the picker before its own
    // handler finished. In a real DOM the backdrop covers the screen, so a
    // bubbled tap always meant an instant close.
    const { module, bodyChildren } = pickerContext({ fieldPath: "~/Documents" });
    module.openForField("worktreeDiscoverPath");
    await new Promise((r) => setTimeout(r, 0));
    const ids = bodyChildren().map((n) => n.id);
    assert.ok(ids.includes("mobileDirectoryPickerBackdrop"), "backdrop is a body child");
    assert.ok(ids.includes("mobileDirectoryPickerSheet"), "sheet is a body child too");
    const backdrop = bodyChildren().find((n) => n.id === "mobileDirectoryPickerBackdrop");
    const sheet = bodyChildren().find((n) => n.id === "mobileDirectoryPickerSheet");
    assert.ok(!backdrop.children.includes(sheet), "sheet must not live inside the backdrop");
  });

  it("field-mode confirm chains onFieldPickFn so discovery can auto-run", async () => {
    const picks = [];
    const { module, state } = pickerContext({
      fieldPath: "~/Documents",
      onFieldPickFn: (field, folder) => picks.push({ field, folder }),
    });
    module.openForField("worktreeDiscoverPath");
    await new Promise((r) => setTimeout(r, 0));
    await module.selectCurrent();
    assert.equal(state.worktreeDiscoverPath, "~/Documents");
    assert.deepEqual(picks, [{ field: "worktreeDiscoverPath", folder: "~/Documents" }], "pick hook fires with field and confirmed folder");
    assert.equal(module._picker.active, false, "hook runs after the sheet is closed so app rendering owns the screen");
  });

  it("entering a row loads its path and Up walks back out", async () => {
    const { module, calls } = pickerContext();
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    module.enter(encodeURIComponent("Projects/alpha"));
    await new Promise((r) => setTimeout(r, 0));
    assert.match(calls.api[1].url, /path=Projects%2Falpha/);
    assert.equal(module.currentPath(), "~/Projects/alpha");

    module.up();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(calls.api[2].url, /path=Projects/);
    assert.equal(module.currentPath(), "~/Projects");
  });

  it("Up from home root jumps to filesystem root, then stops", async () => {
    const { module } = pickerContext();
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module._picker.root, "~");
    assert.equal(module._picker.path, "");
    module.up();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module._picker.root, "/");
    assert.equal(module.currentPath(), "/");
    module.up();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module.currentPath(), "/", "Up at filesystem root is a no-op");
  });

  it("Home and Default dir navigate to their targets", async () => {
    const { module, calls } = pickerContext({ defaultFolder: "~/Documents/code" });
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    module.enter(encodeURIComponent("Projects/alpha"));
    await new Promise((r) => setTimeout(r, 0));
    module.home();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module._picker.root, "~");
    assert.equal(module._picker.path, "");

    module.defaultFolder();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module._picker.root, "~");
    assert.equal(module._picker.path, "Documents/code");
    assert.match(calls.api[calls.api.length - 1].url, /path=Documents%2Fcode/);
  });

  it("filter narrows rows by name and path", async () => {
    const { module, sheetHTML } = pickerContext();
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    module.filter("alp");
    await new Promise((r) => setTimeout(r, 250));
    const html = sheetHTML();
    assert.match(html, /alpha/);
    assert.ok(!/beta/.test(html), "filter drops non-matching rows");
    assert.ok(!/gamma/.test(html));

    module.filter("");
    await new Promise((r) => setTimeout(r, 250));
    assert.match(sheetHTML(), /beta/, "clearing the filter restores rows");
  });

  it("permission errors show the Grant access button and requestAccess reloads", async () => {
    const permissionError = Object.assign(new Error("Folder access denied"), {
      details: { permission_required: true },
    });
    const { module, calls, sheetHTML } = pickerContext({
      // First tree load hits the permission wall; after granting access the
      // reload succeeds and the error state clears.
      failTreeOnceWith: permissionError,
    });
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    const html = sheetHTML();
    assert.match(html, /Folder access denied/);
    assert.match(html, /Grant folder access/);

    await module.requestAccess();
    assert.match(calls.api[1].url, /\/api\/file-browser\/request-access/);
    assert.equal(calls.api[1].opts.method, "POST");
    assert.deepEqual(JSON.parse(calls.api[1].opts.body), { cwd: "~", path: "" });
    assert.equal(calls.api.length, 3, "grant triggers a tree reload");
    assert.match(calls.api[2].url, /\/api\/file-browser\/tree/);
    assert.equal(module._picker.permissionRequired, false, "grant reload clears the error state");
  });

  it("workspace mode delegates to the wired openWorkspaceFn", async () => {
    const opens = [];
    const { module, calls, state } = pickerContext({
      defaultFolder: "~/Documents/code",
      openWorkspaceFn: async (folder) => opens.push(folder),
    });
    module.openForWorkspace();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(module._picker.mode, "workspace");
    assert.ok(calls.api.length >= 1);
    assert.match(calls.api[0].url, /path=Documents%2Fcode/, "workspace mode opens at the default folder");

    await module.selectCurrent();
    assert.deepEqual(opens, ["~/Documents/code"]);
    assert.equal(module._picker.active, false);
    assert.equal(state.screen, "worktrees", "workspace mode does not touch state itself; openWorkspaceFn owns navigation");
  });

  it("workspace mode falls back to POST /api/recent-workspaces and navigates", async () => {
    const { module, state, calls } = pickerContext({ defaultFolder: "~/src" });
    module.openForWorkspace();
    await new Promise((r) => setTimeout(r, 0));
    await module.selectCurrent();
    assert.equal(state.worktreeLoading, false);
    assert.equal(state.ws, "w-pick");
    assert.equal(state.tab, "t-pick");
    assert.equal(state.pane, "p-pick");
    assert.equal(state.screen, "terminal");
    const open = calls.api.find((c) => c.url.includes("/api/recent-workspaces"));
    assert.ok(open, "fallback posts to the recents open route");
    assert.equal(open.opts.method, "POST");
    assert.deepEqual(JSON.parse(open.opts.body), { path: "~/src", label: null });
  });

  it("workspace fallback surfaces API errors on the worktree screen", async () => {
    const boom = new Error("workspace exploded");
    const { module, state, calls } = pickerContext({ defaultFolder: "~/src", failWorkspaceWith: boom });
    module.openForWorkspace();
    await new Promise((r) => setTimeout(r, 0));
    await module.selectCurrent();
    assert.equal(state.worktreeLoading, false, "loading flag cleared on failure");
    assert.equal(state.worktreeError, "workspace exploded");
    assert.equal(state.screen, "worktrees", "stays on the worktree screen so the error is visible");
    assert.ok(calls.api.some((c) => c.url.includes("/api/recent-workspaces")));
  });

  it("stale tree responses never overwrite a newer navigation", async () => {
    // Enter alpha, whose reply is held at the gate; tap Up (fast, immediate
    // reply); only then let alpha's slow reply land. The listing must stay
    // on the parent (beta), not flip back to alpha's rows.
    const gate = { pending: [] };
    const { module, sheetHTML } = pickerContext({
      entries: [{ name: "beta", path: "Projects/beta", is_dir: true }],
      treeGate: { match: "alpha", gate },
    });
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    assert.match(sheetHTML(), /beta/, "parent listing loaded");

    module.enter(encodeURIComponent("Projects/alpha"));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(gate.pending.length, 1, "alpha request is held at the gate");
    assert.equal(module._picker.loading, true, "alpha load pending");

    module.up();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(sheetHTML(), /beta/, "Up's immediate reply wins while alpha is still in flight");
    assert.equal(module._picker.loading, false);

    // Alpha's stale reply finally lands; it must be discarded.
    gate.pending[0].resolve({ entries: [{ name: "alpha-child", path: "Projects/alpha/alpha-child", is_dir: true }] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!sheetHTML().includes("alpha-child"), "stale reply dropped, listing still the parent");
    assert.equal(module.currentPath(), "~/Projects", "path tracks the newest navigation");
  });

  it("filter keeps focus and caret across re-renders", async () => {
    const { module, getFilterNode } = pickerContext();
    module.openForField("worktreePath");
    await new Promise((r) => setTimeout(r, 0));
    const filter = getFilterNode();
    assert.ok(filter, "filter input exists after open");
    // Simulate the user focusing the filter and typing (focus + caret move).
    filter.focus();
    filter.selectionStart = 3;
    module.filter("alp");
    await new Promise((r) => setTimeout(r, 250));
    const after = getFilterNode();
    assert.ok(after, "filter still rendered after re-render");
    assert.equal(after.focused, true, "focus restored to the filter input");
    assert.equal(after.selectionStart, 3, "caret position restored");
  });
});
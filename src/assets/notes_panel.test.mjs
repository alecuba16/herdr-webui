// Shared notes panel (Notes rail view) behavior tests. Pins:
//   - open hosts the panel into #rightSidebarContent, remembers the "notes"
//     shell mode, and expands a collapsed column on a rail click
//   - list render: rows render in the server's arrival order (the server
//     sorts newest-first; the client must not re-sort), titles come from
//     the server's display_title, clear-all only with notes, per-row
//     open/delete wiring
//   - editing: row click mounts the editor with the per-note language path
//     resolved through the server-provided language table
//   - create: the server names the created note (created_note_id) and the
//     client opens exactly that note
//   - remote apply: no-op while closed, repaint while hosted, and while
//     editing the local note wins (no editor remount, other clients'
//     notes still land in the list behind); frames also adopt the server
//     language table
//   - cleanup: per-note delete is confirm-free, clear-all rides the danger
//     confirm, both hit the API and adopt the snapshot
//   - close flushes a pending debounced save instead of dropping it
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Mirror of the server's language table (src/notes.rs NOTE_LANGUAGES):
// value, label, editor extension. Tests exercise the client against the
// same shape the API and notes_changed frames carry.
const SERVER_LANGUAGES = [
  { value: "txt", label: "Text", ext: "txt" },
  { value: "markdown", label: "Markdown", ext: "md" },
  { value: "javascript", label: "JavaScript", ext: "js" },
  { value: "typescript", label: "TypeScript", ext: "ts" },
  { value: "rust", label: "Rust", ext: "rs" },
  { value: "python", label: "Python", ext: "py" },
  { value: "go", label: "Go", ext: "go" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "yaml", label: "YAML", ext: "yaml" },
  { value: "css", label: "CSS", ext: "css" },
  { value: "html", label: "HTML", ext: "html" },
  { value: "xml", label: "XML", ext: "xml" },
  { value: "java", label: "Java", ext: "java" },
  { value: "sql", label: "SQL", ext: "sql" },
];

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    hidden: false,
    attributes: {},
    onclick: null,
    onchange: null,
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name] != null ? node.attributes[name] : null;
    },
    appendChild(child) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (node.parentNode) {
        const at = node.parentNode.children.indexOf(node);
        if (at >= 0) node.parentNode.children.splice(at, 1);
        node.parentNode = null;
      }
    },
    matchesAttribute(attr) {
      const wantClass = attr.startsWith(".") ? attr.slice(1) : null;
      if (wantClass) {
        return String(node.className)
          .split(/\s+/)
          .includes(wantClass);
      }
      return node.attributes[attr] != null;
    },
    querySelector(selector) {
      const wantId = selector.startsWith("#") ? selector.slice(1) : null;
      const attr = selector.startsWith("[") && selector.endsWith("]") ? selector.slice(1, -1) : null;
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const walk = (n) => {
        for (const child of n.children) {
          if (wantId && child.id === wantId) return child;
          if (attr && child.matchesAttribute(attr)) return child;
          if (wantClass && child.matchesAttribute("." + wantClass)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
    querySelectorAll(selector) {
      const attr = selector.startsWith("[") && selector.endsWith("]") ? selector.slice(1, -1) : null;
      const wantId = selector.startsWith("#") ? selector.slice(1) : null;
      const out = [];
      const walk = (n) => {
        for (const child of n.children) {
          if (attr && child.matchesAttribute(attr)) out.push(child);
          if (wantId && child.id === wantId) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    },
  };
  Object.defineProperty(node, "childNodes", {
    get() {
      return node.children;
    },
  });
  return node;
}

function buildDom() {
  const body = makeNode("body", "");
  const app = makeNode("app", "");
  const content = makeNode("rightSidebarContent", "right-sidebar-content");
  app.appendChild(content);
  body.appendChild(app);
  const nodes = { body, app, rightSidebarContent: content };
  // innerHTML replaces child nodes; parse the ids and note rows the panel
  // markup carries so getElementById/querySelector and the wiring pass
  // behave like the DOM.
  const parseInnerHtml = (host, html) => {
    host.children.length = 0;
    const seen = new Set();
    const idRegex = /id="([^"]+)"/g;
    let match;
    while ((match = idRegex.exec(html))) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const child = makeNode(id, "");
      if (id === "notesTitleInput") child.addEventListener = (type, fn) => { child.__changeListener = fn; };
      if (id === "notesLanguage") {
        // A real <select> resolves value from its selected option.
        const selected = /<option value="([^"]*)" selected>/.exec(html);
        child.value = selected ? selected[1] : "";
      }
      nodes[id] = child;
      host.appendChild(child);
    }
    const rowRegex = /<li[^>]*data-notes-open="([^"]*)"[^>]*>/g;
    while ((match = rowRegex.exec(html))) {
      const row = makeNode("", "notes-row");
      row.setAttribute("data-notes-open", match[1]);
      const segment = html.slice(match.index, match.index + 600);
      const deleteId = /data-notes-delete="([^"]*)"/.exec(segment);
      if (deleteId) {
        const button = makeNode("", "notes-row-delete");
        button.setAttribute("data-notes-delete", deleteId[1]);
        row.appendChild(button);
      }
      host.appendChild(row);
    }
  };
  const document = {
    activeElement: null,
    hidden: false,
    __listeners: {},
    addEventListener(type, handler) {
      const list = this.__listeners[type] || (this.__listeners[type] = []);
      list.push(handler);
    },
    createElement: () => {
      const node = makeNode("", "");
      let id = "";
      let inner = "";
      Object.defineProperty(node, "id", {
        get: () => id,
        set: (value) => {
          id = String(value);
          nodes[id] = node;
        },
      });
      Object.defineProperty(node, "innerHTML", {
        get: () => inner,
        set: (html) => {
          inner = String(html);
          parseInnerHtml(node, inner);
        },
      });
      return node;
    },
    getElementById: (id) => (nodes[id] ? nodes[id] : null),
  };
  return { nodes, document };
}

function loadPanel(document, ctxOverrides = {}) {
  const calls = { api: [], confirm: [], editorMounts: 0 };
  const ctx = {
    document,
    setTimeout: (fn) => {
      ctx.__pendingTimers.push(fn);
      return ctx.__pendingTimers.length;
    },
    clearTimeout: (t) => {
      if (t) ctx.__pendingTimers[t - 1] = null;
    },
    // Interval harness mirrors the timer one: callbacks park in a list so
    // tests fire ticks on demand instead of waiting wall-clock seconds.
    setInterval: (fn) => {
      ctx.__pendingIntervals.push(fn);
      return ctx.__pendingIntervals.length;
    },
    clearInterval: (id) => {
      if (id) {
        ctx.__pendingIntervals[id - 1] = null;
        ctx.__clearedIntervals += 1;
      }
    },
    state: { ws: "ws-1", workspaces: [], workspaceShell: {} },
    api: async (url, opts) => {
      calls.api.push({ url, opts });
      if (ctx.__apiReject && ctx.__apiReject.test(url)) {
        throw new Error(ctx.__apiRejectMessage || "request failed");
      }
      return ctx.__apiResponse || { notes: [] };
    },
    askQuestion: async (opts) => {
      calls.confirm.push(opts);
      return ctx.__confirmResult !== false;
    },
    alert: () => {},
    inputAttrs: (hint) => ` autocomplete="off" spellcheck="false" enterkeyhint="${hint}"`,
    rememberWorkspaceShellMode: (mode, id) => {
      ctx.__remembered = { mode, id };
    },
    render: () => {},
    HerdrRightSidebar: {
      collapsed: () => ctx.__collapsed === true,
      setCollapsed: (v) => {
        ctx.__collapsed = v;
      },
      openView: async (mode, id, ensurePanel) => {
        const panel = ensurePanel();
        const host = document.getElementById("rightSidebarContent");
        if (host && panel && panel.parentNode !== host) host.appendChild(panel);
        return "hosted";
      },
      afterDrawerRender: () => {},
      isHosted: (id) => {
        const host = document.getElementById("rightSidebarContent");
        const panel = document.getElementById(id);
        return !!(host && panel && panel.parentNode === host);
      },
    },
    HerdrEditor: {
      create(opts) {
        calls.editorMounts += 1;
        ctx.__editorOpts = opts;
        opts.parent._herdrEditorApi = {
          getValue: () => ctx.__editorValue || "",
        };
        return opts.parent._herdrEditorApi;
      },
    },
    ...ctxOverrides,
  };
  ctx.__pendingTimers = [];
  ctx.__pendingIntervals = [];
  ctx.__clearedIntervals = 0;
  ctx.__calls = calls;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const source = readFileSync(new URL("./desktop/notes.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));
  return ctx;
}

function rowNodes(panel) {
  return panel.querySelectorAll("[data-notes-open]");
}

function deleteButtons(panel) {
  return panel.querySelectorAll("[data-notes-delete]");
}

test("open hosts the panel, remembers notes mode, and expands a collapsed column", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__collapsed = true;

  await ctx.HerdrNotesPanel.open("ws-1", {});

  assert.equal(ctx.__remembered.mode, "notes", "open remembers the notes shell mode");
  const panel = nodes.notesPanel;
  assert.ok(panel, "panel created and registered");
  assert.equal(panel.parentNode, nodes.rightSidebarContent, "panel hosted in the sidebar column");
  assert.equal(ctx.__collapsed, false, "rail click expands the column");
});

test("the list renders rows in the server's arrival order without re-sorting", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  // Arrival order deliberately differs from updated_at order: if the client
  // still sorted, the second row would jump to the front.
  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [
      { id: "first-arrival", title: "first", content: "", language: "txt", updated_at: 1000, updated_by: "user", display_title: "first" },
      { id: "second-arrival", title: "second", content: "", language: "rust", updated_at: 2000, updated_by: "user", display_title: "second" },
    ],
  };

  await ctx.HerdrNotesPanel.open("ws-1", {});

  const panel = nodes.notesPanel;
  const html = panel.innerHTML;
  assert.ok(html.includes('id="notesNew"'), "new-note button present");
  assert.ok(html.includes('id="notesClear"'), "clear-all button present when notes exist");
  const rows = rowNodes(panel);
  assert.equal(rows.length, 2, "both rows rendered");
  assert.equal(rows[0].getAttribute("data-notes-open"), "first-arrival", "rows keep the server's order");
  assert.equal(rows[1].getAttribute("data-notes-open"), "second-arrival", "no client-side re-sort");
  assert.ok(html.includes("first") && html.includes("second"), "server display titles render");
  assert.equal(deleteButtons(panel).length, 2, "per-row delete present");
});

test("clear-all hides when there are no notes", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);

  await ctx.HerdrNotesPanel.open("ws-1", {});

  const html = nodes.notesPanel.innerHTML;
  assert.ok(!html.includes('id="notesClear"'), "no clear-all on an empty list");
  assert.ok(html.includes("No notes yet"), "empty state copy present");
});

test("opening a note mounts the editor with the server-resolved language path", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [{ id: "n1", title: "t", content: "fn main() {}", language: "rust", updated_at: 1000, updated_by: "user", display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});

  const panel = nodes.notesPanel;
  const rows = rowNodes(panel);
  assert.equal(typeof rows[0].onclick, "function", "row click wired");
  rows[0].onclick();

  assert.ok(panel.innerHTML.includes("Rust</option>"), "select options build from the server language table");

  assert.equal(ctx.__editorOpts.path, "note.rs", "editor path uses the server-provided rs extension");
  assert.equal(ctx.__editorOpts.content, "fn main() {}", "editor seeds note content");
  assert.equal(ctx.__editorOpts.readonly, false, "editor is editable");
  assert.equal(typeof ctx.__editorOpts.onChange, "function", "onChange captured");
  assert.equal(nodes.notesTitleInput.value, "t", "title input seeded");
  assert.equal(nodes.notesLanguage.value, "rust", "language select reflects the note's language");
});

test("createNote opens exactly the note the server says it created", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});

  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    created_note_id: "n9",
    notes: [{ id: "n9", title: "", content: "", language: "txt", updated_at: 5000, updated_by: "user", display_title: "Untitled" }],
  };
  await ctx.HerdrNotesPanel.createNote();

  const post = ctx.__calls.api.find((c) => c.url === "/api/notes" && c.opts && c.opts.method === "POST");
  assert.ok(post, "POST /api/notes issued");
  assert.equal(post.opts.body, JSON.stringify({ title: "", content: "", language: "txt" }), "create body is the empty note");
  assert.ok(nodes.notesPanel.querySelector("#notesTitleInput"), "the created note's editing view hosts");
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted for the created note");
  // The panel went straight into editing for the server-named id, not a
  // locally guessed "latest" note.
  assert.ok(!nodes.notesPanel.innerHTML.includes("No notes yet"), "list view replaced by the editor");
});

test("per-note delete is confirm-free and wired through the row button", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});

  const buttons = deleteButtons(nodes.notesPanel);
  assert.equal(buttons.length, 1, "delete button rendered");
  ctx.__apiResponse = { notes: [] };
  buttons[0].onclick({ stopPropagation() {} });
  // The row onclick fire-and-forgets the delete promise (same as the real
  // DOM); drain the microtask chain before asserting on the repaint.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.__calls.confirm.length, 0, "per-note delete asks nothing");
  const del = ctx.__calls.api.find((c) => c.url === "/api/notes/n1" && c.opts && c.opts.method === "DELETE");
  assert.ok(del, "DELETE issued for the note id");
  assert.ok(nodes.notesPanel.innerHTML.includes("No notes yet"), "list adopted the emptied snapshot");
});

test("clear-all rides the danger confirm and adopts the emptied snapshot", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});

  ctx.__apiResponse = { notes: [] };
  await ctx.HerdrNotesPanel.clearAll();

  assert.equal(ctx.__calls.confirm.length, 1, "clear-all asks once");
  assert.equal(ctx.__calls.confirm[0].danger, true, "confirm is the danger modal");
  const clearCall = ctx.__calls.api.find((c) => c.url === "/api/notes/clear");
  assert.ok(clearCall, "clear POST issued");
  assert.ok(nodes.notesPanel.innerHTML.includes("No notes yet"), "list emptied after clear");
});

test("clear-all cancels cleanly when the confirm is rejected", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  ctx.__confirmResult = false;

  await ctx.HerdrNotesPanel.clearAll();

  assert.equal(ctx.__calls.api.length, 1, "only the initial GET ran, no clear POST");
  assert.ok(nodes.notesPanel.innerHTML.includes('data-notes-open="n1"'), "note survives a rejected confirm");
});

test("applyRemote is a no-op while closed and repaints while hosted", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);

  // Closed panel: the frame must not mount anything.
  ctx.HerdrNotesPanel.applyRemote([
    { id: "x", title: "ghost", content: "", language: "txt", updated_at: 1, updated_by: "", display_title: "ghost" },
  ]);
  assert.ok(!nodes.notesPanel, "closed panel did not mount anything");

  await ctx.HerdrNotesPanel.open("ws-1", {});
  const panel = nodes.notesPanel;
  assert.ok(panel, "panel open");

  ctx.HerdrNotesPanel.applyRemote([
    { id: "x", title: "ghost", content: "", language: "txt", updated_at: 1, updated_by: "", display_title: "ghost" },
  ]);
  assert.ok(panel.innerHTML.includes("ghost"), "hosted panel adopted the remote snapshot");

  ctx.HerdrNotesPanel.close();
  const htmlBefore = panel.innerHTML;
  ctx.HerdrNotesPanel.applyRemote([]);
  assert.equal(panel.innerHTML, htmlBefore, "closed panel ignores further frames");
});

test("applyRemote while editing keeps the editor mounted and the local note", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "mine", content: "draft", language: "txt", updated_at: 1000, updated_by: "user", display_title: "mine" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");
  const htmlWhileEditing = nodes.notesPanel.innerHTML;

  // Another client rewrites everything including our note, and adds a note.
  ctx.HerdrNotesPanel.applyRemote([
    { id: "n1", title: "theirs", content: "remote rewrite", language: "txt", updated_at: 5000, updated_by: "other", display_title: "theirs" },
    { id: "n2", title: "other client", content: "", language: "txt", updated_at: 4000, updated_by: "other", display_title: "other client" },
  ]);

  assert.equal(ctx.__calls.editorMounts, 1, "no editor remount on a remote frame");
  assert.equal(nodes.notesPanel.innerHTML, htmlWhileEditing, "editing view untouched by the frame");

  // Back to the list: the other client's note landed, ours is the local copy.
  await nodes.notesBack.onclick();
  const html = nodes.notesPanel.innerHTML;
  assert.ok(html.includes("other client"), "other client's note adopted into the list");
  assert.ok(html.includes("mine"), "local note kept while it was being edited");
  assert.ok(!html.includes("theirs"), "stale remote copy of the edited note discarded");
});

test("close flushes a pending debounced save instead of dropping it", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "draft", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();

  // Type twice: the debounce must coalesce both into one save.
  ctx.__editorValue = "typed draft";
  ctx.__editorOpts.onChange("typed draft");
  ctx.__editorValue = "typed draft more";
  ctx.__editorOpts.onChange("typed draft more");

  ctx.__apiResponse = { notes: [{ id: "n1", title: "t", content: "typed draft more", language: "txt", updated_at: 2000, updated_by: "user" , display_title: "t" }] };
  await ctx.HerdrNotesPanel.close();

  const puts = ctx.__calls.api.filter((c) => c.url === "/api/notes/n1" && c.opts && c.opts.method === "PUT");
  assert.equal(puts.length, 1, "exactly one PUT after the debounce window");
  assert.equal(puts[0].opts.body, JSON.stringify({ content: "typed draft more" }), "flush sends the editor text");
});

test("the back button flushes only when an edit is pending", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "draft", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();

  // No edits: going back must not PUT (and must not bump updated_at).
  await nodes.notesBack.onclick();
  const puts = ctx.__calls.api.filter((c) => c.url === "/api/notes/n1" && c.opts && c.opts.method === "PUT");
  assert.equal(puts.length, 0, "no spurious PUT without edits");
  assert.ok(nodes.notesPanel.innerHTML.includes('data-notes-open="n1"'), "back returns to the list");

  // With a pending edit, back must save it.
  rowNodes(nodes.notesPanel)[0].onclick();
  ctx.__editorValue = "typed";
  ctx.__editorOpts.onChange("typed");
  await nodes.notesBack.onclick();
  const putsAfter = ctx.__calls.api.filter((c) => c.url === "/api/notes/n1" && c.opts && c.opts.method === "PUT");
  assert.equal(putsAfter.length, 1, "pending edit flushed on back");
  assert.equal(putsAfter[0].opts.body, JSON.stringify({ content: "typed" }), "flush sends the editor text");
});
test("a failed content save surfaces the error and stays dirty for retry", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "draft", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  const editorApi = nodes.notesPanel._herdrEditorApi;

  // The PUT fails (note deleted remotely, 500, ...).
  ctx.__apiReject = /\/api\/notes\/n1$/;
  ctx.__apiRejectMessage = "note not found";
  ctx.__editorValue = "typed";
  ctx.__editorOpts.onChange("typed");
  // Fire the debounced flush manually and let the PUT settle.
  const flush = ctx.__pendingTimers[ctx.__pendingTimers.length - 1];
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(nodes.notesSaveState.textContent, "Save failed", "state button shows the failure");
  const errorNode = nodes.notesPanel.querySelector(".notes-editor-error");
  assert.ok(errorNode, "editor view paints the error");
  assert.equal(errorNode.textContent, "note not found");
  // The edit stays dirty: no editor remount (no innerHTML wipe) happened.
  assert.equal(nodes.notesPanel._herdrEditorApi, editorApi, "editor stayed mounted");

  // Back must retry the flush because the save is still pending.
  ctx.__apiReject = null;
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "typed", language: "txt", updated_at: 2000, updated_by: "user" , display_title: "t" }],
  };
  await nodes.notesBack.onclick();
  const puts = ctx.__calls.api.filter((c) => c.url === "/api/notes/n1" && c.opts && c.opts.method === "PUT");
  assert.equal(puts.length, 2, "back retried the failed save");
  assert.equal(puts[1].opts.body, JSON.stringify({ content: "typed" }), "retry sends the same text");
});

test("a successful retry clears the error and the dirty sentinel", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "draft", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();

  ctx.__apiReject = /\/api\/notes\/n1$/;
  ctx.__editorValue = "typed";
  ctx.__editorOpts.onChange("typed");
  const flush = ctx.__pendingTimers[ctx.__pendingTimers.length - 1];
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(nodes.notesPanel.querySelector(".notes-editor-error"), "error painted after failure");

  // Next edit saves cleanly: error and sentinel must clear.
  ctx.__apiReject = null;
  ctx.__editorOpts.onChange("typed more");
  const flush2 = ctx.__pendingTimers[ctx.__pendingTimers.length - 1];
  await flush2();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes.notesSaveState.textContent, "Saved", "state button returns to Saved");
  assert.equal(nodes.notesPanel.querySelector(".notes-editor-error"), null, "error node removed");
});

test("a failed title save surfaces the error without remounting the editor", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "draft", language: "txt", updated_at: 1000, updated_by: "user" , display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  const editorApi = nodes.notesPanel._herdrEditorApi;

  ctx.__apiReject = /\/api\/notes\/n1$/;
  ctx.__apiRejectMessage = "boom";
  nodes.notesTitleInput.value = "new title";
  nodes.notesTitleInput.__changeListener();

  // The title PUT is async: let it settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes.notesSaveState.textContent, "Save failed", "title failure reaches the state button");
  const errorNode = nodes.notesPanel.querySelector(".notes-editor-error");
  assert.ok(errorNode, "title failure paints the error");
  assert.equal(nodes.notesPanel._herdrEditorApi, editorApi, "editor stayed mounted through the failure");
});

test("the editor mounts headerless for notes", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "t", content: "body", language: "txt", updated_at: 1, updated_by: "", display_title: "t" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");
  assert.equal(ctx.__editorOpts.hideHeader, true, "notes editor mounts without the file header");
  assert.ok(!nodes.notesPanel.innerHTML.includes("herdr-editor-head"), "no note.txt/txt header row");
  assert.ok(!nodes.notesPanel.innerHTML.includes("note.txt"), "no fake filename in the markup");
});

test("open starts the resync interval, close stops it", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  assert.equal(ctx.__pendingIntervals.length, 1, "one resync interval scheduled");
  assert.equal(ctx.__clearedIntervals, 0, "interval not cleared while open");

  ctx.HerdrNotesPanel.close();
  assert.equal(ctx.__clearedIntervals, 1, "close cleared the resync interval");

  await ctx.HerdrNotesPanel.open("ws-1", {});
  assert.equal(ctx.__pendingIntervals.filter(Boolean).length, 1, "reopen schedules a fresh interval");
});

test("resync ticks fetch the list and repaint the list view", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = { notes: [] };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  assert.ok(nodes.notesPanel.innerHTML.includes("No notes yet"), "starts empty");

  ctx.__apiResponse = {
    notes: [{ id: "x", title: "from tick", content: "", language: "txt", updated_at: 5, updated_by: "", display_title: "from tick" }],
  };
  const tick = ctx.__pendingIntervals[0];
  await tick();
  assert.ok(nodes.notesPanel.innerHTML.includes("from tick"), "interval tick adopted the fresh snapshot");
});

test("resync skips while hidden, collapsed, or while a sync is in flight", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  const apiCallsBefore = ctx.__calls.api.length;

  document.hidden = true;
  await ctx.__pendingIntervals[0]();
  assert.equal(ctx.__calls.api.length, apiCallsBefore, "hidden tab skipped the tick");

  document.hidden = false;
  ctx.__collapsed = true;
  await ctx.__pendingIntervals[0]();
  assert.equal(ctx.__calls.api.length, apiCallsBefore, "collapsed column skipped the tick");
  ctx.__collapsed = false;

  // In-flight guard: the first tick hangs on the api; the second must
  // skip instead of stacking a second request.
  let resolveApi;
  ctx.api = async () => new Promise((resolve) => { resolveApi = resolve; });
  const first = ctx.__pendingIntervals[0]();
  const callsAtFirst = ctx.__calls.api.length;
  const second = ctx.__pendingIntervals[0]();
  assert.equal(ctx.__calls.api.length, callsAtFirst, "second tick skipped while the first sync was in flight");
  resolveApi({ notes: [] });
  await first;
  await second;
});

test("the sync button click forces a fetch past the guards", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  const apiCallsBefore = ctx.__calls.api.length;

  document.hidden = true;
  await nodes.notesSync.onclick();
  assert.equal(ctx.__calls.api.length, apiCallsBefore + 1, "manual sync ignores the hidden guard");
  document.hidden = false;
});

test("a failed resync paints the sync button failed and the retry recovers", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  const sync = nodes.notesSync;

  ctx.__apiReject = { test: (url) => url.includes("/api/notes") };
  await sync.onclick();
  assert.equal(sync.className, "mini notes-sync failed", "failed state painted");
  assert.equal(sync.title, "Sync failed. Click to retry.", "failed title painted");
  assert.equal(sync.disabled, false, "failed sync stays clickable");

  ctx.__apiReject = null;
  await sync.onclick();
  // The successful sync repaints the panel, so the button node is fresh.
  const fresh = nodes.notesSync;
  assert.equal(fresh.className, "mini notes-sync", "retry recovered to idle");
  assert.equal(fresh.disabled, false, "idle stays clickable");
});

test("spinning state disables the sync button while a sync runs", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  const sync = nodes.notesSync;

  let resolveApi;
  ctx.api = async () => new Promise((resolve) => { resolveApi = resolve; });
  const inflight = sync.onclick();
  assert.equal(sync.className, "mini notes-sync spinning", "spinning while in flight");
  assert.equal(sync.disabled, true, "button disabled while spinning");
  resolveApi({ notes: [] });
  await inflight;
  // The repaint replaced the sync button node; read the fresh one.
  const fresh = nodes.notesSync;
  assert.equal(fresh.className, "mini notes-sync", "back to idle after");
  assert.equal(fresh.disabled, false, "re-enabled after");
});

test("visibilitychange triggers a catch-up sync when the tab returns", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  await ctx.HerdrNotesPanel.open("ws-1", {});
  const apiCallsBefore = ctx.__calls.api.length;

  const listeners = document.__listeners.visibilitychange || [];
  assert.equal(listeners.length, 1, "one visibility listener wired");
  // hidden -> the listener must not fire a sync
  document.hidden = true;
  await listeners[0]();
  assert.equal(ctx.__calls.api.length, apiCallsBefore, "no sync while still hidden");
  document.hidden = false;
  await listeners[0]();
  assert.equal(ctx.__calls.api.length, apiCallsBefore + 1, "returning to the tab synced at once");
});

test("syncNotes merges snapshots exactly like applyRemote", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "mine", content: "draft", language: "txt", updated_at: 1000, updated_by: "user", display_title: "mine" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");
  const htmlWhileEditing = nodes.notesPanel.innerHTML;

  // Same merge semantics as the broadcast path: local edited note wins,
  // no repaint while editing.
  ctx.__apiResponse = {
    notes: [
      { id: "n1", title: "theirs", content: "remote rewrite", language: "txt", updated_at: 5000, updated_by: "other", display_title: "theirs" },
      { id: "n2", title: "other client", content: "", language: "txt", updated_at: 4000, updated_by: "other", display_title: "other client" },
    ],
  };
  await nodes.notesSync.onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "no remount during an editing sync");
  assert.equal(nodes.notesPanel.innerHTML, htmlWhileEditing, "editing view untouched by the sync");
});

test("an externally deleted note closes a clean editor but not a dirty one", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [
      { id: "n1", title: "keep", content: "", language: "txt", updated_at: 1, updated_by: "", display_title: "keep" },
      { id: "n2", title: "victim", content: "v", language: "txt", updated_at: 2, updated_by: "", display_title: "victim" },
    ],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[1].onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");

  // Clean edit + note deleted remotely: the edit view closes.
  ctx.__apiResponse = {
    notes: [{ id: "n1", title: "keep", content: "", language: "txt", updated_at: 3, updated_by: "", display_title: "keep" }],
  };
  ctx.HerdrNotesPanel.applyRemote(
    { notes: [{ id: "n1", title: "keep", content: "", language: "txt", updated_at: 3, updated_by: "", display_title: "keep" }] }
  );
  assert.ok(!nodes.notesPanel.innerHTML.includes("notes-editor"), "clean editor closed after external delete");
  assert.ok(nodes.notesPanel.innerHTML.includes("keep"), "list repainted without the deleted note");

  // Dirty edit + note deleted remotely: the editor stays.
  rowNodes(nodes.notesPanel)[0].onclick();
  assert.equal(ctx.__calls.editorMounts, 2, "editor mounted again");
  // The real dirty signal: the editor reports a change, the debounce
  // parks a pending save.
  ctx.__editorOpts.onChange("unsaved typing");
  ctx.__apiResponse = { notes: [] };
  ctx.HerdrNotesPanel.applyRemote({ notes: [] });
  assert.ok(nodes.notesPanel.innerHTML.includes("notes-editor"), "dirty editor survived the external delete");
});

test("syncNotes closes a clean editor on an externally deleted note", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__apiResponse = {
    notes: [{ id: "n2", title: "victim", content: "v", language: "txt", updated_at: 2, updated_by: "", display_title: "victim" }],
  };
  await ctx.HerdrNotesPanel.open("ws-1", {});
  rowNodes(nodes.notesPanel)[0].onclick();
  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");

  ctx.__apiResponse = { notes: [] };
  await nodes.notesSync.onclick();
  assert.ok(!nodes.notesPanel.innerHTML.includes("notes-editor"), "sync closed the clean ghost edit");
  assert.ok(nodes.notesPanel.innerHTML.includes("No notes yet"), "list shows the emptied state");
});

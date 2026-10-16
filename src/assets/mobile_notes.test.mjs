// Mobile Notes screen unit tests. The module loads in a vm with a fake
// deps surface (api/confirm/escapeHtml/inputAttrs/render) plus a minimal
// document, so the drawer-screen flow runs without the mobile shell.
// Pins:
//   - renderScreen: list rows newest-first as the server sends them,
//     empty state, sync/new/clear-all wiring, no clear-all without notes
//   - create: opens exactly the server-named note (created_note_id)
//   - open: mounts the headerless editor with the language-resolved path
//     and schedules debounced saves through the editor onChange
//   - delete: confirm-free per-row delete hits the API and adopts the
//     snapshot; deleting the open note closes the editor
//   - clear-all: danger confirm rides the shared confirm sheet
//   - sync: manual sync adopts incoming snapshots; while editing a note
//     that still exists remotely the local copy wins (no remount), a note
//     deleted remotely with nothing dirty closes the editor, dirty edits
//     keep the local note pinned
//   - resync timer: enter arms the 15s interval only once, leave stops
//     it and flushes a pending save
//   - applyRemote: ignores frames while the screen is closed
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SERVER_LANGUAGES = [
  { value: "txt", label: "Text", ext: "txt" },
  { value: "markdown", label: "Markdown", ext: "md" },
  { value: "rust", label: "Rust", ext: "rs" },
];

function makeScreen(html, nodes) {
  // Minimal parse: ids become stub nodes so getElementById works after a
  // render; row ids ride data passed through the row onclick arg.
  const section = { id: "mobileNotesScreen", innerHTML: html, children: [], parentNode: {} };
  const idRegex = /id="([^"]+)"/g;
  let match;
  while ((match = idRegex.exec(html))) {
    if (nodes[match[1]]) continue;
    nodes[match[1]] = {
      id: match[1],
      innerHTML: "",
      textContent: "",
      focus() {},
      disabled: false,
    };
  }
  nodes.mobileNotesScreen = section;
  return section;
}

function loadModule(overrides = {}) {
  const calls = { api: [], confirm: [], renders: 0, editorMounts: 0 };
  const nodes = {};
  const ctx = {
    document: {
      hidden: false,
      getElementById: (id) => nodes[id] || null,
    },
    setTimeout: (fn) => {
      ctx.__pendingTimers.push(fn);
      return ctx.__pendingTimers.length;
    },
    clearTimeout: (id) => {
      if (id) ctx.__pendingTimers[id - 1] = null;
    },
    setInterval: (fn) => {
      ctx.__pendingIntervals.push(fn);
      return ctx.__pendingIntervals.length;
    },
    clearInterval: (id) => {
      if (id) ctx.__clearedIntervals += 1;
    },
    api: async (url, opts) => {
      calls.api.push({ url, opts });
      if (ctx.__apiReject && ctx.__apiReject.test(url)) {
        throw new Error("request failed");
      }
      return ctx.__apiResponse || { notes: [], languages: SERVER_LANGUAGES };
    },
    confirm: async (message) => {
      calls.confirm.push(message);
      return ctx.__confirmResult !== false;
    },
    escapeHtml: (v) =>
      String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    inputAttrs: (hint) => ` autocomplete="off" enterkeyhint="${hint}"`,
    render: () => {
      calls.renders += 1;
    },
    HerdrEditor: {
      create(opts) {
        calls.editorMounts += 1;
        ctx.__editorOpts = opts;
        const api = {
          getValue: () => ctx.__editorValue || "",
        };
        opts.parent._api = api;
        return api;
      },
    },
    ...overrides,
  };
  ctx.__pendingTimers = [];
  ctx.__pendingIntervals = [];
  ctx.__clearedIntervals = 0;
  ctx.__calls = calls;
  ctx.__nodes = nodes;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const source = readFileSync(new URL("./mobile/notes.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));
  ctx.__module = ctx.HerdrMobileNotesModule;
  return ctx;
}

function makeNotes(ctx) {
  return ctx.__module.create({
    api: ctx.api,
    confirm: ctx.confirm,
    escapeHtml: ctx.escapeHtml,
    inputAttrs: ctx.inputAttrs,
    render: ctx.render,
  });
}

function note(id, title, extra = {}) {
  return {
    id,
    title,
    display_title: title,
    content: "content-" + id,
    language: "txt",
    updated_at: 1000,
    updated_by: "user",
    ...extra,
  };
}

test("renderScreen lists rows in server order with per-row delete", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [note("a", "Alpha"), note("b", "Beta")],
  };
  await notes.load();

  const html = notes.renderScreen();
  assert.ok(html.includes('class="mobile-note-row-wrap"'), "row wrapper div present");
  assert.match(html, /class="mobile-row mobile-note-row"/);
  const wrap = html.slice(html.indexOf("mobile-note-row-wrap"), html.indexOf("</div>", html.indexOf("mobile-note-row-wrap")));
  assert.ok(wrap.indexOf('class="mobile-row mobile-note-row"') < wrap.indexOf("mobile-note-delete"), "delete lives in the same wrapper as its row");
  assert.ok(html.indexOf("Alpha") < html.indexOf("Beta"), "server order kept");
  assert.ok(html.includes("mobile-note-delete"), "per-row delete present");
  assert.ok(html.includes("HerdrMobileNotes.openNote('a')"), "row opens by id");
  assert.ok(html.includes("Clear all"), "clear-all present with notes");
  assert.ok(html.includes("id=\"mobileNotesSync\""), "sync button present");
});

test("empty state hides clear-all", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  await notes.load();
  const html = notes.renderScreen();
  assert.ok(html.includes("No notes yet"), "empty state rendered");
  assert.ok(!html.includes("Clear all"), "no clear-all without notes");
});

test("create opens exactly the server-named note", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { notes: [], languages: SERVER_LANGUAGES };
  await notes.load();
  ctx.__apiResponse = {
    notes: [note("fresh", "Untitled")],
    created_note_id: "fresh",
    languages: SERVER_LANGUAGES,
  };
  await notes.createNote();

  assert.equal(notes.state.editingId, "fresh", "editing the created note");
  const html = notes.renderScreen();
  assert.ok(html.includes("mobileNoteEditor"), "editor container rendered");
  assert.ok(html.includes("mobileNoteTitle"), "title input rendered");
  const put = ctx.__calls.api.find((call) => call.opts && call.opts.method === "POST");
  assert.ok(put, "create POSTs /api/notes");
});

test("openNote mounts the headerless editor with the language-resolved path", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [note("rn", "Rust note", { language: "rust" })],
  };
  await notes.load();
  notes.openNote("rn");

  const host = { innerHTML: "", _api: null };
  ctx.__nodes.mobileNoteEditor = host;
  notes.afterRender();

  assert.equal(ctx.__calls.editorMounts, 1, "editor mounted once");
  assert.equal(ctx.__editorOpts.path, "note.rs", "rust language maps to note.rs");
  assert.equal(ctx.__editorOpts.hideHeader, true, "headerless mount");
  assert.equal(notes.state.editorApi, host._api, "editor api stored");
});

test("editor onChange schedules a debounced save that PUTs content", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [note("t1", "Title")],
  };
  await notes.load();
  notes.openNote("t1");
  const host = { innerHTML: "", _api: null };
  ctx.__nodes.mobileNoteEditor = host;
  ctx.__nodes.mobileNoteSaveState = { textContent: "" };
  notes.afterRender();

  ctx.__editorValue = "typed draft";
  ctx.__editorOpts.onChange("typed draft");

  assert.equal(notes.state.saveTimer != null, true, "save scheduled");
  ctx.__apiResponse = { notes: [note("t1", "Title", { content: "typed draft" })], languages: SERVER_LANGUAGES };
  const timer = ctx.__pendingTimers[notes.state.saveTimer - 1];
  await timer();

  const put = ctx.__calls.api.find((c) => c.opts && c.opts.method === "PUT");
  assert.ok(put, "flush PUTs the note");
  assert.equal(put.url, "/api/notes/t1");
  assert.deepEqual(JSON.parse(put.opts.body), { content: "typed draft" });
});

test("per-row delete is confirm-free and adopts the snapshot", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("d1", "One")] };
  await notes.load();

  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [] };
  await notes.deleteNote("d1");

  assert.equal(ctx.__calls.confirm.length, 0, "no confirm on single delete");
  const del = ctx.__calls.api.find((c) => c.opts && c.opts.method === "DELETE");
  assert.ok(del, "DELETE hit the API");
  assert.equal(notes.state.notes.length, 0, "snapshot adopted");
});

test("deleting the open note closes the editor", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("k1", "Keep"), note("x1", "X")] };
  await notes.load();
  notes.openNote("x1");
  assert.equal(notes.state.editingId, "x1");

  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("k1", "Keep")] };
  await notes.deleteNote("x1");
  assert.equal(notes.state.editingId, null, "editor closed after delete");
});

test("clear-all rides the danger confirm", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("c1", "One")] };
  await notes.load();

  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [] };
  await notes.clearAll();
  assert.equal(ctx.__calls.confirm.length, 1, "clear-all asks once");
  const clear = ctx.__calls.api.find((c) => c.url === "/api/notes/clear");
  assert.ok(clear, "clear POSTs /api/notes/clear");

  ctx.__confirmResult = false;
  ctx.__calls.api.length = 0;
  await notes.clearAll();
  assert.equal(ctx.__calls.api.length, 0, "declined confirm clears nothing");
});

test("manual sync adopts the remote snapshot", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("s1", "One")] };
  await notes.load();
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("s1", "One"), note("s2", "Two")] };

  await notes.syncNow();
  assert.equal(notes.state.notes.length, 2, "sync adopted new list");
  assert.equal(notes.state.syncFailed, false, "sync failure cleared");
});

test("sync keeps local copy while editing a note that still exists", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("e1", "Edit me")] };
  await notes.load();
  notes.openNote("e1");

  ctx.__apiResponse = {
    languages: SERVER_LANGUAGES,
    notes: [note("e1", "Remote title", { content: "remote content" })],
  };
  await notes.syncNow();

  assert.equal(notes.state.notes[0].title, "Edit me", "local open note wins over remote");
  assert.equal(notes.state.editingId, "e1", "still editing");
});

test("remote delete closes a clean editor but keeps dirty edits pinned", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("z1", "Zap me")] };
  await notes.load();
  notes.openNote("z1");
  const host = { innerHTML: "", _api: null };
  ctx.__nodes.mobileNoteEditor = host;
  notes.afterRender();

  // Clean: the note vanished remotely, nothing pending -> close.
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [] };
  await notes.syncNow();
  assert.equal(notes.state.editingId, null, "clean editor closed on remote delete");

  // Dirty: local content pinned, editor stays.
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("z2", "Keep me")] };
  await notes.load();
  notes.openNote("z2");
  const host2 = { innerHTML: "", _api: null };
  ctx.__nodes.mobileNoteEditor = host2;
  ctx.__nodes.mobileNoteSaveState = { textContent: "" };
  notes.afterRender();
  ctx.__editorValue = "local draft";
  ctx.__editorOpts.onChange("local draft");

  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [] };
  await notes.syncNow();
  assert.equal(notes.state.editingId, "z2", "dirty editor stays open");
  assert.ok(notes.state.notes.some((n) => n.id === "z2"), "dirty note pinned in list");
});

test("enter arms the resync interval once; leave stops it and flushes pending saves", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("f1", "Flush")] };
  await notes.load();
  notes.enter();
  notes.enter();
  assert.equal(ctx.__pendingIntervals.length, 1, "one interval armed");

  notes.openNote("f1");
  const host = { innerHTML: "", _api: null };
  ctx.__nodes.mobileNoteEditor = host;
  ctx.__nodes.mobileNoteSaveState = { textContent: "" };
  notes.afterRender();
  ctx.__editorValue = "unflushed";
  ctx.__editorOpts.onChange("unflushed");

  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("f1", "Flush", { content: "unflushed" })] };
  notes.leave();

  assert.equal(ctx.__clearedIntervals, 1, "interval cleared");
  const put = ctx.__calls.api.find((c) => c.opts && c.opts.method === "PUT");
  assert.ok(put, "pending save flushed on leave");
  assert.deepEqual(JSON.parse(put.opts.body), { content: "unflushed" });
});

test("sync failure flags the badge state without dropping local data", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("n1", "Stable")] };
  await notes.load();

  ctx.__apiReject = /\/api\/notes/;
  await notes.syncNow();
  assert.equal(notes.state.syncFailed, true, "failure flagged");
  assert.equal(notes.state.notes.length, 1, "notes kept after failure");

  ctx.__apiReject = null;
  const html = notes.renderScreen();
  assert.ok(html.includes("Sync failed"), "failed state surfaces in the sync button");
});

test("applyRemote ignores frames while the screen is closed", async () => {
  const ctx = loadModule();
  const notes = makeNotes(ctx);
  ctx.__apiResponse = { languages: SERVER_LANGUAGES, notes: [note("r1", "One")] };
  await notes.load();

  notes.applyRemote({ notes: [note("r2", "Two")] });
  assert.equal(notes.state.notes.length, 1, "closed screen ignores frames");

  makeScreen(notes.renderScreen(), ctx.__nodes);
  notes.applyRemote({ notes: [note("r2", "Two")] });
  assert.equal(notes.state.notes.length, 1, "visible screen adopts the frame list");
});
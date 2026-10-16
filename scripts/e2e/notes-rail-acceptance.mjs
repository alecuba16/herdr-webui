// Real-DOM acceptance for the Notes rail. Boots an isolated server +
// chrome-headless (run-notes-rail-e2e.sh), then drives the real served
// bundle end to end:
//   - the rail Notes button hosts #notesPanel in the sidebar column
//   - a created note hits POST /api/notes and renders in the list
//   - editing mounts the shared CodeMirror editor
//   - the flushed save lands in the sidecar and survives a client reload
//     (the restart case is covered by the Rust state-rebuild test)
//   - per-note delete is confirm-free; Clear all rides the danger confirm
//   - the notes editor mounts headerless with a floating find toggle,
//     and find/replace toggles open/closed from the button and Ctrl+F
//   - the list-head sync icon forces a resync and settles back to idle
//   - an external DELETE closes a clean editor; dirty edits survive
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/notes_rail_e2e_result.json`;

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch (_) { /* degrade */ }

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  await reload();

  // n1: the rail Notes button hosts the panel in the sidebar column.
  const hosted = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailNotes");
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const panel = document.getElementById("notesPanel");
    const host = document.getElementById("rightSidebarContent");
    return JSON.stringify({
      hosted: !!(panel && host && panel.parentNode === host),
      empty: !!(panel && panel.textContent.includes("No notes yet")),
    });
  })()`);
  let hostInfo = null;
  try { hostInfo = JSON.parse(hosted); } catch { /* below */ }
  record("rail Notes button hosts #notesPanel in the column", !!hostInfo && hostInfo.hosted === true, hosted.slice(0, 300));
  record("empty state shows before any note exists", !!hostInfo && hostInfo.empty === true, hosted.slice(0, 300));

  // n2: create a note. POST /api/notes must render a row.
  const created = await evalExpr(`(async () => {
    const btn = document.getElementById("notesNew");
    if (!btn) return "no-new";
    btn.click();
    await new Promise((r) => setTimeout(r, 1000));
    const rows = document.querySelectorAll("[data-notes-open]");
    const titleInput = document.getElementById("notesTitleInput");
    return JSON.stringify({
      rows: rows.length,
      editing: !!titleInput,
    });
  })()`);
  let createInfo = null;
  try { createInfo = JSON.parse(created); } catch { /* below */ }
  // Creating enters the editing view straight away; the list (and its rows)
  // renders only after going back.
  record("new note enters editing straight away", !!createInfo && createInfo.editing === true, created.slice(0, 300));
  const listedAfterBack = await evalExpr(`(async () => {
    const back = document.getElementById("notesBack");
    if (!back) return "no-back";
    back.click();
    await new Promise((r) => setTimeout(r, 600));
    return JSON.stringify({ rows: document.querySelectorAll("[data-notes-open]").length });
  })()`);
  let backInfo = null;
  try { backInfo = JSON.parse(listedAfterBack); } catch { /* below */ }
  record("created note renders a list row", !!backInfo && backInfo.rows === 1, listedAfterBack.slice(0, 300));
  // Reopen the note for the editing checks below.
  await evalExpr(`(async () => {
    const row = document.querySelector("[data-notes-open]");
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 800));
    return "ok";
  })()`);

  // n3: pick rust, type a title and content, check CodeMirror mounted with
  // the rust language and the debounced save hit the API.
  const edited = await evalExpr(`(async () => {
    const lang = document.getElementById("notesLanguage");
    if (!lang) return "no-lang";
    lang.value = "rust";
    lang.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 800));
    const title = document.getElementById("notesTitleInput");
    if (!title) return "no-title";
    title.value = "build steps";
    title.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 800));
    const editorHost = document.getElementById("notesEditor");
    const cm = editorHost && editorHost.querySelector(".cm-editor");
    const content = 'fn main() { println!("e2e"); }';
    const api = window.HerdrNotesPanel;
    if (api && api.flush) {
      const editorApi = document.getElementById("notesPanel")._herdrEditorApi;
      if (editorApi && editorApi.setValue) editorApi.setValue(content);
    }
    if (api && api.flush) await api.flush();
    await new Promise((r) => setTimeout(r, 1000));
    const saved = await fetch("/api/notes").then((r) => r.json()).catch(() => null);
    const note = saved && saved.notes && saved.notes[0];
    return JSON.stringify({
      cm: !!cm,
      title: note ? note.title : null,
      language: note ? note.language : null,
      content: note ? note.content : null,
    });
  })()`);
  let editInfo = null;
  try { editInfo = JSON.parse(edited); } catch { /* below */ }
  record("CodeMirror mounted for the edited note", !!editInfo && editInfo.cm === true, edited.slice(0, 300));
  record("title and language saved through the API", !!editInfo && editInfo.title === "build steps" && editInfo.language === "rust", edited.slice(0, 300));
  const expectedContent = 'fn main() { println!("e2e"); }';
  record("content flushed through the shared editor save path", !!editInfo && editInfo.content === expectedContent, edited.slice(0, 300));

  // n4: the sidecar survives a full client reload (no server restart here;
  // the persistence-across-restart case is covered by the Rust suite's
  // state-rebuild test).
  await reload();
  const reloaded = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailNotes");
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 1500));
    const panel = document.getElementById("notesPanel");
    return JSON.stringify({
      row: !!(panel && panel.querySelector('[data-notes-open]')),
      title: panel ? (panel.querySelector(".notes-row-title") || {}).textContent : null,
    });
  })()`);
  let reloadInfo = null;
  try { reloadInfo = JSON.parse(reloaded); } catch { /* below */ }
  record("note survives a client reload through the sidecar GET", !!reloadInfo && reloadInfo.row === true && /build steps/.test(String(reloadInfo.title || "")), reloaded.slice(0, 300));

  // n5: per-note delete is confirm-free and empties the list; then create
  // again and check Clear all goes through the danger confirm.
  const deleted = await evalExpr(`(async () => {
    const del = document.querySelector("[data-notes-delete]");
    if (!del) return "no-delete";
    let asked = 0;
    const origConfirm = window.confirm;
    window.confirm = () => { asked += 1; return false; };
    del.click();
    await new Promise((r) => setTimeout(r, 900));
    window.confirm = origConfirm;
    return JSON.stringify({
      asked,
      rows: document.querySelectorAll("[data-notes-open]").length,
    });
  })()`);
  let delInfo = null;
  try { delInfo = JSON.parse(deleted); } catch { /* below */ }
  record("per-note delete asks nothing and removes the row", !!delInfo && delInfo.asked === 0 && delInfo.rows === 0, deleted.slice(0, 300));

  // Recreate one note for the clear-all check. Creating lands in the editor
  // view, so go back to the list first: notesClear only renders there.
  await evalExpr(`(async () => {
    const btn = document.getElementById("notesNew");
    if (!btn) return "no-new";
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const back = document.getElementById("notesBack");
    if (!back) return "no-back";
    back.click();
    await new Promise((r) => setTimeout(r, 600));
    const clear = document.getElementById("notesClear");
    return clear ? "list-ready" : "no-clear-button";
  })()`).then((r) => { if (r !== "list-ready") console.log("recreate step:", r); });
  const cleared = await evalExpr(`(async () => {
    const clear = document.getElementById("notesClear");
    if (!clear) return "no-clear";
    let danger = null;
    const panel = window.HerdrNotesPanel;
    if (!panel) return "no-panel";
    if (typeof askQuestion === "function") {
      const origAsk = askQuestion;
      window.askQuestion = (opts) => { danger = opts && opts.danger; return Promise.resolve(false); };
      // notes.js captured the original binding at call time, so restoring
      // happens after the awaited clearAll below.
      try { await panel.clearAll(); } finally { window.askQuestion = origAsk; }
    } else {
      await panel.clearAll();
    }
    await new Promise((r) => setTimeout(r, 600));
    const saved = await fetch("/api/notes").then((r) => r.json()).catch(() => null);
    return JSON.stringify({
      danger,
      notes: saved && saved.notes ? saved.notes.length : null,
    });
  })()`);
  let clearInfo = null;
  try { clearInfo = JSON.parse(cleared); } catch { /* below */ }
  record("clear-all rides the danger confirm and rejects cleanly", !!clearInfo && clearInfo.danger === true && clearInfo.notes === 1, cleared.slice(0, 300));

  // n6: the edited view mounts the editor headerless: no note.txt-style
  // head, but the floating find toggle and Ctrl+F both work as toggles.
  const headerless = await evalExpr(`(async () => {
    const nb = document.getElementById("notesNew");
    if (!nb) return "no-new";
    nb.click();
    await new Promise((r) => setTimeout(r, 1200));
    const host = document.getElementById("notesEditor");
    if (!host) return "no-host";
    const head = host.querySelector(".herdr-editor-head");
    const float = host.querySelector(".herdr-editor-find-float");
    const find = host.querySelector(".herdr-editor-find");
    if (!float || !find) return JSON.stringify({ head: !!head, float: !!float, find: !!find });
    const before = { pressed: float.getAttribute("aria-pressed"), hidden: find.hidden };
    float.click();
    await new Promise((r) => setTimeout(r, 200));
    const opened = { pressed: float.getAttribute("aria-pressed"), hidden: find.hidden, focused: document.activeElement === find.querySelector(".herdr-editor-find-query") };
    // Ctrl+F with focus already in the query re-selects instead of hiding.
    // Dispatch with the query as the target (inside .herdr-editor) so the
    // app-level Ctrl+F fallback does not intercept the keystroke.
    const query = find.querySelector(".herdr-editor-find-query");
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const requery = { hidden: find.hidden, stillFocused: document.activeElement === query };
    float.click();
    await new Promise((r) => setTimeout(r, 200));
    const closed = { pressed: float.getAttribute("aria-pressed"), hidden: find.hidden };
    // Ctrl+F from the editor surface (CodeMirror content holds focus)
    // opens the bar again.
    const cmContent = host.querySelector(".cm-content") || host.querySelector(".herdr-editor");
    cmContent.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const viaShortcut = { hidden: find.hidden };
    return JSON.stringify({ head: !!head, before, opened, requery, closed, viaShortcut });
  })()`);
  let headerlessInfo = null;
  try { headerlessInfo = JSON.parse(headerless); } catch { /* below */ }
  const hl = headerlessInfo || {};
  record("edited note mounts headerless (no note.txt head)", hl.head === false, headerless.slice(0, 300));
  record("floating find toggle opens with aria-pressed sync", hl.opened && hl.opened.pressed === "true" && hl.opened.hidden === false && hl.opened.focused === true, headerless.slice(0, 300));
  record("Ctrl+F with focus in the query re-selects, not hides", hl.requery && hl.requery.hidden === false && hl.requery.stillFocused === true, headerless.slice(0, 300));
  record("toggle and Ctrl+F close and reopen the find bar", hl.closed && hl.closed.hidden === true && hl.closed.pressed === "false" && hl.viaShortcut && hl.viaShortcut.hidden === false, headerless.slice(0, 300));

  // n7: the list head shows the sync icon; a manual forced sync runs and
  // settles back to idle. The list repaint replaces the button node, so
  // re-grab it by id for every read (a detached node measures 0x0).
  const synced = await evalExpr(`(async () => {
    const back = document.getElementById("notesBack");
    if (back) back.click();
    await new Promise((r) => setTimeout(r, 600));
    const idle = (() => { const b = document.getElementById("notesSync"); return { cls: b.className, disabled: b.disabled, last: b === b.parentNode.lastElementChild }; })();
    const btn = document.getElementById("notesSync");
    if (!btn) return "no-sync";
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    const fresh = document.getElementById("notesSync");
    if (!fresh) return "no-sync-after";
    const after = { cls: fresh.className, disabled: fresh.disabled };
    const size = Math.round(fresh.getBoundingClientRect().width) + "x" + Math.round(fresh.getBoundingClientRect().height);
    return JSON.stringify({ idle, after, size });
  })()`);
  let syncInfo = null;
  try { syncInfo = JSON.parse(synced); } catch { /* below */ }
  const sy = syncInfo || {};
  record("list head shows the sync icon pinned last", sy.idle && sy.idle.last === true && sy.idle.cls.includes("notes-sync") && sy.size === "28x28", synced.slice(0, 300));
  record("manual sync runs and settles back to idle", sy.after && sy.after.cls === "mini notes-sync" && sy.after.disabled === false, synced.slice(0, 300));

  // n8: an external DELETE of the open, clean note closes the editor back
  // to the list on the next sync; dirty local edits survive instead.
  const ghost = await evalExpr(`(async () => {
    // Open the note, let the save settle, then delete it behind the UI.
    const row = document.querySelector("[data-notes-open]");
    if (!row) return "no-row";
    row.click();
    await new Promise((r) => setTimeout(r, 1000));
    const api = window.HerdrNotesPanel;
    if (api && api.flush) await api.flush();
    await new Promise((r) => setTimeout(r, 400));
    const id = api && api.editingId ? api.editingId() : null;
    if (!id) return "no-editing-id";
    const res = await fetch("/api/notes/" + encodeURIComponent(id), { method: "DELETE" });
    if (!res.ok) return "delete-failed:" + res.status;
    // Clean editor: the next periodic sync (or a forced one) closes it.
    await api.syncNow();
    await new Promise((r) => setTimeout(r, 300));
    const closed = !document.getElementById("notesTitleInput");
    // The earlier n6 note legitimately remains: only the open note dies.
    const rows = document.querySelectorAll("[data-notes-open]").length;
    return JSON.stringify({ closed, rows });
  })()`);
  let ghostInfo = null;
  try { ghostInfo = JSON.parse(ghost); } catch { /* below */ }
  record("external delete closes the clean edited note on sync", ghostInfo && ghostInfo.closed === true && ghostInfo.rows === 1, ghost.slice(0, 300));

  // n9: a dirty editor (un-flushed keystrokes) survives the external delete.
  const dirtySurvives = await evalExpr(`(async () => {
    const nb = document.getElementById("notesNew");
    if (!nb) return "no-new";
    nb.click();
    await new Promise((r) => setTimeout(r, 1200));
    const host = document.getElementById("notesEditor");
    const editorApi = document.getElementById("notesPanel")._herdrEditorApi;
    if (!editorApi || !editorApi.setValue) return "no-editor-api";
    editorApi.setValue("dirty local draft");
    // Give the debounce a tick to arm, then delete behind the UI without
    // flushing: the local edit must win and the editor must stay open.
    await new Promise((r) => setTimeout(r, 200));
    const api = window.HerdrNotesPanel;
    const id = api.editingId ? api.editingId() : null;
    if (!id) return "no-editing-id";
    const res = await fetch("/api/notes/" + encodeURIComponent(id), { method: "DELETE" });
    if (!res.ok) return "delete-failed:" + res.status;
    await api.syncNow();
    await new Promise((r) => setTimeout(r, 300));
    const stillEditing = !!document.getElementById("notesTitleInput");
    const content = editorApi.getValue ? editorApi.getValue() : null;
    return JSON.stringify({ stillEditing, content });
  })()`);
  let dirtyInfo = null;
  try { dirtyInfo = JSON.parse(dirtySurvives); } catch { /* below */ }
  record("dirty editor survives an external delete", dirtyInfo && dirtyInfo.stillEditing === true && dirtyInfo.content === "dirty local draft", dirtySurvives.slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeCrashReport(outPath, recorder, e);
  process.exit(1);
});